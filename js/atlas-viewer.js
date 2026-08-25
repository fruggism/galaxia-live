/*
 * Galaxia Live — visualizzatore dell'Atlante, sempre attivo.
 *
 * Variante "auto-load" del Lettore di Cube-Atlas: invece di far scegliere un
 * file all'utente, carica da solo data/atlas.json (lo stesso formato che
 * l'Editor di Cube-Atlas scrive con "🗺️ Esporta atlante", semplicemente
 * salvato con questo nome fisso). Il rendering dei layer è lo stesso
 * dell'app originale, importato da atlas.js così look & feel restano identici.
 */

import { el, escapeHtml, setStatus, toLatLng } from './vendor/ui-core.js';
import * as Atlas from './vendor/atlas.js';
import { listJsonFiles, fetchJson } from './github-folder.js';

const READER_MAP_FORMAT = Atlas.READER_MAP_FORMAT || 'cube-atlas/map';
const ATLAS_FOLDER = 'data/atlante';

let map = null;
let layers = [];
const layerGroups = new Map();

function showEmpty(message) {
  el('map-empty').classList.remove('hidden');
  el('map-view').classList.add('hidden');
  el('map-layers-panel').classList.add('hidden');
  if (message) el('map-empty-msg').textContent = message;
}

function showMap() {
  el('map-empty').classList.add('hidden');
  el('map-view').classList.remove('hidden');
  el('map-layers-panel').classList.remove('hidden');
}

function initMap() {
  if (map) return map;
  map = L.map('reader-map', {
    crs: L.CRS.Simple,
    minZoom: -6,
    maxZoom: 4,
    zoomSnap: 0.25,
    attributionControl: false,
    zoomControl: true,
  });
  return map;
}

function layerVisible(layer) {
  let cur = layer;
  const seen = new Set();
  while (cur) {
    if (cur.visible === false) return false;
    if (seen.has(cur.id)) break;
    seen.add(cur.id);
    cur = cur.parentId ? layers.find((l) => l.id === cur.parentId) : null;
  }
  return true;
}

function buildFeature(feature, layer) {
  const style = Atlas.styleOf(feature, layer);
  const group = L.layerGroup();
  let primary;

  if (layer.type === 'areas') {
    primary = L.polygon(feature.coords.map(([x, z]) => toLatLng(x, z)), {
      color: style.strokeColor || '#4fa3d1',
      weight: Number(style.strokeWidth) || 2,
      dashArray: Atlas.dashFor(style),
      fillColor: style.fillColor || '#4fa3d1',
      fillOpacity: style.fillOpacity ?? 0.25,
    });
  } else if (layer.type === 'roads' || layer.type === 'transit') {
    const coords = layer.type === 'transit' ? Atlas.offsetTransitCoords(feature, layer) : feature.coords;
    primary = L.polyline(coords.map(([x, z]) => toLatLng(x, z)), {
      color: style.color || (layer.type === 'transit' ? '#4fa3d1' : '#f2c14e'),
      weight: Number(style.width) || (layer.type === 'transit' ? 5 : 4),
      opacity: style.opacity ?? 1,
      dashArray: Atlas.dashFor(style),
      lineJoin: 'round',
    });
  } else if (layer.type === 'notes') {
    const size = Number(style.size) || 16;
    primary = L.marker(toLatLng(feature.coord[0], feature.coord[1]), {
      icon: L.divIcon({
        className: 'ca-poi ca-note', html: Atlas.noteSvg(style.color || '#f5e14a', size),
        iconSize: [size, size], iconAnchor: [size / 2, size],
      }),
      keyboard: false,
    });
  } else {
    const size = Number(style.size) || 10;
    primary = L.marker(toLatLng(feature.coord[0], feature.coord[1]), {
      icon: L.divIcon({
        className: 'ca-poi', html: Atlas.poiSvg(style.shape || 'circle', style.color || '#e05a47', size),
        iconSize: [size, size], iconAnchor: style.shape === 'pin' ? [size / 2, size] : [size / 2, size / 2],
      }),
      keyboard: false,
    });
  }
  group.addLayer(primary);
  if (feature.image) group.addLayer(Atlas.bannerMarker(feature, layer));

  if (style.showName !== false && feature.name) {
    primary.bindTooltip(escapeHtml(feature.name), {
      permanent: true,
      direction: Atlas.isPointLayer(layer.type) ? 'right' : 'center',
      offset: Atlas.isPointLayer(layer.type) ? [Number(style.size) / 2 + 2 || 8, 0] : [0, 0],
      className: `ca-label${layer.type === 'areas' ? ' big' : ''}`,
      sticky: false,
    });
  }
  primary.bindPopup(Atlas.popupHtml(feature, layer), { closeButton: false, autoPan: false, className: 'ca-info-popup' });
  primary.on('mouseover', () => primary.openPopup());
  primary.on('mouseout', () => primary.closePopup());
  return group;
}

