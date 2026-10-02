import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import documentSchema from '../../../../contracts/document.schema.json';
import operationsSchema from '../../../../contracts/operations.schema.json';
import protocolSchema from '../../../../contracts/protocol.schema.json';
import type { DiagramDocument, Element, Operation, Page } from './types';
import { err, ok, type Result } from './result';
import { deriveGroupBounds, indexPage, EPS } from './geometry';
import { DEFAULT_PORTS } from './defaults';

export { toPoints } from './units';

const ajv = new Ajv2020({ allErrors: false, strict: false, discriminator: true });
addFormats(ajv);
ajv.addSchema(documentSchema).addSchema(operationsSchema).addSchema(protocolSchema);

const getValidator = (ref: string) => {
  const v = ajv.getSchema(ref);
  if (!v) throw new Error(`schema ${ref} not found`);
  return v;
};
const documentValidator = getValidator('https://agentic-diagram.invalid/schema/document.json');
const elementValidator = getValidator('https://agentic-diagram.invalid/schema/document.json#/$defs/Element');
const batchValidator = getValidator('https://agentic-diagram.invalid/schema/operations.json#/$defs/OperationBatch');
const requestValidator = getValidator('https://agentic-diagram.invalid/schema/protocol.json#/$defs/RequestEnvelope');
const mutationValidator = getValidator('https://agentic-diagram.invalid/schema/protocol.json#/$defs/MutationRequest');

function schemaError<T>(what: string, v: { errors?: unknown[] | null }): Result<T> {
  const e = (v.errors?.[0] ?? {}) as { instancePath?: string; message?: string; params?: unknown };
  return err('invalid_request', `${what}: ${e.instancePath || '/'} ${e.message ?? 'invalid'}`, { path: e.instancePath, params: e.params });
}

/** Rejects NaN/Infinity anywhere (JSON Schema "number" alone does not). */
export function findNonFinite(value: unknown, path = ''): string | null {
  if (typeof value === 'number') return Number.isFinite(value) ? null : path || '/';
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const p = findNonFinite(value[i], `${path}/${i}`);
      if (p) return p;
    }
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const p = findNonFinite(v, `${path}/${k}`);
      if (p) return p;
    }
  }
  return null;
}

export function validateOperations(value: unknown): Result<Operation[]> {
  const nf = findNonFinite(value);
  if (nf) return err('invalid_request', `non-finite number at ${nf}`);
  if (!batchValidator(value)) return schemaError('operations', batchValidator);
  return ok(value as Operation[]);
}

export function validateMutationShape(value: unknown): Result<void> {
  const nf = findNonFinite(value);
  if (nf) return err('invalid_request', `non-finite number at ${nf}`);
  if (!mutationValidator(value)) return schemaError('mutation request', mutationValidator);
  return ok(undefined);
}

export function validateEnvelope(value: unknown): Result<void> {
  if (!requestValidator(value)) return schemaError('request envelope', requestValidator);
  return ok(undefined);
}

export function validateElementSchema(value: unknown): Result<Element> {
  if (!elementValidator(value)) return schemaError('element', elementValidator);
  return ok(value as Element);
}

export function validateDocument(value: unknown): Result<DiagramDocument> {
  const nf = findNonFinite(value);
  if (nf) return err('invalid_request', `non-finite number at ${nf}`);
  if (!documentValidator(value)) return schemaError('document', documentValidator);
  const doc = value as DiagramDocument;
  const problems = checkInvariants(doc);
  if (problems.length) return err(problems[0].code, problems[0].message, { problems: problems.slice(0, 20) });
  return ok(doc);
}

export type Problem = { code: 'invalid_request' | 'dependency_conflict' | 'not_found'; message: string; elementId?: string; pageId?: string };

/** Semantic invariants (D2) on a whole document. Returns all problems found. */
export function checkInvariants(doc: DiagramDocument): Problem[] {
  const problems: Problem[] = [];
  const push = (p: Problem) => problems.length < 100 && problems.push(p);
  const elementIds = new Set<string>();
  const pageIds = new Set<string>();
  const layerIds = new Set<string>();
  const assetIds = new Set<string>();
  for (const a of doc.assets) {
    if (assetIds.has(a.id)) push({ code: 'invalid_request', message: `duplicate asset id ${a.id}` });
    assetIds.add(a.id);
  }
  for (const page of doc.pages) {
    if (pageIds.has(page.id)) push({ code: 'invalid_request', message: `duplicate page id ${page.id}` });
    pageIds.add(page.id);
    for (const l of page.layers) {
      if (layerIds.has(l.id)) push({ code: 'invalid_request', message: `duplicate layer id ${l.id}`, pageId: page.id });
      layerIds.add(l.id);
    }
    for (const e of page.elements) {
      if (elementIds.has(e.id)) push({ code: 'invalid_request', message: `duplicate element id ${e.id}`, elementId: e.id });
      elementIds.add(e.id);
    }
    checkPage(page, new Set(page.layers.map((l) => l.id)), assetIds, push);
  }
  return problems;
}

