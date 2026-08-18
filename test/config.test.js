const test = require('node:test');
const assert = require('node:assert');

const { getBaseConfig } = require('../domain/config');

const CONCEPT_TYPES = ['PRIMARY', 'SECONDARY', 'SOURCE', 'QUESTION', 'RESPONSE'];

test('getBaseConfig defines every concept type the tool renders', () => {
    assert.deepStrictEqual(Object.keys(getBaseConfig()).sort(), [...CONCEPT_TYPES].sort());
});

test('every concept type requires a conceptId and a key', () => {
    for (const [type, fields] of Object.entries(getBaseConfig())) {
        const required = fields.filter(field => field.required).map(field => field.id);

        assert.ok(required.includes('conceptId'), `${type} must require conceptId`);
        assert.ok(required.includes('key'), `${type} must require key`);
    }
});

test('every reference field points at a concept type that exists', () => {
    for (const [type, fields] of Object.entries(getBaseConfig())) {
        for (const field of fields.filter(field => field.type === 'reference')) {
            assert.ok(
                CONCEPT_TYPES.includes(field.referencesType),
                `${type}.${field.id} references unknown type ${field.referencesType}`
            );
        }
    }
});

test('field ids are unique within a concept type', () => {
    for (const [type, fields] of Object.entries(getBaseConfig())) {
        const ids = fields.map(field => field.id);
        assert.strictEqual(new Set(ids).size, ids.length, `${type} has duplicate field ids`);
    }
});

test('getBaseConfig returns a fresh object each call so callers cannot mutate the default', () => {
    const first = getBaseConfig();
    first.PRIMARY.push({ id: 'injected' });

    assert.strictEqual(getBaseConfig().PRIMARY.length, 2);
});
