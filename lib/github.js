const { Octokit } = require('octokit');

const API_VERSION = '2022-11-28';

const createClient = (token) => new Octokit({ auth: token });

const getFile = async (token, owner, repo, path) => {
    return createClient(token).request('GET /repos/{owner}/{repo}/contents/{path}', {
        owner,
        repo,
        path,
        headers: {
            'X-GitHub-Api-Version': API_VERSION
        }
    });
};

const createFile = async (token, owner, repo, path, content, message) => {
    return createClient(token).request('PUT /repos/{owner}/{repo}/contents/{path}', {
        owner,
        repo,
        path,
        message,
        content,
        headers: {
            'X-GitHub-Api-Version': API_VERSION
        }
    });
};

// The Contents API accepts file bodies only as base64.
const toBase64 = (string) => Buffer.from(string, 'utf-8').toString('base64');

module.exports = {
    API_VERSION,
    createClient,
    getFile,
    createFile,
    toBase64
};
