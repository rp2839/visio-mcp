import type { DiagramDocument } from '../contracts/generated';
import type { BeautifyPreview } from './beautifyPreview';

/** Run the synchronous route search off the editor thread. */
export function buildBeautifyPreviewOffThread(document: DiagramDocument, pageId: string, targetIds?: readonly string[]): Promise<BeautifyPreview> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./beautifyPreview.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<{ preview?: BeautifyPreview; error?: string }>) => {
      worker.terminate();
      if (event.data.error) reject(new Error(event.data.error));
      else if (event.data.preview) resolve(event.data.preview);
      else reject(new Error('Beautify preview worker returned no result'));
    };
    worker.onerror = event => {
      worker.terminate();
      reject(new Error(event.message || 'Beautify preview worker failed'));
    };
    worker.postMessage({ document, pageId, ...(targetIds ? { targetIds: [...targetIds] } : {}) });
  });
}
