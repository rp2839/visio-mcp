/**
 * Shape preset geometry as SVG path data in a unit box (0..1). Used by the offscreen
 * renderer and VSDX export; the live canvas maps presets to maxGraph shapes with the same
 * outlines. Original generic outlines only (no vendor stencils).
 */
export type PresetName =
  | 'rectangle' | 'roundedRect' | 'ellipse' | 'diamond' | 'triangle' | 'hexagon' | 'parallelogram' | 'cylinder'
  | 'cloud' | 'callout' | 'server' | 'database' | 'application' | 'user' | 'document' | 'custom';

export const PRESETS: { name: PresetName; label: string; library: 'Basic' | 'Flowchart' | 'Architecture/IT' }[] = [
  { name: 'rectangle', label: 'Rectangle', library: 'Basic' },
  { name: 'roundedRect', label: 'Rounded rectangle', library: 'Basic' },
  { name: 'ellipse', label: 'Ellipse', library: 'Basic' },
  { name: 'triangle', label: 'Triangle', library: 'Basic' },
  { name: 'hexagon', label: 'Hexagon', library: 'Basic' },
  { name: 'cloud', label: 'Cloud', library: 'Basic' },
  { name: 'callout', label: 'Callout', library: 'Basic' },
  { name: 'rectangle', label: 'Process', library: 'Flowchart' },
  { name: 'diamond', label: 'Decision', library: 'Flowchart' },
  { name: 'parallelogram', label: 'Data', library: 'Flowchart' },
  { name: 'document', label: 'Document', library: 'Flowchart' },
  { name: 'cylinder', label: 'Storage', library: 'Flowchart' },
  { name: 'server', label: 'Server', library: 'Architecture/IT' },
  { name: 'database', label: 'Database', library: 'Architecture/IT' },
  { name: 'cloud', label: 'Cloud', library: 'Architecture/IT' },
  { name: 'application', label: 'Application', library: 'Architecture/IT' },
  { name: 'user', label: 'User', library: 'Architecture/IT' },
];

/** Path in absolute coordinates for a w×h box at (x,y). */
export function presetPath(preset: string | undefined, x: number, y: number, w: number, h: number, cornerRadius = 0, custom?: string): string {
  const X = (u: number) => +(x + u * w).toFixed(4);
  const Y = (v: number) => +(y + v * h).toFixed(4);
  const poly = (pts: [number, number][]) => `M${pts.map(([u, v]) => `${X(u)},${Y(v)}`).join(' L')} Z`;
  switch (preset) {
    case 'roundedRect': {
      const r = Math.min(cornerRadius || Math.min(w, h) * 0.15, w / 2, h / 2);
      return `M${x + r},${y} H${x + w - r} A${r},${r} 0 0 1 ${x + w},${y + r} V${y + h - r} A${r},${r} 0 0 1 ${x + w - r},${y + h} H${x + r} A${r},${r} 0 0 1 ${x},${y + h - r} V${y + r} A${r},${r} 0 0 1 ${x + r},${y} Z`;
    }
    case 'ellipse':
      return `M${x},${y + h / 2} A${w / 2},${h / 2} 0 1 1 ${x + w},${y + h / 2} A${w / 2},${h / 2} 0 1 1 ${x},${y + h / 2} Z`;
    case 'diamond': return poly([[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]]);
    case 'triangle': return poly([[0.5, 0], [1, 1], [0, 1]]);
    case 'hexagon': return poly([[0.25, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0.25, 1], [0, 0.5]]);
    case 'parallelogram': return poly([[0.2, 0], [1, 0], [0.8, 1], [0, 1]]);
    case 'callout': return poly([[0, 0], [1, 0], [1, 0.75], [0.4, 0.75], [0.2, 1], [0.25, 0.75], [0, 0.75]]);
    case 'document':
      return `M${X(0)},${Y(0)} L${X(1)},${Y(0)} L${X(1)},${Y(0.85)} C${X(0.75)},${Y(0.7)} ${X(0.5)},${Y(1.05)} ${X(0)},${Y(0.9)} Z`;
    case 'cylinder':
    case 'database': {
      const ry = h * 0.1;
      return `M${x},${y + ry} A${w / 2},${ry} 0 0 1 ${x + w},${y + ry} V${y + h - ry} A${w / 2},${ry} 0 0 1 ${x},${y + h - ry} Z M${x},${y + ry} A${w / 2},${ry} 0 0 0 ${x + w},${y + ry}`;
    }
    case 'cloud':
      return `M${X(0.25)},${Y(0.8)} C${X(0.02)},${Y(0.8)} ${X(0.02)},${Y(0.45)} ${X(0.22)},${Y(0.45)} C${X(0.2)},${Y(0.15)} ${X(0.55)},${Y(0.1)} ${X(0.6)},${Y(0.3)} C${X(0.75)},${Y(0.15)} ${X(0.98)},${Y(0.3)} ${X(0.85)},${Y(0.5)} C${X(1)},${Y(0.6)} ${X(0.95)},${Y(0.8)} ${X(0.8)},${Y(0.8)} Z`;
    case 'server':
      return `${poly([[0, 0], [1, 0], [1, 1], [0, 1]])} M${X(0)},${Y(0.33)} L${X(1)},${Y(0.33)} M${X(0)},${Y(0.66)} L${X(1)},${Y(0.66)}`;
    case 'application':
      return `${poly([[0, 0], [1, 0], [1, 1], [0, 1]])} M${X(0)},${Y(0.18)} L${X(1)},${Y(0.18)}`;
    case 'user':
      return `M${X(0.5)},${Y(0)} A${w * 0.18},${h * 0.2} 0 1 1 ${X(0.5)},${Y(0.4)} A${w * 0.18},${h * 0.2} 0 1 1 ${X(0.5)},${Y(0)} Z M${X(0.1)},${Y(1)} C${X(0.1)},${Y(0.5)} ${X(0.9)},${Y(0.5)} ${X(0.9)},${Y(1)} Z`;
    case 'custom':
      if (custom && /^[MmLlHhVvCcSsQqTtAaZz0-9\s,.\-eE]+$/.test(custom)) return `${custom}`; // restricted path data only
      return poly([[0, 0], [1, 0], [1, 1], [0, 1]]);
    default:
      return poly([[0, 0], [1, 0], [1, 1], [0, 1]]);
  }
}

/** maxGraph style fragment for the live canvas outline of a preset. */
export function presetCanvasStyle(preset: string | undefined): Record<string, unknown> {
  switch (preset) {
    case 'roundedRect': return { rounded: true };
    case 'ellipse': return { shape: 'ellipse', perimeter: 'ellipsePerimeter' };
    case 'diamond': return { shape: 'rhombus', perimeter: 'rhombusPerimeter' };
    case 'triangle': return { shape: 'triangle', perimeter: 'trianglePerimeter', direction: 'north' };
    case 'hexagon': return { shape: 'hexagon', perimeter: 'hexagonPerimeter' };
    case 'cylinder': case 'database': return { shape: 'cylinder' };
    case 'cloud': return { shape: 'cloud' };
    case 'parallelogram': return { shape: 'parallelogram' };
    case 'callout': return { shape: 'callout' };
    case 'document': return { shape: 'document' };
    default: return {};
  }
}
