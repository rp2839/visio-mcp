import { useEffect, useState } from 'react';
import type { Viewport } from '../canvas/CanvasAdapter';
import { POINTS_PER, type Unit } from '../model/units';

const STEPS: Record<Unit, number[]> = { mm: [1, 5, 10, 50, 100], cm: [0.5, 1, 5, 10], in: [0.125, 0.25, 0.5, 1, 2], pt: [10, 50, 100, 500], px: [10, 50, 100, 500] };

/** Unit-labelled physical rulers following the canvas viewport. */
export function Ruler(props: { orientation: 'horizontal' | 'vertical'; viewport: Viewport | null; unit: Unit; length: number }) {
  const { viewport: v, unit, orientation, length } = props;
  if (!v) return <div className={`ruler ${orientation}`} />;
  const ptPerUnit = POINTS_PER[unit];
  const pxPerUnit = ptPerUnit * v.scale;
  const step = STEPS[unit].find((s) => s * pxPerUnit >= 40) ?? STEPS[unit][STEPS[unit].length - 1];
  const offset = (orientation === 'horizontal' ? v.translateX : v.translateY) * v.scale;
  const first = Math.floor(-offset / (step * pxPerUnit)) * step;
  const ticks: { pos: number; label: string }[] = [];
  for (let u = first; (u * pxPerUnit + offset) < length && ticks.length < 400; u += step) ticks.push({ pos: u * pxPerUnit + offset, label: `${+u.toFixed(3)}` });
  return (
    <svg className={`ruler ${orientation}`} data-testid={`ruler-${orientation}`} data-unit={unit}>
      {ticks.map((t) => orientation === 'horizontal'
        ? <g key={t.pos}><line x1={t.pos} x2={t.pos} y1={10} y2={20} /><text x={t.pos + 2} y={9}>{t.label}</text></g>
        : <g key={t.pos}><line y1={t.pos} y2={t.pos} x1={10} x2={20} /><text x={1} y={t.pos - 2}>{t.label}</text></g>)}
      <text className="unit" x={2} y={orientation === 'horizontal' ? 19 : 12}>{unit}</text>
    </svg>
  );
}

export function useViewport(subscribe: ((l: (v: Viewport) => void) => () => void) | null) {
  const [v, setV] = useState<Viewport | null>(null);
  useEffect(() => (subscribe ? subscribe(setV) : undefined), [subscribe]);
  return v;
}
