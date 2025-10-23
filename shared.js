const {SecretManagerServiceClient} = require('@google-cloud/secret-manager');
const { Octokit } = require('octokit');

const setHeaders = (res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers','Accept,Content-Type,Content-Length,Accept-Encoding,X-CSRF-Token,Authorization');
    res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
}

const fetchSecrets = async (local) => {
    const secrets = {};

    if (local) {
        secrets.client_id = process.env.GITHUB_CLIENT_ID_DEV;
        secrets.client_secret = process.env.GITHUB_CLIENT_SECRET_DEV;
    }
    else{
        secrets.client_id = process.env.GITHUB_CLIENT_ID;
        secrets.client_secret = process.env.GITHUB_CLIENT_SECRET;
    }

    const client = new SecretManagerServiceClient();
    let fetchedSecrets = {};

    for (const [key, value] of Object.entries(secrets)) {
        const [version] = await client.accessSecretVersion({ name: value });
        fetchedSecrets[key] = version.payload.data.toString();
    }
    
    return fetchedSecrets;
}

const manageIndexFile = async (octokit, owner, repo, filePath, fileType, operation, fileContent = null) => {
    try {
        // Get directory path and construct index path
        const directoryPath = filePath.includes('/') ? filePath.substring(0, filePath.lastIndexOf('/')) : '';
        const indexPath = directoryPath ? `${directoryPath}/${fileType}.json` : `${fileType}.json`;
        
        let content = {};
        let sha = null;
    
        // Fetch the existing index file (if it exists)
        try {
            const response = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
                owner,
                repo,
                path: indexPath,
                headers: {
                    'X-GitHub-Api-Version': '2022-11-28',
                },
            });

            const data = Buffer.from(response.data.content, 'base64').toString('utf-8');
            content = JSON.parse(data);
            sha = response.data.sha;

            // Detect if this is legacy format (no _metadata, _files, _search)
            if (!content._metadata && !content._files && !content._search) {
                console.log('Legacy index format detected, migrating to v2.0');
                
                // Migrate legacy format to new format
                const legacyContent = content;
                content = {
                    _metadata: {
                        last_updated: new Date().toISOString(),
                        total_files: 0,
                        version: '2.0'
                    },
                    _files: {},
                    _search: {
                        by_key: {},
                        by_type: {}
                    }
                };

                // Migrate existing entries (legacy format: {filename: key})
                for (const [filename, key] of Object.entries(legacyContent)) {
                    content._files[filename] = {
                        key: key,
                        object_type: '' // Unknown in legacy format
                    };
                    
                    // Add to search index
                    if (key) {
                        if (!content._search.by_key[key]) {
                            content._search.by_key[key] = [];
                        }
                        content._search.by_key[key].push(filename);
                    }
                }
            }
        } catch (error) {
            if (error.status !== 404) {
                throw error;
            }
            // For remove operation, exit early if file doesn't exist
            if (operation === 'remove') {
                return;
            }
            
            // Initialize new v2.0 structure for new index files
            content = {
                _metadata: {
                    last_updated: new Date().toISOString(),
                    total_files: 0,
                    version: '2.0'
                },
                _files: {},
                _search: {
                    by_key: {},
                    by_type: {}
                }
            };
        }

        // Ensure content has the v2.0 structure
        if (!content._metadata) {
            content._metadata = {
                last_updated: new Date().toISOString(),
                total_files: 0,
                version: '2.0'
            };
        }
        if (!content._files) content._files = {};
        if (!content._search) content._search = { by_key: {}, by_type: {} };
        if (!content._search.by_key) content._search.by_key = {};
        if (!content._search.by_type) content._search.by_type = {};

        const fileName = filePath.substring(filePath.lastIndexOf('/') + 1);

        // Perform the operation
        if (operation === 'update') {
            // Extract key and object_type from file content
            const fileData = Buffer.from(fileContent, 'base64').toString('utf-8');
            const fileJson = JSON.parse(fileData);
            
            const key = fileJson['key'] || '';
            const objectType = fileJson['object_type'] || '';

            // If this file already exists, remove it from old search indexes first
            if (content._files[fileName]) {
                const oldKey = content._files[fileName].key;
                const oldType = content._files[fileName].object_type;

                // Remove from old key index
                if (oldKey && content._search.by_key[oldKey]) {
                    content._search.by_key[oldKey] = content._search.by_key[oldKey].filter(f => f !== fileName);
                    if (content._search.by_key[oldKey].length === 0) {
                        delete content._search.by_key[oldKey];
                    }
                }

                // Remove from old type index
                if (oldType && content._search.by_type[oldType]) {
                    content._search.by_type[oldType] = content._search.by_type[oldType].filter(f => f !== fileName);
                    if (content._search.by_type[oldType].length === 0) {
                        delete content._search.by_type[oldType];
                    }
                }
            }

            // Add/update in _files
            content._files[fileName] = {
                key: key,
                object_type: objectType
            };

            // Add to _search.by_key (inverted index)
            if (key) {
                if (!content._search.by_key[key]) {
                    content._search.by_key[key] = [];
                }
                if (!content._search.by_key[key].includes(fileName)) {
                    content._search.by_key[key].push(fileName);
                }
            }

            // Add to _search.by_type (inverted index)
            if (objectType) {
                if (!content._search.by_type[objectType]) {
                    content._search.by_type[objectType] = [];
                }
                if (!content._search.by_type[objectType].includes(fileName)) {
                    content._search.by_type[objectType].push(fileName);
                }
            }

        } else if (operation === 'remove') {
            // Get the file's metadata before removing
            const fileMetadata = content._files[fileName];
            
            if (fileMetadata) {
                const key = fileMetadata.key;
                const objectType = fileMetadata.object_type;

                // Remove from _files
                delete content._files[fileName];

                // Remove from _search.by_key
                if (key && content._search.by_key[key]) {
                    content._search.by_key[key] = content._search.by_key[key].filter(f => f !== fileName);
                    if (content._search.by_key[key].length === 0) {
                        delete content._search.by_key[key];
                    }
                }

                // Remove from _search.by_type
                if (objectType && content._search.by_type[objectType]) {
                    content._search.by_type[objectType] = content._search.by_type[objectType].filter(f => f !== fileName);
                    if (content._search.by_type[objectType].length === 0) {
                        delete content._search.by_type[objectType];
                    }
                }
            }
        }

        // Update metadata
        content._metadata.last_updated = new Date().toISOString();
        content._metadata.total_files = Object.keys(content._files).length;

        // Prepare commit message
        const commitMessage = operation === 'update' ? 
            `Update ${fileType}.json for ${filePath}` : 
            `Update ${fileType}.json after deleting ${filePath}`;

        // Commit the updated index file
        const updatedContent = Buffer.from(JSON.stringify(content, null, 2)).toString('base64');
        
        const params = {
            owner,
            repo,
            path: indexPath,
            message: commitMessage,
            content: updatedContent,
            headers: {
                'X-GitHub-Api-Version': '2022-11-28',
            },
        };

        if (sha) {
            params.sha = sha;
        }

        await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', params);

        console.log(`Successfully ${operation}d ${fileName} in ${fileType}.json`);

    } catch (error) {
        console.error(`Error ${operation}ing ${fileType}.json:`, error);
        throw error;
    }
}

