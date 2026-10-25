import { buildBeautifyPreview, type BeautifyPreview } from './beautifyPreview';
import type { DiagramDocument } from '../contracts/generated';

interface PreviewRequest { document: DiagramDocument; pageId: string; targetIds?: string[] }
type PreviewResponse = { preview: BeautifyPreview } | { error: string };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<PreviewRequest>) => void) | null;
  postMessage: (message: PreviewResponse) => void;
};

scope.onmessage = async ({ data }) => {
  try {
    const context = new OffscreenCanvas(1, 1).getContext('2d');
    if (!context) throw new Error('Offscreen canvas text measurement is unavailable');
    const preview = await buildBeautifyPreview(data.document, data.pageId, data.targetIds, {
      measureWidth: (text, font) => {
        context.font = `${font.italic ? 'italic ' : ''}${font.bold ? 'bold ' : ''}${font.sizePt}px "${font.family}"`;
        return context.measureText(text).width;
      },
    });
    scope.postMessage({ preview });
  } catch (error) {
    scope.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
