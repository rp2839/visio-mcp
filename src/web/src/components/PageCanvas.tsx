import { useEffect, useRef, useState } from 'react';
import { MaxGraphAdapter } from '../canvas/MaxGraphAdapter';
import type { Viewport } from '../canvas/CanvasAdapter';
import { useController, useEditorState } from './hooks';
import { Ruler } from './Rulers';

export function PageCanvas(props: { onAdapter?: (a: MaxGraphAdapter) => void }) {
  const c = useController();
  const units = useEditorState((s) => s.units);
  const host = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  useEffect(() => {
    const adapter = new MaxGraphAdapter(c.assets);
    adapter.mount(host.current!);
    const off = adapter.onViewport(setViewport);
    c.attach(adapter);
    props.onAdapter?.(adapter);
    const ro = new ResizeObserver(() => setSize({ w: host.current?.clientWidth ?? 800, h: host.current?.clientHeight ?? 600 }));
    ro.observe(host.current!);
    return () => { off(); ro.disconnect(); c.detach(); adapter.dispose(); };
  }, [c]);
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (!viewport) return;
    const r = host.current!.getBoundingClientRect();
    const at = { x: (e.clientX - r.left) / viewport.scale - viewport.translateX, y: (e.clientY - r.top) / viewport.scale - viewport.translateY };
    const preset = e.dataTransfer.getData('application/x-diagram-preset');
    if (preset) { const p = JSON.parse(preset); void c.createShape(p.name, { x: at.x, y: at.y, width: 108, height: 54 }, p.label); return; }
    const assetId = e.dataTransfer.getData('application/x-diagram-asset');
    const asset = c.getState().snapshot.document.assets.find((a) => a.id === assetId);
    if (asset) void c.insertImage(asset, at);
  };
  return (
    <div className="canvas-area">
      <div className="ruler-corner">{units}</div>
      <Ruler orientation="horizontal" viewport={viewport} unit={units} length={size.w} />
      <Ruler orientation="vertical" viewport={viewport} unit={units} length={size.h} />
      <div className="canvas" data-testid="canvas" ref={host} onDragOver={(e) => e.preventDefault()} onDrop={onDrop} tabIndex={0} />
    </div>
  );
}
