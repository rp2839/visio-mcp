import type { Result } from '../model/result';
import type { Point, Snapshot } from '../model/types';

export type GestureKind = 'move' | 'resize' | 'rotate' | 'bend' | 'text';

/** Typed change observed on the canvas at gesture end; never a maxGraph cell. */
export type CanvasChange =
  | { kind: 'geometry'; id: string; x: number; y: number; width: number; height: number }
  | { kind: 'rotation'; id: string; rotationDeg: number }
  | { kind: 'text'; id: string; value: string }
  | { kind: 'terminal'; id: string; end: 'from' | 'to'; elementId: string | null; port?: string; point?: Point }
  | { kind: 'points'; id: string; points: Point[] };

export type CanvasIntent =
  | { type: 'gesture-begin'; gesture: GestureKind; ids: string[] }
  | { type: 'gesture-end'; gesture: GestureKind; changes: CanvasChange[] }
  | { type: 'gesture-cancel'; gesture: GestureKind }
  | { type: 'selection'; ids: string[] }
  | { type: 'create'; tool: 'shape' | 'text' | 'connector'; bounds?: { x: number; y: number; width: number; height: number }; from?: { elementId?: string; port?: string; point?: Point }; to?: { elementId?: string; port?: string; point?: Point } };

export type Viewport = { scale: number; translateX: number; translateY: number; zoom: number };

/** Library-neutral canvas contract. Implementations translate UUIDs to cells internally. */
export interface CanvasAdapter {
  mount(container: HTMLElement): void;
  project(snapshot: Snapshot, pageId: string): Result<void>;
  setSelection(ids: string[]): void;
  getSelection(): string[];
  onIntent(listener: (intent: CanvasIntent) => void): () => void;
  onViewport(listener: (v: Viewport) => void): () => void;
  setTool(tool: 'select' | 'shape' | 'text' | 'connector'): void;
  cancelGesture(): void;
  isGestureActive(): boolean;
  zoom(factor: number, around?: Point): void;
  fit(target: 'page' | 'selection' | 'actual'): void;
  /** Page coordinates (pt) → client pixels; test/inspection helper. */
  pageToClient(p: Point): Point;
  dispose(): void;
}
