import { ActorShape, ShapeRegistry, type AbstractCanvas2D } from '@maxgraph/core';
import { presetPath } from './presets';

/** Canvas shape key for presets maxGraph has no built-in shape for. */
export const PRESET_SHAPE = 'agentPreset';

/**
 * Replays SVG path data (absolute M/L/H/V/C/A/Z, as emitted by presetPath) on a maxGraph canvas.
 * Using the same path source as the PNG renderer and VSDX export keeps all three in agreement.
 */
export function drawSvgPath(c: Pick<AbstractCanvas2D, 'moveTo' | 'lineTo' | 'curveTo' | 'arcTo' | 'close'>, d: string) {
  const tokens = d.match(/[MLHVCAZ]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
  let i = 0, cmd = '', x = 0, y = 0;
  const n = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[i])) cmd = tokens[i++].toUpperCase();
    switch (cmd) {
      case 'M': x = n(); y = n(); c.moveTo(x, y); cmd = 'L'; break; // implicit lineto after moveto
      case 'L': x = n(); y = n(); c.lineTo(x, y); break;
      case 'H': x = n(); c.lineTo(x, y); break;
      case 'V': y = n(); c.lineTo(x, y); break;
      case 'C': { const a = n(), b = n(), e = n(), f = n(); x = n(); y = n(); c.curveTo(a, b, e, f, x, y); break; }
      case 'A': { const rx = n(), ry = n(), rot = n(), large = n(), sweep = n(); x = n(); y = n(); c.arcTo(rx, ry, rot, large === 1, sweep === 1, x, y); break; }
      case 'Z': c.close(); break;
      default: i++; // unsupported token: skip rather than loop forever
    }
  }
}

// ActorShape is maxGraph's exported single-path shape; only its outline is replaced.
class PresetPathShape extends ActorShape {
  override redrawPath(c: AbstractCanvas2D, _x: number, _y: number, w: number, h: number) {
    const preset = (this.style as unknown as Record<string, unknown> | null)?.[PRESET_SHAPE] as string | undefined;
    drawSvgPath(c, presetPath(preset, 0, 0, w, h));
  }
}

let registered = false;
export function registerPresetShape() {
  if (registered) return;
  ShapeRegistry.add(PRESET_SHAPE, PresetPathShape as any);
  registered = true;
}
