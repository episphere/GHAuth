const { setHeaders, fetchSecrets, generateConceptID, manageIndexFile, rebuildIndex } = require('./shared');
const { Octokit } = require('octokit');

// Helper function to extract rate limit information from GitHub API responses
const extractRateLimit = (response, defaultLimit = 5000) => {
    return {
        limit: parseInt(response.headers['x-ratelimit-limit']) || defaultLimit,
        remaining: parseInt(response.headers['x-ratelimit-remaining']) || 0,
        reset: new Date(parseInt(response.headers['x-ratelimit-reset']) * 1000),
        resetIn: parseInt(response.headers['x-ratelimit-reset']) - Math.floor(Date.now() / 1000)
    };
};

const ghauth = async (req, res) => {
    setHeaders(res);
    
    if(req.method === 'OPTIONS') return res.status(200).json({code: 200});

    const api = req.query.api;
    console.log(`API: ${api}`);

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
        'getConfig',
        'rebuildIndex'
    ];

    // Early validation for invalid API endpoints
    if (!validEndpoints.includes(api)) {
        return res.status(400).json({
            error: 'Invalid API endpoint',
            message: `API endpoint '${api}' is not supported`,
            supportedEndpoints: validEndpoints
        });
    }

    if (api === 'accessToken') {
        try {
            if (req.method !== 'POST') return res.status(405).json({error: 'Method Not Allowed'});

            const environment = req.query.environment;
            const local = environment === 'dev' ? true : false;

            console.log(`Local Development: ${environment}`);

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
            res.status(200).json(response);

        } catch (error) {
            console.error('Error:', error);
            res.status(500).json({error: 'Internal Server Error'});
        }
    }

    if (api === 'getUser') {
        try {
            if (req.method !== 'GET') return res.status(405).json({error: 'Method Not Allowed'});

            const token = req.headers.authorization.replace('Bearer','').trim();

            const octokit = new Octokit({
                auth: token
            });

            const response = await octokit.request('GET /user');
            
            res.status(200).json({
                ...response,
                rateLimit: extractRateLimit(response)
            });
        } catch (error) {
            console.error('Error:', error);
            res.status(500).json({error: 'Internal Server Error'});
        }
    }

    if (api === 'addFile') {
        try {
            if (req.method !== 'POST') return res.status(405).json({error: 'Method Not Allowed'});

            const token = req.headers.authorization.replace('Bearer','').trim();

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

            // If file is '.gitkeep' then don't update index.json
            if (!path.endsWith('.gitkeep')) {
                // Step 2: Update index.json
                await manageIndexFile(octokit, owner, repo, path, 'index', 'update', content);
            }

            res.status(200).json(response);
        } catch (error) {
            console.error('Error:', error);
            res.status(500).json({error: 'Internal Server Error'});
        }
    }

    if (api === 'updateFile') {
        try {
            if (req.method !== 'POST') return res.status(405).json({error: 'Method Not Allowed'});

            const token = req.headers.authorization.replace('Bearer','').trim();

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

            res.status(200).json(response);
        } catch (error) {
            console.error('Error:', error);
            res.status(500).json({error: 'Internal Server Error'});
        }
    }

    if (api === 'getRepo') {
        try {
            if (req.method !== 'GET') return res.status(405).json({error: 'Method Not Allowed'});

            const token = req.headers.authorization.replace('Bearer','').trim();

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

            res.set('Content-Type', 'application/zip');
            res.status(200).send(zipData);
        } catch (error) {
            console.error('Error:', error);
            res.status(500).json({error: 'Internal Server Error'});
        }
    }

    if (api === 'searchFiles') {
        try {
            if (req.method !== 'GET') return res.status(405).json({error: 'Method Not Allowed'});

            const token = req.headers.authorization.replace('Bearer','').trim();
            const { owner, repo, query } = req.query;

            if (!query) {
                return res.status(400).json({error: 'Query parameter is required'});
            }

            const octokit = new Octokit({
                auth: token
            });

            console.log(`Searching for files in ${owner}/${repo} with query: ${query}`);

            // Use GitHub Search API to find JSON files containing the query term
            const searchQuery = `${query} in:file extension:json repo:${owner}/${repo}`;
            
            console.log(`GitHub search query: ${searchQuery}`);
            
            const searchResponse = await octokit.request('GET /search/code', {
                q: searchQuery,
                per_page: 100, // Maximum allowed by GitHub
                headers: {
                    'X-GitHub-Api-Version': '2022-11-28'
                }
            });

            console.log(`GitHub API returned ${searchResponse.data.total_count} total results`);
            console.log(`Incomplete results: ${searchResponse.data.incomplete_results}`);
            console.log(`Items in response: ${searchResponse.data.items.length}`);

            // Filter out reference/index files and extract file paths and relevant information
            const matchingFiles = searchResponse.data.items
                .filter(item => {
                    // Exclude index.json and config.json files
                    const fileName = item.name.toLowerCase();
                    const queryFileName = `${query.toLowerCase()}.json`;

                    const shouldInclude = !['index.json', 'config.json'].includes(fileName) &&
                           fileName !== queryFileName; // Exclude the file that matches the query itself
                    
                    if (!shouldInclude) {
                        console.log(`Filtering out file: ${fileName}`);
                    }
                    
                    return shouldInclude;
                })
                .map(item => ({
                    path: item.path,
                    name: item.name,
                    sha: item.sha,
                    url: item.html_url,
                    score: item.score,
                    repository: item.repository.full_name
                }));

            console.log(`After filtering: ${matchingFiles.length} files`);

            res.status(200).json({
                query: query,
                totalCount: searchResponse.data.total_count,
                incomplete_results: searchResponse.data.incomplete_results,
                files: matchingFiles,
                rateLimit: extractRateLimit(searchResponse, 30) // Search API limit is 30/min
            });

        } catch (error) {
            console.error('Error:', error);
            
            // Handle specific GitHub API errors
            if (error.status === 403) {
                res.status(403).json({
                    error: 'Rate limit exceeded or insufficient permissions',
                    message: 'GitHub Search API has strict rate limits. Try again later.'
                });
            } else if (error.status === 422) {
                res.status(422).json({
                    error: 'Invalid search query',
                    message: 'The search query format is invalid or too complex.'
                });
            } else {
                res.status(500).json({error: 'Internal Server Error'});
            }
        }
    }

    if (api === 'getUserRepositories') {
        try {
            if (req.method !== 'GET') return res.status(405).json({error: 'Method Not Allowed'});

            const token = req.headers.authorization.replace('Bearer','').trim();

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
            
            res.status(200).json({
                ...response,
                rateLimit: extractRateLimit(response)
            });
        }
        catch (error) {
            console.error('Error:', error);
            res.status(500).json({error: 'Internal Server Error'});
        }
    }

    if (api === 'getFiles') {
        try {
            if (req.method !== 'GET') return res.status(405).json({error: 'Method Not Allowed'});

            const token = req.headers.authorization.replace('Bearer','').trim();

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

            res.status(200).json({
                ...response,
                rateLimit: extractRateLimit(response)
            });
        } catch (error) {
            console.error('Error in getFiles:', error);

            // Handle 404 - path doesn't exist (empty repo or missing directory)
            if (error.status === 404) {
                console.log(`Path not found: ${req.query.path} - returning empty array`);
                return res.status(200).json({
                    data: [],
                    status: 200,
                    headers: {},
                    message: 'Path not found - empty repository or directory does not exist'
                });
            }

            // Handle 403 - permission denied
            if (error.status === 403) {
                return res.status(403).json({
                    error: 'Permission denied',
                    message: 'You do not have access to this repository or path'
                });
            }

            // Handle other errors
            res.status(500).json({
                error: 'Internal Server Error',
                message: error.message
            });
        }
    }

    if (api === 'deleteFile') {
        try {
            if (req.method !== 'POST') return res.status(405).json({error: 'Method Not Allowed'});

            const token = req.headers.authorization.replace('Bearer','').trim();

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

            res.status(200).json(response);
        } catch (error) {
            console.error('Error:', error);
            res.status(500).json({error: 'Internal Server Error'});
        }
    }

    if (api === 'getConcept') {
        const token = req.headers.authorization.replace('Bearer','').trim();
        const { owner, repo, path } = req.query;

        try {
            if (req.method !== 'GET') return res.status(405).json({error: 'Method Not Allowed'});

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

            res.status(200).json({ conceptID });
        } catch (error) {
            if (error.status === 404) {

                const { createFile, getBaseConfig, toBase64 } = require('./shared');
                const content = JSON.stringify({}, null, 2);
                await createFile(token, owner, repo, path, toBase64(content), 'Create index file');

                const conceptID = generateConceptID();
                return res.status(200).json({ conceptID });
            }
            
            console.error('Error:', error);
            res.status(500).json({error: 'Internal Server Error'});
        }
    }

    if (api === 'getConfig') {
        const token = req.headers.authorization.replace('Bearer','').trim();
        const { owner, repo, path } = req.query;

        try {
            if (req.method !== 'GET') return res.status(405).json({error: 'Method Not Allowed'});

            const { getFile } = require('./shared');
            const response = await getFile(token, owner, repo, path);

            res.status(200).json(response);
        } catch (error) {

            if (error.status === 404) {

                const { createFile, getBaseConfig, toBase64 } = require('./shared');
                const content = JSON.stringify(getBaseConfig(), null, 2);
                const fileResponse = await createFile(token, owner, repo, path, toBase64(content), 'Create config file');
                return res.status(200).json(fileResponse);
            }
            
            console.error('Error:', error);
            res.status(500).json({error: 'Internal Server Error'});
        }
    }

    if (api === 'rebuildIndex') {
        try {
            if (req.method !== 'POST') return res.status(405).json({error: 'Method Not Allowed'});

            const token = req.headers.authorization.replace('Bearer','').trim();
            const { owner, repo, branch } = req.body;

            const octokit = new Octokit({
                auth: token
            });

            console.log(`Rebuilding index for ${owner}/${repo}${branch ? ` on branch ${branch}` : ''}`);

            const result = await rebuildIndex(octokit, owner, repo, branch || 'main');

            res.status(200).json(result);

        } catch (error) {
            console.error('Error rebuilding index:', error);
            
            if (error.status === 404) {
                res.status(404).json({
                    error: 'Repository or branch not found',
                    message: 'Could not find the specified repository or branch'
                });
            } else if (error.status === 403) {
                res.status(403).json({
                    error: 'Permission denied',
                    message: 'You do not have permission to access this repository'
                });
            } else {
                res.status(500).json({
                    error: 'Internal Server Error',
                    message: error.message
                });
            }
        }
    }
}

module.exports = {
    ghauth
}