const getFile = async (token, owner, repo, path) => {
    const octokit = new Octokit({
        auth: token
    });

    const response = await octokit.request(`GET /repos/{owner}/{repo}/contents/{path}`, {
        owner,
        repo,
        path,
        headers: {
            'X-GitHub-Api-Version': '2022-11-28'
        }
    });

    return response;
}

const createFile = async (token, owner, repo, path, content, message) => {

    console.log(`Creating file at ${path}`);
    
    const octokit = new Octokit({
        auth: token
    });
    
    const response = await octokit.request(`PUT /repos/{owner}/{repo}/contents/{path}`, {
        owner,
        repo,
        path,
        message,
        content,
        headers: {
            'X-GitHub-Api-Version': '2022-11-28'
        }
    });

    return response;
}

const getBaseConfig = () => {
    return {
        PRIMARY: [
            { id: "conceptId", label: "Concept ID", required: true, type: "concept" },
            { id: "key", label: "Key", required: true, type: "text" }
        ],
        SECONDARY: [
            { id: "conceptId", label: "Concept ID", required: true, type: "concept" },
            { id: "key", label: "Key", required: true, type: "text" },
            { id: "primaryConceptId", label: "Primary Concept ID", required: true, type: "reference", referencesType: "PRIMARY" }
        ],
        SOURCE: [
            { id: "conceptId", label: "Concept ID", required: true, type: "concept" },
            { id: "key", label: "Key", required: true, type: "text" }
        ],
        QUESTION: [
            { id: "conceptId", label: "Concept ID", required: true, type: "concept" },
            { id: "key", label: "Key", required: true, type: "text" },
            { id: "secondaryConceptId", label: "Secondary Concept ID", required: true, type: "reference", referencesType: "SECONDARY" },
            { id: "sourceConceptId", label: "Source Concept ID", required: false, type: "reference", referencesType: "SOURCE" },
            { id: "responses", label: "Responses", required: false, type: "reference", referencesType: "RESPONSE" }
        ],
        RESPONSE: [
            { id: "conceptId", label: "Concept ID", required: true, type: "concept" },
            { id: "key", label: "Key", required: true, type: "text" }
        ]
    }
}

