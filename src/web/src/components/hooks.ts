import { createContext, useContext, useSyncExternalStore } from 'react';
import type { EditorController, EditorState } from '../editor/EditorController';

export const ControllerContext = createContext<EditorController | null>(null);

export function useController(): EditorController {
  const c = useContext(ControllerContext);
  if (!c) throw new Error('EditorController missing');
  return c;
}

export function useEditorState<T>(select: (s: EditorState) => T): T {
  const c = useController();
  return select(useSyncExternalStore(c.subscribe, c.getState));
}
