const { setHeaders, fetchSecrets, updateIndexFile, removeFromIndexFile, generateConceptID } = require('./shared');
const { Octokit } = require('octokit');

const ghauth = async (req, res) => {
    setHeaders(res);
    
    if(req.method === 'OPTIONS') return res.status(200).json({code: 200});

    const api = req.query.api;
    console.log(`API: ${api}`);

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
            res.status(200).json(response);
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
                await updateIndexFile(octokit, owner, repo, path, content, 'index');
                await updateIndexFile(octokit, owner, repo, path, content, 'object');
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
            await updateIndexFile(octokit, owner, repo, path, content);

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
            res.status(200).json(response);
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

            res.status(200).json(response);
        } catch (error) {
            console.error('Error:', error);
            res.status(500).json({error: 'Internal Server Error'});
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

            // Step 2: Update index.json
            await removeFromIndexFile(octokit, owner, repo, path);

            res.status(200).json(response);
        } catch (error) {
            console.error('Error:', error);
            res.status(500).json({error: 'Internal Server Error'});
        }
    }

    if (api === 'getConcept') {
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
            console.error('Error:', error);
            res.status(500).json({error: 'Internal Server Error'});
        }
    }

    if (api === 'getConfig') {
        try {
            if (req.method !== 'GET') return res.status(405).json({error: 'Method Not Allowed'});

            const token = req.headers.authorization.replace('Bearer','').trim();
            const { owner, repo, path } = req.query;
            
            const response = await getFile(token, owner, repo, path);

            console.log('Config file response:', response);

            res.status(200);
        } catch (error) {
            console.error('Error:', error);
            res.status(500).json({error: 'Internal Server Error'});
        }
    }
}

module.exports = {
    ghauth
}