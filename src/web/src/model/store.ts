import type { DiagramDocument, Snapshot } from './types';

/**
 * Holds the committed canonical document. Committed documents are treated as immutable:
 * the engine replaces the whole value on commit and never mutates a published one.
 */
export class DocumentStore {
  private doc: DiagramDocument;
  constructor(document: DiagramDocument, readonly sessionId: string) {
    this.doc = document;
  }
  get document() { return this.doc; }
  get documentId() { return this.doc.id; }
  get revision() { return this.doc.revision; }
  /** Engine-only: publish a new committed document. */
  publish(next: DiagramDocument) { this.doc = next; }
  snapshot(pageId?: string): Snapshot {
    return { documentId: this.doc.id, sessionId: this.sessionId, revision: this.doc.revision, document: this.doc, ...(pageId ? { pageId } : {}) };
  }
}

export function createDocumentStore(document: DiagramDocument, sessionId: string): DocumentStore {
  return new DocumentStore(document, sessionId);
}