function checkPage(page: Page, pageLayers: Set<string>, assetIds: Set<string>, push: (p: Problem) => void) {
  const index = indexPage(page);
  const aliases = new Set<string>();
  const z = new Set<number>();
  const parentCount = new Map<string, number>();
  let lastZ = -1;
  for (const e of page.elements) {
    const at = { elementId: e.id, pageId: page.id };
    if (e.alias !== undefined) {
      if (aliases.has(e.alias)) push({ code: 'invalid_request', message: `duplicate alias "${e.alias}" on page`, ...at });
      aliases.add(e.alias);
    }
    if (z.has(e.zIndex)) push({ code: 'invalid_request', message: `zIndex tie ${e.zIndex}`, ...at });
    z.add(e.zIndex);
    if (e.zIndex < lastZ) push({ code: 'invalid_request', message: 'elements must be stored in zIndex order', ...at });
    lastZ = e.zIndex;
    for (const l of e.layerIds) if (!pageLayers.has(l)) push({ code: 'not_found', message: `layer ${l} is not on this page`, ...at });
    if (e.kind !== 'connector' && e.kind !== 'group' && (e.bounds.width <= 0 || e.bounds.height <= 0))
      push({ code: 'invalid_request', message: 'width and height must be positive', ...at });
    if (e.kind === 'image' && !assetIds.has(e.assetId)) push({ code: 'not_found', message: `asset ${e.assetId} does not exist`, ...at });
    if (e.kind === 'group') {
      if (e.rotationDeg !== 0) push({ code: 'invalid_request', message: 'group rotationDeg must be 0', ...at });
      for (const c of e.childIds) {
        if (!index.byId.has(c)) push({ code: 'not_found', message: `group child ${c} is not on this page`, ...at });
        parentCount.set(c, (parentCount.get(c) ?? 0) + 1);
      }
    }
    if (e.kind === 'connector') {
      for (const end of [e.from, e.to]) {
        if (end.glue === 'none') {
          if (!end.point || end.elementId || end.port) push({ code: 'invalid_request', message: 'free endpoint needs point only', ...at });
          continue;
        }
        if (!end.elementId) { push({ code: 'invalid_request', message: 'glued endpoint needs elementId', ...at }); continue; }
        if (end.point) push({ code: 'invalid_request', message: 'glued endpoint cannot also have a point', ...at });
        const target = index.byId.get(end.elementId);
        if (!target) { push({ code: 'dependency_conflict', message: `connector endpoint ${end.elementId} does not exist on this page`, ...at }); continue; }
        if (target.kind === 'connector') push({ code: 'invalid_request', message: 'cannot glue to a connector', ...at });
        if (end.glue === 'static') {
          const ports = new Set([...Object.keys(DEFAULT_PORTS), ...((target.kind === 'shape' ? target.ports : undefined) ?? []).map((p) => p.name)]);
          if (!end.port || !ports.has(end.port)) push({ code: 'invalid_request', message: `static glue needs a port on the target (${end.port ?? 'missing'})`, ...at });
        } else if (end.glue === 'dynamic' && end.port && end.port !== 'auto') {
          push({ code: 'invalid_request', message: 'dynamic glue cannot name a port', ...at });
        }
      }
    }
  }
  for (const [c, n] of parentCount) if (n > 1) push({ code: 'invalid_request', message: `element ${c} has ${n} parent groups`, elementId: c, pageId: page.id });
  // Acyclic forest and derived bounds.
  for (const e of page.elements) {
    if (e.kind !== 'group') continue;
    const seen = new Set<string>([e.id]);
    let p = index.parentOf.get(e.id);
    let cyclic = false;
    while (p) {
      if (seen.has(p)) { cyclic = true; break; }
      seen.add(p);
      p = index.parentOf.get(p);
    }
    if (cyclic) { push({ code: 'invalid_request', message: 'group cycle', elementId: e.id, pageId: page.id }); continue; }
    const derived = deriveGroupBounds(index, e.id);
    if (!derived) { push({ code: 'invalid_request', message: 'empty group', elementId: e.id, pageId: page.id }); continue; }
    const b = e.bounds;
    if (Math.abs(b.x - derived.x) > EPS || Math.abs(b.y - derived.y) > EPS || Math.abs(b.width - derived.width) > EPS || Math.abs(b.height - derived.height) > EPS)
      push({ code: 'invalid_request', message: 'group bounds must equal derived descendant bounds', elementId: e.id, pageId: page.id });
  }
}
