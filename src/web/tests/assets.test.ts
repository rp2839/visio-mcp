import { describe, expect, it } from 'vitest';
import { HOST_ORIGIN, HostAssetResolver } from '../src/editor/assets';

describe('HostAssetResolver', () => {
  it('requests image bytes from /blobs/<sha256> on the app origin (served by AppResourceServer, not the frontend folder)', () => {
    const sha = 'a'.repeat(64);
    const url = new HostAssetResolver().urlFor({ id: 'asset:x', name: 'x', mimeType: 'image/png', sha256: sha, tags: [] });
    expect(url).toBe(`${HOST_ORIGIN}/blobs/${sha}`);
    expect(url.startsWith(`${HOST_ORIGIN}/assets/`)).toBe(false); // Vite's build folder
  });
});
