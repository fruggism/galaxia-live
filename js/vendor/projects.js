/*
 * Cube-Atlas project model and storage.
 *
 * A project bundles: which world/dimension it maps, the saved view, the
 * user's vector layers (roads / points of interest / areas) and the archive
 * documents. It is stored in IndexedDB and is exactly the shape that the
 * "esporta progetto" button downloads and the import accepts.
 *
 * All feature coordinates are Minecraft block coordinates [x, z], never
 * screen or tile coordinates, so a project stays valid at any zoom.
 */

import { idbGet, idbPut, idbDelete, idbGetAll } from './db.js';

export const FORMAT = 'cube-atlas/project';
export const FORMAT_VERSION = 1;
export const LAYER_TYPES = ['roads', 'pois', 'areas', 'transit', 'notes'];

export function newId(prefix) {
  const rand = (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Math.random().toString(36).slice(2)).slice(0, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

export const DEFAULT_ROAD_STYLE = {
  color: '#f2c14e', width: 4, dash: 'solid', opacity: 1,
  casingColor: '#2b2b2b', casingWidth: 2, showName: true,
};
export const DEFAULT_POI_STYLE = {
  shape: 'circle', color: '#e05a47', size: 10, showName: true,
};
export const DEFAULT_AREA_STYLE = {
  fillColor: '#4fa3d1', fillOpacity: 0.25,
  strokeColor: '#4fa3d1', strokeWidth: 2, dash: 'solid', showName: true,
};
/* A transit line looks like a road (colour/width/dash), and can optionally
 * take a road-style casing (contour) too — off by default, since a flat
 * stroke plus the sideways nudge from offsetTransitCoords is usually enough
 * to tell adjacent lines apart, but some maps want the contrast anyway. */
export const DEFAULT_TRANSIT_STYLE = {
  color: '#4fa3d1', width: 5, dash: 'solid', opacity: 1, showName: true,
  casingColor: '#2b2b2b', casingWidth: 0,
  // The default look for every station in the layer — small dots, so a
  // station doesn't outshine the lines. A single station can still override
  // shape/size for itself (see normalizeStation), which is when this
  // matters: it's what a station falls back to when it hasn't.
  stationShape: 'circle', stationSize: 10,
};
export const DEFAULT_NOTE_STYLE = {
  color: '#f5e14a', size: 16, showName: true,
};

export function defaultStyleFor(type) {
  if (type === 'roads') return { ...DEFAULT_ROAD_STYLE };
  if (type === 'pois') return { ...DEFAULT_POI_STYLE };
  if (type === 'transit') return { ...DEFAULT_TRANSIT_STYLE };
  if (type === 'notes') return { ...DEFAULT_NOTE_STYLE };
  return { ...DEFAULT_AREA_STYLE };
}

export const LAYER_TYPE_NAMES = {
  roads: 'Strade', pois: 'Punti di interesse', areas: 'Aree',
  transit: 'Trasporti', notes: 'Note',
};

export function makeLayer(type, name, parentId) {
  if (!LAYER_TYPES.includes(type)) throw new Error(`Tipo di layer sconosciuto: ${type}`);
  return {
    id: newId('lay'),
    type,
    name: name || LAYER_TYPE_NAMES[type],
    visible: true,
    locked: false,
    // A layer can nest under another purely for organization (e.g. a
    // "quartiere" area containing "strade"/"trasporti"/"edifici" sublayers).
    // Nesting has no effect on what a layer draws, only on the list and on
    // cascading visibility.
    parentId: typeof parentId === 'string' && parentId ? parentId : null,
    defaultStyle: defaultStyleFor(type),
    features: [],
    // Only meaningful for 'transit' layers, but present on every layer so
    // callers never have to guard against it being missing.
    stations: [],
  };
}

export function defaultLayers() {
  return [makeLayer('areas', 'Aree'), makeLayer('roads', 'Strade'), makeLayer('pois', 'Punti di interesse')];
}

// ---------------------------------------------------------------------------
// Validation / normalization
// ---------------------------------------------------------------------------

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function normCoord(c) {
  if (!Array.isArray(c) || c.length < 2 || !isNum(c[0]) || !isNum(c[1])) return null;
  return [c[0], c[1]];
}

function normCoords(list) {
  if (!Array.isArray(list)) return [];
  return list.map(normCoord).filter(Boolean);
}

/* A banner is stored inline as a small data URL. The cap is deliberate: these
 * live inside the project, which is kept in the browser's storage and gets
 * downloaded whole on export. */
export const MAX_IMAGE_BYTES = 400000;

function normalizeImage(value) {
  if (typeof value !== 'string') return null;
  if (!/^data:image\/(png|jpeg|webp|gif);base64,/.test(value)) return null;
  if (value.length > MAX_IMAGE_BYTES) return null;
  return value;
}

export function normalizeFeature(raw, layerType) {
  if (!raw || typeof raw !== 'object') return null;
  const base = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId('f'),
    name: typeof raw.name === 'string' ? raw.name : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    image: normalizeImage(raw.image),
    style: raw.style && typeof raw.style === 'object' ? { ...raw.style } : {},
  };
  if (layerType === 'pois' || layerType === 'notes') {
    const coord = normCoord(raw.coord);
    if (!coord) return null;
    const out = { ...base, coord };
    if (layerType === 'pois') out.category = typeof raw.category === 'string' ? raw.category : 'altro';
    return out;
  }
  const coords = normCoords(raw.coords);
  // A line needs 2 points; a closed area needs 3.
  if (coords.length < (layerType === 'areas' ? 3 : 2)) return null;
  const out = { ...base, coords };
  if (layerType === 'transit') {
    // Which shared stations (see normalizeStation) this line stops at.
    // Filtered against the layer's actual station list by normalizeLayer,
    // since that list isn't known here.
    out.stationIds = Array.isArray(raw.stationIds) ? raw.stationIds.filter((s) => typeof s === 'string') : [];
    // Per-line show/hide, set from the layer's "Linee visibili" menu.
    // Absent/anything but `false` means visible, so older saved projects
    // (before this field existed) show every line as before.
    out.visible = raw.visible !== false;
  }
  return out;
}

/* A station is not owned by any single line: several transit features in the
 * same layer can reference the same station id, which is how two metro lines
 * "share a stop" ("passare sulle stazioni per far fermare le linee anche
 * lì") without duplicating its position or name. */
const STATION_SHAPES = ['circle', 'square', 'rectangle'];

export function normalizeStation(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!isNum(raw.x) || !isNum(raw.z)) return null;
  const off = raw.labelOffset;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId('st'),
    x: raw.x,
    z: raw.z,
    name: typeof raw.name === 'string' ? raw.name : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    labelOffset: Array.isArray(off) && off.length === 2 && isNum(off[0]) && isNum(off[1]) ? [off[0], off[1]] : null,
    // null/absent means "use the layer's default symbol" (see
    // DEFAULT_TRANSIT_STYLE) — only set when this one station has been
    // customized individually from its own editor.
    shape: STATION_SHAPES.includes(raw.shape) ? raw.shape : null,
    size: isNum(raw.size) && raw.size > 0 ? raw.size : null,
  };
}

