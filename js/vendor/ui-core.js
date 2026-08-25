/*
 * Cube-Atlas — shared state and small UI utilities.
 *
 * Where the earlier version talked to a local server, this one calls the
 * project store (IndexedDB) and the map worker directly: there is no server.
 */

import * as projects from './projects.js';
import { engine } from './engine.js';

// -------------------------------------------------------------- state
export const state = {
  world: null,        // result of /api/world/scan
  project: null,      // the open project (source of truth for layers/docs)
  selectedLayerId: null,
  selectedFeature: null, // { layerId, featureId }
  selectedStation: null, // { layerId, stationId } — mutually exclusive with selectedFeature
  map: null,
  dirty: false,
};

// -------------------------------------------------------- coordinates
// Leaflet CRS.Simple with block coordinates as CRS units:
//   lng = blockX, lat = -blockZ  (so north is up and X grows east)
export const toLatLng = (x, z) => L.latLng(-z, x);
export const fromLatLng = (ll) => ({ x: ll.lng, z: -ll.lat });
export const roundCoord = (v) => Math.round(v * 100) / 100;

// ------------------------------------------------------------- utils
export const el = (id) => document.getElementById(id);

export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

let toastTimer = null;
export function toast(message, kind) {
  const host = el('toast-host');
  const node = document.createElement('div');
  node.className = `toast ${kind || ''}`;
  node.textContent = message;
  host.appendChild(node);
  clearTimeout(toastTimer);
  setTimeout(() => node.remove(), 3200);
}

export function setStatus(id, message, kind) {
  const node = el(id);
  if (!node) return;
  node.textContent = message || '';
  node.className = `status ${kind || ''}`;
}

/** Minecraft-styled replacement for window.confirm. */
export function confirmDialog({ title, message, confirmLabel = 'Conferma', danger = false }) {
  return new Promise((resolve) => {
    const host = el('modal-host');
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal">
        <h3>${escapeHtml(title)}</h3>
        <div class="modal-body">${escapeHtml(message)}</div>
        <div class="row">
          <button class="btn" data-act="cancel">Annulla</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`;
    const done = (value) => { backdrop.remove(); resolve(value); };
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) done(false);
      const act = e.target.dataset && e.target.dataset.act;
      if (act === 'ok') done(true);
      if (act === 'cancel') done(false);
    });
    host.appendChild(backdrop);
    backdrop.querySelector('[data-act="ok"]').focus();
  });
}

/** Minecraft-styled replacement for window.prompt. */
export function promptDialog({ title, message, value = '', confirmLabel = 'OK' }) {
  return new Promise((resolve) => {
    const host = el('modal-host');
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal">
        <h3>${escapeHtml(title)}</h3>
        <div class="modal-body">
          <label><span class="lbl">${escapeHtml(message)}</span>
          <input type="text" class="prompt-input" value="${escapeHtml(value)}"></label>
        </div>
        <div class="row">
          <button class="btn" data-act="cancel">Annulla</button>
          <button class="btn btn-primary" data-act="ok">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`;
    const input = backdrop.querySelector('.prompt-input');
    const done = (value2) => { backdrop.remove(); resolve(value2); };
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) done(null);
      const act = e.target.dataset && e.target.dataset.act;
      if (act === 'ok') done(input.value);
      if (act === 'cancel') done(null);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(input.value);
      if (e.key === 'Escape') done(null);
    });
    host.appendChild(backdrop);
    input.focus();
    input.select();
  });
}

/** A row of labeled buttons instead of a single confirm/cancel — used to
 *  pick a layer type when creating a sublayer. Resolves the chosen value,
 *  or null if dismissed. */