const toBase64 = (string) => {
    return btoa(string);
}

const generateConceptID = () => {
    return Math.floor(100000000 + Math.random() * 900000000);
}

const rebuildIndex = async (octokit, owner, repo, branch = 'main') => {
    try {
        console.log(`Starting index rebuild for ${owner}/${repo}`);
        
        // Get all files in repo using Git Tree API
        const treeResponse = await octokit.request('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', {
            owner,
            repo,
            tree_sha: branch,
            recursive: '1',
            headers: {
                'X-GitHub-Api-Version': '2022-11-28'
            }
        });

        // Filter for .json files, excluding index.json, config.json, object.json
        const excludeFiles = ['index.json', 'config.json', 'object.json'];
        const jsonFiles = treeResponse.data.tree.filter(item => 
            item.type === 'blob' && 
            item.path.endsWith('.json') &&
            !excludeFiles.includes(item.path.split('/').pop())
        );

        console.log(`Found ${jsonFiles.length} JSON files to process`);

        // Build index structure
        const index = {
            _metadata: {
                last_updated: new Date().toISOString(),
                total_files: 0,
                version: '2.0'
            },
            _files: {},
            _search: {
                by_key: {},
                by_type: {}
            }
        };

        const errors = [];
        let processedCount = 0;

        // Process files in chunks to avoid rate limits
        const chunkSize = 50;
        for (let i = 0; i < jsonFiles.length; i += chunkSize) {
            const chunk = jsonFiles.slice(i, i + chunkSize);
            
            await Promise.all(chunk.map(async (file) => {
                try {
                    // Fetch file content
                    const response = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
                        owner,
                        repo,
                        path: file.path,
                        headers: {
                            'X-GitHub-Api-Version': '2022-11-28'
                        }
                    });

                    const content = Buffer.from(response.data.content, 'base64').toString('utf-8');
                    const fileData = JSON.parse(content);

                    const fileName = file.path.split('/').pop();
                    const key = fileData.key || '';
                    const objectType = fileData.object_type || '';

                    // Add to _files
                    index._files[fileName] = {
                        key: key,
                        object_type: objectType
                    };

                    // Add to _search.by_key (inverted index)
                    if (key) {
                        if (!index._search.by_key[key]) {
                            index._search.by_key[key] = [];
                        }
                        index._search.by_key[key].push(fileName);
                    }

                    // Add to _search.by_type (inverted index)
                    if (objectType) {
                        if (!index._search.by_type[objectType]) {
                            index._search.by_type[objectType] = [];
                        }
                        index._search.by_type[objectType].push(fileName);
                    }

                    processedCount++;

                } catch (error) {
                    errors.push({
                        file: file.path,
                        error: error.message
                    });
                }
            }));

            console.log(`Processed ${Math.min(i + chunkSize, jsonFiles.length)}/${jsonFiles.length} files`);
        }

        // Update metadata
        index._metadata.total_files = processedCount;

        // Calculate type counts for metadata
        const typeCounts = {};
        for (const [type, files] of Object.entries(index._search.by_type)) {
            typeCounts[type] = files.length;
        }

        // Commit the new index.json
        const indexContent = Buffer.from(JSON.stringify(index, null, 2)).toString('base64');
        
        // Check if index.json already exists
        let sha = null;
        try {
            const existingIndex = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
                owner,
                repo,
                path: 'index.json',
                headers: {
                    'X-GitHub-Api-Version': '2022-11-28'
                }
            });
            sha = existingIndex.data.sha;
        } catch (error) {
            if (error.status !== 404) {
                throw error;
            }
        }

        const commitParams = {
            owner,
            repo,
            path: 'index.json',
            message: 'Rebuild index.json',
            content: indexContent,
            headers: {
                'X-GitHub-Api-Version': '2022-11-28'
            }
        };

        if (sha) {
            commitParams.sha = sha;
        }

        await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', commitParams);

        console.log(`Index rebuild complete. Processed ${processedCount} files with ${errors.length} errors`);

        return {
            success: true,
            filesProcessed: processedCount,
            indexPath: 'index.json',
            metadata: {
                last_updated: index._metadata.last_updated,
                total_files: processedCount,
                by_type: typeCounts
            },
            errors: errors
        };

    } catch (error) {
        console.error('Error rebuilding index:', error);
        throw error;
    }
}
 
module.exports = {
    setHeaders,
    fetchSecrets,
    manageIndexFile,
    generateConceptID,
    getFile,
    createFile,
    getBaseConfig,
    toBase64,
    rebuildIndex
}