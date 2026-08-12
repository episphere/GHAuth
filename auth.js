const { Octokit } = require('octokit');
const {
    setHeaders,
    extractToken,
    missingParams,
    sendMissingParams,
    sendUnauthorized,
    sendError
} = require('./lib/http');
const { extractRateLimit } = require('./lib/rateLimit');
const { logRequest } = require('./lib/logging');
const { fetchSecrets } = require('./lib/secrets');
const { getFile, createFile, toBase64 } = require('./lib/github');
const { manageIndexFile } = require('./domain/indexFile');
const { getBaseConfig } = require('./domain/config');
const { generateConceptID } = require('./domain/conceptId');

const ghauth = async (req, res) => {
    setHeaders(res);
    
    if(req.method === 'OPTIONS') return res.status(200).json({code: 200});

    const api = req.query.api;
    const startedAt = Date.now();

    // Define valid API endpoints in one place
    const validEndpoints = [
        'accessToken',
        'getUser',
        'addFile', 
        'updateFile',
        'getRepo',
        'searchFiles',
        'getUserRepositories',
        'getFiles',
        'deleteFile',
        'getConcept',
        'getConfig'
    ];

    // Early validation for invalid API endpoints
    if (!validEndpoints.includes(api)) {
        logRequest({ api, status: 400, startedAt, error: 'Invalid API endpoint' });
        return res.status(400).json({
            error: 'Invalid API endpoint',
            message: `API endpoint '${api}' is not supported`,
            supportedEndpoints: validEndpoints
        });
    }

    if (api === 'accessToken') {
        try {
            if (req.method !== 'POST') return res.status(405).json({error: 'Method Not Allowed'});

            const missing = missingParams(req.body, ['code', 'redirect']);
            if (missing.length) return sendMissingParams(res, api, startedAt, missing);

            const environment = req.query.environment;
            const local = environment === 'dev' ? true : false;

            const secrets = await fetchSecrets(local);

            const code = req.body.code;
            const redirect = req.body.redirect;

            const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify({
                    client_id: secrets.client_id,
                    client_secret: secrets.client_secret,
                    code: code,
                    redirect_uri: redirect,
                })
            });
    
            const response = await tokenResponse.json();
            logRequest({ api, status: 200, startedAt });
            res.status(200).json(response);

        } catch (error) {
            return sendError(res, api, startedAt, error);
        }
    }

    if (api === 'getUser') {
        try {
            if (req.method !== 'GET') return res.status(405).json({error: 'Method Not Allowed'});

            const token = extractToken(req);
            if (!token) return sendUnauthorized(res, api, startedAt);

            const octokit = new Octokit({
                auth: token
            });

            const response = await octokit.request('GET /user');
            const rateLimit = extractRateLimit(response);

            logRequest({ api, status: 200, startedAt, rateLimit });
            res.status(200).json({
                data: response.data,
                status: response.status,
                rateLimit
            });
        } catch (error) {
            return sendError(res, api, startedAt, error);
        }
    }

    if (api === 'addFile') {
        try {
            if (req.method !== 'POST') return res.status(405).json({error: 'Method Not Allowed'});

            const token = extractToken(req);
            if (!token) return sendUnauthorized(res, api, startedAt);

            const missing = missingParams(req.body, ['owner', 'repo', 'path', 'message', 'content']);
            if (missing.length) return sendMissingParams(res, api, startedAt, missing);

            const octokit = new Octokit({
                auth: token
            });

            const { owner, repo, path, message, content } = req.body;

            // Step 1: Add the new file
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

            // Step 2: Update index.json
            await manageIndexFile(octokit, owner, repo, path, 'index', 'update', content);

            const rateLimit = extractRateLimit(response);
            logRequest({ api, status: 200, startedAt, rateLimit });
            res.status(200).json({
                data: response.data,
                status: response.status,
                rateLimit
            });
        } catch (error) {
            return sendError(res, api, startedAt, error);
        }
    }

    if (api === 'updateFile') {
        try {
            if (req.method !== 'POST') return res.status(405).json({error: 'Method Not Allowed'});

            const token = extractToken(req);
            if (!token) return sendUnauthorized(res, api, startedAt);

            const missing = missingParams(req.body, ['owner', 'repo', 'path', 'message', 'content', 'sha']);
            if (missing.length) return sendMissingParams(res, api, startedAt, missing);

            const octokit = new Octokit({
                auth: token
            });

            const { owner, repo, path, message, content, sha } = req.body;

            const response = await octokit.request(`PUT /repos/{owner}/{repo}/contents/{path}`, {
                owner,
                repo,
                path,
                message,
                content,
                sha,
                headers: {
                  'X-GitHub-Api-Version': '2022-11-28'
                }
            });

            // Step 2: Update index.json
            if (path !== 'config.json') {
                await manageIndexFile(octokit, owner, repo, path, 'index', 'update', content);
            }

            const rateLimit = extractRateLimit(response);
            logRequest({ api, status: 200, startedAt, rateLimit });
            res.status(200).json({
                data: response.data,
                status: response.status,
                rateLimit
            });
        } catch (error) {
            return sendError(res, api, startedAt, error);
        }
    }

    if (api === 'getRepo') {
        try {
            if (req.method !== 'GET') return res.status(405).json({error: 'Method Not Allowed'});

            const token = extractToken(req);
            if (!token) return sendUnauthorized(res, api, startedAt);

            const missing = missingParams(req.query, ['owner', 'repo']);
            if (missing.length) return sendMissingParams(res, api, startedAt, missing);

            const octokit = new Octokit({
                auth: token
            });

            const { owner, repo } = req.query;

            const response = await octokit.request('GET /repos/{owner}/{repo}/zipball/{ref}', {
                owner,
                repo,
                headers: {
                  'X-GitHub-Api-Version': '2022-11-28'
                }
            });

            const zipData = Buffer.from(response.data);

            logRequest({ api, status: 200, startedAt, rateLimit: extractRateLimit(response) });
            res.set('Content-Type', 'application/zip');
            res.status(200).send(zipData);
        } catch (error) {
            return sendError(res, api, startedAt, error);
        }
    }

    if (api === 'searchFiles') {
        try {
            if (req.method !== 'GET') return res.status(405).json({error: 'Method Not Allowed'});

            const token = extractToken(req);
            if (!token) return sendUnauthorized(res, api, startedAt);

            const missing = missingParams(req.query, ['owner', 'repo', 'query']);
            if (missing.length) return sendMissingParams(res, api, startedAt, missing);

            const { owner, repo, query } = req.query;

            const octokit = new Octokit({
                auth: token
            });

            // Use GitHub Search API to find JSON files containing the query term
            const searchQuery = `${query} in:file extension:json repo:${owner}/${repo}`;
            
            const searchResponse = await octokit.request('GET /search/code', {
                q: searchQuery,
                per_page: 100, // Maximum allowed by GitHub
                headers: {
                    'X-GitHub-Api-Version': '2022-11-28'
                }
            });

            // Filter out reference/index files and extract file paths and relevant information
            const matchingFiles = searchResponse.data.items
                .filter(item => {
                    // Exclude index.json and config.json files
                    const fileName = item.name.toLowerCase();
                    const queryFileName = `${query.toLowerCase()}.json`;

                    return !['index.json', 'config.json'].includes(fileName) &&
                           fileName !== queryFileName; // Exclude the file that matches the query itself
                })
                .map(item => ({
                    path: item.path,
                    name: item.name,
                    sha: item.sha,
                    url: item.html_url,
                    score: item.score,
                    repository: item.repository.full_name
                }));

            const rateLimit = extractRateLimit(searchResponse, 30); // Search API limit is 30/min

            logRequest({ api, status: 200, startedAt, rateLimit });
            res.status(200).json({
                query: query,
                totalCount: searchResponse.data.total_count,
                incomplete_results: searchResponse.data.incomplete_results,
                files: matchingFiles,
                rateLimit
            });

        } catch (error) {
            return sendError(res, api, startedAt, error);
        }
    }

    if (api === 'getUserRepositories') {
        try {
            if (req.method !== 'GET') return res.status(405).json({error: 'Method Not Allowed'});

            const token = extractToken(req);
            if (!token) return sendUnauthorized(res, api, startedAt);

            const octokit = new Octokit({
                auth: token
            });

            const response = await octokit.request('GET /user/repos', {
                affiliation: 'owner, collaborator',
                per_page: 100,
                headers: {
                  'X-GitHub-Api-Version': '2022-11-28'
                }
            });
            
            const rateLimit = extractRateLimit(response);
            logRequest({ api, status: 200, startedAt, rateLimit });
            res.status(200).json({
                data: response.data,
                status: response.status,
                rateLimit
            });
        }
        catch (error) {
            return sendError(res, api, startedAt, error);
        }
    }

    if (api === 'getFiles') {
        try {
            if (req.method !== 'GET') return res.status(405).json({error: 'Method Not Allowed'});

            const token = extractToken(req);
            if (!token) return sendUnauthorized(res, api, startedAt);

            const missing = missingParams(req.query, ['owner', 'repo', 'path']);
            if (missing.length) return sendMissingParams(res, api, startedAt, missing);

            const octokit = new Octokit({
                auth: token
            });

            const { owner, repo, path } = req.query;

            const response = await octokit.request(`GET /repos/{owner}/{repo}/contents/{path}`, {
                owner,
                repo,
                path,
                headers: {
                  'X-GitHub-Api-Version': '2022-11-28'
                }
            });

            const rateLimit = extractRateLimit(response);
            logRequest({ api, status: 200, startedAt, rateLimit });
            res.status(200).json({
                data: response.data,
                status: response.status,
                rateLimit
            });
        } catch (error) {
            // A genuinely absent path is an empty repository; every other failure must surface
            if (error.status === 404) {
                logRequest({ api, status: 200, startedAt, error: 'Path not found - treated as empty' });
                return res.status(200).json({
                    data: [],
                    status: 200,
                    message: 'Path not found - empty repository or file does not exist'
                });
            }

            return sendError(res, api, startedAt, error);
        }
    }

    if (api === 'deleteFile') {
        try {
            if (req.method !== 'POST') return res.status(405).json({error: 'Method Not Allowed'});

            const token = extractToken(req);
            if (!token) return sendUnauthorized(res, api, startedAt);

            const missing = missingParams(req.body, ['owner', 'repo', 'path', 'message', 'sha']);
            if (missing.length) return sendMissingParams(res, api, startedAt, missing);

            const octokit = new Octokit({
                auth: token
            });

            const { owner, repo, path, message, sha } = req.body;

            const response = await octokit.request(`DELETE /repos/{owner}/{repo}/contents/{path}`, {
                owner,
                repo,
                path,
                message,
                sha,
                headers: {
                  'X-GitHub-Api-Version': '2022-11-28'
                }
            });

            // Step 2: Update index files
            await manageIndexFile(octokit, owner, repo, path, 'index', 'remove');

            const rateLimit = extractRateLimit(response);
            logRequest({ api, status: 200, startedAt, rateLimit });
            res.status(200).json({
                data: response.data,
                status: response.status,
                rateLimit
            });
        } catch (error) {
            return sendError(res, api, startedAt, error);
        }
    }

    if (api === 'getConcept') {
        if (req.method !== 'GET') return res.status(405).json({error: 'Method Not Allowed'});

        const token = extractToken(req);
        if (!token) return sendUnauthorized(res, api, startedAt);

        const conceptMissing = missingParams(req.query, ['owner', 'repo', 'path']);
        if (conceptMissing.length) return sendMissingParams(res, api, startedAt, conceptMissing);

        const { owner, repo, path } = req.query;

        try {
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


            // get keys from response file json
            const file = Buffer.from(response.data.content, 'base64').toString('utf-8');
            const content = JSON.parse(file);
            const keys = Object.keys(content);

            let flag = true;
            let conceptID;

            while (flag) {
                conceptID = generateConceptID();
                if (!keys.includes(conceptID.toString())) {
                    flag = false;
                }
            }

            logRequest({ api, status: 200, startedAt, rateLimit: extractRateLimit(response) });
            res.status(200).json({ conceptID });
        } catch (error) {
            if (error.status === 404) {

                const content = JSON.stringify({}, null, 2);
                await createFile(token, owner, repo, path, toBase64(content), 'Create index file');

                const conceptID = generateConceptID();
                logRequest({ api, status: 200, startedAt, error: 'Index missing - created' });
                return res.status(200).json({ conceptID });
            }
            
            return sendError(res, api, startedAt, error);
        }
    }

    if (api === 'getConfig') {
        if (req.method !== 'GET') return res.status(405).json({error: 'Method Not Allowed'});

        const token = extractToken(req);
        if (!token) return sendUnauthorized(res, api, startedAt);

        const configMissing = missingParams(req.query, ['owner', 'repo', 'path']);
        if (configMissing.length) return sendMissingParams(res, api, startedAt, configMissing);

        const { owner, repo, path } = req.query;

        try {
            const response = await getFile(token, owner, repo, path);

            logRequest({ api, status: 200, startedAt, rateLimit: extractRateLimit(response) });
            res.status(200).json({ data: response.data, status: response.status });
        } catch (error) {

            if (error.status === 404) {

                const content = JSON.stringify(getBaseConfig(), null, 2);
                const fileResponse = await createFile(token, owner, repo, path, toBase64(content), 'Create config file');
                logRequest({ api, status: 200, startedAt, error: 'Config missing - created' });
                return res.status(200).json({ data: fileResponse.data, status: fileResponse.status });
            }
            
            return sendError(res, api, startedAt, error);
        }
    }
}

module.exports = {
    ghauth
}