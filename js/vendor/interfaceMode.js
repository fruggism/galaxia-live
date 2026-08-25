/*
 * Desktop vs iPad interface mode — a deliberate choice from the selector in
 * the header, not an automatic (max-width:...) guess, because a mouse user
 * on a narrow window and a pencil user on an iPad need different things:
 * the narrow-window case just needs the layout to stack (see the existing
 * @media rule in style.css), while iPad mode also changes *behaviour* —
 * bigger touch targets, tap instead of hover for info, and freehand areas
 * get straightened after drawing (see atlas.js's straightenPolygon).
 *
 * Persisted so it survives a reload; read synchronously at module load so
 * the very first paint already has the right data-interface attribute and
 * nothing flashes in the wrong mode.
 */

const KEY = 'cube-atlas-interface';

export function getInterfaceMode() {
  try {
    return localStorage.getItem(KEY) === 'ipad' ? 'ipad' : 'desktop';
  } catch {
    return 'desktop';
  }
}

export function setInterfaceMode(mode) {
  const clean = mode === 'ipad' ? 'ipad' : 'desktop';
  try { localStorage.setItem(KEY, clean); } catch { /* private mode: won't persist, still applies for this session */ }
  document.documentElement.dataset.interface = clean;
}

export function isIpadMode() {
  return document.documentElement.dataset.interface === 'ipad';
}

// Applied immediately on import, before the rest of the app wires up, so
// the header select and CSS agree with storage from the first frame.
setInterfaceMode(getInterfaceMode());
