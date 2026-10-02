// Canonical wire types are generated from contracts/; this module re-exports them with
// a few narrow helpers. Do not hand-write property names here.
export type * from '../contracts/generated';
import type {
  DiagramDocument, Element, Page, AppError, ShapeElement, TextElement, ImageElement, ConnectorElement, GroupElement,
} from '../contracts/generated';

export type ElementKind = Element['kind'];
export type ElementOf<K extends ElementKind> = Extract<Element, { kind: K }>;
export type BoxElement = ShapeElement | TextElement | ImageElement;
export type Source = 'gui' | 'script' | 'mcp' | 'import' | 'undo' | 'redo';
export type ErrorCode = AppError['code'];
export type { DiagramDocument, Element, Page, ShapeElement, TextElement, ImageElement, ConnectorElement, GroupElement };
