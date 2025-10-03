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

const updateIndexFile = async (octokit, owner, repo, filePath, fileContent, fileType) => {
    try {
        let directoryPath = '';

        if (filePath.includes('/')) {
            directoryPath = filePath.substring(0, filePath.lastIndexOf('/'));
        }

        const indexPath = directoryPath ? `${directoryPath}/${fileType}.json` : `${fileType}.json`;
        let content = {};
        let sha = null;
    
        // Step 1: Fetch the existing index.json (if it exists)
        try {
            const indexResponse = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
                owner,
                repo,
                path: indexPath,
                headers: {
                    'X-GitHub-Api-Version': '2022-11-28',
                },
            });
    
            const indexData = Buffer.from(indexResponse.data.content, 'base64').toString('utf-8');
            content = JSON.parse(indexData);
            sha = indexResponse.data.sha;
        } catch (error) {
            // If index.json doesn't exist, we'll create a new one
            if (error.status !== 404) {
                throw error;
            }
        }

        // Ensure content is an object
        if (!content || typeof content !== 'object') {
            content = {};
        }
    
        // Step 2: Read the "key" value from the file content
        const fileData = Buffer.from(fileContent, 'base64').toString('utf-8');
        const fileJson = JSON.parse(fileData);

        let keyValue;
        
        if (fileType === 'index') {
            keyValue = fileJson['key'] || '';
        }
        else if (fileType === 'object') {
            keyValue = fileJson['object_type'] || '';
        }

        // Step 3: Update the content with the new/updated entry
        const fileName = filePath.substring(filePath.lastIndexOf('/') + 1);
        content[fileName] = keyValue;

        // Step 4: Commit the updated index.json
        const updatedContent = Buffer.from(JSON.stringify(content, null, 2)).toString('base64');

        const commitMessage = `Update index.json for ${filePath}`;
    
        // Prepare the request parameters
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

    } catch (error) {
        console.error('Error updating index.json:', error);
        throw error;
    }
}

const removeFromIndexFile = async (octokit, owner, repo, filePath, fileType) => {
    try {
        let directoryPath = '';

        if (filePath.includes('/')) {
            directoryPath = filePath.substring(0, filePath.lastIndexOf('/'));
        }

        const indexPath = directoryPath ? `${directoryPath}/${fileType}.json` : `${fileType}.json`;
        let content = {};
        let sha = null;
    
        // Step 1: Fetch the existing index file (if it exists)
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
        } catch (error) {
            // If index file doesn't exist, nothing to remove
            if (error.status !== 404) {
                throw error;
            }
            return; // Exit early if file doesn't exist
        }

        // Ensure content is an object
        if (!content || typeof content !== 'object') {
            content = {};
        }

        // Step 2: Remove the file entry from content
        const fileName = filePath.substring(filePath.lastIndexOf('/') + 1);
        delete content[fileName];

        // Step 3: Commit the updated index file
        const updatedContent = Buffer.from(JSON.stringify(content, null, 2)).toString('base64');

        const commitMessage = `Update ${fileType}.json after deleting ${filePath}`;
    
        // Prepare the request parameters
        const params = {
            owner,
            repo,
            path: indexPath,
            message: commitMessage,
            sha,
            content: updatedContent,
            headers: {
                'X-GitHub-Api-Version': '2022-11-28',
            },
        };

        await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', params);

    } catch (error) {
        console.error(`Error updating ${fileType}.json:`, error);
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
 
module.exports = {
    setHeaders,
    fetchSecrets,
    updateIndexFile,
    generateConceptID,
    removeFromIndexFile,
    getFile,
    createFile,
    getBaseConfig,
    toBase64
}