// Fullscreen toggle (F key / double-click). The whole page goes fullscreen,
// not just the picture: Display already fits the 4:3 frame to the viewport on
// every resize, so leaving the layout alone keeps the pixel-exact scaling.
//
// Browsers only grant fullscreen inside a user gesture, so toggle() must be
// called from the keydown/dblclick handler itself, not later in the frame.

type WebkitDoc = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => void;
};
type WebkitEl = HTMLElement & { webkitRequestFullscreen?: () => void };

export function isFullscreen(): boolean {
  const d = document as WebkitDoc;
  return !!(d.fullscreenElement ?? d.webkitFullscreenElement);
}

export function toggleFullscreen(): void {
  const d = document as WebkitDoc;
  const el = document.documentElement as WebkitEl;
  // a refusal (iframe without allowfullscreen, permissions policy) is not an
  // error worth surfacing: the game just stays windowed
  const ignore = () => {};
  if (isFullscreen()) {
    if (d.exitFullscreen) d.exitFullscreen().catch(ignore);
    else d.webkitExitFullscreen?.();
  } else if (el.requestFullscreen) {
    el.requestFullscreen({ navigationUI: 'hide' }).catch(ignore);
  } else {
    el.webkitRequestFullscreen?.();
  }
}
