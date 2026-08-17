const test = require('node:test');
const assert = require('node:assert');

const {
    emptyIndex,
    normalizeIndex,
    applyUpdate,
    applyRemoval,
    finalizeIndex,
    baseName
} = require('../domain/indexFile');

test('normalizeIndex returns an empty index for missing content', () => {
    const index = normalizeIndex(null);

    assert.deepStrictEqual(index._files, {});
    assert.strictEqual(index._metadata.version, '2.0');
});

test('normalizeIndex migrates the legacy {filename: key} form', () => {
    const index = normalizeIndex({ '123456789.json': 'smoking_status' });

    assert.deepStrictEqual(index._files['123456789.json'], { key: 'smoking_status', object_type: '' });
    assert.deepStrictEqual(index._search.by_key['smoking_status'], ['123456789.json']);
});

test('normalizeIndex backfills missing sections without discarding entries', () => {
    const index = normalizeIndex({ _files: { 'a.json': { key: 'a', object_type: 'PRIMARY' } } });

    assert.deepStrictEqual(index._files['a.json'], { key: 'a', object_type: 'PRIMARY' });
    assert.deepStrictEqual(index._search.by_key, {});
});

test('applyUpdate records a concept in both search buckets', () => {
    const index = applyUpdate(emptyIndex(), '1.json', { key: 'age', object_type: 'QUESTION' });

    assert.deepStrictEqual(index._files['1.json'], { key: 'age', object_type: 'QUESTION' });
    assert.deepStrictEqual(index._search.by_key['age'], ['1.json']);
    assert.deepStrictEqual(index._search.by_type['QUESTION'], ['1.json']);
});

test('applyUpdate clears stale buckets when a concept is renamed', () => {
    const index = applyUpdate(emptyIndex(), '1.json', { key: 'old', object_type: 'QUESTION' });
    applyUpdate(index, '1.json', { key: 'new', object_type: 'RESPONSE' });

    assert.strictEqual(index._search.by_key['old'], undefined);
    assert.strictEqual(index._search.by_type['QUESTION'], undefined);
    assert.deepStrictEqual(index._search.by_key['new'], ['1.json']);
    assert.deepStrictEqual(index._search.by_type['RESPONSE'], ['1.json']);
});

test('applyUpdate keeps a shared key bucket intact when one file leaves it', () => {
    const index = emptyIndex();
    applyUpdate(index, '1.json', { key: 'yes', object_type: 'RESPONSE' });
    applyUpdate(index, '2.json', { key: 'yes', object_type: 'RESPONSE' });

    applyUpdate(index, '1.json', { key: 'no', object_type: 'RESPONSE' });

    assert.deepStrictEqual(index._search.by_key['yes'], ['2.json']);
    assert.deepStrictEqual(index._search.by_key['no'], ['1.json']);
});

test('applyUpdate tolerates a concept with no key or type', () => {
    const index = applyUpdate(emptyIndex(), '1.json', {});

    assert.deepStrictEqual(index._files['1.json'], { key: '', object_type: '' });
    assert.deepStrictEqual(index._search.by_key, {});
});

test('applyRemoval deletes the entry and empties its buckets', () => {
    const index = applyUpdate(emptyIndex(), '1.json', { key: 'age', object_type: 'QUESTION' });
    applyRemoval(index, '1.json');

    assert.strictEqual(index._files['1.json'], undefined);
    assert.strictEqual(index._search.by_key['age'], undefined);
    assert.strictEqual(index._search.by_type['QUESTION'], undefined);
});

test('applyRemoval is a no-op for an unknown file', () => {
    const index = applyUpdate(emptyIndex(), '1.json', { key: 'age', object_type: 'QUESTION' });
    applyRemoval(index, 'missing.json');

    assert.deepStrictEqual(Object.keys(index._files), ['1.json']);
});

test('finalizeIndex recounts files', () => {
    const index = emptyIndex();
    applyUpdate(index, '1.json', { key: 'a', object_type: 'PRIMARY' });
    applyUpdate(index, '2.json', { key: 'b', object_type: 'PRIMARY' });
    finalizeIndex(index);

    assert.strictEqual(index._metadata.total_files, 2);
});

test('baseName strips any directory component', () => {
    assert.strictEqual(baseName('123.json'), '123.json');
    assert.strictEqual(baseName('nested/dir/123.json'), '123.json');
});