export function normalizeLayer(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = LAYER_TYPES.includes(raw.type) ? raw.type : null;
  if (!type) return null;
  const stations = type === 'transit' && Array.isArray(raw.stations)
    ? raw.stations.map(normalizeStation).filter(Boolean)
    : [];
  const stationIdSet = new Set(stations.map((s) => s.id));
  const features = Array.isArray(raw.features)
    ? raw.features.map((f) => normalizeFeature(f, type)).filter(Boolean)
    : [];
  if (type === 'transit') {
    // Drop references to stations that didn't survive normalization.
    for (const f of features) f.stationIds = (f.stationIds || []).filter((id) => stationIdSet.has(id));
  }
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId('lay'),
    type,
    name: typeof raw.name === 'string' && raw.name ? raw.name : 'Layer',
    visible: raw.visible !== false,
    locked: raw.locked === true,
    parentId: typeof raw.parentId === 'string' && raw.parentId ? raw.parentId : null,
    defaultStyle: { ...defaultStyleFor(type), ...(raw.defaultStyle || {}) },
    features,
    stations,
  };
}

/** Drop parentId links that point nowhere, or that would form a cycle —
 *  both would otherwise make the layer tree impossible to render. */
function sanitizeLayerTree(layers) {
  const byId = new Map(layers.map((l) => [l.id, l]));
  for (const layer of layers) {
    if (!layer.parentId) continue;
    if (!byId.has(layer.parentId) || layer.parentId === layer.id) { layer.parentId = null; continue; }
    const seen = new Set([layer.id]);
    let cur = byId.get(layer.parentId);
    while (cur) {
      if (seen.has(cur.id)) { layer.parentId = null; break; }
      seen.add(cur.id);
      cur = cur.parentId ? byId.get(cur.parentId) : null;
    }
  }
  return layers;
}

