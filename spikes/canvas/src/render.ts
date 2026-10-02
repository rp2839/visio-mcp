import { ProbeCanvas } from './projection';
import type { ProbeSceneDto } from './types';

/** Renders an immutable snapshot offscreen (not a viewport capture) to PNG bytes. */
export async function renderProbe(scene: ProbeSceneDto, width = 900, height = 600): Promise<Uint8Array> {
  const host = document.createElement('div');
  host.style.cssText = `position:absolute;left:-10000px;top:0;width:${width}px;height:${height}px`;
  document.body.appendChild(host);
  try {
    const canvas = new ProbeCanvas(host, false);
    canvas.project(scene);
    const svg = host.querySelector('svg')!.cloneNode(true) as SVGSVGElement;
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    const images = [...svg.querySelectorAll('image')];
    for (const img of images) {
      const href = img.getAttribute('href') ?? img.getAttribute('xlink:href') ?? '';
      if (!href.startsWith('data:')) throw new Error(`non-inline asset ${href}`);
    }
    const blob = new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      const out = document.createElement('canvas');
      out.width = width; out.height = height;
      const ctx = out.getContext('2d')!;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(image, 0, 0);
      // toBlob throws SecurityError on a tainted canvas: that is the taint check.
      const png = await new Promise<Blob>((res, rej) => out.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), 'image/png'));
      return new Uint8Array(await png.arrayBuffer());
    } finally {
      URL.revokeObjectURL(url);
    }
  } finally {
    host.remove();
  }
}
