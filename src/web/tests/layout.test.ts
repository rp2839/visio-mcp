import { describe, expect, it } from 'vitest';
import { inspectLayout, contrastRatio } from '../src/layout/inspectLayout';
import { SnapshotProjector } from '../src/canvas/SnapshotProjector';
import { renderSvg } from '../src/render/SnapshotRenderer';
import { createTestEngine, exactElementHashes, ids, uuid } from './support/engine';
import type { Operation } from '../src/model/types';

async function sceneWith(ops: Operation[]) {
  const t = createTestEngine();
  const r = await t.engine.execute(t.request(ops, { pageId: ids.page }), 'gui');
  if (!r.ok) throw new Error(r.error.message);
  const snap = t.engine.current();
  const proj = new SnapshotProjector().project(snap);
  if (!proj.ok) throw new Error('projection');
  return { ...t, snap, projection: proj.value, issues: inspectLayout(snap, proj.value), aliases: r.value.aliases ?? {} };
}
const codes = (issues: { code: string; elementIds: string[] }[], id: string) => issues.filter((i) => i.elementIds.includes(id)).map((i) => i.code);

describe('inspect_layout', () => {
  it('out-of-page (full and partial) with element IDs and bounds; inspection never mutates', async () => {
    const t = await sceneWith([
      { op: 'create', element: { kind: 'shape', id: uuid(0x10), bounds: { x: -500, y: -500, width: 50, height: 50 } } },
      { op: 'create', element: { kind: 'shape', id: uuid(0x11), bounds: { x: 820, y: 100, width: 50, height: 50 } } },
    ]);
    const beforeHashes = exactElementHashes(t.engine.current());
    const issues = inspectLayout(t.snap, t.projection);
    const outsideId = uuid(0x10);
    expect(issues.find((i) => i.code === 'OUTSIDE_PAGE')?.elementIds).toEqual([outsideId]);
    expect(issues.find((i) => i.code === 'PARTLY_OUTSIDE_PAGE')?.elementIds).toEqual([uuid(0x11)]);
    expect(issues.find((i) => i.code === 'OUTSIDE_PAGE')?.bounds).toEqual({ x: -500, y: -500, width: 50, height: 50 });
    const afterInspection = t.engine.current();
    expect(exactElementHashes(afterInspection)).toEqual(beforeHashes);
  });

  it('text overflow reports measurement uncertainty', async () => {
    const t = await sceneWith([{ op: 'create', element: { kind: 'shape', id: uuid(0x12), bounds: { x: 10, y: 400, width: 40, height: 20 }, text: { value: 'A long label that cannot fit in a tiny box', wrap: true } } }]);
    const i = t.issues.find((x) => x.code === 'TEXT_OVERFLOW' && x.elementIds[0] === uuid(0x12))!;
    expect(i.evidence.measurement).toMatch(/approximate/);
  });

  it('dangling endpoint and glue to hidden elements', async () => {
    const t = await sceneWith([
      { op: 'create', element: { kind: 'connector', id: uuid(0x13), from: { target: ids.shapes[0] }, to: { point: { x: 700, y: 500 } } } },
      { op: 'create', element: { kind: 'connector', id: uuid(0x14), from: { target: ids.shapes[1] }, to: { target: ids.shapes[2] } } },
      { op: 'set', target: ids.shapes[2], patch: { hidden: true } },
    ]);
    expect(codes(t.issues, uuid(0x13))).toContain('DANGLING_ENDPOINT');
    expect(codes(t.issues, uuid(0x14))).toContain('GLUED_TO_HIDDEN');
  });

  it('image distortion only when aspect is not preserved', async () => {
    const t = await sceneWith([
      { op: 'set', target: ids.image, patch: { fit: 'stretch', bounds: { width: 100, height: 100 } } }, // asset is 200×80
    ]);
    expect(codes(t.issues, ids.image)).toContain('IMAGE_DISTORTION');
    const u = await sceneWith([{ op: 'set', target: ids.image, patch: { bounds: { width: 100, height: 100 } } }]); // contain
    expect(codes(u.issues, ids.image)).not.toContain('IMAGE_DISTORTION');
  });

  it('crossings ignore endpoints and group containment; overlaps are heuristic warnings', async () => {
    const t = await sceneWith([
      { op: 'create', element: { kind: 'connector', id: uuid(0x15), route: 'straight', from: { target: ids.shapes[0] }, to: { target: ids.shapes[2] } } }, // passes through shapes[1]
      { op: 'create', element: { kind: 'shape', id: uuid(0x16), bounds: { x: 160, y: 110, width: 40, height: 40 } } }, // overlaps shapes[0]
    ]);
    const crossing = t.issues.filter((i) => i.code === 'CONNECTOR_CROSSES_SHAPE');
    expect(crossing.map((i) => i.elementIds)).toContainEqual([uuid(0x15), ids.shapes[1]]);
    expect(crossing.every((i) => i.elementIds[1] !== ids.shapes[0] && i.elementIds[1] !== ids.shapes[2])).toBe(true);
    const overlap = t.issues.find((i) => i.code === 'OVERLAP' && i.elementIds.includes(uuid(0x16)))!;
    expect(overlap.elementIds).toContain(ids.shapes[0]);
    expect(overlap.evidence.heuristic).toBeDefined();
  });

  it('low contrast heuristic', async () => {
    const t = await sceneWith([{ op: 'set', target: ids.shapes[3], patch: { style: { fill: '#FFFF00' }, text: { colour: '#FFFFFF' } } }]);
    expect(codes(t.issues, ids.shapes[3])).toContain('LOW_CONTRAST');
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
  });

  it('near-zero size', async () => {
    const t = await sceneWith([{ op: 'create', element: { kind: 'shape', id: uuid(0x17), bounds: { x: 10, y: 10, width: 0.5, height: 30 } } }]);
    expect(codes(t.issues, uuid(0x17))).toContain('NEAR_ZERO_SIZE');
  });
});

