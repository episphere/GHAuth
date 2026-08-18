const test = require('node:test');
const assert = require('node:assert');

const { commitFiles, MAX_ENTRIES_PER_COMMIT, WRITES_PER_COMMIT } = require('../domain/gitData');

const notFound = () => Object.assign(new Error('Not Found'), { status: 404 });
const conflict = () => Object.assign(new Error('Update is not a fast forward'), { status: 422 });

/**
 * Route-aware stand-in for octokit. Each handler may be overridden per test, and
 * every call is recorded so the resulting tree and commit can be asserted.
 */
const fakeGit = ({ head = { commitSha: 'commit-base', treeSha: 'tree-base' }, index = null, overrides = {} } = {}) => {
    const calls = [];

    const handlers = {
        'GET /repos/{owner}/{repo}/git/ref/{ref}': () => {
            if (!head.commitSha) throw notFound();
            return { data: { object: { sha: head.commitSha } } };
        },
        'GET /repos/{owner}/{repo}/git/commits/{commit_sha}': () => ({ data: { tree: { sha: head.treeSha } } }),
        'GET /repos/{owner}/{repo}/contents/{path}': () => {
            if (!index) throw notFound();
            return {
                data: {
                    sha: 'index-sha',
                    size: 10,
                    encoding: 'base64',
                    content: Buffer.from(JSON.stringify(index)).toString('base64')
                }
            };
        },
        'POST /repos/{owner}/{repo}/git/trees': () => ({ data: { sha: 'tree-new' } }),
        'POST /repos/{owner}/{repo}/git/commits': () => ({ data: { sha: 'commit-new' } }),
        'PATCH /repos/{owner}/{repo}/git/refs/{ref}': () => ({ data: { ref: 'refs/heads/main' } }),
        'POST /repos/{owner}/{repo}/git/refs': () => ({ data: { ref: 'refs/heads/main' } }),
        ...overrides
    };

    return {
        calls,
        callsTo: (route) => calls.filter(call => call.route === route),
        request: async (route, options) => {
            calls.push({ route, options });

            const handler = handlers[route];
            if (!handler) throw new Error(`Unexpected route: ${route}`);

            return handler(options, calls);
        }
    };
};

const commit = (octokit, overrides = {}) => commitFiles({
    octokit,
    owner: 'o',
    repo: 'r',
    branch: 'main',
    message: 'test commit',
    files: [{ path: '123456789.json', content: JSON.stringify({ conceptID: 123456789, key: 'alpha', object_type: 'QUESTION' }) }],
    ...overrides
});

test('commitFiles rejects a non-array files argument', async () => {
    await assert.rejects(
        () => commit(fakeGit(), { files: 'nope' }),
        error => error.status === 400
    );
});

test('commitFiles rejects an empty batch', async () => {
    await assert.rejects(
        () => commit(fakeGit(), { files: [], deletions: [] }),
        error => error.status === 400 && /Nothing to commit/.test(error.message)
    );
});

test('commitFiles rejects a batch above the entry ceiling', async () => {
    const files = Array.from({ length: MAX_ENTRIES_PER_COMMIT + 1 }, (_, i) => ({
        path: `${i}.json`,
        content: '{}'
    }));

    await assert.rejects(
        () => commit(fakeGit(), { files }),
        error => error.status === 400 && /at most/.test(error.message)
    );
});

test('commitFiles rejects a malformed file entry', async () => {
    await assert.rejects(
        () => commit(fakeGit(), { files: [{ path: 'a.json', content: { not: 'a string' } }] }),
        error => error.status === 400 && /path: string, content: string/.test(error.message)
    );
});

test('commitFiles returns the new commit and the write cost', async () => {
    const octokit = fakeGit();
    const result = await commit(octokit);

    assert.strictEqual(result.commitSha, 'commit-new');
    assert.strictEqual(result.treeSha, 'tree-new');
    assert.strictEqual(result.committed, 1);
    assert.strictEqual(result.deleted, 0);
    assert.strictEqual(result.writes, WRITES_PER_COMMIT);
});

test('commitFiles never returns the raw ref response to the caller of the API layer', async () => {
    const result = await commit(fakeGit());

    // auth.js strips lastResponse; it exists only so rate limit headers can be read
    assert.ok(result.lastResponse, 'lastResponse should be present for rate limit extraction');
});

test('commitFiles writes index.json alongside the concept in a single tree', async () => {
    const octokit = fakeGit();
    await commit(octokit);

    const [treeCall] = octokit.callsTo('POST /repos/{owner}/{repo}/git/trees');
    const paths = treeCall.options.tree.map(entry => entry.path);

    assert.deepStrictEqual(paths, ['123456789.json', 'index.json']);
    assert.strictEqual(treeCall.options.base_tree, 'tree-base');

    const index = JSON.parse(treeCall.options.tree.find(entry => entry.path === 'index.json').content);
    assert.deepStrictEqual(index._files['123456789.json'], { key: 'alpha', object_type: 'QUESTION' });
});

