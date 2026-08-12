const { API_VERSION } = require('../lib/github');

const emptyIndex = () => ({
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
});

const manageIndexFile = async (octokit, owner, repo, filePath, fileType, operation, fileContent = null) => {
    try {
        const indexPath = `${fileType}.json`;

        let content = {};
        let sha = null;

        // Fetch the existing index file (if it exists)
        try {
            const response = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
                owner,
                repo,
                path: indexPath,
                headers: {
                    'X-GitHub-Api-Version': API_VERSION,
                },
            });

            const data = Buffer.from(response.data.content, 'base64').toString('utf-8');
            content = JSON.parse(data);
            sha = response.data.sha;

            // Detect if this is legacy format (no _metadata, _files, _search)
            if (!content._metadata && !content._files && !content._search) {
                console.log('Legacy index format detected, migrating to v2.0');

                const legacyContent = content;
                content = emptyIndex();

                // Migrate existing entries (legacy format: {filename: key})
                for (const [filename, key] of Object.entries(legacyContent)) {
                    content._files[filename] = {
                        key: key,
                        object_type: '' // Unknown in legacy format
                    };

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

            content = emptyIndex();
        }

        // Ensure content has the v2.0 structure
        if (!content._metadata) {
            content._metadata = emptyIndex()._metadata;
        }
        if (!content._files) content._files = {};
        if (!content._search) content._search = { by_key: {}, by_type: {} };
        if (!content._search.by_key) content._search.by_key = {};
        if (!content._search.by_type) content._search.by_type = {};

        const fileName = filePath.substring(filePath.lastIndexOf('/') + 1);

        if (operation === 'update') {
            const fileData = Buffer.from(fileContent, 'base64').toString('utf-8');
            const fileJson = JSON.parse(fileData);

            const key = fileJson['key'] || '';
            const objectType = fileJson['object_type'] || '';

            // If this file already exists, remove it from old search indexes first
            if (content._files[fileName]) {
                const oldKey = content._files[fileName].key;
                const oldType = content._files[fileName].object_type;

                if (oldKey && content._search.by_key[oldKey]) {
                    content._search.by_key[oldKey] = content._search.by_key[oldKey].filter(f => f !== fileName);
                    if (content._search.by_key[oldKey].length === 0) {
                        delete content._search.by_key[oldKey];
                    }
                }

                if (oldType && content._search.by_type[oldType]) {
                    content._search.by_type[oldType] = content._search.by_type[oldType].filter(f => f !== fileName);
                    if (content._search.by_type[oldType].length === 0) {
                        delete content._search.by_type[oldType];
                    }
                }
            }

            content._files[fileName] = {
                key: key,
                object_type: objectType
            };

            if (key) {
                if (!content._search.by_key[key]) {
                    content._search.by_key[key] = [];
                }
                if (!content._search.by_key[key].includes(fileName)) {
                    content._search.by_key[key].push(fileName);
                }
            }

            if (objectType) {
                if (!content._search.by_type[objectType]) {
                    content._search.by_type[objectType] = [];
                }
                if (!content._search.by_type[objectType].includes(fileName)) {
                    content._search.by_type[objectType].push(fileName);
                }
            }

        } else if (operation === 'remove') {
            const fileMetadata = content._files[fileName];

            if (fileMetadata) {
                const key = fileMetadata.key;
                const objectType = fileMetadata.object_type;

                delete content._files[fileName];

                if (key && content._search.by_key[key]) {
                    content._search.by_key[key] = content._search.by_key[key].filter(f => f !== fileName);
                    if (content._search.by_key[key].length === 0) {
                        delete content._search.by_key[key];
                    }
                }

                if (objectType && content._search.by_type[objectType]) {
                    content._search.by_type[objectType] = content._search.by_type[objectType].filter(f => f !== fileName);
                    if (content._search.by_type[objectType].length === 0) {
                        delete content._search.by_type[objectType];
                    }
                }
            }
        }

        content._metadata.last_updated = new Date().toISOString();
        content._metadata.total_files = Object.keys(content._files).length;

        const commitMessage = operation === 'update' ?
            `Update ${fileType}.json for ${filePath}` :
            `Update ${fileType}.json after deleting ${filePath}`;

        const updatedContent = Buffer.from(JSON.stringify(content, null, 2)).toString('base64');

        const params = {
            owner,
            repo,
            path: indexPath,
            message: commitMessage,
            content: updatedContent,
            headers: {
                'X-GitHub-Api-Version': API_VERSION,
            },
        };

        if (sha) {
            params.sha = sha;
        }

        await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', params);

    } catch (error) {
        console.error(`Error ${operation}ing ${fileType}.json:`, error);
        throw error;
    }
};

module.exports = {
    manageIndexFile
};