/* Blocks hidden by default: both are invisible in game, and both otherwise
 * draw solid walls across the map. */
export const DEFAULT_HIDDEN_BLOCKS = ['minecraft:barrier', 'minecraft:light'];

/** "barrier" and "minecraft:barrier" mean the same thing to a player. */
export function normalizeBlockName(name) {
  const clean = String(name || '').trim().toLowerCase().replace(/\s+/g, '_');
  if (!clean) return null;
  if (!/^[a-z0-9_.:\/-]+$/.test(clean)) return null;
  return clean.includes(':') ? clean : `minecraft:${clean}`;
}

export function normalizeBlockList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    const name = normalizeBlockName(item);
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

function normalizeSettings(raw, existing) {
  const from = (raw && raw.settings) || null;
  const prev = (existing && existing.settings) || null;
  const pick = (key, fallback) => {
    if (from && from[key] !== undefined) return from[key];
    if (prev && prev[key] !== undefined) return prev[key];
    return fallback;
  };
  return {
    showTerrain: pick('showTerrain', true) !== false,
    showRails: pick('showRails', false) === true,
    hiddenBlocks: from && from.hiddenBlocks !== undefined
      ? normalizeBlockList(from.hiddenBlocks)
      : (prev && prev.hiddenBlocks !== undefined
        ? normalizeBlockList(prev.hiddenBlocks)
        : [...DEFAULT_HIDDEN_BLOCKS]),
  };
}

/** The saved map view, or null when the project has never been positioned. */
export function normalizeView(raw, existing) {
  const fromRaw = raw && raw.view;
  if (fromRaw && normCoord(fromRaw.center)) {
    return { center: normCoord(fromRaw.center), zoom: isNum(fromRaw.zoom) ? fromRaw.zoom : -2 };
  }
  return (existing && existing.view) || null;
}

/**
 * Coerce arbitrary input (a PUT body, or an imported file) into a valid
 * project. Unknown fields are dropped rather than trusted.
 */
export function normalizeProject(raw, existing) {
  const now = new Date().toISOString();
  const world = (raw && raw.world) || (existing && existing.world) || {};
  const layers = sanitizeLayerTree(Array.isArray(raw && raw.layers)
    ? raw.layers.map(normalizeLayer).filter(Boolean)
    : (existing ? existing.layers : defaultLayers()));

  return {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    id: (existing && existing.id) || (raw && typeof raw.id === 'string' && raw.id) || newId('p'),
    name: (raw && typeof raw.name === 'string' && raw.name.trim()) || (existing && existing.name) || 'Nuovo atlante',
    world: {
      path: world.path || '',
      id: world.id || '',
      dimension: world.dimension || 'overworld',
      levelName: world.levelName || '',
    },
    // A brand-new project has no saved view, which is what tells the map to
    // frame the whole generated world instead of jumping to an arbitrary spot.
    view: normalizeView(raw, existing),
    settings: normalizeSettings(raw, existing),
    layers: layers.length ? layers : defaultLayers(),
    // Documents used to live here, but the Archivio is independent of any
    // atlas now (see app/documents.js) — a project no longer carries them.
    createdAt: (existing && existing.createdAt) || now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export async function listProjects() {
  const all = await idbGetAll('projects');
  return all
    .map((p) => ({
      id: p.id,
      name: p.name,
      updatedAt: p.updatedAt,
      world: p.world,
      layerCount: (p.layers || []).length,
      featureCount: (p.layers || []).reduce((n, l) => n + (l.features || []).length, 0),
    }))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export async function getProject(id) {
  return (await idbGet('projects', id)) || null;
}

export async function createProject(raw) {
  const project = normalizeProject({ ...raw, id: undefined }, null);
  if (!project.layers.length) project.layers = defaultLayers();
  await idbPut('projects', project);
  return project;
}

export async function saveProject(id, raw) {
  const existing = await getProject(id);
  if (!existing) throw new Error('Progetto non trovato');
  const merged = normalizeProject(raw, existing);
  await idbPut('projects', merged);
  return merged;
}

export async function deleteProject(id) {
  await idbDelete('projects', id);
}

/** Import always creates a new project rather than overwriting whatever
 *  happens to share its id. */
export async function importProject(raw, nameSuffix) {
  if (raw && raw.format && raw.format !== FORMAT) {
    throw new Error('Il file non sembra un progetto Cube-Atlas');
  }
  const project = normalizeProject({ ...raw, id: undefined }, null);
  if (nameSuffix) project.name = `${project.name}${nameSuffix}`;
  await idbPut('projects', project);
  return project;
}
