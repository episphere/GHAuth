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
        } catch (error) {
            if (error.status !== 404) {
                throw error;
            }
            // For remove operation, exit early if file doesn't exist
            if (operation === 'remove') {
                return;
            }
        }

        // Ensure content is an object
        if (!content || typeof content !== 'object') {
            content = {};
        }

        const fileName = filePath.substring(filePath.lastIndexOf('/') + 1);

        // Perform the operation
        if (operation === 'update') {
            // Extract key value from file content
            const fileData = Buffer.from(fileContent, 'base64').toString('utf-8');
            const fileJson = JSON.parse(fileData);
            
            let keyValue;
            if (fileType === 'index') {
                keyValue = fileJson['key'] || '';
            }
            
            content[fileName] = keyValue;
        } else if (operation === 'remove') {
            delete content[fileName];
        }

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
 
module.exports = {
    setHeaders,
    fetchSecrets,
    manageIndexFile,
    generateConceptID,
    getFile,
    createFile,
    getBaseConfig,
    toBase64
}