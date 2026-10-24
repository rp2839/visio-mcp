import type { EditorModel } from '../editor/EditorModel';
import type { LayoutIssue } from '../layout/inspectLayout';
import { RULER_SIZE } from './Ruler';

const COLOUR = { error: '#dc2626', warning: '#ea580c', info: '#2563eb', intended: '#64748b' } as const;

const isIntended = (i: LayoutIssue) => i.evidence.intended === true;
const colourOf = (i: LayoutIssue) => (isIntended(i) ? COLOUR.intended : COLOUR[i.severity]);
const pointsOf = (i: LayoutIssue): Array<{ x: number; y: number }> => {
  const e = i.evidence as { points?: Array<{ x: number; y: number }>; point?: { x: number; y: number } };
  return e.points ?? (e.point ? [e.point] : []);
};

/**
 * R26: the routing findings drawn over the canvas: crossings, joins and touching ends as rings, everything else as a box round what it is
 * about. Grey is drawn on purpose (a junction, a hop, a container), orange and red are defects, blue is advice. It takes no pointer
 * input and never changes the document; turn it on from View, Show route diagnostics.
 */
export function RouteDiagnostics({ model }: { model: EditorModel }) {
  const vp = model.viewport;
  if (!model.showRouteDiagnostics || !vp) return null;
  const issues = model.routeDiagnostics();
  const elements = new Map(model.currentPage.elements.map(e => [e.id, e] as const));
  const sx = (x: number) => (x + vp.marginPt) * vp.scale - vp.scrollLeft;
  const sy = (y: number) => (y + vp.marginPt) * vp.scale - vp.scrollTop;
  const defects = issues.filter(i => !isIntended(i) && i.severity !== 'info').length;
  const intended = issues.filter(isIntended).length;
  const counts = new Map<string, number>();
  for (const i of issues) counts.set(i.code, (counts.get(i.code) ?? 0) + 1);

  return (
    <div style={{ position: 'absolute', left: RULER_SIZE, top: RULER_SIZE, right: 0, bottom: 0, pointerEvents: 'none', overflow: 'hidden', zIndex: 4 }} data-testid="route-diagnostics">
      <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
        {issues.map((i, n) => {
          const colour = colourOf(i), dash = isIntended(i) ? '3 3' : undefined, pts = pointsOf(i);
          // something crossed on purpose with no place to mark (a backdrop, a container, a lower level) is only counted
          if (isIntended(i) && !pts.length) return null;
          // a shape crossing marks the shapes crossed, not the whole connector
          const boxes = i.code === 'CONNECTOR_CROSSES_SHAPE' ? (i.evidence.crossedElementIds as string[]).map(id => elements.get(id)?.bounds).filter((b): b is LayoutIssue['bounds'] => !!b) : [i.bounds];
          return (
            <g key={n} data-testid={`route-diagnostic-${i.code}`} data-severity={i.severity} data-intended={isIntended(i)} aria-label={i.message}>
              <title>{i.message}</title>
              {pts.length
                ? pts.map((p, k) => <circle key={k} cx={sx(p.x)} cy={sy(p.y)} r={6} fill="none" stroke={colour} strokeWidth={2} strokeDasharray={dash} />)
                : boxes.map((b, k) => <rect key={k} x={sx(b.x) - 3} y={sy(b.y) - 3} width={Math.max(b.width * vp.scale, 0) + 6} height={Math.max(b.height * vp.scale, 0) + 6}
                    fill="none" stroke={colour} strokeWidth={1.5} strokeDasharray="6 3" rx={3} />)}
            </g>
          );
        })}
      </svg>
      <div data-testid="route-diagnostics-legend" role="status" aria-live="polite"
        style={{ position: 'absolute', right: 8, top: 8, background: 'var(--panel)', color: 'var(--ink)', border: '1px solid var(--line)', borderRadius: 4, padding: '4px 8px', fontSize: 12, maxWidth: 280 }}>
        <div><strong>Route diagnostics</strong>: {defects} to look at, {intended} on purpose</div>
        {[...counts].sort(([a], [b]) => a.localeCompare(b)).map(([code, n]) => <div key={code} data-testid={`route-diagnostics-count-${code}`}>{code.toLowerCase().replaceAll('_', ' ')}: {n}</div>)}
      </div>
    </div>
  );
}
