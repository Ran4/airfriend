// Where each actor ended up on screen this frame. The actor layer publishes it,
// the effects read it (ARF! bubble over the dog's head, dizzy stars, "!"), so
// attachments follow the exact sprite instead of guessing a head height.
// Keyed by the scene both layers share (renderer.ts builds one of each).

export interface ActorScreen {
  visible: boolean;
  /** projected ice point, framebuffer px */
  sx: number;
  sy: number;
  /** opaque sprite extents on screen, framebuffer px (y down; right/bottom exclusive) */
  top: number;
  bottom: number;
  left: number;
  right: number;
  /** pixels per texel used for this sprite */
  scale: number;
  /** depth-plane distance (for drawing attachments in front) */
  dist: number;
}

export const REF_ID = 100;
export const PUCK_ID = 101;

const registries = new WeakMap<object, Map<number, ActorScreen>>();

export function actorScreens(key: object): Map<number, ActorScreen> {
  let m = registries.get(key);
  if (!m) {
    m = new Map();
    registries.set(key, m);
  }
  return m;
}