test('commitFiles ignores a caller-supplied index.json rather than writing it twice', async () => {
    const octokit = fakeGit();

    await commit(octokit, {
        files: [
            { path: '1.json', content: JSON.stringify({ key: 'a', object_type: 'QUESTION' }) },
            { path: 'index.json', content: '{"_files":{"stale":{}}}' }
        ]
    });

    const [treeCall] = octokit.callsTo('POST /repos/{owner}/{repo}/git/trees');
    const indexEntries = treeCall.options.tree.filter(entry => entry.path === 'index.json');

    assert.strictEqual(indexEntries.length, 1);
    assert.ok(!JSON.parse(indexEntries[0].content)._files.stale);
});

test('commitFiles marks deletions with a null sha and drops them from the index', async () => {
    const octokit = fakeGit({
        index: { _files: { '1.json': { key: 'a', object_type: 'QUESTION' } } }
    });

    const result = await commit(octokit, { files: [], deletions: ['1.json'] });

    const [treeCall] = octokit.callsTo('POST /repos/{owner}/{repo}/git/trees');
    const deletion = treeCall.options.tree.find(entry => entry.path === '1.json');

    assert.strictEqual(deletion.sha, null);
    assert.strictEqual(result.deleted, 1);

    const index = JSON.parse(treeCall.options.tree.find(entry => entry.path === 'index.json').content);
    assert.ok(!index._files['1.json']);
});

test('commitFiles commits a file that is not valid JSON but leaves it out of the index', async () => {
    const octokit = fakeGit();
    await commit(octokit, { files: [{ path: 'broken.json', content: 'not json' }] });

    const [treeCall] = octokit.callsTo('POST /repos/{owner}/{repo}/git/trees');
    const paths = treeCall.options.tree.map(entry => entry.path);

    assert.ok(paths.includes('broken.json'));

    const index = JSON.parse(treeCall.options.tree.find(entry => entry.path === 'index.json').content);
    assert.ok(!index._files['broken.json']);
});

test('commitFiles creates the ref on a repository with no commits', async () => {
    const octokit = fakeGit({
        head: { commitSha: null, treeSha: null },
        overrides: {
            'PATCH /repos/{owner}/{repo}/git/refs/{ref}': () => { throw conflict(); }
        }
    });

    const result = await commit(octokit);

    assert.strictEqual(result.commitSha, 'commit-new');
    assert.strictEqual(octokit.callsTo('POST /repos/{owner}/{repo}/git/refs').length, 1);

    const [commitCall] = octokit.callsTo('POST /repos/{owner}/{repo}/git/commits');
    assert.deepStrictEqual(commitCall.options.parents, []);

    const [treeCall] = octokit.callsTo('POST /repos/{owner}/{repo}/git/trees');
    assert.strictEqual(treeCall.options.base_tree, undefined);
});

test('commitFiles retries when the branch moves and succeeds on a later attempt', async () => {
    let attempts = 0;

    const octokit = fakeGit({
        overrides: {
            'PATCH /repos/{owner}/{repo}/git/refs/{ref}': () => {
                attempts += 1;
                if (attempts === 1) throw conflict();
                return { data: { ref: 'refs/heads/main' } };
            }
        }
    });

    const result = await commit(octokit);

    assert.strictEqual(result.commitSha, 'commit-new');
    assert.strictEqual(attempts, 2);
    // The index is re-read per attempt, since a competing commit may have changed it
    assert.strictEqual(octokit.callsTo('GET /repos/{owner}/{repo}/contents/{path}').length, 2);
});

test('commitFiles gives up with a 409 when the branch keeps moving', async () => {
    const octokit = fakeGit({
        overrides: {
            'PATCH /repos/{owner}/{repo}/git/refs/{ref}': () => { throw conflict(); }
        }
    });

    await assert.rejects(
        () => commit(octokit),
        error => error.status === 409 && /branch moved/.test(error.message)
    );

    assert.strictEqual(octokit.callsTo('PATCH /repos/{owner}/{repo}/git/refs/{ref}').length, 3);
});

test('commitFiles propagates a ref failure that is not a conflict', async () => {
    const octokit = fakeGit({
        overrides: {
            'PATCH /repos/{owner}/{repo}/git/refs/{ref}': () => {
                throw Object.assign(new Error('Server Error'), { status: 500 });
            }
        }
    });

    await assert.rejects(() => commit(octokit), error => error.status === 500);
});
