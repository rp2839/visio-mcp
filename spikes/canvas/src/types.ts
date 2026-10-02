export type ProbeBox = { id: string; x: number; y: number; width: number; height: number; rotation: number };
export type ProbeEndpoint = { elementId: string; port?: string };
export type ProbeSceneDto = {
  revision: number;
  rect: ProbeBox & { text: string };
  ellipse: ProbeBox & { text: string };
  picture: ProbeBox & { assetDataUrl: string };
  connector: { id: string; from: ProbeEndpoint; to: ProbeEndpoint };
};
export type ProbeIntent =
  | { kind: 'geometry'; id: string; x: number; y: number; width: number; height: number }
  | { kind: 'rotation'; id: string; rotation: number }
  | { kind: 'text'; id: string; text: string }
  | { kind: 'connect'; id: string; end: 'from' | 'to'; elementId: string };
export type GestureKind = 'move' | 'resize' | 'rotate' | 'bend' | 'text';
export type GestureEvent = { phase: 'begin' | 'commit' | 'cancel'; kind: GestureKind; revision: number };
