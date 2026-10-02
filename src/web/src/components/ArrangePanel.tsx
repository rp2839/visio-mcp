import type { Operation } from '../model/types';
import { toPoints } from '../model/units';
import { useController, useEditorState } from './hooks';

/** Align / distribute / gap / z-order / group actions against the existing planners. */
export function ArrangePanel() {
  const c = useController();
  const selection = useEditorState((s) => s.selection);
  const units = useEditorState((s) => s.units);
  const ids = selection.filter((id) => c.element(id));
  const one = ids.length === 1 ? c.element(ids[0]) : undefined;
  const run = (op: Operation, d: string) => void c.apply([op], d);
  const b = (testid: string, label: string, enabled: boolean, f: () => void) => <button key={testid} data-testid={testid} disabled={!enabled} onClick={f}>{label}</button>;
  return (
    <section className="arrange" data-testid="arrange">
      <h4>Arrange</h4>
      <div className="row wrap">
        {(['left', 'center', 'right', 'top', 'middle', 'bottom'] as const).map((edge) => b(`align-${edge}`, edge, ids.length > 1, () => run({ op: 'align', targets: ids, edge }, `Align ${edge}`)))}
      </div>
      <div className="row wrap">
        {b('distribute-horizontal', 'Distribute H', ids.length > 2, () => run({ op: 'distribute', targets: ids, axis: 'horizontal' }, 'Distribute horizontally'))}
        {b('distribute-vertical', 'Distribute V', ids.length > 2, () => run({ op: 'distribute', targets: ids, axis: 'vertical' }, 'Distribute vertically'))}
        {b('gap-horizontal', 'Gap H…', ids.length > 1, () => { const g = prompt(`Horizontal gap (${units})`, '5'); if (g) run({ op: 'setGap', targets: ids, axis: 'horizontal', gapPt: toPoints(Number(g), units) }, 'Set gap'); })}
        {b('gap-vertical', 'Gap V…', ids.length > 1, () => { const g = prompt(`Vertical gap (${units})`, '5'); if (g) run({ op: 'setGap', targets: ids, axis: 'vertical', gapPt: toPoints(Number(g), units) }, 'Set gap'); })}
      </div>
      <div className="row wrap">
        {(['front', 'forward', 'backward', 'back'] as const).map((action) => b(`z-${action}`, action, ids.length > 0, () => run({ op: 'zorder', targets: ids, action }, `Bring ${action}`)))}
      </div>
      <div className="row wrap">
        {b('group', 'Group', ids.length > 1, () => run({ op: 'group', targets: ids }, 'Group'))}
        {b('ungroup', 'Ungroup', one?.kind === 'group', () => run({ op: 'ungroup', target: ids[0] }, 'Ungroup'))}
      </div>
    </section>
  );
}
