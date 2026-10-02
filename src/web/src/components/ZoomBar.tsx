import type { Viewport } from '../canvas/CanvasAdapter';
import { useController } from './hooks';

// The adapter clamps zoom to 10%–800%; the slider is logarithmic so each notch feels the same.
const MIN = Math.log2(0.1), MAX = Math.log2(8);

/** Zoom controls over the bottom-right corner of the canvas: −, slider, +, percentage and fit to window. */
export function ZoomBar(props: { viewport: Viewport | null }) {
  const c = useController();
  const zoom = props.viewport?.zoom ?? 1;
  return (
    <div className="zoom-bar" role="group" aria-label="Zoom">
      <button data-testid="zoombar-out" title="Zoom out" onClick={() => c.zoom(1 / 1.25)}>−</button>
      <input data-testid="zoombar-slider" type="range" aria-label="Zoom level" min={MIN} max={MAX} step="any" value={Math.log2(zoom)}
        onChange={(e) => c.setZoom(2 ** Number(e.target.value), zoom)} />
      <button data-testid="zoombar-in" title="Zoom in" onClick={() => c.zoom(1.25)}>+</button>
      <button data-testid="zoombar-actual" className="zoom-level" title="Zoom to 100%" onClick={() => c.fit('actual')}>{Math.round(zoom * 100)}%</button>
      <button data-testid="zoombar-fit" title="Fit page to window" onClick={() => c.fit('page')}>Fit</button>
    </div>
  );
}
