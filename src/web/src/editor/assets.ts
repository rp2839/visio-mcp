import type { Asset } from '../model/types';

/**
 * Resolves asset bytes for display. In the WPF host, bytes are same-origin host resources
 * (no filesystem paths, no remote fetches); in the standalone dev/test build they come from
 * an in-memory map populated by local preparation.
 */
export interface AssetResolver {
  urlFor(asset: Asset): string | null;
  dataUrlFor(asset: Asset): Promise<string | null>;
}

export const HOST_ORIGIN = 'https://app.agentic-diagram.invalid';

export class HostAssetResolver implements AssetResolver {
  /** Must match AppResourceServer.BlobPath in Diagram.Host.Core. */
  urlFor(asset: Asset) { return `${HOST_ORIGIN}/blobs/${asset.sha256}`; }
  async dataUrlFor(asset: Asset) {
    const res = await fetch(this.urlFor(asset));
    if (!res.ok) return null;
    return blobToDataUrl(await res.blob());
  }
}

export class MemoryAssetResolver implements AssetResolver {
  private readonly bytes = new Map<string, string>();
  put(sha256: string, dataUrl: string) { this.bytes.set(sha256, dataUrl); }
  has(sha256: string) { return this.bytes.has(sha256); }
  urlFor(asset: Asset) { return this.bytes.get(asset.sha256) ?? null; }
  async dataUrlFor(asset: Asset) { return this.urlFor(asset); }
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function sniffMime(b: Uint8Array): string | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  const head = new TextDecoder().decode(b.subarray(0, 512)).trimStart();
  if ((head.startsWith('<?xml') || head.startsWith('<svg')) && head.includes('<svg')) return 'image/svg+xml';
  return null;
}

/** Standalone preparation (dev/test build only). The WPF host uses Diagram.Host.Core.AssetPreparer. */
export async function prepareLocally(file: { name: string; arrayBuffer(): Promise<ArrayBuffer> }, resolver: MemoryAssetResolver): Promise<Asset> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const mime = sniffMime(bytes);
  if (!mime) throw new Error('unsupported image format');
  let data = buf;
  if (mime === 'image/svg+xml') {
    const text = new TextDecoder().decode(bytes);
    if (/<script|\son\w+=|<foreignObject|href="(?!#|data:image\/(png|jpeg))/i.test(text)) throw new Error('SVG contains scripts or external resources');
    data = new TextEncoder().encode(text).buffer as ArrayBuffer;
  }
  const sha = await sha256Hex(data);
  const url = await blobToDataUrl(new Blob([data], { type: mime }));
  const dims = await new Promise<{ w: number; h: number }>((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth || 100, h: img.naturalHeight || 100 });
    img.onerror = () => resolve({ w: 100, h: 100 });
    img.src = url;
  });
  if (dims.w > 16384 || dims.h > 16384 || dims.w * dims.h > 64 * 1024 * 1024) throw new Error('image exceeds the pixel budget');
  resolver.put(sha, url);
  const slug = file.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'asset';
  return { id: `asset:${slug}~${sha}`, name: file.name, mimeType: mime as Asset['mimeType'], sha256: sha, widthPx: dims.w, heightPx: dims.h, tags: [], provenance: 'local import' };
}
