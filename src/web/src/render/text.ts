/** Text measurement seam: the browser uses canvas metrics with loaded fonts; tests/Node use a heuristic. */
export type MeasureText = (text: string, font: { family: string; sizePt: number; bold: boolean; italic: boolean }) => { width: number; exact: boolean };

export const heuristicMeasure: MeasureText = (text, font) => ({ width: text.length * font.sizePt * (font.bold ? 0.56 : 0.52), exact: false });

export function canvasMeasure(): MeasureText {
  const ctx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
  if (!ctx) return heuristicMeasure;
  return (text, f) => {
    ctx.font = `${f.italic ? 'italic ' : ''}${f.bold ? 'bold ' : ''}${f.sizePt}px ${JSON.stringify(f.family)}, sans-serif`;
    const width = ctx.measureText(text).width;
    // Report fallback: if the requested family is not available, metrics come from a substitute.
    const exact = typeof document !== 'undefined' && (document as any).fonts?.check?.(`${f.sizePt}px ${JSON.stringify(f.family)}`) === true;
    return { width, exact };
  };
}

/** Greedy word wrap into lines that fit maxWidth (pt). */
export function wrapLines(value: string, maxWidth: number, wrap: boolean, measure: (s: string) => number): string[] {
  const out: string[] = [];
  for (const para of value.split('\n')) {
    if (!wrap) { out.push(para); continue; }
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && measure(next) > maxWidth) { out.push(line); line = word; } else line = next;
    }
    out.push(line);
  }
  return out;
}