export function pickDialog({ title, message, options }) {
  return new Promise((resolve) => {
    const host = el('modal-host');
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal">
        <h3>${escapeHtml(title)}</h3>
        ${message ? `<div class="modal-body">${escapeHtml(message)}</div>` : ''}
        <div class="modal-options">${options.map((o) => (
          `<button class="btn btn-sm" data-val="${escapeHtml(o.value)}">${o.label}</button>`
        )).join('')}</div>
        <div class="row"><button class="btn" data-act="cancel">Annulla</button></div>
      </div>`;
    const done = (value) => { backdrop.remove(); resolve(value); };
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) done(null);
      if (e.target.dataset.act === 'cancel') done(null);
      if (e.target.dataset.val !== undefined) done(e.target.dataset.val);
    });
    host.appendChild(backdrop);
  });
}

/** A read-only info panel — the report ("elenco linee e stazioni") and
 *  similar one-way displays. `bodyHtml` is trusted markup the caller has
 *  already escaped where it embeds user data. */
export function alertDialog({ title, bodyHtml, closeLabel = 'Chiudi' }) {
  return new Promise((resolve) => {
    const host = el('modal-host');
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal">
        <h3>${escapeHtml(title)}</h3>
        <div class="modal-body">${bodyHtml}</div>
        <div class="row"><button class="btn btn-primary" data-act="ok">${escapeHtml(closeLabel)}</button></div>
      </div>`;
    const done = () => { backdrop.remove(); resolve(); };
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) done();
      if (e.target.dataset && e.target.dataset.act === 'ok') done();
    });
    host.appendChild(backdrop);
  });
}

export function download(filename, content, mime) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime || 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function slugify(s) {
  return String(s || 'cube-atlas').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'cube-atlas';
}

export function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// --------------------------------------------------- project helpers
export function findLayer(layerId) {
  if (!state.project) return null;
  return state.project.layers.find((l) => l.id === layerId) || null;
}

export function selectedLayer() { return findLayer(state.selectedLayerId); }

export function findFeature(layerId, featureId) {
  const layer = findLayer(layerId);
  if (!layer) return null;
  return layer.features.find((f) => f.id === featureId) || null;
}

export function selectedFeature() {
  if (!state.selectedFeature) return null;
  return findFeature(state.selectedFeature.layerId, state.selectedFeature.featureId);
}

export function findStation(layerId, stationId) {
  const layer = findLayer(layerId);
  if (!layer) return null;
  return (layer.stations || []).find((s) => s.id === stationId) || null;
}

export function selectedStation() {
  if (!state.selectedStation) return null;
  return findStation(state.selectedStation.layerId, state.selectedStation.stationId);
}

// Autosave: coalesce rapid edits into a single PUT.
export const saveNow = async () => {
  if (!state.project) return;
  try {
    const saved = await projects.saveProject(state.project.id, state.project);
    // Keep local layer/feature ids stable by merging only bookkeeping fields.
    state.project.updatedAt = saved.updatedAt;
    state.dirty = false;
    setStatus('save-status', `Salvato alle ${new Date().toLocaleTimeString('it-IT')}`, 'ok');
  } catch (err) {
    setStatus('save-status', `Salvataggio fallito: ${err.message}`, 'err');
  }
};
const scheduleSave = debounce(saveNow, 600);

export function markDirty() {
  if (!state.project) return;
  state.dirty = true;
  setStatus('save-status', 'Modifiche non salvate…', 'busy');
  scheduleSave();
}

/** Push any debounced-but-unsaved edits before the page goes away.
 *  sendBeacon survives unload, which a normal fetch does not. */
export function flushOnExit() {
  if (!state.project || !state.dirty) return;
  try {
    const blob = new Blob([JSON.stringify(state.project)], { type: 'application/json' });
    navigator.sendBeacon(`/api/projects/${state.project.id}/flush`, blob);
    state.dirty = false;
  } catch { /* nothing more we can do at unload time */ }
}
window.addEventListener('pagehide', flushOnExit);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushOnExit();
});


/** The map worker, exposed so the UI modules share one instance. */
export { engine };
export { projects };