function buildStation(station, layer) {
  const size = 14;
  const marker = L.marker(toLatLng(station.x, station.z), {
    icon: L.divIcon({
      className: 'ca-poi ca-station', html: Atlas.stationSvg(size),
      iconSize: [size, size], iconAnchor: [size / 2, size / 2],
    }),
    keyboard: false,
  });
  if (station.name) {
    marker.bindTooltip(escapeHtml(station.name), {
      permanent: true, direction: 'right', offset: [size / 2 + 2, 0], className: 'ca-label', sticky: false,
    });
  }
  const lines = (layer.features || [])
    .filter((f) => (f.stationIds || []).includes(station.id))
    .map((f) => f.name || '(senza nome)');
  marker.bindPopup(`<div class="ca-popup">
      <h4>${escapeHtml(station.name || '(stazione)')}</h4>
      ${station.description ? `<p class="desc">${escapeHtml(station.description)}</p>` : ''}
      <div class="meta">Stazione · ${lines.length ? escapeHtml(lines.join(', ')) : 'nessuna linea collegata'}</div>
    </div>`, { closeButton: false, autoPan: false, className: 'ca-info-popup' });
  marker.on('mouseover', () => marker.openPopup());
  marker.on('mouseout', () => marker.closePopup());
  return marker;
}

function renderLayers() {
  for (const g of layerGroups.values()) map.removeLayer(g);
  layerGroups.clear();
  for (const layer of layers) {
    const group = L.layerGroup();
    for (const feature of layer.features || []) group.addLayer(buildFeature(feature, layer));
    if (layer.type === 'transit') {
      for (const station of layer.stations || []) group.addLayer(buildStation(station, layer));
    }
    layerGroups.set(layer.id, group);
    if (layerVisible(layer)) group.addTo(map);
  }
}

function applyVisibility() {
  for (const layer of layers) {
    const group = layerGroups.get(layer.id);
    if (!group) continue;
    const visible = layerVisible(layer);
    if (visible && !map.hasLayer(group)) group.addTo(map);
    if (!visible && map.hasLayer(group)) map.removeLayer(group);
  }
}

const LAYER_ICONS = { roads: '🛣️', pois: '📍', areas: '⬟', transit: '🚇', notes: '📝' };

function renderLayerList() {
  const host = el('atlas-layer-list');
  const byParent = new Map();
  for (const l of layers) {
    const key = l.parentId || '';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(l);
  }
  const order = [];
  const visit = (key, depth) => {
    for (const l of byParent.get(key) || []) { order.push({ layer: l, depth }); visit(l.id, depth + 1); }
  };
  visit('', 0);
  const seen = new Set(order.map((o) => o.layer.id));
  for (const l of layers) if (!seen.has(l.id)) order.push({ layer: l, depth: 0 });

  host.innerHTML = order.map(({ layer, depth }) => `
    <li class="layer-item" data-id="${layer.id}" style="padding-left:${7 + depth * 16}px">
      <span class="eye ${layer.visible === false ? 'off' : ''}" data-eye="${layer.id}" title="Mostra/nascondi">👁</span>
      <span class="kind" title="${layer.type}">${LAYER_ICONS[layer.type] || '•'}</span>
      <span class="lname">${escapeHtml(layer.name)}</span>
      <span class="count">${(layer.features || []).length}</span>
    </li>`).join('');

  host.querySelectorAll('.eye').forEach((node) => {
    node.addEventListener('click', () => {
      const layer = layers.find((l) => l.id === node.dataset.eye);
      if (!layer) return;
      layer.visible = layer.visible === false;
      applyVisibility();
      renderLayerList();
    });
  });
}

