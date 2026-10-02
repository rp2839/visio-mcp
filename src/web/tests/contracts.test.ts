import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateDocument, validateEnvelope, validateMutationShape, validateOperations, toPoints } from '../src/model/validate';
import { parseDimension } from '../src/model/units';
import { seedDocument, ids, uuid } from './support/engine';

const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, '../../../contracts/fixtures', name), 'utf8'));

describe('schema and unit validation', () => {
  it('accepts one valid batch and the seed document', () => {
    expect(validateOperations([{ op: 'set', target: ids.shape, patch: { style: { stroke: '#333333' } } }]).ok).toBe(true);
    expect(validateDocument(seedDocument()).ok).toBe(true);
  });

  it('rejects unknown operation names and patch fields', () => {
    expect(validateOperations([{ op: 'explode', target: ids.shape }]).ok).toBe(false);
    expect(validateOperations([{ op: 'set', target: ids.shape, patch: { style: { glow: 3 } } }]).ok).toBe(false);
    expect(validateOperations([{ op: 'set', target: ids.shape, patch: { colour: '#fff' } }]).ok).toBe(false);
  });

  it('rejects NaN and Infinity', () => {
    const nan = validateOperations([{ op: 'move', target: ids.shape, delta: { xPt: NaN, yPt: 0 } }]);
    expect(nan.ok).toBe(false);
    const doc = seedDocument();
    doc.pages[0].elements[1].bounds.x = Infinity;
    expect(validateDocument(doc).ok).toBe(false);
  });

  it('rejects duplicate UUIDs and duplicate page aliases', () => {
    const dupId = seedDocument();
    dupId.pages[0].elements[2].id = dupId.pages[0].elements[1].id;
    expect(validateDocument(dupId).ok).toBe(false);
    const dupAlias = seedDocument();
    dupAlias.pages[0].elements[2].alias = dupAlias.pages[0].elements[1].alias;
    const r = validateDocument(dupAlias);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/duplicate alias/);
  });

  it('rejects atomic:false and envelope scope copies in params', () => {
    const valid = fixture('valid-apply.json');
    expect(validateEnvelope(valid).ok).toBe(true);
    const flat = { documentId: valid.documentId, sessionId: valid.sessionId, ...valid.params };
    expect(validateMutationShape(flat).ok).toBe(true);
    expect(validateMutationShape({ ...flat, atomic: false }).ok).toBe(false);
    expect(fixture('invalid-apply.json').every((f: unknown) => !validateEnvelope(f).ok)).toBe(true);
  });

  it('converts mm, cm, in and px to points', () => {
    expect(toPoints(25.4, 'mm')).toBeCloseTo(72, 12);
    expect(toPoints(2.54, 'cm')).toBeCloseTo(72, 12);
    expect(toPoints(1, 'in')).toBe(72);
    expect(toPoints(96, 'px')).toBe(72);
    expect(parseDimension('10mm')).toBeCloseTo(28.346456692913385, 12);
    expect(() => parseDimension('10')).toThrow(/needs a unit/);
  });

  it('every fixture uuid helper value is a valid UUID shape', () => {
    expect(uuid(255)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