describe('snapshot SVG renderer', () => {
  const data = new Map([['a'.repeat(64), 'data:image/png;base64,iVBORw0KGgo='], ['b'.repeat(64), 'data:image/png;base64,iVBORw0KGgo=']]);

  it('clean mode has no debug overlay; debug mode labels aliases', async () => {
    const t = createTestEngine();
    const snap = t.engine.current();
    const proj = new SnapshotProjector().project(snap);
    if (!proj.ok) throw new Error();
    const clean = renderSvg(snap, proj.value, { pageId: ids.page, assetData: data });
    const debug = renderSvg(snap, proj.value, { pageId: ids.page, assetData: data, mode: 'debug' });
    expect(clean.ok && clean.value.svg).not.toContain('data-debug');
    expect(debug.ok && debug.value.svg).toContain('>logo<');
    expect(debug.ok && debug.value.svg.match(/data-debug/g)?.length).toBe(20);
  });

  it('missing asset bytes fail instead of rendering blank', () => {
    const t = createTestEngine();
    const snap = t.engine.current();
    const proj = new SnapshotProjector().project(snap);
    const r = proj.ok ? renderSvg(snap, proj.value, { pageId: ids.page, assetData: new Map() }) : null;
    expect(r && !r.ok && r.error.code).toBe('not_found');
  });

  it('non-printable layers are omitted for print/export', async () => {
    const t = await sceneWith([{ op: 'addLayer', layer: { id: uuid(0x18), name: 'Draft', printable: false } }, { op: 'assignLayer', targets: [ids.shapes[0]], layers: ['Draft'] }]);
    const svg = renderSvg(t.snap, t.projection, { pageId: ids.page, assetData: data, printable: true });
    expect(svg.ok && svg.value.svg).not.toContain(ids.shapes[0]);
    expect(svg.ok && svg.value.svg).toContain(ids.shapes[1]);
  });
});