/** Se la mappa ha un layer "Province", parte visibile solo quello: gli
 *  altri (strade, punti, trasporti…) restano lì, un clic sull'occhio
 *  li riaccende quando servono. */
function applyDefaultVisibility() {
  const hasProvince = layers.some((l) => (l.name || '').trim().toLowerCase() === 'province');
  if (!hasProvince) return;
  for (const l of layers) l.visible = (l.name || '').trim().toLowerCase() === 'province';
}

function openBundle(raw) {
  const m = initMap();
  layers = Array.isArray(raw.layers) ? raw.layers : [];
  applyDefaultVisibility();
  showMap();
  setTimeout(() => m.invalidateSize(), 30);

  const b = raw.bounds || {};
  const bounds = L.latLngBounds(toLatLng(b.minX || 0, b.minZ || 0), toLatLng(b.maxX || 0, b.maxZ || 0));
  m.eachLayer((l) => { if (l instanceof L.ImageOverlay) m.removeLayer(l); });
  if (raw.image) L.imageOverlay(raw.image, bounds).addTo(m);
  m.fitBounds(bounds);

  renderLayers();
  renderLayerList();
}

/** Il nome mostrato nel menu è il nome del file: rinominalo come vuoi
 *  prima di caricarlo in data/atlante/, l'estensione e un eventuale
 *  "_ATLAS"/"-ATLAS" finale (quello che l'Editor aggiunge da solo)
 *  vengono tolti automaticamente. */
function labelFromFilename(name) {
  const base = name.replace(/\.camap\.json$/i, '').replace(/\.json$/i, '')
    .replace(/[_-]?ATLAS$/i, '').replace(/[_-]+/g, ' ').trim();
  return base || name;
}

let files = [];
let selectedName = null;

function renderAtlasList() {
  const host = el('atlas-list');
  if (!host) return;
  host.innerHTML = files.map((f) => `
    <li class="doc-item ${f.name === selectedName ? 'selected' : ''}" data-name="${escapeHtml(f.name)}">
      <b>${escapeHtml(labelFromFilename(f.name))}</b>
    </li>`).join('');
  host.querySelectorAll('.doc-item').forEach((node) => {
    node.addEventListener('click', () => openAtlas(node.dataset.name));
  });
}

async function openAtlas(name) {
  const file = files.find((f) => f.name === name);
  if (!file) return;
  selectedName = name;
  renderAtlasList();
  const label = labelFromFilename(file.name);
  if (el('current-atlas-label')) el('current-atlas-label').textContent = label;
  try {
    const raw = await fetchJson(file.download_url);
    if (!raw || raw.format !== READER_MAP_FORMAT) {
      throw new Error(`"${file.name}" non è un atlante Cube-Atlas valido`);
    }
    openBundle(raw);
    setStatus('atlas-status', `"${label}" — aggiornato al ${new Date().toLocaleString('it-IT')}`, 'ok');
  } catch (err) {
    showEmpty(`Caricamento non riuscito: ${err.message}`);
    setStatus('atlas-status', `Caricamento non riuscito: ${err.message}`, 'err');
  }
}

async function load() {
  try {
    files = (await listJsonFiles(ATLAS_FOLDER)).sort((a, b) => labelFromFilename(a.name).localeCompare(labelFromFilename(b.name), 'it'));
    renderAtlasList();
    if (!files.length) {
      showEmpty('Nessun atlante caricato ancora: da Cube-Atlas Editor, esporta con "🗺️ Esporta atlante" e trascina il file in data/atlante/ di questo repository — rinominalo come preferisci, sarà il nome mostrato qui.');
      return;
    }
    await openAtlas(files[0].name);
  } catch (err) {
    showEmpty(`Caricamento non riuscito: ${err.message}`);
    setStatus('atlas-status', `Caricamento non riuscito: ${err.message}`, 'err');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  showEmpty();
  load();
  el('btn-atlas-reload').addEventListener('click', load);
});
