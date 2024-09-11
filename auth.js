const { setHeaders, fetchSecrets } = require('./shared');
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

    if (api === 'createFile') {
        try {
            if (req.method !== 'POST') return res.status(405).json({error: 'Method Not Allowed'});

            const token = req.headers.authorization.replace('Bearer','').trim();

            const octokit = new Octokit({
                auth: token
            });

            const { owner, repo, path, message, content, sha } = req.body;
            console.log(`Owner: ${owner}`);
            console.log(`Repo: ${repo}`);
            console.log(`Path: ${path}`);
            console.log(`Message: ${message}`);
            console.log(`Content: ${content}`);

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

            res.status(200).json(response);
        } catch (error) {
            console.error('Error:', error);
            res.status(500).json({error: 'Internal Server Error'});
        }
    }
    
}

module.exports = {
    ghauth
}