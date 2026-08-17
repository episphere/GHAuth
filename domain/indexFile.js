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

/**
 * Brings any stored index shape up to v2.0, migrating the legacy {filename: key} form.
 *
 * @param {Object|null} content - Parsed index.json, or null for a repository without one
 * @returns {Object} A v2.0 index safe to mutate
 */
const normalizeIndex = (content) => {
    if (!content || typeof content !== 'object') return emptyIndex();

    let index = content;

    if (!index._metadata && !index._files && !index._search) {
        console.log('Legacy index format detected, migrating to v2.0');

        const legacyContent = index;
        index = emptyIndex();

        // Legacy form carried no type information
        for (const [filename, key] of Object.entries(legacyContent)) {
            index._files[filename] = { key: key, object_type: '' };

            if (key) {
                if (!index._search.by_key[key]) index._search.by_key[key] = [];
                index._search.by_key[key].push(filename);
            }
        }

        return index;
    }

    if (!index._metadata) index._metadata = emptyIndex()._metadata;
    if (!index._files) index._files = {};
    if (!index._search) index._search = { by_key: {}, by_type: {} };
    if (!index._search.by_key) index._search.by_key = {};
    if (!index._search.by_type) index._search.by_type = {};

    return index;
};

const dropFromBucket = (bucket, value, fileName) => {
    if (!value || !bucket[value]) return;

    bucket[value] = bucket[value].filter(f => f !== fileName);
    if (bucket[value].length === 0) delete bucket[value];
};

const addToBucket = (bucket, value, fileName) => {
    if (!value) return;

    if (!bucket[value]) bucket[value] = [];
    if (!bucket[value].includes(fileName)) bucket[value].push(fileName);
};

/**
 * Records one concept file in the index, replacing any previous entry for that file.
 *
 * @param {Object} index - A normalized index, mutated in place
 * @param {string} fileName - Bare file name, no directory component
 * @param {Object} concept - Parsed concept object
 * @returns {Object} The same index
 */
const applyUpdate = (index, fileName, concept) => {
    const key = concept?.['key'] || '';
    const objectType = concept?.['object_type'] || '';

    const existing = index._files[fileName];
    if (existing) {
        dropFromBucket(index._search.by_key, existing.key, fileName);
        dropFromBucket(index._search.by_type, existing.object_type, fileName);
    }

    index._files[fileName] = { key: key, object_type: objectType };

    addToBucket(index._search.by_key, key, fileName);
    addToBucket(index._search.by_type, objectType, fileName);

    return index;
};

/**
 * Removes one concept file from the index.
 *
 * @param {Object} index - A normalized index, mutated in place
 * @param {string} fileName - Bare file name, no directory component
 * @returns {Object} The same index
 */
const applyRemoval = (index, fileName) => {
    const existing = index._files[fileName];
    if (!existing) return index;

    delete index._files[fileName];
    dropFromBucket(index._search.by_key, existing.key, fileName);
    dropFromBucket(index._search.by_type, existing.object_type, fileName);

    return index;
};

/**
 * Refreshes derived metadata. Call once after all updates and removals are applied.
 *
 * @param {Object} index - A normalized index, mutated in place
 * @returns {Object} The same index
 */
const finalizeIndex = (index) => {
    index._metadata.last_updated = new Date().toISOString();
    index._metadata.total_files = Object.keys(index._files).length;

    return index;
};

const baseName = (filePath) => filePath.substring(filePath.lastIndexOf('/') + 1);

/**
 * Reads and normalizes index.json.
 *
 * @returns {Promise<Object>} `{ index, sha }`; both null when the file does not exist yet
 */
const readIndex = async (octokit, owner, repo, indexPath = 'index.json') => {
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

        return { index: normalizeIndex(JSON.parse(data)), sha: response.data.sha };
    } catch (error) {
        if (error.status !== 404) throw error;

        return { index: null, sha: null };
    }
};

const manageIndexFile = async (octokit, owner, repo, filePath, fileType, operation, fileContent = null) => {
    try {
        const indexPath = `${fileType}.json`;

        const { index: storedIndex, sha } = await readIndex(octokit, owner, repo, indexPath);

        // Nothing to remove from an index that does not exist yet
        if (!storedIndex && operation === 'remove') return;

        const content = storedIndex || emptyIndex();
        const fileName = baseName(filePath);

        if (operation === 'update') {
            const fileData = Buffer.from(fileContent, 'base64').toString('utf-8');
            applyUpdate(content, fileName, JSON.parse(fileData));
        } else if (operation === 'remove') {
            applyRemoval(content, fileName);
        }

        finalizeIndex(content);

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
    manageIndexFile,
    emptyIndex,
    normalizeIndex,
    applyUpdate,
    applyRemoval,
    finalizeIndex,
    readIndex,
    baseName
};
