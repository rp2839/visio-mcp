import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';

// Probe-only contract check (I00). Validates the isolated spike envelope, not
// the production schema bundle that I10 will own.
const schema = JSON.parse(
  readFileSync(new URL('../contracts/envelope.schema.json', import.meta.url), 'utf8'),
);
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile(schema);

type Json = Record<string, unknown>;

// Fixed identities so failures are reproducible.
const validApplyFixture: Json = {
  protocolVersion: 1,
  kind: 'request',
  requestId: '6f1c2a3e-8b4d-4e5f-9a01-23456789abcd',
  method: 'doc.apply',
  documentId: '0b7e5c1a-2d3f-4a6b-8c9d-0e1f2a3b4c5d',
  sessionId: '9a8b7c6d-5e4f-4a3b-9c1d-0e2f4a6b8c0d',
  params: {
    transactionId: '3c2b1a09-8f7e-4d6c-b5a4-938271605f4e',
    baseRevision: 0,
    atomic: true,
    operations: [],
  },
};

function without(fixture: Json, key: string): Json {
  const copy = structuredClone(fixture);
  delete copy[key];
  return copy;
}

function withoutParam(fixture: Json, key: string): Json {
  const copy = structuredClone(fixture);
  delete (copy.params as Json)[key];
  return copy;
}

function withParam(fixture: Json, key: string, value: unknown): Json {
  const copy = structuredClone(fixture);
  (copy.params as Json)[key] = value;
  return copy;
}

function withAtomicFalse(fixture: Json): Json {
  return withParam(fixture, 'atomic', false);
}

describe('probe envelope schema', () => {
  it('accepts a well-formed doc.apply request', () => {
    expect(validate(validApplyFixture), JSON.stringify(validate.errors)).toBe(true);
  });

  it('rejects doc.apply without session or document scope', () => {
    expect(validate(without(validApplyFixture, 'sessionId'))).toBe(false);
    expect(validate(without(validApplyFixture, 'documentId'))).toBe(false);
  });

  it('rejects doc.apply without a UUID transaction ID', () => {
    expect(validate(withoutParam(validApplyFixture, 'transactionId'))).toBe(false);
    expect(validate(withParam(validApplyFixture, 'transactionId', 'tx-1'))).toBe(false);
  });

  it('rejects non-atomic or unspecified batches', () => {
    expect(validate(withAtomicFalse(validApplyFixture))).toBe(false);
    expect(validate(withoutParam(validApplyFixture, 'atomic'))).toBe(false);
  });

  it('rejects missing or negative base revisions', () => {
    expect(validate(withoutParam(validApplyFixture, 'baseRevision'))).toBe(false);
    expect(validate(withParam(validApplyFixture, 'baseRevision', -1))).toBe(false);
    expect(validate(withParam(validApplyFixture, 'baseRevision', 0.5))).toBe(false);
  });

  it('rejects scope duplicated inside params', () => {
    const sessionId = validApplyFixture.sessionId;
    expect(validate(withParam(validApplyFixture, 'sessionId', sessionId))).toBe(false);
  });

  it('rejects other protocol versions', () => {
    expect(validate({ ...validApplyFixture, protocolVersion: 2 })).toBe(false);
  });

  it('accepts optional page scope and opaque operation objects', () => {
    const fixture = withParam(
      withParam(validApplyFixture, 'pageId', '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a'),
      'operations',
      [{ op: 'element.create' }],
    );
    expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
  });

  it.each([
    ['non-UUID documentId', { ...validApplyFixture, documentId: 'doc-1' }],
    ['non-UUID sessionId', { ...validApplyFixture, sessionId: 'session-1' }],
    ['non-UUID pageId', withParam(validApplyFixture, 'pageId', 'page-1')],
    ['missing operations', withoutParam(validApplyFixture, 'operations')],
    ['non-array operations', withParam(validApplyFixture, 'operations', {})],
    ['non-request kind', { ...validApplyFixture, kind: 'response' }],
  ])('rejects doc.apply with %s', (_label, fixture) => {
    expect(validate(fixture)).toBe(false);
  });

  it('rejects conflicting scope inside params for any method', () => {
    const summary = {
      protocolVersion: 1,
      kind: 'request',
      requestId: '22222222-3333-4444-8555-666666666666',
      method: 'doc.summary',
      documentId: validApplyFixture.documentId,
      sessionId: validApplyFixture.sessionId,
      params: {},
    };
    expect(validate(summary), JSON.stringify(validate.errors)).toBe(true);
    const conflicting = { ...summary, params: { sessionId: '7e6d5c4b-3a29-4180-9f7e-6d5c4b3a2918' } };
    expect(validate(conflicting)).toBe(false);
  });

  it('accepts an unscoped app.hello handshake', () => {
    const hello = {
      protocolVersion: 1,
      kind: 'request',
      requestId: '11111111-2222-4333-8444-555555555555',
      method: 'app.hello',
      params: {},
    };
    expect(validate(hello), JSON.stringify(validate.errors)).toBe(true);
  });
});
