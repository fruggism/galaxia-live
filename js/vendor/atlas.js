/*
 * Cube-Atlas — the map screen: tile background, vector layers (roads /
 * points of interest / areas), drawing + editing tools, and export.
 *
 * Terrain tiles come from the map worker as ImageBitmaps and are painted into
 * canvas tiles, so nothing on this thread ever parses a region file.
 */

import {
  state, el, escapeHtml, toast, toLatLng, fromLatLng, roundCoord,
  debounce, newId, confirmDialog, promptDialog, pickDialog, download, slugify, setStatus, markDirty,
  findLayer, selectedLayer, findFeature, selectedFeature, findStation, selectedStation, engine,
} from './ui-core.js';
import { isIpadMode } from './interfaceMode.js';

const DASHES = {
  solid: null,
  dashed: '12,8',
  dotted: '1,7',
  dashdot: '14,7,3,7',
};
const DASH_LABELS = { solid: 'continuo', dashed: 'tratteggiato', dotted: 'punteggiato', dashdot: 'tratto-punto' };

const PALETTE = [
  '#e8453c', '#f2c14e', '#5fa839', '#4fa3d1', '#8a63d2', '#e07a3f',
  '#e888c0', '#f5f0e6', '#8b6b4a', '#3c3c3c', '#2bb5a0', '#c9d63f',
];

const POI_SHAPES = ['circle', 'square', 'triangle', 'diamond', 'star', 'pin'];

const POI_CATEGORIES = [
  'abitazione', 'negozio', 'fattoria', 'industria', 'istituzioni', 'monumento',
  'stazione', 'porto', 'tempio', 'castello', 'miniera',
  'fiume', 'montagna', 'lago', 'altro',
];

// Runtime map objects, keyed by feature id. Rebuilt whenever the project
// reloads; the project JSON stays the single source of truth.
const rendered = new Map();     // featureId -> { layerId, group, primary, feature }
const layerGroups = new Map();  // layerId -> L.LayerGroup
const stationGroups = new Map(); // layerId -> L.LayerGroup (transit stations only)
let extendTarget = null;         // { layerId, featureId } while continuing an existing line
let placingStation = null;       // { layerId, featureId, name } while placing a new station by clicking the map

// Clicking within this many blocks of an existing station reuses it instead
// of creating an overlapping twin — this is how you deliberately attach a
// new station to an existing one, or place one on an existing line.
const STATION_CLICK_SNAP_BLOCKS = 10;
// Tolerance for auto-attaching while *drawing*: generous enough that a
// normal, not pixel-perfect click on or near an existing stop reliably
// catches it (this was too tight before and rarely triggered).
const STATION_DRAW_SNAP_BLOCKS = 8;
// Sideways nudge, in blocks, applied to each line sharing an exact stretch
// of track with another line in the same layer, so "linee adiacenti" don't
// render as one indistinguishable stroke. Purely visual.
const TRANSIT_OFFSET_BLOCKS = 3;

let map = null;
let tileLayer = null;
let railLayer = null;
let worldBounds = null;
let currentDim = null;
let drawHandler = null;
let editingFeatureId = null;
let currentTool = 'select';

// ------------------------------------------------------------------ map
function initMap() {
  map = L.map('map', {
    crs: L.CRS.Simple,
    minZoom: -6,
    maxZoom: 5,
    zoomSnap: 0.5,
    zoomDelta: 0.5,
    wheelPxPerZoomLevel: 90,
    attributionControl: false,
    zoomControl: true,
    doubleClickZoom: false, // double-click finishes a drawing instead
  });
  state.map = map;
  // Rails go in their own pane: above the terrain, below anything drawn.
  map.createPane('railPane');
  map.getPane('railPane').style.zIndex = 250;
  map.setView([0, 0], -2);
  // Handles for debugging and for the browser test harness.
  window.__map = map;
  window.__fromLatLng = fromLatLng;

  map.on('mousemove', (e) => {
    const { x, z } = fromLatLng(e.latlng);
    el('coord-readout').innerHTML = `X <b>${Math.floor(x)}</b>&nbsp; Z <b>${Math.floor(z)}</b>`;
  });
  map.on('moveend zoomend', () => { persistView(); updateViewInfo(); });
  map.on(L.Draw.Event.CREATED, onDrawCreated);
  // Clicking empty map clears the selection — but a click that landed on a
  // feature must not, and Leaflet still fires the map's click after the
  // layer's, so check what was actually hit rather than relying on
  // propagation being stopped.
  map.on('click', (e) => {
    if (placingStation) { placeStationAt(e.latlng); return; }
    if (currentTool !== 'select') return;
    if (hitsFeature(e.originalEvent)) return;
    selectFeature(null);
  });

  return map;
}

/** True when a DOM event landed on a drawn feature (vector path, POI icon
 *  or its label) rather than on the bare map. */
function hitsFeature(domEvent) {
  const target = domEvent && domEvent.target;
  if (!target || !target.closest) return false;
  return !!(target.closest('.leaflet-interactive')
    || target.closest('.ca-poi')
    || target.closest('.ca-label'));
}

function persistView() {
  if (!state.project || !map) return;
  const c = fromLatLng(map.getCenter());
  state.project.view = { center: [roundCoord(c.x), roundCoord(c.z)], zoom: map.getZoom() };
  markDirty();
}

/**
 * Terrain layer: each Leaflet tile is a canvas the worker paints into.
 * Tiles arrive as ImageBitmaps (transferred, not copied) and a tile the
 * worker reports as "partial" is re-requested shortly after, which is how the
 * map fills in while a generation job runs.
 */
function makeTerrainLayer(dimId, kind) {
  const TerrainLayer = L.GridLayer.extend({
    createTile(coords, done) {
      const tile = document.createElement('canvas');
      tile.width = 256;
      tile.height = 256;
      const ctx = tile.getContext('2d');
      engine.tile(dimId, coords.z, coords.x, coords.y, kind).then((res) => {
        if (res && !res.empty && res.bitmap) {
          ctx.drawImage(res.bitmap, 0, 0);
          res.bitmap.close();
        }
        tile.dataset.partial = res && res.partial ? '1' : '';
        done(null, tile);
      }).catch((err) => done(err, tile));
      return tile;
    },
  });
  return new TerrainLayer({
    tileSize: 256,
    minZoom: -6, maxZoom: 5,
    minNativeZoom: -6, maxNativeZoom: 0,
    noWrap: true,
    keepBuffer: 2,
    updateWhenZooming: false,
    className: 'ca-terrain-tiles',
    // Rails sit above the terrain but below the drawn layers.
    pane: kind === 'rails' ? 'railPane' : 'tilePane',
  });
}

/** Point the map at a world + dimension. */
function attachWorld(world, dimId, view) {
  if (tileLayer) { map.removeLayer(tileLayer); tileLayer = null; }
  const dim = world.dimensions.find((d) => d.id === dimId) || world.dimensions[0];
  currentDim = dim;

  tileLayer = makeTerrainLayer(dim.id, 'terrain');
  if (railLayer) { map.removeLayer(railLayer); railLayer = null; }
  railLayer = makeTerrainLayer(dim.id, 'rails');
  // Terrain is always shown, rails never — there's no toggle for either in
  // the UI any more (setTerrainVisible/setRailsVisible still work if
  // something ever needs to flip them programmatically).
  tileLayer.addTo(map);

  // Panning is bounded by the generated area, but generously: a tight bound
  // makes the map feel stuck, which is worse than letting the user drift a
  // little into the void.
  const b = dim.bounds;
  worldBounds = L.latLngBounds(toLatLng(b.minX, b.minZ), toLatLng(b.maxX + 1, b.maxZ + 1));
  map.setMaxBounds(worldBounds.pad(1.0));

  if (view && Array.isArray(view.center)) {
    map.setView(toLatLng(view.center[0], view.center[1]), view.zoom ?? -2);
  } else {
    // A freshly opened world starts where the player does, at one pixel per
    // block — not zoomed out over an explored area that can be tens of
    // thousands of blocks wide, where a whole town is a few pixels.
    const spawn = world.spawn || { x: 0, z: 0 };
    goTo(spawn.x, spawn.z, 0);
  }
  el('map-overlay').classList.add('hidden');
  updateViewInfo();
}

/** Centre the map on a block coordinate. */
function goTo(x, z, zoom) {
  if (!map) return;
  const target = toLatLng(Number(x) || 0, Number(z) || 0);
  // Don't let maxBounds silently refuse a jump to a far-away coordinate.
  if (worldBounds && !worldBounds.pad(1.0).contains(target)) {
    map.setMaxBounds(null);
    map.setView(target, zoom ?? map.getZoom());
    return;
  }
  map.setView(target, zoom ?? map.getZoom());
}

function fitWorld() {
  if (worldBounds) {
    map.setMaxBounds(worldBounds.pad(1.0));
    map.fitBounds(worldBounds);
  }
}

function updateViewInfo() {
  const node = el('view-info');
  if (!node || !map) return;
  const c = fromLatLng(map.getCenter());
  const z = map.getZoom();
  const scale = Math.pow(2, z);
  const blocksAcross = Math.round(map.getSize().x / scale);
  node.textContent = `Centro X ${Math.round(c.x)}, Z ${Math.round(c.z)} — larghezza vista ~${blocksAcross} blocchi`;
}

/** Re-request the map tiles (after a render job produced new ones). */
function refreshTiles() {
  if (tileLayer) tileLayer.redraw();
  if (railLayer) railLayer.redraw();
}

function setRailsVisible(visible) {
  if (!railLayer || !map) return;
  if (visible && !map.hasLayer(railLayer)) railLayer.addTo(map);
  if (!visible && map.hasLayer(railLayer)) map.removeLayer(railLayer);
}

function currentDimension() { return currentDim; }

// -------------------------------------------------------------- styling
function styleOf(feature, layer) {
  return { ...(layer.defaultStyle || {}), ...(feature.style || {}) };
}

function dashFor(style) {
  const key = style.dash || 'solid';
  return DASHES[key] !== undefined ? DASHES[key] : null;
}

// ------------------------------------------------------- POI shape icon
function poiSvg(shape, color, size) {
  const s = size;
  const half = s / 2;
  const stroke = '#0d0d0d';
  const common = `stroke="${stroke}" stroke-width="2" vector-effect="non-scaling-stroke"`;
  let body;
  switch (shape) {
    case 'square':
      body = `<rect x="1" y="1" width="${s - 2}" height="${s - 2}" fill="${color}" ${common}/>`;
      break;
    case 'triangle':
      body = `<polygon points="${half},1 ${s - 1},${s - 1} 1,${s - 1}" fill="${color}" ${common}/>`;
      break;
    case 'diamond':
      body = `<polygon points="${half},1 ${s - 1},${half} ${half},${s - 1} 1,${half}" fill="${color}" ${common}/>`;
      break;
    case 'star': {
      const pts = [];
      for (let i = 0; i < 10; i++) {
        const r = i % 2 === 0 ? half - 1 : half * 0.45;
        const a = (Math.PI / 5) * i - Math.PI / 2;
        pts.push(`${(half + r * Math.cos(a)).toFixed(1)},${(half + r * Math.sin(a)).toFixed(1)}`);
      }
      body = `<polygon points="${pts.join(' ')}" fill="${color}" ${common}/>`;
      break;
    }
    case 'pin':
      body = `<path d="M ${half} ${s - 1} L 1 ${half * 0.85} A ${half - 1} ${half - 1} 0 1 1 ${s - 1} ${half * 0.85} Z" fill="${color}" ${common}/>`;
      break;
    case 'circle':
    default:
      body = `<circle cx="${half}" cy="${half}" r="${half - 1.5}" fill="${color}" ${common}/>`;
  }
  return `<svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
}

const isPointLayer = (type) => type === 'pois' || type === 'notes';

/** The point a feature's banner is planted at: the centroid for shapes and
 *  lines, the point itself for a POI or a note. */
function bannerAnchor(feature, layer) {
  if (isPointLayer(layer.type)) return toLatLng(feature.coord[0], feature.coord[1]);
  let sx = 0, sz = 0;
  for (const [x, z] of feature.coords) { sx += x; sz += z; }
  return toLatLng(sx / feature.coords.length, sz / feature.coords.length);
}

// How far clear of the stroke a road's name label starts, in blocks —
// enough that a fresh label reads next to its road instead of sitting on
// top of it, which is what a dead-centre default (the old behaviour)
// produced on anything but a single straight segment.
const LINE_LABEL_CLEARANCE_BLOCKS = 8;

/** A perpendicular nudge, away from the line, for a road's name label to
 *  start at — computed from the segment nearest the middle of the line,
 *  since that's usually close to where bannerAnchor (the vertex average)
 *  lands. Only ever the *starting* offset: once a label is dragged, its
 *  stored feature.style.labelOffset takes over completely (see
 *  buildFeatureLayer), so this never fights a placement the user chose. */
function defaultLineLabelOffset(feature) {
  const coords = feature.coords;
  if (!coords || coords.length < 2) return [0, 0];
  const mid = Math.floor((coords.length - 1) / 2);
  const [ax, az] = coords[mid];
  const [bx, bz] = coords[mid + 1];
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.hypot(dx, dz) || 1;
  return [(-dz / len) * LINE_LABEL_CLEARANCE_BLOCKS, (dx / len) * LINE_LABEL_CLEARANCE_BLOCKS];
}

/** A small sticky-note glyph, for the "cose da costruire" layer. */
function noteSvg(color, size) {
  const s = size;
  return `<svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}" xmlns="http://www.w3.org/2000/svg">
    <path d="M 1 1 H ${s - 5} L ${s - 1} 5 V ${s - 1} H 1 Z" fill="${color}" stroke="#0d0d0d" stroke-width="2" vector-effect="non-scaling-stroke"/>
    <path d="M ${s - 5} 1 V 5 H ${s - 1}" fill="none" stroke="#0d0d0d" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
    <line x1="4" y1="${s * 0.5}" x2="${s - 5}" y2="${s * 0.5}" stroke="#0d0d0d" stroke-width="1.5" stroke-opacity=".5"/>
    <line x1="4" y1="${s * 0.68}" x2="${s - 8}" y2="${s * 0.68}" stroke="#0d0d0d" stroke-width="1.5" stroke-opacity=".5"/>
  </svg>`;
}

const STATION_SHAPES = ['circle', 'square', 'rectangle'];
// How rounded the icon's corners are, as a fraction of its height — the
// same shape choice applies whether the station is a lone stop or an
// interchange, so the two always look like a matching family of icons.
const STATION_SHAPE_RADIUS = { circle: 0.5, square: 0.12, rectangle: 0.22 };

/** A shared transit station: a white dot (or square/rectangle, per
 *  `layer.defaultStyle.stationShape`) with a dark core when only one (or no)
 *  line stops there. Once a second line joins, it becomes a wider icon of
 *  the same shape with one colour stripe per line — a real interchange, not
 *  just a dot — so a glance says how many lines meet there and which. */
function stationSvg(size, lineColors, shape = 'circle') {
  const rFrac = STATION_SHAPE_RADIUS[shape] ?? STATION_SHAPE_RADIUS.circle;
  if (!lineColors || lineColors.length <= 1) {
    const [w, h] = stationIconSize(size, 1, shape);
    const rx = h * rFrac;
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
      <rect x="1.25" y="1.25" width="${w - 2.5}" height="${h - 2.5}" rx="${rx}" fill="#ffffff" stroke="#1a1a1a" stroke-width="2.5"/>
      <rect x="5" y="5" width="${Math.max(1, w - 10)}" height="${Math.max(1, h - 10)}" rx="${Math.max(0, rx - 3)}" fill="${(lineColors && lineColors[0]) || '#1a1a1a'}"/>
    </svg>`;
  }
  const [w, h] = stationIconSize(size, lineColors.length, shape);
  const pad = 2;
  const stripeW = (w - pad * 2) / lineColors.length;
  const stripes = lineColors.map((c, i) => (
    `<rect x="${(pad + i * stripeW).toFixed(1)}" y="${pad}" width="${Math.ceil(stripeW)}" height="${h - pad * 2}" fill="${c}"/>`
  )).join('');
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
    ${stripes}
    <rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="${h * rFrac}" fill="none" stroke="#1a1a1a" stroke-width="2"/>
  </svg>`;
}

/** Width/height of the station icon: a plain square for a lone stop unless
 *  "rettangolo" is chosen (a touch wider than tall even alone), widened
 *  further for each extra line so its stripe has room. Shared between
 *  stationSvg (what to draw) and buildStationMarker (icon size/anchor), so
 *  the two can never disagree about how big the icon actually is. */
function stationIconSize(size, lineCount, shape = 'circle') {
  if (lineCount <= 1) {
    return shape === 'rectangle' ? [size * 1.4, size * 0.8] : [size, size];
  }
  return [Math.max(size * 1.6, size * 0.85 * lineCount), size];
}

// How far a label can be dragged from what it names before a thin line
// appears to tie the two back together, in blocks.
const LABEL_LEADER_BLOCKS = 20;
// Default nudge for a point feature's label so it doesn't start on top of
// its own icon; lines and areas default to dead centre, as before.
const DEFAULT_POINT_LABEL_OFFSET = [10, 0];

/** A label as a small draggable marker rather than a fixed tooltip, so it
 *  can be moved clear of clutter by hand. Past LABEL_LEADER_BLOCKS from its
 *  anchor, a thin line ties it back to whatever it labels. Returns the
 *  marker and leader line for the caller to add to its group; `getOffset`/
 *  `setOffset` read and persist the [dx, dz] world-unit offset wherever the
 *  caller keeps it (feature.style.labelOffset, or a station's own field). */
function buildLabel({ text, anchor, getOffset, setOffset, extraClass }) {
  const anchorPt = fromLatLng(anchor);
  const off = getOffset() || [0, 0];
  const labelLatLng = toLatLng(anchorPt.x + off[0], anchorPt.z + off[1]);

  const leader = L.polyline([anchor, labelLatLng], {
    color: '#0a0a0a', weight: 1, opacity: Math.hypot(off[0], off[1]) > LABEL_LEADER_BLOCKS ? 0.6 : 0,
    interactive: false,
  });

  const marker = L.marker(labelLatLng, {
    icon: L.divIcon({
      className: `ca-label-marker${extraClass ? ` ${extraClass}` : ''}`,
      html: text,
      iconSize: null,
    }),
    draggable: true,
    keyboard: false,
  });
  marker.on('drag', () => leader.setLatLngs([anchor, marker.getLatLng()]));
  marker.on('dragend', () => {
    const p = fromLatLng(marker.getLatLng());
    const dx = Math.round(p.x - anchorPt.x);
    const dz = Math.round(p.z - anchorPt.z);
    leader.setStyle({ opacity: Math.hypot(dx, dz) > LABEL_LEADER_BLOCKS ? 0.6 : 0 });
    setOffset([dx, dz]);
  });
  return { marker, leader };
}

/** A banner drawn on the map, as a flag planted on the feature. */
function bannerMarker(feature, layer) {
  const size = 34;
  return L.marker(bannerAnchor(feature, layer), {
    icon: L.divIcon({
      className: 'ca-banner',
      html: `<img src="${feature.image}" alt="" style="max-width:${size}px;max-height:${size}px">`,
      iconSize: null,
      iconAnchor: [size / 2, size],
    }),
    interactive: false,
    keyboard: false,
  });
}

// ----------------------------------------------------- feature rendering
function buildFeatureLayer(feature, layer) {
  const style = styleOf(feature, layer);
  const group = L.layerGroup();
  let primary;

  if (layer.type === 'roads') {
    const latlngs = feature.coords.map(([x, z]) => toLatLng(x, z));
    const casingWidth = Number(style.casingWidth) || 0;
    if (casingWidth > 0) {
      group.addLayer(L.polyline(latlngs, {
        color: style.casingColor || '#000',
        weight: (Number(style.width) || 4) + casingWidth * 2,
        opacity: style.opacity ?? 1,
        lineCap: 'round', lineJoin: 'round',
        interactive: false,
      }));
    }
    primary = L.polyline(latlngs, {
      color: style.color || '#f2c14e',
      weight: Number(style.width) || 4,
      opacity: style.opacity ?? 1,
      dashArray: dashFor(style),
      lineCap: style.dash === 'dotted' ? 'round' : 'butt',
      lineJoin: 'round',
    });
    group.addLayer(primary);

  } else if (layer.type === 'areas') {
    const latlngs = feature.coords.map(([x, z]) => toLatLng(x, z));
    primary = L.polygon(latlngs, {
      color: style.strokeColor || '#4fa3d1',
      weight: Number(style.strokeWidth) || 2,
      dashArray: dashFor(style),
      fillColor: style.fillColor || '#4fa3d1',
      fillOpacity: style.fillOpacity ?? 0.25,
    });
    group.addLayer(primary);

  } else if (layer.type === 'transit') {
    // Casing is off by default (a metro line reads fine as a flat stroke,
    // and adjacent lines already tell themselves apart by colour plus the
    // sideways nudge from offsetTransitCoords) but works exactly like a
    // road's when turned on, contouring the very same offset coordinates.
    const latlngs = offsetTransitCoords(feature, layer).map(([x, z]) => toLatLng(x, z));
    const casingWidth = Number(style.casingWidth) || 0;
    if (casingWidth > 0) {
      group.addLayer(L.polyline(latlngs, {
        color: style.casingColor || '#000',
        weight: (Number(style.width) || 5) + casingWidth * 2,
        opacity: style.opacity ?? 1,
        lineCap: 'round', lineJoin: 'round',
        interactive: false,
      }));
    }
    primary = L.polyline(latlngs, {
      color: style.color || '#4fa3d1',
      weight: Number(style.width) || 5,
      opacity: style.opacity ?? 1,
      dashArray: dashFor(style),
      lineCap: style.dash === 'dotted' ? 'round' : 'butt',
      lineJoin: 'round',
    });
    group.addLayer(primary);

  } else if (layer.type === 'notes') {
    const size = Number(style.size) || 16;
    const icon = L.divIcon({
      className: 'ca-poi ca-note',
      html: noteSvg(style.color || '#f5e14a', size),
      iconSize: [size, size],
      iconAnchor: [size / 2, size],
    });
    primary = L.marker(toLatLng(feature.coord[0], feature.coord[1]), {
      icon,
      draggable: !layer.locked,
      keyboard: false,
    });
    primary.on('dragend', () => {
      const p = fromLatLng(primary.getLatLng());
      feature.coord = [Math.round(p.x), Math.round(p.z)];
      markDirty();
      refreshProps();
    });
    group.addLayer(primary);

  } else { // pois
    const size = Number(style.size) || 10;
    const icon = L.divIcon({
      className: 'ca-poi',
      html: poiSvg(style.shape || 'circle', style.color || '#e05a47', size),
      iconSize: [size, size],
      iconAnchor: style.shape === 'pin' ? [size / 2, size] : [size / 2, size / 2],
    });
    primary = L.marker(toLatLng(feature.coord[0], feature.coord[1]), {
      icon,
      draggable: !layer.locked,
      keyboard: false,
    });
    primary.on('dragend', () => {
      const p = fromLatLng(primary.getLatLng());
      feature.coord = [Math.round(p.x), Math.round(p.z)];
      markDirty();
      refreshProps();
    });
    group.addLayer(primary);
  }

  // Transit lines never show their name on the map — with several lines
  // packed close together (and now auto-bundled side by side), a floating
  // name per line only adds clutter; the name is still one hover away.
  if (layer.type !== 'transit' && style.showName !== false && feature.name) {
    const { marker: labelMarker, leader } = buildLabel({
      text: escapeHtml(feature.name),
      anchor: bannerAnchor(feature, layer),
      // No stored offset yet: a point label starts just clear of its own
      // icon instead of sitting right on top of it; a road's starts clear
      // of its stroke the same way, perpendicular to the line itself
      // (see defaultLineLabelOffset) instead of sitting dead centre on
      // top of it; an area's does start dead centre, since there the
      // centre is empty space, not a stroke to sit on.
      getOffset: () => (feature.style && feature.style.labelOffset)
        || (isPointLayer(layer.type) ? DEFAULT_POINT_LABEL_OFFSET
          : layer.type === 'roads' ? defaultLineLabelOffset(feature) : [0, 0]),
      setOffset: (off) => {
        feature.style = { ...(feature.style || {}), labelOffset: off };
        markDirty();
      },
      extraClass: layer.type === 'areas' ? 'big' : '',
    });
    group.addLayer(leader);
    group.addLayer(labelMarker);
  }

  // Hover-only info bubble. It must not swallow clicks: it appears under the
  // cursor the moment you hover a feature, so a click aimed at the feature
  // would otherwise land on the popup and select nothing.
  if (feature.image) group.addLayer(bannerMarker(feature, layer));

  primary.bindPopup(popupHtml(feature, layer), {
    closeButton: false,
    autoPan: false,
    className: 'ca-info-popup',
  });
  primary.on('mouseover', () => { if (currentTool !== 'draw') primary.openPopup(); });
  primary.on('mouseout', () => primary.closePopup());
  primary.on('click', (e) => {
    if (e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent);
    if (placingStation) { placeStationAt(e.latlng); return; }
    if (currentTool === 'delete') { deleteFeature(layer.id, feature.id); return; }
    // A tap IS the hover on iPad — there's no separate "point at it first"
    // gesture — so the info bubble that the mouse gets for free needs an
    // explicit open here, or it would never be seen at all.
    if (isIpadMode()) primary.openPopup(e.latlng);
    selectFeature(layer.id, feature.id);
    if (currentTool === 'edit') toggleVertexEditing(feature.id, true);
  });

  rendered.set(feature.id, { layerId: layer.id, group, primary, feature });
  return group;
}

function popupHtml(feature, layer) {
  const kind = { roads: 'Strada', pois: 'Punto di interesse', areas: 'Area', transit: 'Linea di trasporto', notes: 'Nota' }[layer.type];
  const cat = layer.type === 'pois' && feature.category ? ` · ${escapeHtml(feature.category)}` : '';
  const len = (layer.type === 'roads' || layer.type === 'transit') ? ` · ${lengthOf(feature.coords)} blocchi` : '';
  const area = layer.type === 'areas' ? ` · ${areaOf(feature.coords)} blocchi²` : '';
  const stops = layer.type === 'transit' && feature.stationIds && feature.stationIds.length
    ? ` · ${feature.stationIds.length} stazioni` : '';
  return `<div class="ca-popup">
    <h4>${escapeHtml(feature.name || '(senza nome)')}</h4>
    ${feature.description ? `<p class="desc">${escapeHtml(feature.description)}</p>` : ''}
    <div class="meta">${kind}${cat}${len}${area}${stops} · ${escapeHtml(layer.name)}</div>
  </div>`;
}

function dist(x1, z1, x2, z2) { return Math.hypot(x1 - x2, z1 - z2); }

/** The closest station within `tolerance` blocks, or null. */
function nearestStation(layer, x, z, tolerance = STATION_CLICK_SNAP_BLOCKS) {
  let best = null, bestD = tolerance;
  for (const s of layer.stations || []) {
    const d = dist(s.x, s.z, x, z);
    if (d <= bestD) { bestD = d; best = s; }
  }
  return best;
}

function nearestVertex(coords, x, z) {
  let best = null, bestD = STATION_CLICK_SNAP_BLOCKS;
  for (const pt of coords) {
    const d = dist(pt[0], pt[1], x, z);
    if (d <= bestD) { bestD = d; best = pt; }
  }
  return best;
}

/** Whenever a freshly drawn/extended line passes close to an existing
 *  station, snap that vertex onto it and record the stop — this is the
 *  "passare sulle stazioni per far fermare le linee anche lì" behaviour.
 *  Uses the tighter draw tolerance: a merely-nearby adjacent line must not
 *  pick up stations it doesn't actually call at. */
function snapToStations(layer, coords) {
  const stationIds = [];
  const snapped = coords.map(([x, z]) => {
    const st = nearestStation(layer, x, z, STATION_DRAW_SNAP_BLOCKS);
    if (st) { stationIds.push(st.id); return [st.x, st.z]; }
    return [x, z];
  });
  return { coords: snapped, stationIds: [...new Set(stationIds)] };
}

// Two segments "run together" if their midpoints are close and they point
// the same way — not only when they're pixel-identical. A user tracing a
// second line along roughly the same route, a few blocks off, still gets
// bundled and separated, which is the common case for two real metro lines
// sharing a stretch of physical track.
const TRANSIT_BUNDLE_RANGE = 8;          // blocks between midpoints
const TRANSIT_BUNDLE_ANGLE = Math.PI / 8; // ~22.5°, so a crossing line doesn't bundle

function segAngle(a, b) {
  let angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
  if (angle < 0) angle += Math.PI; // fold the reverse direction onto the same value
  return angle;
}
function angleDiff(a1, a2) {
  const d = Math.abs(a1 - a2) % Math.PI;
  return Math.min(d, Math.PI - d);
}

// Tuning for straightenPolygon: a hand can't hold a pencil still, so these
// treat "close enough" as intentional rather than as a real extra vertex.
const STRAIGHTEN_MERGE_BLOCKS = 3;   // points closer than this to their neighbour are jitter, not a corner
const STRAIGHTEN_COLLINEAR_DEG = 12; // a turn smaller than this is noise along what should be one straight edge
const STRAIGHTEN_CLUSTER_BLOCKS = 6; // vertices whose rotated x (or z) lands within this of each other snap together

/** Groups nearby numbers and replaces each with its cluster's average —
 *  the step that turns "four corners whose x's are roughly 0, 2, 48, 50"
 *  into "two clean edges at x=1 and x=49", by construction closing exactly
 *  (shared edges get literally the same number) rather than by walking
 *  forward from one vertex and hoping the error doesn't show by the time
 *  it gets back around to the start. */
function clusterAxis(values, tolerance) {
  const order = values.map((v, i) => i).sort((a, b) => values[a] - values[b]);
  const result = new Array(values.length);
  let start = 0;
  for (let k = 1; k <= order.length; k++) {
    if (k === order.length || values[order[k]] - values[order[k - 1]] > tolerance) {
      let sum = 0;
      for (let j = start; j < k; j++) sum += values[order[j]];
      const avg = sum / (k - start);
      for (let j = start; j < k; j++) result[order[j]] = avg;
      start = k;
    }
  }
  return result;
}

/** Cleans up a freehand-drawn area (iPad pencil) into straight edges: merges
 *  jittery near-duplicate points, drops near-collinear ones, rotates the
 *  shape so its longest edge sits on the nearest 45°, then snaps vertices
 *  that share roughly the same rotated x or z onto the same value. Only
 *  ever called for areas drawn in iPad mode (see onDrawCreated) — a mouse
 *  user's polygon is never touched. */
function straightenPolygon(coords) {
  if (coords.length < 3) return coords;

  let pts = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    const prev = pts[pts.length - 1];
    if (dist(prev[0], prev[1], coords[i][0], coords[i][1]) >= STRAIGHTEN_MERGE_BLOCKS) pts.push(coords[i]);
  }
  if (pts.length > 3 && dist(pts[0][0], pts[0][1], pts[pts.length - 1][0], pts[pts.length - 1][1]) < STRAIGHTEN_MERGE_BLOCKS) {
    pts.pop(); // the closing click landed back on the starting point
  }
  if (pts.length < 3) return coords;

  const collinearThreshold = (STRAIGHTEN_COLLINEAR_DEG * Math.PI) / 180;
  pts = pts.filter((pt, i) => {
    const prev = pts[(i - 1 + pts.length) % pts.length];
    const next = pts[(i + 1) % pts.length];
    const a1 = Math.atan2(pt[1] - prev[1], pt[0] - prev[0]);
    const a2 = Math.atan2(next[1] - pt[1], next[0] - pt[0]);
    let turn = Math.abs(a1 - a2);
    if (turn > Math.PI) turn = 2 * Math.PI - turn;
    return turn > collinearThreshold;
  });
  if (pts.length < 3) return coords;

  let longest = 0;
  let dominantAngle = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const len = dist(a[0], a[1], b[0], b[1]);
    if (len > longest) { longest = len; dominantAngle = segAngle(a, b); }
  }
  const snapAngle = Math.round(dominantAngle / (Math.PI / 4)) * (Math.PI / 4);
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cz = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const cos = Math.cos(-snapAngle);
  const sin = Math.sin(-snapAngle);
  const rotated = pts.map(([x, z]) => {
    const dx = x - cx;
    const dz = z - cz;
    return [dx * cos - dz * sin, dx * sin + dz * cos];
  });

  const xs = clusterAxis(rotated.map((p) => p[0]), STRAIGHTEN_CLUSTER_BLOCKS);
  const zs = clusterAxis(rotated.map((p) => p[1]), STRAIGHTEN_CLUSTER_BLOCKS);

  const cos2 = Math.cos(snapAngle);
  const sin2 = Math.sin(snapAngle);
  return rotated.map((_, i) => {
    const x = xs[i];
    const z = zs[i];
    return [Math.round(x * cos2 - z * sin2 + cx), Math.round(x * sin2 + z * cos2 + cz)];
  });
}

/** Nudges a transit line's rendered vertices sideways wherever it runs
 *  alongside another line in the same layer, so two "linee adiacenti" don't
 *  paint as a single indistinguishable stroke. Pure rendering:
 *  `feature.coords` itself is never touched, which is also why vertex
 *  editing must reset to the true coordinates before it starts (see
 *  toggleVertexEditing) rather than read back these offset ones. */
function offsetTransitCoords(feature, layer) {
  const coords = feature.coords;
  if (coords.length < 2) return coords;

  const siblings = layer.features.filter((f) => f.coords && f.coords.length >= 2);
  const edges = [];
  for (const f of siblings) {
    for (let i = 0; i < f.coords.length - 1; i++) {
      const a = f.coords[i], b = f.coords[i + 1];
      edges.push({
        featureId: f.id, a, b,
        mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
        angle: segAngle(a, b),
      });
    }
  }

  const edgeOffset = (i) => {
    const a = coords[i], b = coords[i + 1];
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const angle = segAngle(a, b);
    // Every OTHER line with a segment running alongside this one here — one
    // entry per line, whichever of its segments comes first in scan order.
    const bundle = [];
    const seen = new Set();
    for (const e of edges) {
      if (seen.has(e.featureId)) continue;
      if (Math.hypot(e.mid[0] - mid[0], e.mid[1] - mid[1]) > TRANSIT_BUNDLE_RANGE) continue;
      if (angleDiff(e.angle, angle) > TRANSIT_BUNDLE_ANGLE) continue;
      bundle.push(e);
      seen.add(e.featureId);
    }
    if (bundle.length <= 1) return [0, 0];
    // Stable order (not scan order) so the sides don't flicker on re-render.
    bundle.sort((x, y) => (x.featureId < y.featureId ? -1 : x.featureId > y.featureId ? 1 : 0));
    const rank = bundle.findIndex((g) => g.featureId === feature.id) - (bundle.length - 1) / 2;
    // All lines in the bundle offset along the same axis — the first
    // segment's direction, rather than each line's own — so they fan out to
    // either side instead of each computing an independent, mismatched one.
    const ref = bundle[0];
    const dx = ref.b[0] - ref.a[0], dz = ref.b[1] - ref.a[1];
    const len = Math.hypot(dx, dz) || 1;
    return [(-dz / len) * rank * TRANSIT_OFFSET_BLOCKS, (dx / len) * rank * TRANSIT_OFFSET_BLOCKS];
  };

  return coords.map((pt, i) => {
    const before = i > 0 ? edgeOffset(i - 1) : null;
    const after = i < coords.length - 1 ? edgeOffset(i) : null;
    let ox = 0, oz = 0, n = 0;
    if (before) { ox += before[0]; oz += before[1]; n++; }
    if (after) { ox += after[0]; oz += after[1]; n++; }
    return n ? [pt[0] + ox / n, pt[1] + oz / n] : pt;
  });
}

/** Starts a one-off "click the map to place this station" interaction.
 *  `feature` is optional: a station is its own element (see linesAtStation),
 *  not owned by any one line — pass no feature to plant a stop before any
 *  line reaches it yet, and attach lines to it later ("Collega", or just by
 *  drawing/extending a line past it). */
async function beginPlaceStation(layer, feature) {
  const name = await promptDialog({
    title: 'Nuova stazione', message: 'Nome della stazione', confirmLabel: 'Crea',
  });
  if (name === null) return;
  setTool('select'); // cancel any active drawing tool; also clears placingStation
  placingStation = { layerId: layer.id, featureId: feature ? feature.id : null, name: name.trim() || 'Stazione' };
  const hint = el('draw-hint');
  hint.classList.remove('hidden');
  hint.innerHTML = feature
    ? 'Clicca sulla mappa, idealmente sulla linea, per posizionare la stazione. '
      + 'Clicca vicino a una stazione esistente per collegarti a quella. <kbd>Esc</kbd> per annullare.'
    : 'Clicca sulla mappa per posizionare la stazione. '
      + 'Clicca vicino a una stazione esistente per non duplicarla. <kbd>Esc</kbd> per annullare.';
}

function placeStationAt(latlng) {
  const target = placingStation;
  placingStation = null;
  el('draw-hint').classList.add('hidden');
  const layer = findLayer(target.layerId);
  const feature = target.featureId ? findFeature(target.layerId, target.featureId) : null;
  if (!layer) return;

  const p = fromLatLng(latlng);
  let x = Math.round(p.x), z = Math.round(p.z);

  const existing = nearestStation(layer, x, z);
  if (existing) {
    if (feature) {
      feature.stationIds = [...new Set([...(feature.stationIds || []), existing.id])];
      toast(`Collegata alla stazione esistente "${existing.name || '(senza nome)'}"`, 'ok');
    } else {
      toast(`"${existing.name || '(senza nome)'}" è già una stazione qui: non ne ho creata una seconda`, 'err');
    }
  } else {
    const onLine = feature ? nearestVertex(feature.coords, x, z) : null;
    if (onLine) { x = onLine[0]; z = onLine[1]; }
    const station = { id: newId('st'), x, z, name: target.name, description: '' };
    layer.stations = layer.stations || [];
    layer.stations.push(station);
    if (feature) feature.stationIds = [...(feature.stationIds || []), station.id];
    toast('Stazione aggiunta', 'ok');
  }
  markDirty();
  refreshStations(layer.id);
  Main.renderLayerList();
  if (feature && state.selectedFeature && state.selectedFeature.featureId === feature.id) refreshProps();
}

/** The lines (features) that stop at a station, each with its own colour —
 *  what decides whether the icon is a plain dot or a multi-line rectangle. */
function linesAtStation(station, layer) {
  return layer.features.filter((f) => (f.stationIds || []).includes(station.id));
}

/** A station marker, shared by every transit line that stops there — a
 *  standalone element in its own right (see beginPlaceStation), not owned
 *  by any one line. */
function buildStationMarker(station, layer) {
  const layerStyle = layer.defaultStyle || {};
  // A station's own shape/size (set from its editor) wins; otherwise it
  // falls back to the layer's default symbol (small dots, normally).
  const shape = STATION_SHAPES.includes(station.shape) ? station.shape
    : (STATION_SHAPES.includes(layerStyle.stationShape) ? layerStyle.stationShape : 'circle');
  const size = Number(station.size) || Number(layerStyle.stationSize) || 14;
  const lines = linesAtStation(station, layer);
  const colors = lines.map((f) => styleOf(f, layer).color || '#4fa3d1');
  const [w, h] = stationIconSize(size, colors.length, shape);
  const icon = L.divIcon({
    className: 'ca-poi ca-station',
    html: stationSvg(size, colors, shape),
    iconSize: [w, h],
    iconAnchor: [w / 2, h / 2],
  });
  const marker = L.marker(toLatLng(station.x, station.z), {
    icon, draggable: !layer.locked, keyboard: false,
  });
  const group = L.layerGroup([marker]);
  marker.on('dragend', () => {
    const p = fromLatLng(marker.getLatLng());
    station.x = Math.round(p.x);
    station.z = Math.round(p.z);
    markDirty();
  });
  if (station.name) {
    const { marker: labelMarker, leader } = buildLabel({
      text: escapeHtml(station.name),
      anchor: toLatLng(station.x, station.z),
      getOffset: () => station.labelOffset || [Math.round(w / 2) + 4, 0],
      setOffset: (off) => { station.labelOffset = off; markDirty(); },
    });
    group.addLayer(leader);
    group.addLayer(labelMarker);
  }
  const lineNames = lines.map((f) => f.name || '(senza nome)');
  const lineChips = lines.map((f) => (
    `<span class="line-chip" style="background:${styleOf(f, layer).color || '#4fa3d1'}"></span>${escapeHtml(f.name || '(senza nome)')}`
  )).join('<br>');
  marker.bindPopup(`<div class="ca-popup">
      <h4>${escapeHtml(station.name || '(stazione)')}</h4>
      ${station.description ? `<p class="desc">${escapeHtml(station.description)}</p>` : ''}
      <div class="meta">Stazione${lineNames.length ? '' : ' · nessuna linea collegata'}</div>
      ${lineChips ? `<div class="line-chip-list">${lineChips}</div>` : ''}
    </div>`, { closeButton: false, autoPan: false, className: 'ca-info-popup' });
  marker.on('mouseover', () => { if (currentTool !== 'draw') marker.openPopup(); });
  marker.on('mouseout', () => marker.closePopup());
  marker.on('click', (e) => {
    if (e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent);
    if (placingStation) { placeStationAt(e.latlng); return; }
    if (currentTool === 'delete') { deleteStation(layer.id, station.id); return; }
    if (isIpadMode()) marker.openPopup(e.latlng);
    if (currentTool === 'select') selectStation(layer.id, station.id);
  });
  return group;
}

/** Rebuild just the station markers of one layer, without touching its
 *  lines or disturbing any feature currently selected/being edited. */
function refreshStations(layerId) {
  const layer = findLayer(layerId);
  const group = layerGroups.get(layerId);
  if (!layer || !group) return;
  const old = stationGroups.get(layerId);
  if (old) group.removeLayer(old);
  const fresh = L.layerGroup();
  for (const station of layer.stations || []) fresh.addLayer(buildStationMarker(station, layer));
  stationGroups.set(layerId, fresh);
  group.addLayer(fresh);
}

/** Sets the layer-wide station icon (shape + size, from "Simbolo delle
 *  stazioni" in the layer panel) and re-draws every station right away. */
function setStationStyle(layer, { shape, size } = {}) {
  layer.defaultStyle = { ...(layer.defaultStyle || {}) };
  if (shape !== undefined) layer.defaultStyle.stationShape = STATION_SHAPES.includes(shape) ? shape : 'circle';
  if (size !== undefined) layer.defaultStyle.stationSize = Math.max(6, Number(size) || 14);
  markDirty();
  refreshStations(layer.id);
}

function deleteStation(layerId, stationId) {
  const layer = findLayer(layerId);
  if (!layer) return;
  layer.stations = (layer.stations || []).filter((s) => s.id !== stationId);
  for (const f of layer.features) f.stationIds = (f.stationIds || []).filter((id) => id !== stationId);
  refreshStations(layerId);
  markDirty();
  if (state.selectedStation && state.selectedStation.stationId === stationId) selectStation(null);
  if (state.selectedFeature && state.selectedFeature.layerId === layerId) refreshProps();
  toast('Stazione eliminata');
}

function lengthOf(coords) {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += Math.hypot(coords[i][0] - coords[i - 1][0], coords[i][1] - coords[i - 1][1]);
  }
  return Math.round(total);
}

function areaOf(coords) {
  let sum = 0;
  for (let i = 0; i < coords.length; i++) {
    const [x1, z1] = coords[i];
    const [x2, z2] = coords[(i + 1) % coords.length];
    sum += x1 * z2 - x2 * z1;
  }
  return Math.round(Math.abs(sum) / 2);
}

/** A layer's own visibility flag, but overridden off by any hidden
 *  ancestor: hiding a "quartiere" hides everything nested inside it. */
function layerVisible(layer) {
  let cur = layer;
  const seen = new Set();
  while (cur) {
    if (cur.visible === false) return false;
    if (seen.has(cur.id)) break; // a cycle should never survive normalization, but don't hang if one does
    seen.add(cur.id);
    cur = cur.parentId ? findLayer(cur.parentId) : null;
  }
  return true;
}

/** Re-apply visibility to every layer group, e.g. after any layer's own
 *  `visible` flag changes (children may need to follow their parent). */
function applyLayerVisibility() {
  if (!state.project) return;
  for (const layer of state.project.layers) setLayerVisibility(layer.id, layerVisible(layer));
}

/** Rebuild every vector layer from the project (called after load/import). */
function renderAllLayers() {
  for (const g of layerGroups.values()) map.removeLayer(g);
  layerGroups.clear();
  stationGroups.clear();
  rendered.clear();

  if (!state.project) return;
  for (const layer of state.project.layers) {
    const group = L.layerGroup();
    for (const feature of layer.features) {
      const built = buildFeatureLayer(feature, layer);
      // Still tracked in `rendered` (buildFeatureLayer does that) even when
      // left off the map — the "Linee visibili" menu re-adds it later
      // without a full rebuild.
      if (feature.visible !== false) group.addLayer(built);
    }
    if (layer.type === 'transit') {
      const stationGroup = L.layerGroup();
      for (const station of layer.stations || []) stationGroup.addLayer(buildStationMarker(station, layer));
      stationGroups.set(layer.id, stationGroup);
      group.addLayer(stationGroup);
    }
    layerGroups.set(layer.id, group);
    if (layerVisible(layer)) group.addTo(map);
  }
}

/** Re-render a single feature in place (after a style or geometry change). */
function refreshFeature(layerId, featureId) {
  const layer = findLayer(layerId);
  const feature = findFeature(layerId, featureId);
  const entry = rendered.get(featureId);
  const group = layerGroups.get(layerId);
  if (!layer || !feature || !group) return;
  // Rebuilding replaces the Leaflet layer object entirely — including its
  // vertex-editing handles. Left alone, that silently threw away any
  // in-progress drag the moment something else refreshed this same feature
  // (typing in the name field, nudging a colour slider — anything in the
  // Properties panel commits via this same function). Commit whatever is
  // on screen right now first, then resume editing on the fresh layer, so
  // "Modifica nodi" can never lose an edit that hasn't been saved yet.
  const wasEditing = featureId === editingFeatureId
    && entry && entry.primary.editing && entry.primary.editing.enabled();
  if (wasEditing) commitVertexPositions(featureId);
  if (entry) group.removeLayer(entry.group);
  const fresh = buildFeatureLayer(feature, layer);
  if (feature.visible !== false) group.addLayer(fresh);
  if (wasEditing) toggleVertexEditing(featureId, true);
}

/** Shows/hides one transit line without a full re-render — flips the
 *  stored flag and adds/removes its already-built layer group directly. */
function setLineVisible(layer, feature, visible) {
  feature.visible = visible;
  markDirty();
  const group = layerGroups.get(layer.id);
  const entry = rendered.get(feature.id);
  if (!group || !entry) return;
  if (visible) group.addLayer(entry.group);
  else group.removeLayer(entry.group);
}

/** "Linee visibili" — opens when a transit layer is selected in the sidebar,
 *  listing every line so only some can be shown at a time. Checkboxes apply
 *  immediately (see setLineVisible), not on close. */
function openLineVisibilityMenu(layer) {
  const lines = layer.features;
  const host = el('modal-host');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const rowsHtml = lines.length
    ? lines.map((f) => `
      <label class="line-visibility-row">
        <input type="checkbox" data-line="${f.id}" ${f.visible === false ? '' : 'checked'}>
        <span class="line-chip" style="background:${styleOf(f, layer).color || '#4fa3d1'}"></span>
        <span class="lname">${escapeHtml(f.name || '(senza nome)')}</span>
      </label>`).join('')
    : '<p class="hint" style="margin:0">Nessuna linea in questo layer.</p>';
  backdrop.innerHTML = `
    <div class="modal">
      <h3>Linee visibili — ${escapeHtml(layer.name)}</h3>
      <div class="modal-body">
        ${lines.length ? '<div class="row"><button class="btn btn-sm" data-act="all">Mostra tutte</button><button class="btn btn-sm" data-act="none">Nascondi tutte</button></div>' : ''}
        <div class="line-visibility-list">${rowsHtml}</div>
      </div>
      <div class="row"><button class="btn btn-primary" data-act="ok">Chiudi</button></div>
    </div>`;
  const done = () => backdrop.remove();
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) { done(); return; }
    const act = e.target.dataset && e.target.dataset.act;
    if (act === 'ok') { done(); return; }
    if (act === 'all' || act === 'none') {
      const visible = act === 'all';
      backdrop.querySelectorAll('.line-visibility-row input[type="checkbox"]').forEach((cb) => { cb.checked = visible; });
      lines.forEach((f) => setLineVisible(layer, f, visible));
    }
  });
  backdrop.addEventListener('change', (e) => {
    const id = e.target.dataset && e.target.dataset.line;
    if (!id) return;
    const feature = lines.find((f) => f.id === id);
    if (feature) setLineVisible(layer, feature, e.target.checked);
  });
  host.appendChild(backdrop);
}

function setLayerVisibility(layerId, visible) {
  const group = layerGroups.get(layerId);
  if (!group) return;
  if (visible && !map.hasLayer(group)) group.addTo(map);
  if (!visible && map.hasLayer(group)) map.removeLayer(group);
}

// ------------------------------------------------------------ selection
function selectFeature(layerId, featureId) {
  // Drop any half-finished vertex editing on the previous selection.
  if (editingFeatureId && editingFeatureId !== featureId) toggleVertexEditing(editingFeatureId, false);
  state.selectedFeature = layerId && featureId ? { layerId, featureId } : null;
  state.selectedStation = null; // a station and a feature are never selected at once
  refreshProps();
}

/** Selects a station for editing (name/description/symbol) in the
 *  Properties panel — clicking a station with "Seleziona" active, the same
 *  way clicking a line or a point opens its own properties. */
function selectStation(layerId, stationId) {
  if (editingFeatureId) toggleVertexEditing(editingFeatureId, false);
  state.selectedFeature = null;
  state.selectedStation = layerId && stationId ? { layerId, stationId } : null;
  refreshProps();
}

/** Reads the live (possibly mid-drag) vertex positions of an editing
 *  feature back into the project. Split out of toggleVertexEditing so
 *  refreshFeature can call it without also disabling editing or recursing
 *  back into itself. */
function commitVertexPositions(featureId) {
  const entry = rendered.get(featureId);
  if (!entry) return;
  const layer = findLayer(entry.layerId);
  if (!layer || !entry.primary.editing || !entry.primary.editing.enabled()) return;
  const latlngs = layer.type === 'areas'
    ? entry.primary.getLatLngs()[0]
    : entry.primary.getLatLngs();
  entry.feature.coords = latlngs.map((ll) => {
    const p = fromLatLng(ll);
    return [Math.round(p.x), Math.round(p.z)];
  });
  markDirty();
}

function toggleVertexEditing(featureId, on) {
  const entry = rendered.get(featureId);
  if (!entry || !entry.primary.editing) return;
  const layer = findLayer(entry.layerId);
  if (on) {
    // A transit line can be rendered offset from its stored path (see
    // offsetTransitCoords) when it shares track with another line: editing
    // must move handles on the true coordinates, or every edit would bake
    // the visual offset permanently into feature.coords.
    if (layer && layer.type === 'transit') {
      entry.primary.setLatLngs(entry.feature.coords.map(([x, z]) => toLatLng(x, z)));
    }
    entry.primary.editing.enable();
    editingFeatureId = featureId;
  } else {
    if (entry.primary.editing.enabled()) {
      commitVertexPositions(featureId);
      entry.primary.editing.disable();
      refreshFeature(entry.layerId, featureId);
    }
    editingFeatureId = null;
  }
}

function deleteFeature(layerId, featureId) {
  const layer = findLayer(layerId);
  if (!layer) return;
  const idx = layer.features.findIndex((f) => f.id === featureId);
  if (idx < 0) return;
  const entry = rendered.get(featureId);
  const group = layerGroups.get(layerId);
  if (entry && group) group.removeLayer(entry.group);
  rendered.delete(featureId);
  layer.features.splice(idx, 1);
  if (state.selectedFeature && state.selectedFeature.featureId === featureId) selectFeature(null);
  markDirty();
  Main.renderLayerList();
  toast('Elemento eliminato');
}

// -------------------------------------------------------------- drawing
function setTool(tool) {
  if (drawHandler) { drawHandler.disable(); drawHandler = null; }
  if (editingFeatureId) toggleVertexEditing(editingFeatureId, false);
  extendTarget = null;
  placingStation = null;
  currentTool = tool;

  document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  const hint = el('draw-hint');

  if (tool === 'draw') {
    const layer = selectedLayer();
    if (!layer) { currentTool = 'select'; return; }
    startDrawing(layer);
    hint.classList.remove('hidden');
    hint.innerHTML = isPointLayer(layer.type)
      ? 'Clicca sulla mappa per posizionare il punto. <kbd>Esc</kbd> per annullare.'
      : `Clicca per aggiungere i vertici, <kbd>doppio clic</kbd> per finire${layer.type === 'areas' ? ' (l\'area si chiude da sola)' : ''}. <kbd>Esc</kbd> per annullare.`;
  } else {
    hint.classList.add('hidden');
    if (tool === 'edit' && state.selectedFeature) toggleVertexEditing(state.selectedFeature.featureId, true);
    if (tool === 'delete') toast('Clicca un elemento sulla mappa per eliminarlo', 'err');
  }
}

/** Snaps `latlng` so the segment from `prevLatLng` to it falls on a
 *  multiple of 45°, keeping the same length — "gli angoli possono essere
 *  solo ogni 45 gradi" while tracing a transit line. */
function snapTransitVertex(prevLatLng, latlng) {
  const prev = fromLatLng(prevLatLng);
  const cur = fromLatLng(latlng);
  const dx = cur.x - prev.x;
  const dz = cur.z - prev.z;
  const len = Math.hypot(dx, dz);
  if (len < 0.01) return latlng;
  const step = Math.PI / 4;
  const angle = Math.round(Math.atan2(dz, dx) / step) * step;
  return toLatLng(prev.x + Math.cos(angle) * len, prev.z + Math.sin(angle) * len);
}

/** Overrides a live L.Draw.Polyline session (must be called before
 *  `.enable()`) so that, while tracing a transit line:
 *   - every new vertex snaps to a 45° angle from the previous one, live in
 *     the mouse-move preview as well as on click;
 *   - clicking back near the line's own starting point closes the loop and
 *     finishes the shape instead of adding an overlapping vertex. */
function wireTransitDrawSnapping(handler) {
  const originalMouseMove = handler._onMouseMove.bind(handler);
  handler._onMouseMove = function onMouseMoveSnapped(t) {
    const markers = this._markers || [];
    if (!markers.length) { originalMouseMove(t); return; }
    const layerPoint = this._map.mouseEventToLayerPoint(t.originalEvent);
    const raw = this._map.layerPointToLatLng(layerPoint);
    const snapped = snapTransitVertex(markers[markers.length - 1].getLatLng(), raw);
    this._currentLatLng = snapped;
    this._updateTooltip(snapped);
    this._updateGuide(this._map.latLngToLayerPoint(snapped));
    this._mouseMarker.setLatLng(snapped);
    L.DomEvent.preventDefault(t.originalEvent);
  };

  const originalAddVertex = handler.addVertex.bind(handler);
  handler.addVertex = function addVertexSnapped(latlng) {
    const markers = this._markers || [];
    const target = markers.length ? snapTransitVertex(markers[markers.length - 1].getLatLng(), latlng) : latlng;
    if (markers.length >= 3) {
      const start = fromLatLng(markers[0].getLatLng());
      const t2 = fromLatLng(target);
      if (dist(start.x, start.z, t2.x, t2.z) <= STATION_DRAW_SNAP_BLOCKS) {
        originalAddVertex(markers[0].getLatLng());
        this._finishShape();
        return;
      }
    }
    originalAddVertex(target);
  };
}

function startDrawing(layer) {
  const style = layer.defaultStyle || {};
  if (isPointLayer(layer.type)) {
    const size = layer.type === 'notes' ? (Number(style.size) || 16) : (Number(style.size) || 10);
    drawHandler = new L.Draw.Marker(map, {
      icon: L.divIcon({
        className: 'ca-poi',
        html: layer.type === 'notes'
          ? noteSvg(style.color || '#f5e14a', size)
          : poiSvg(style.shape || 'circle', style.color || '#e05a47', size),
        iconSize: [size, size],
      }),
    });
  } else if (layer.type === 'areas') {
    drawHandler = new L.Draw.Polygon(map, {
      allowIntersection: true,
      showArea: false,
      shapeOptions: {
        color: style.strokeColor || '#4fa3d1',
        weight: Number(style.strokeWidth) || 2,
        fillColor: style.fillColor || '#4fa3d1',
        fillOpacity: style.fillOpacity ?? 0.25,
      },
    });
  } else { // roads or transit
    drawHandler = new L.Draw.Polyline(map, {
      shapeOptions: {
        color: style.color || (layer.type === 'transit' ? '#4fa3d1' : '#f2c14e'),
        weight: Number(style.width) || (layer.type === 'transit' ? 5 : 4),
      },
    });
    if (layer.type === 'transit') wireTransitDrawSnapping(drawHandler);
  }
  drawHandler.enable();
}

/** Continue an existing roads/transit line from whichever of its two ends
 *  is closer to where the new drawing starts ("estendendola"). */
function extendFeature(layer, feature) {
  if (layer.type !== 'roads' && layer.type !== 'transit') return;
  state.selectedLayerId = layer.id;
  Main.renderLayerList();
  setTool('draw'); // resets extendTarget, so set it only after
  extendTarget = { layerId: layer.id, featureId: feature.id };
  const hint = el('draw-hint');
  hint.innerHTML = 'Continua la linea da un\'estremità esistente. <kbd>doppio clic</kbd> per finire, <kbd>Esc</kbd> per annullare.';
}

function handleExtend(target, e) {
  const layer = findLayer(target.layerId);
  const feature = findFeature(target.layerId, target.featureId);
  if (!layer || !feature) return;
  let newPts = e.layer.getLatLngs().map((ll) => {
    const p = fromLatLng(ll);
    return [Math.round(p.x), Math.round(p.z)];
  });
  if (!newPts.length) return;
  let newStationIds = [];
  if (layer.type === 'transit') {
    const snapped = snapToStations(layer, newPts);
    newPts = snapped.coords;
    newStationIds = snapped.stationIds;
  }
  const ptDist = (a, b) => dist(a[0], a[1], b[0], b[1]);
  const first = feature.coords[0];
  const last = feature.coords[feature.coords.length - 1];
  if (ptDist(newPts[0], first) < ptDist(newPts[0], last)) {
    feature.coords = [...newPts.slice().reverse(), ...feature.coords];
  } else {
    feature.coords = [...feature.coords, ...newPts];
  }
  if (newStationIds.length) {
    feature.stationIds = [...new Set([...(feature.stationIds || []), ...newStationIds])];
  }
  markDirty();
  refreshFeature(target.layerId, target.featureId);
  Main.renderLayerList();
}

function onDrawCreated(e) {
  if (extendTarget) {
    const target = extendTarget;
    extendTarget = null;
    handleExtend(target, e);
    setTool('select');
    selectFeature(target.layerId, target.featureId);
    return;
  }

  const layer = selectedLayer();
  if (!layer) return;

  const feature = {
    id: newId('f'),
    name: '',
    description: '',
    style: {},
  };

  if (layer.type === 'pois') {
    const p = fromLatLng(e.layer.getLatLng());
    feature.coord = [Math.round(p.x), Math.round(p.z)];
    feature.category = 'altro';
    feature.name = `Punto ${layer.features.length + 1}`;
  } else if (layer.type === 'notes') {
    const p = fromLatLng(e.layer.getLatLng());
    feature.coord = [Math.round(p.x), Math.round(p.z)];
    feature.name = `Nota ${layer.features.length + 1}`;
  } else if (layer.type === 'transit') {
    const raw = e.layer.getLatLngs().map((ll) => {
      const p = fromLatLng(ll);
      return [Math.round(p.x), Math.round(p.z)];
    });
    const snapped = snapToStations(layer, raw);
    feature.coords = snapped.coords;
    feature.stationIds = snapped.stationIds;
    feature.name = `Linea ${layer.features.length + 1}`;
    if (snapped.stationIds.length === 1) toast('Linea collegata a 1 stazione esistente', 'ok');
    else if (snapped.stationIds.length > 1) toast(`Linea collegata a ${snapped.stationIds.length} stazioni esistenti`, 'ok');
  } else {
    const latlngs = layer.type === 'areas' ? e.layer.getLatLngs()[0] : e.layer.getLatLngs();
    let coords = latlngs.map((ll) => {
      const p = fromLatLng(ll);
      return [Math.round(p.x), Math.round(p.z)];
    });
    // A pencil on glass can't hold a straight line the way a mouse does —
    // squares up the freehand shape right after drawing it, iPad mode only.
    if (layer.type === 'areas' && isIpadMode()) coords = straightenPolygon(coords);
    feature.coords = coords;
    feature.name = layer.type === 'roads'
      ? `Via ${layer.features.length + 1}`
      : `Area ${layer.features.length + 1}`;
  }

  layer.features.push(feature);
  if (layer.type === 'transit') {
    // Passing near an existing line's segments bundles the two automatically
    // (see offsetTransitCoords) — let the user know it happened, since
    // there's no separate "affianca" step to trigger on purpose.
    const offsetCoords = offsetTransitCoords(feature, layer);
    const bundled = offsetCoords.some(([x, z], i) => x !== feature.coords[i][0] || z !== feature.coords[i][1]);
    if (bundled) toast('Linea affiancata automaticamente a un\'altra linea che corre sullo stesso tracciato', 'ok');
  }
  const group = layerGroups.get(layer.id);
  if (group) group.addLayer(buildFeatureLayer(feature, layer));
  markDirty();
  Main.renderLayerList();
  selectFeature(layer.id, feature.id);
  setTool('select');
  // Focus the name field so naming the new element is the natural next step.
  const nameInput = document.querySelector('#props .f-name');
  if (nameInput) { nameInput.focus(); nameInput.select(); }
}

// ----------------------------------------------------- properties panel
function refreshProps() {
  const host = el('props');
  const station = selectedStation();
  if (station) { renderStationProps(host, station); return; }
  const feature = selectedFeature();
  if (!feature) {
    host.innerHTML = '<div class="prop-empty">Nessun elemento selezionato.<br>Clicca un elemento sulla mappa.</div>';
    return;
  }
  const layer = findLayer(state.selectedFeature.layerId);
  const style = styleOf(feature, layer);

  const swatches = (current, cls) => `<div class="swatch-row">${PALETTE
    .map((c) => `<div class="swatch ${c.toLowerCase() === String(current).toLowerCase() ? 'sel' : ''}" data-swatch="${cls}" style="background:${c}" title="${c}"></div>`)
    .join('')}</div>`;

  const dashSelect = (current) => `<select class="f-dash">${Object.keys(DASHES)
    .map((d) => `<option value="${d}" ${d === (current || 'solid') ? 'selected' : ''}>${DASH_LABELS[d]}</option>`)
    .join('')}</select>`;

  let specific = '';
  if (layer.type === 'roads') {
    specific = `
      <label><span class="lbl">Colore tracciato</span>
        <input type="color" class="f-color" value="${style.color || '#f2c14e'}">${swatches(style.color, 'color')}</label>
      <label><span class="lbl">Spessore: <b class="v-width">${style.width || 4}</b> px</span>
        <input type="range" class="f-width" min="1" max="16" step="1" value="${style.width || 4}"></label>
      <label><span class="lbl">Tratteggio</span>${dashSelect(style.dash)}</label>
      <label><span class="lbl">Colore bordo (abbinamento)</span>
        <input type="color" class="f-casingColor" value="${style.casingColor || '#2b2b2b'}">${swatches(style.casingColor, 'casingColor')}</label>
      <label><span class="lbl">Spessore bordo: <b class="v-casing">${style.casingWidth ?? 2}</b> px</span>
        <input type="range" class="f-casingWidth" min="0" max="8" step="1" value="${style.casingWidth ?? 2}"></label>
      <div class="hint">Lunghezza: ${lengthOf(feature.coords)} blocchi · ${feature.coords.length} vertici</div>
      <button class="btn btn-sm" data-act="extend">Estendi questa strada</button>`;
  } else if (layer.type === 'transit') {
    const stations = layer.stations || [];
    const stationIds = feature.stationIds || [];
    const otherStations = stations.filter((s) => !stationIds.includes(s.id));
    const chips = stationIds.map((id) => {
      const st = stations.find((s) => s.id === id);
      return st ? `<span class="station-chip">${escapeHtml(st.name || '(senza nome)')}
        <b data-act="rmstation" data-station="${st.id}" title="Rimuovi dalla linea">×</b></span>` : '';
    }).join('');
    specific = `
      <label><span class="lbl">Colore linea</span>
        <input type="color" class="f-color" value="${style.color || '#4fa3d1'}">${swatches(style.color, 'color')}</label>
      <label><span class="lbl">Spessore: <b class="v-width">${style.width || 5}</b> px</span>
        <input type="range" class="f-width" min="1" max="16" step="1" value="${style.width || 5}"></label>
      <label><span class="lbl">Tratteggio</span>${dashSelect(style.dash)}</label>
      <label><span class="lbl">Colore contorno</span>
        <input type="color" class="f-casingColor" value="${style.casingColor || '#2b2b2b'}">${swatches(style.casingColor, 'casingColor')}</label>
      <label><span class="lbl">Spessore contorno: <b class="v-casing">${style.casingWidth ?? 0}</b> px</span>
        <input type="range" class="f-casingWidth" min="0" max="8" step="1" value="${style.casingWidth ?? 0}"></label>
      <div class="hint">Lunghezza: ${lengthOf(feature.coords)} blocchi · ${feature.coords.length} vertici</div>
      <button class="btn btn-sm" data-act="extend">Estendi questa linea</button>
      <div class="stations-box">
        <span class="lbl">Stazioni su questa linea</span>
        <div class="station-chips">${chips || '<span class="hint" style="margin:0">Nessuna stazione</span>'}</div>
        <button class="btn btn-sm" data-act="newstation">+ Nuova stazione</button>
        ${otherStations.length ? `
          <div class="row" style="margin-top:6px">
            <select class="f-existing-station">${otherStations.map((s) => (
              `<option value="${s.id}">${escapeHtml(s.name || '(senza nome)')}</option>`
            )).join('')}</select>
            <button class="btn btn-sm" data-act="attachstation">Collega</button>
          </div>` : ''}
        <div class="hint">"+ Nuova stazione" fa scegliere il punto sulla mappa: se clicchi
          vicino a una stazione già esistente ti colleghi a quella invece di crearne una nuova.
          Disegnando o estendendo una linea che passa sopra una stazione, la linea si collega
          da sola.</div>
      </div>
      <div class="stations-box" style="margin-top:8px">
        <span class="lbl">Linee e stazioni — ${escapeHtml(layer.name)}</span>
        ${transitReportHtml(layer)}
      </div>`;
  } else if (layer.type === 'notes') {
    specific = `
      <label><span class="lbl">Colore</span>
        <input type="color" class="f-color" value="${style.color || '#f5e14a'}">${swatches(style.color, 'color')}</label>
      <label><span class="lbl">Dimensione: <b class="v-size">${style.size || 16}</b> px</span>
        <input type="range" class="f-size" min="10" max="30" step="1" value="${style.size || 16}"></label>
      <div class="hint">Posizione: X ${feature.coord[0]}, Z ${feature.coord[1]} — trascinabile sulla mappa</div>`;
  } else if (layer.type === 'areas') {
    specific = `
      <label><span class="lbl">Colore riempimento</span>
        <input type="color" class="f-fillColor" value="${style.fillColor || '#4fa3d1'}">${swatches(style.fillColor, 'fillColor')}</label>
      <label><span class="lbl">Opacità: <b class="v-opacity">${Math.round((style.fillOpacity ?? 0.25) * 100)}</b>%</span>
        <input type="range" class="f-fillOpacity" min="0" max="100" step="5" value="${Math.round((style.fillOpacity ?? 0.25) * 100)}"></label>
      <label><span class="lbl">Colore bordo</span>
        <input type="color" class="f-strokeColor" value="${style.strokeColor || '#4fa3d1'}">${swatches(style.strokeColor, 'strokeColor')}</label>
      <label><span class="lbl">Spessore bordo: <b class="v-stroke">${style.strokeWidth || 2}</b> px</span>
        <input type="range" class="f-strokeWidth" min="0" max="10" step="1" value="${style.strokeWidth || 2}"></label>
      <label><span class="lbl">Tratteggio bordo</span>${dashSelect(style.dash)}</label>
      <div class="hint">Superficie: ${areaOf(feature.coords)} blocchi² · ${feature.coords.length} vertici</div>`;
  } else {
    const shapeBtns = POI_SHAPES.map((s) => `
      <button class="shape-btn ${s === (style.shape || 'circle') ? 'sel' : ''}" data-shape="${s}" title="${s}">
        ${poiSvg(s, '#ffffff', 16)}
      </button>`).join('');
    specific = `
      <label><span class="lbl">Categoria</span>
        <select class="f-category">${POI_CATEGORIES
          .map((c) => `<option value="${c}" ${c === (feature.category || 'altro') ? 'selected' : ''}>${c}</option>`).join('')}
        </select></label>
      <label><span class="lbl">Simbolo</span><div class="shape-row">${shapeBtns}</div></label>
      <label><span class="lbl">Colore</span>
        <input type="color" class="f-color" value="${style.color || '#e05a47'}">${swatches(style.color, 'color')}</label>
      <label><span class="lbl">Dimensione: <b class="v-size">${style.size || 10}</b> px</span>
        <input type="range" class="f-size" min="6" max="30" step="1" value="${style.size || 10}"></label>
      <div class="hint">Posizione: X ${feature.coord[0]}, Z ${feature.coord[1]} — trascinabile sulla mappa</div>`;
  }

  host.innerHTML = `
    <label><span class="lbl">Nome</span><input type="text" class="f-name" value="${escapeHtml(feature.name)}"></label>
    <label><span class="lbl">Descrizione</span><textarea class="f-description" rows="3">${escapeHtml(feature.description)}</textarea></label>
    <label><span class="lbl">Banner / immagine</span>
      <input type="file" class="f-image" accept="image/png,image/jpeg,image/webp">
      <div class="props-banner">
        ${feature.image ? `<img src="${feature.image}" alt="">` : '<span class="hint" style="margin:0">Nessuna immagine</span>'}
        ${feature.image ? '<button class="btn btn-sm btn-danger" data-act="rmimg" style="margin:0">Rimuovi</button>' : ''}
      </div>
    </label>
    ${layer.type !== 'transit' ? `
    <label style="display:flex;align-items:center;gap:8px">
      <input type="checkbox" class="f-showName" ${style.showName !== false ? 'checked' : ''}> Mostra il nome sulla mappa
    </label>` : ''}
    ${specific}
    <div class="row">
      <button class="btn btn-sm" data-act="zoom">Vai all'elemento</button>
      <button class="btn btn-sm btn-danger" data-act="delete">Elimina</button>
    </div>`;

  wireProps(host, feature, layer);
}

/** A station's own Properties panel — reached by selecting it on the map
 *  with "Seleziona" active. Name/description were only ever settable at
 *  creation before this; shape/size default to the layer's symbol (see
 *  "Simbolo delle stazioni" on the layer panel) until customized here. */
function renderStationProps(host, station) {
  const layerId = state.selectedStation.layerId;
  const layer = findLayer(layerId);
  if (!layer) {
    host.innerHTML = '<div class="prop-empty">Nessun elemento selezionato.<br>Clicca un elemento sulla mappa.</div>';
    return;
  }
  const layerStyle = layer.defaultStyle || {};
  const custom = STATION_SHAPES.includes(station.shape) || !!station.size;
  const shape = custom ? station.shape : (layerStyle.stationShape || 'circle');
  const size = custom ? (station.size || layerStyle.stationSize || 14) : (layerStyle.stationSize || 14);
  const lines = linesAtStation(station, layer);
  const lineChips = lines.map((f) => (
    `<span class="line-chip" style="background:${styleOf(f, layer).color || '#4fa3d1'}"></span>${escapeHtml(f.name || '(senza nome)')}`
  )).join('<br>');

  host.innerHTML = `
    <label><span class="lbl">Nome</span><input type="text" class="st-name" value="${escapeHtml(station.name)}"></label>
    <label><span class="lbl">Descrizione</span><textarea class="st-description" rows="3">${escapeHtml(station.description)}</textarea></label>
    <label style="display:flex;align-items:center;gap:8px">
      <input type="checkbox" class="st-custom" ${custom ? 'checked' : ''}> Simbolo personalizzato per questa stazione
    </label>
    <div class="st-custom-fields" ${custom ? '' : 'style="display:none"'}>
      <label><span class="lbl">Simbolo</span>
        <select class="st-shape">
          <option value="circle" ${shape === 'circle' ? 'selected' : ''}>Cerchio</option>
          <option value="square" ${shape === 'square' ? 'selected' : ''}>Quadrato</option>
          <option value="rectangle" ${shape === 'rectangle' ? 'selected' : ''}>Rettangolo</option>
        </select>
      </label>
      <label><span class="lbl">Dimensione: <b class="st-size-v">${size}</b> px</span>
        <input type="range" class="st-size" min="8" max="28" step="1" value="${size}"></label>
    </div>
    <div class="hint">${lines.length ? 'Linee collegate:' : 'Nessuna linea collegata a questa stazione'}</div>
    ${lineChips ? `<div class="line-chip-list">${lineChips}</div>` : ''}
    <div class="row">
      <button class="btn btn-sm" data-act="zoom">Vai alla stazione</button>
      <button class="btn btn-sm btn-danger" data-act="delete">Elimina</button>
    </div>`;

  wireStationProps(host, station, layer);
}

function wireStationProps(host, station, layer) {
  const commit = () => {
    markDirty();
    refreshStations(layer.id);
    Main.renderLayerList();
  };

  const bindText = (sel, apply) => {
    const node = host.querySelector(sel);
    if (node) node.addEventListener('input', debounce(() => apply(node.value), 250));
  };
  bindText('.st-name', (v) => { station.name = v; commit(); });
  bindText('.st-description', (v) => { station.description = v; commit(); });

  const customBox = host.querySelector('.st-custom-fields');
  const customCb = host.querySelector('.st-custom');
  if (customCb) {
    customCb.addEventListener('change', () => {
      if (customCb.checked) {
        const layerStyle = layer.defaultStyle || {};
        station.shape = STATION_SHAPES.includes(layerStyle.stationShape) ? layerStyle.stationShape : 'circle';
        station.size = Number(layerStyle.stationSize) || 14;
        if (customBox) customBox.style.display = '';
      } else {
        station.shape = null;
        station.size = null;
        if (customBox) customBox.style.display = 'none';
      }
      commit();
    });
  }

  const shapeSel = host.querySelector('.st-shape');
  if (shapeSel) shapeSel.addEventListener('change', () => { station.shape = shapeSel.value; commit(); });

  const sizeInput = host.querySelector('.st-size');
  if (sizeInput) {
    sizeInput.addEventListener('input', () => {
      const readout = host.querySelector('.st-size-v');
      if (readout) readout.textContent = sizeInput.value;
      station.size = Number(sizeInput.value);
      commit();
    });
  }

  const zoomBtn = host.querySelector('[data-act="zoom"]');
  if (zoomBtn) zoomBtn.addEventListener('click', () => zoomToStation(station));
  const delBtn = host.querySelector('[data-act="delete"]');
  if (delBtn) {
    delBtn.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Eliminare la stazione?',
        message: `"${station.name || 'senza nome'}" verrà rimossa, e scollegata da ogni linea che vi si fermava.`,
        confirmLabel: 'Elimina', danger: true,
      });
      if (ok) deleteStation(layer.id, station.id);
    });
  }
}

function zoomToStation(station) {
  map.setView(toLatLng(station.x, station.z), Math.max(map.getZoom(), -1));
}

function wireProps(host, feature, layer) {
  const commit = (rerender) => {
    markDirty();
    if (rerender) refreshFeature(layer.id, feature.id);
    Main.renderLayerList();
  };
  const setStyle = (key, value, rerender = true) => {
    feature.style = { ...(feature.style || {}), [key]: value };
    commit(rerender);
  };

  const bindText = (sel, apply) => {
    const node = host.querySelector(sel);
    if (node) node.addEventListener('input', debounce(() => apply(node.value), 250));
  };
  bindText('.f-name', (v) => { feature.name = v; commit(true); });
  bindText('.f-description', (v) => { feature.description = v; commit(true); });

  const showName = host.querySelector('.f-showName');
  if (showName) showName.addEventListener('change', () => setStyle('showName', showName.checked));

  // Colors: both the native picker and the quick palette swatches.
  for (const key of ['color', 'casingColor', 'fillColor', 'strokeColor']) {
    const input = host.querySelector(`.f-${key}`);
    if (input) input.addEventListener('input', debounce(() => setStyle(key, input.value), 120));
  }
  host.querySelectorAll('.swatch').forEach((sw) => {
    sw.addEventListener('click', () => {
      const key = sw.dataset.swatch;
      const color = sw.style.backgroundColor;
      // Normalize rgb() from the DOM back into hex for storage.
      const m = color.match(/\d+/g);
      const hex = m ? `#${m.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('')}` : color;
      const input = host.querySelector(`.f-${key}`);
      if (input) input.value = hex;
      setStyle(key, hex);
      host.querySelectorAll(`.swatch[data-swatch="${key}"]`).forEach((s) => s.classList.remove('sel'));
      sw.classList.add('sel');
    });
  });

  // Numeric sliders, with their live value readout.
  const sliders = [
    ['.f-width', 'width', '.v-width', (v) => v],
    ['.f-casingWidth', 'casingWidth', '.v-casing', (v) => v],
    ['.f-strokeWidth', 'strokeWidth', '.v-stroke', (v) => v],
    ['.f-size', 'size', '.v-size', (v) => v],
    ['.f-fillOpacity', 'fillOpacity', '.v-opacity', (v) => v / 100],
  ];
  for (const [sel, key, valSel, transform] of sliders) {
    const node = host.querySelector(sel);
    if (!node) continue;
    node.addEventListener('input', () => {
      const readout = host.querySelector(valSel);
      if (readout) readout.textContent = node.value;
      setStyle(key, transform(Number(node.value)));
    });
  }

  const dash = host.querySelector('.f-dash');
  if (dash) dash.addEventListener('change', () => setStyle('dash', dash.value));

  const category = host.querySelector('.f-category');
  if (category) category.addEventListener('change', () => { feature.category = category.value; commit(true); });

  host.querySelectorAll('.shape-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      host.querySelectorAll('.shape-btn').forEach((b) => b.classList.remove('sel'));
      btn.classList.add('sel');
      setStyle('shape', btn.dataset.shape);
    });
  });

  const imageInput = host.querySelector('.f-image');
  if (imageInput) {
    imageInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        feature.image = await imageToDataUrl(file);
        commit(true);
        refreshProps();
        toast('Banner aggiunto', 'ok');
      } catch (err) {
        toast(`Immagine non caricata: ${err.message}`, 'err');
      }
    });
  }
  const rmImg = host.querySelector('[data-act="rmimg"]');
  if (rmImg) {
    rmImg.addEventListener('click', () => {
      feature.image = null;
      commit(true);
      refreshProps();
    });
  }

  const extendBtn = host.querySelector('[data-act="extend"]');
  if (extendBtn) extendBtn.addEventListener('click', () => extendFeature(layer, feature));

  const newStationBtn = host.querySelector('[data-act="newstation"]');
  if (newStationBtn) newStationBtn.addEventListener('click', () => beginPlaceStation(layer, feature));
  const attachBtn = host.querySelector('[data-act="attachstation"]');
  if (attachBtn) {
    attachBtn.addEventListener('click', () => {
      const sel = host.querySelector('.f-existing-station');
      if (!sel || !sel.value) return;
      feature.stationIds = [...new Set([...(feature.stationIds || []), sel.value])];
      markDirty();
      refreshProps();
    });
  }
  host.querySelectorAll('[data-act="rmstation"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      feature.stationIds = (feature.stationIds || []).filter((id) => id !== btn.dataset.station);
      markDirty();
      refreshProps();
    });
  });

  const zoomBtn = host.querySelector('[data-act="zoom"]');
  if (zoomBtn) zoomBtn.addEventListener('click', () => zoomToFeature(feature, layer));
  const delBtn = host.querySelector('[data-act="delete"]');
  if (delBtn) {
    delBtn.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Eliminare l\'elemento?',
        message: `"${feature.name || 'senza nome'}" verrà rimosso dal layer "${layer.name}".`,
        confirmLabel: 'Elimina', danger: true,
      });
      if (ok) deleteFeature(layer.id, feature.id);
    });
  }
}

function zoomToFeature(feature, layer) {
  if (isPointLayer(layer.type)) {
    map.setView(toLatLng(feature.coord[0], feature.coord[1]), Math.max(map.getZoom(), -1));
  } else {
    const b = L.latLngBounds(feature.coords.map(([x, z]) => toLatLng(x, z)));
    map.fitBounds(b.pad(0.2));
  }
}

function setTerrainVisible(visible) {
  if (!tileLayer) return;
  if (visible && !map.hasLayer(tileLayer)) tileLayer.addTo(map);
  if (!visible && map.hasLayer(tileLayer)) map.removeLayer(tileLayer);
}

// --------------------------------------------------------------- export
/** Block bounds to export, either the current view or the whole dimension. */
function exportBounds(mode) {
  if (mode === 'all' && state.world) {
    const dim = state.world.dimensions.find((d) => d.id === state.project.world.dimension)
      || state.world.dimensions[0];
    return { ...dim.bounds };
  }
  const b = map.getBounds();
  const nw = fromLatLng(b.getNorthWest());
  const se = fromLatLng(b.getSouthEast());
  return {
    minX: Math.floor(nw.x), minZ: Math.floor(nw.z),
    maxX: Math.ceil(se.x), maxZ: Math.ceil(se.z),
  };
}

const MAX_EXPORT_PX = 8000;
/** Pick the native tile zoom whose pixel size stays under the export cap. */
function pickExportZoom(bounds) {
  const wBlocks = bounds.maxX - bounds.minX + 1;
  const hBlocks = bounds.maxZ - bounds.minZ + 1;
  for (let z = 0; z >= -6; z--) {
    const scale = Math.pow(2, z);
    if (wBlocks * scale <= MAX_EXPORT_PX && hBlocks * scale <= MAX_EXPORT_PX) return z;
  }
  return -6;
}

/**
 * Everything an export needs to know about its canvas. `zoom` is capped at
 * -6 (64 blocks/px, the coarsest native tile) — for a world whose explored
 * bounds are vast (a stray far-away region is enough: "tutto il mondo
 * generato" then spans hundreds of thousands of blocks even though the
 * built-up area is tiny), that still isn't small enough to stay under
 * MAX_EXPORT_PX. `shrink` covers the rest, so the canvas this actually
 * allocates never exceeds the cap. Skipping this was the bug behind a
 * "tutto il mondo" export opening as a broken image in the Lettore: the
 * browser silently fails (or produces garbage) trying to allocate a
 * multi-thousand-megapixel canvas, and toDataURL/toBlob on it is worthless.
 */
function exportPlan(bounds) {
  const zoom = pickExportZoom(bounds);
  const tileScale = Math.pow(2, zoom);
  const rawW = (bounds.maxX - bounds.minX + 1) * tileScale;
  const rawH = (bounds.maxZ - bounds.minZ + 1) * tileScale;
  const shrink = Math.min(1, MAX_EXPORT_PX / Math.max(rawW, rawH, 1));
  const scale = tileScale * shrink;
  const w = Math.max(1, Math.round((bounds.maxX - bounds.minX + 1) * scale));
  const h = Math.max(1, Math.round((bounds.maxZ - bounds.minZ + 1) * scale));
  return { zoom, scale, w, h, shrunk: shrink < 1 };
}

/** Draw the terrain for `bounds` onto a canvas, via the worker. `zoom`
 *  decides which cached/rendered tiles are fetched; `drawScale` (which may
 *  be smaller than the tiles' own native scale — see exportPlan) decides
 *  where and how big each one is painted, so the canvas stays bounded no
 *  matter how far apart the fetched tiles are. */
async function drawTerrain(ctx, bounds, zoom, drawScale, kind) {
  const tileScale = Math.pow(2, zoom);
  const span = 256 / tileScale; // blocks covered by one native tile
  const t0x = Math.floor(bounds.minX / span);
  const t1x = Math.floor(bounds.maxX / span);
  const t0y = Math.floor(bounds.minZ / span);
  const t1y = Math.floor(bounds.maxZ / span);
  const dimId = state.project.world.dimension;
  const drawSize = 256 * (drawScale / tileScale);

  const jobs = [];
  for (let ty = t0y; ty <= t1y; ty++) {
    for (let tx = t0x; tx <= t1x; tx++) jobs.push({ tx, ty });
  }
  // Small batches: a whole-world export can be thousands of tiles and we
  // don't want to queue them all into the worker at once.
  const BATCH = 8;
  for (let i = 0; i < jobs.length; i += BATCH) {
    const slice = jobs.slice(i, i + BATCH);
    const results = await Promise.all(slice.map(({ tx, ty }) => (
      engine.tile(dimId, zoom, tx, ty, kind).catch(() => null)
    )));
    results.forEach((res, k) => {
      if (!res || res.empty || !res.bitmap) return;
      const { tx, ty } = slice[k];
      ctx.drawImage(
        res.bitmap,
        (tx * span - bounds.minX) * drawScale, (ty * span - bounds.minZ) * drawScale,
        drawSize, drawSize,
      );
      res.bitmap.close();
    });
  }
}

/* Banner images decoded ahead of an export: drawImage needs them ready, and
 * decoding is asynchronous. */
const bannerImages = new Map();

async function preloadBanners() {
  bannerImages.clear();
  const jobs = [];
  for (const layer of state.project.layers) {
    for (const feature of layer.features) {
      if (!feature.image) continue;
      jobs.push(new Promise((resolve) => {
        const img = new Image();
        img.onload = () => { bannerImages.set(feature.id, img); resolve(); };
        img.onerror = () => resolve();
        img.src = feature.image;
      }));
    }
  }
  await Promise.all(jobs);
}

/** Draw all visible vector layers onto a canvas. */
function drawVectors(ctx, bounds, scale) {
  const toPx = (x, z) => [(x - bounds.minX) * scale, (z - bounds.minZ) * scale];

  const applyDash = (style) => {
    const dash = dashFor(style);
    ctx.setLineDash(dash ? dash.split(',').map((n) => Number(n) * scale) : []);
  };

  for (const layer of state.project.layers) {
    if (!layerVisible(layer)) continue;
    for (const feature of layer.features) {
      const style = styleOf(feature, layer);

      if (layer.type === 'areas') {
        ctx.beginPath();
        feature.coords.forEach(([x, z], i) => {
          const [px, py] = toPx(x, z);
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        });
        ctx.closePath();
        ctx.globalAlpha = style.fillOpacity ?? 0.25;
        ctx.fillStyle = style.fillColor || '#4fa3d1';
        ctx.fill();
        ctx.globalAlpha = 1;
        if ((style.strokeWidth || 0) > 0) {
          applyDash(style);
          ctx.strokeStyle = style.strokeColor || '#4fa3d1';
          ctx.lineWidth = style.strokeWidth;
          ctx.stroke();
          ctx.setLineDash([]);
        }

      } else if (layer.type === 'roads' || layer.type === 'transit') {
        const drawCoords = layer.type === 'transit' ? offsetTransitCoords(feature, layer) : feature.coords;
        const stroke = (color, width, dashed) => {
          ctx.beginPath();
          drawCoords.forEach(([x, z], i) => {
            const [px, py] = toPx(x, z);
            if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          });
          ctx.strokeStyle = color;
          ctx.lineWidth = width;
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';
          if (dashed) applyDash(style); else ctx.setLineDash([]);
          ctx.stroke();
          ctx.setLineDash([]);
        };
        // Casing defaults to off for transit lines, but is drawn the same
        // way as for roads whenever it's turned on (see buildFeatureLayer).
        const casing = Number(style.casingWidth) || 0;
        if (casing > 0) stroke(style.casingColor || '#000', (Number(style.width) || 4) + casing * 2, false);
        stroke(style.color || (layer.type === 'transit' ? '#4fa3d1' : '#f2c14e'), Number(style.width) || 4, true);

      } else if (layer.type === 'notes') {
        const [px, py] = toPx(feature.coord[0], feature.coord[1]);
        drawPoiShape(ctx, 'square', px, py, Number(style.size) || 16, style.color || '#f5e14a');

      } else { // pois
        const [px, py] = toPx(feature.coord[0], feature.coord[1]);
        drawPoiShape(ctx, style.shape || 'circle', px, py, Number(style.size) || 10, style.color || '#e05a47');
      }

      // Banner, planted like a flag on the feature.
      if (feature.image) {
        const img = bannerImages.get(feature.id);
        if (img) {
          const [bx, by] = isPointLayer(layer.type)
            ? toPx(feature.coord[0], feature.coord[1])
            : centroidPx(feature.coords, toPx);
          const bh = 34;
          const bw = Math.max(1, Math.round(img.width * (bh / img.height)));
          ctx.drawImage(img, bx - bw / 2, by - bh, bw, bh);
        }
      }

      // Labels — transit lines never show their name on the map (see buildFeatureLayer).
      if (layer.type !== 'transit' && style.showName !== false && feature.name) {
        const [ox, oz] = labelOffsetWorld(feature, layer);
        const [lx, ly] = isPointLayer(layer.type)
          ? toPx(feature.coord[0] + ox, feature.coord[1] + oz)
          : (() => {
            let sx = 0, sz = 0;
            for (const [x, z] of feature.coords) { sx += x; sz += z; }
            return toPx(sx / feature.coords.length + ox, sz / feature.coords.length + oz);
          })();
        ctx.font = `${layer.type === 'areas' ? 15 : 12}px monospace`;
        ctx.textAlign = isPointLayer(layer.type) ? 'left' : 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.strokeText(feature.name, lx, ly);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(feature.name, lx, ly);
      }
    }

    // Transit stations, drawn once per layer rather than per line so a
    // shared stop isn't stamped twice.
    if (layer.type === 'transit') {
      for (const station of layer.stations || []) {
        const [sx, sy] = toPx(station.x, station.z);
        drawStationDot(ctx, sx, sy);
        if (station.name) {
          ctx.font = '12px monospace';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.lineWidth = 3;
          ctx.strokeStyle = 'rgba(0,0,0,0.85)';
          ctx.strokeText(station.name, sx + 10, sy);
          ctx.fillStyle = '#ffffff';
          ctx.fillText(station.name, sx + 10, sy);
        }
      }
    }
  }
}

function drawStationDot(ctx, cx, cy) {
  const r = 6;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = '#1a1a1a';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(1, r - 4), 0, Math.PI * 2);
  ctx.fillStyle = '#1a1a1a';
  ctx.fill();
}

function centroidPx(coords, toPx) {
  let sx = 0, sz = 0;
  for (const [x, z] of coords) { sx += x; sz += z; }
  return toPx(sx / coords.length, sz / coords.length);
}

/** Where a feature's name label lands, in world blocks relative to its
 *  anchor — a user's drag if there is one, otherwise the same default the
 *  editor starts a fresh label at (see buildFeatureLayer): clear of a
 *  POI's icon, perpendicular to a road's stroke, dead centre for an area.
 *  Shared by the PNG and SVG exports so a flattened map matches what the
 *  editor actually shows instead of falling back to its own dead-centre-
 *  on-the-line default. */
function labelOffsetWorld(feature, layer) {
  if (feature.style && Array.isArray(feature.style.labelOffset)) return feature.style.labelOffset;
  if (isPointLayer(layer.type)) return DEFAULT_POINT_LABEL_OFFSET;
  if (layer.type === 'roads') return defaultLineLabelOffset(feature);
  return [0, 0];
}

function drawPoiShape(ctx, shape, cx, cy, size, color) {
  const r = size / 2;
  ctx.beginPath();
  switch (shape) {
    case 'square': ctx.rect(cx - r, cy - r, size, size); break;
    case 'triangle':
      ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy + r); ctx.lineTo(cx - r, cy + r); ctx.closePath();
      break;
    case 'diamond':
      ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy); ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r, cy); ctx.closePath();
      break;
    case 'star':
      for (let i = 0; i < 10; i++) {
        const rr = i % 2 === 0 ? r : r * 0.45;
        const a = (Math.PI / 5) * i - Math.PI / 2;
        const px = cx + rr * Math.cos(a);
        const py = cy + rr * Math.sin(a);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      break;
    case 'pin':
      ctx.moveTo(cx, cy + r);
      ctx.lineTo(cx - r, cy - r * 0.2);
      ctx.arc(cx, cy - r * 0.2, r, Math.PI, 0);
      ctx.closePath();
      break;
    default: ctx.arc(cx, cy, r, 0, Math.PI * 2);
  }
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#0d0d0d';
  ctx.setLineDash([]);
  ctx.stroke();
}

/** Every export's filename starts with the Minecraft world's own name, not
 *  the atlante's (which the user is free to rename to anything). */
function worldFileBase() {
  const name = (state.project && state.project.world && state.project.world.levelName)
    || (state.project && state.project.name) || 'mondo';
  return slugify(name);
}

/** Asked once per export, instead of a preset dropdown that's easy to
 *  forget to change before clicking. Resolves the block bounds to export,
 *  or null if the user cancels (including cancelling the "disegna" draw). */
async function pickExportBounds() {
  const area = await pickDialog({
    title: 'Area da esportare',
    options: [
      { value: 'view', label: 'Vista attuale' },
      { value: 'all', label: 'Tutto il mondo generato' },
      { value: 'draw', label: 'Disegna un\'area sulla mappa' },
    ],
  });
  if (!area) return null;
  if (area === 'draw') return drawExportArea();
  return exportBounds(area);
}

/** Lets the user drag out a rectangle on the map and resolves its block
 *  bounds — a one-off interaction, kept from colliding with the normal
 *  "draw a new feature" flow (also bound to L.Draw.Event.CREATED) by
 *  unhooking it for the duration and restoring it right after. */
function drawExportArea() {
  return new Promise((resolve) => {
    setTool('select');
    map.off(L.Draw.Event.CREATED, onDrawCreated);
    const rect = new L.Draw.Rectangle(map, { shapeOptions: { color: '#7fd44f', weight: 2 } });
    const hint = el('draw-hint');
    hint.classList.remove('hidden');
    hint.innerHTML = 'Disegna l\'area da esportare trascinando sulla mappa. <kbd>Esc</kbd> per annullare.';

    const cleanup = () => {
      map.off(L.Draw.Event.CREATED, onCreated);
      document.removeEventListener('keydown', onKey);
      map.on(L.Draw.Event.CREATED, onDrawCreated);
      hint.classList.add('hidden');
    };
    const onCreated = (e) => {
      const b = e.layer.getBounds();
      const nw = fromLatLng(b.getNorthWest());
      const se = fromLatLng(b.getSouthEast());
      cleanup();
      resolve({
        minX: Math.floor(nw.x), minZ: Math.floor(nw.z),
        maxX: Math.ceil(se.x), maxZ: Math.ceil(se.z),
      });
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      rect.disable();
      cleanup();
      resolve(null);
    };
    map.on(L.Draw.Event.CREATED, onCreated);
    document.addEventListener('keydown', onKey);
    rect.enable();
  });
}

async function exportPNG() {
  if (!state.project || !state.world) { toast('Apri prima un atlante', 'err'); return; }
  const bounds = await pickExportBounds();
  if (!bounds) return;
  const { zoom, scale, w, h, shrunk } = exportPlan(bounds);

  setStatus('export-status', `Composizione immagine ${w}×${h}…`, 'busy');
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#10120e';
  ctx.fillRect(0, 0, w, h);

  try {
    await drawTerrain(ctx, bounds, zoom, scale); // terrain is always on — no toggle in the UI
    await preloadBanners();
    drawVectors(ctx, bounds, scale);
    await new Promise((resolve) => canvas.toBlob((blob) => {
      download(`${worldFileBase()}.png`, blob);
      resolve();
    }, 'image/png'));
    setStatus('export-status',
      `PNG esportato (${w}×${h} px)${shrunk ? ' — area molto grande, risoluzione ridotta per restare esportabile' : ''}`, 'ok');
  } catch (err) {
    setStatus('export-status', `Export fallito: ${err.message}`, 'err');
  }
}

async function exportSVG() {
  if (!state.project) { toast('Apri prima un atlante', 'err'); return; }
  const bounds = await pickExportBounds();
  if (!bounds) return;
  const { zoom, scale, w, h, shrunk } = exportPlan(bounds);
  const toPx = (x, z) => [((x - bounds.minX) * scale).toFixed(1), ((z - bounds.minZ) * scale).toFixed(1)];

  setStatus('export-status', 'Composizione SVG…', 'busy');
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`];
  parts.push(`<rect width="${w}" height="${h}" fill="#10120e"/>`);

  // Terrain goes in as one flattened raster so the SVG stays a sane size.
  // Always on — no toggle in the UI any more.
  {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    try {
      await drawTerrain(ctx, bounds, zoom, scale);
      parts.push(`<image x="0" y="0" width="${w}" height="${h}" href="${canvas.toDataURL('image/png')}" style="image-rendering:pixelated"/>`);
    } catch { /* terrain is optional in the SVG */ }
  }

  for (const layer of state.project.layers) {
    if (!layerVisible(layer)) continue;
    parts.push(`<g id="${escapeHtml(layer.id)}" data-layer="${escapeHtml(layer.name)}" data-type="${layer.type}">`);
    for (const feature of layer.features) {
      const style = styleOf(feature, layer);
      const dash = dashFor(style);
      const dashAttr = dash ? ` stroke-dasharray="${dash.split(',').map((n) => Number(n) * scale).join(',')}"` : '';

      if (layer.type === 'areas') {
        const pts = feature.coords.map(([x, z]) => toPx(x, z).join(',')).join(' ');
        parts.push(`<polygon points="${pts}" fill="${style.fillColor || '#4fa3d1'}" fill-opacity="${style.fillOpacity ?? 0.25}" stroke="${style.strokeColor || '#4fa3d1'}" stroke-width="${style.strokeWidth || 2}"${dashAttr}/>`);
      } else if (layer.type === 'roads' || layer.type === 'transit') {
        const drawCoords = layer.type === 'transit' ? offsetTransitCoords(feature, layer) : feature.coords;
        const d = `M ${drawCoords.map(([x, z]) => toPx(x, z).join(',')).join(' L ')}`;
        const casing = Number(style.casingWidth) || 0;
        if (casing > 0) {
          parts.push(`<path d="${d}" fill="none" stroke="${style.casingColor || '#000'}" stroke-width="${(Number(style.width) || 4) + casing * 2}" stroke-linejoin="round" stroke-linecap="round"/>`);
        }
        parts.push(`<path id="p-${escapeHtml(feature.id)}" d="${d}" fill="none" stroke="${style.color || (layer.type === 'transit' ? '#4fa3d1' : '#f2c14e')}" stroke-width="${style.width || 4}" stroke-linejoin="round"${dashAttr}/>`);
      } else if (layer.type === 'notes') {
        const [px, py] = toPx(feature.coord[0], feature.coord[1]);
        const size = Number(style.size) || 16;
        parts.push(`<g transform="translate(${px - size / 2},${py - size / 2})">${noteSvg(style.color || '#f5e14a', size)}</g>`);
      } else { // pois
        const [px, py] = toPx(feature.coord[0], feature.coord[1]);
        const size = Number(style.size) || 10;
        parts.push(`<g transform="translate(${px - size / 2},${py - size / 2})">${poiSvg(style.shape || 'circle', style.color || '#e05a47', size)}</g>`);
      }

      if (layer.type !== 'transit' && style.showName !== false && feature.name) {
        const [ox, oz] = labelOffsetWorld(feature, layer);
        const [lx, ly] = isPointLayer(layer.type)
          ? toPx(feature.coord[0] + ox, feature.coord[1] + oz)
          : (() => {
            let sx = 0, sz = 0;
            for (const [x, z] of feature.coords) { sx += x; sz += z; }
            return toPx(sx / feature.coords.length + ox, sz / feature.coords.length + oz);
          })();
        const anchor = isPointLayer(layer.type) ? 'start' : 'middle';
        const fs = layer.type === 'areas' ? 15 : 12;
        parts.push(`<text x="${lx}" y="${ly}" font-family="monospace" font-size="${fs}" text-anchor="${anchor}" dominant-baseline="middle" fill="#fff" stroke="#000" stroke-width="3" paint-order="stroke">${escapeHtml(feature.name)}</text>`);
      }
    }
    if (layer.type === 'transit') {
      for (const station of layer.stations || []) {
        const [sx, sy] = toPx(station.x, station.z);
        parts.push(`<circle cx="${sx}" cy="${sy}" r="6" fill="#fff" stroke="#1a1a1a" stroke-width="2.5"/><circle cx="${sx}" cy="${sy}" r="2" fill="#1a1a1a"/>`);
        if (station.name) {
          parts.push(`<text x="${Number(sx) + 10}" y="${sy}" font-family="monospace" font-size="12" text-anchor="start" dominant-baseline="middle" fill="#fff" stroke="#000" stroke-width="3" paint-order="stroke">${escapeHtml(station.name)}</text>`);
        }
      }
    }
    parts.push('</g>');
  }
  parts.push('</svg>');

  download(`${worldFileBase()}_ATLAS_layer.svg`, parts.join('\n'), 'image/svg+xml');
  setStatus('export-status',
    `SVG esportato (${w}×${h})${shrunk ? ' — area molto grande, risoluzione del terreno ridotta' : ''}`, 'ok');
}

export const READER_MAP_FORMAT = 'cube-atlas/map';

/**
 * Export for the Lettore: unlike "Immagine PNG" this does NOT bake the
 * layers into the raster. The image is terrain (+ rails) only — flat pixels
 * make sense for blocks — while the layers travel as data, so the Lettore
 * can still hide/show them and show each feature's info on hover, the same
 * as the Editor does.
 */
async function exportForReader() {
  if (!state.project || !state.world) { toast('Apri prima un atlante', 'err'); return; }
  const bounds = await pickExportBounds();
  if (!bounds) return;
  const { zoom, scale, w, h, shrunk } = exportPlan(bounds);

  setStatus('export-status', `Composizione atlante ${w}×${h}…`, 'busy');
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#10120e';
  ctx.fillRect(0, 0, w, h);

  try {
    await drawTerrain(ctx, bounds, zoom, scale); // terrain is always on — no toggle in the UI
    const bundle = {
      format: READER_MAP_FORMAT,
      version: 1,
      bounds,
      image: canvas.toDataURL('image/png'),
      layers: JSON.parse(JSON.stringify(state.project.layers)),
    };
    download(`${worldFileBase()}_ATLAS.camap.json`, JSON.stringify(bundle), 'application/json');
    setStatus('export-status',
      `Atlante esportato (${w}×${h} px)${shrunk ? ' — area molto grande, risoluzione ridotta per restare esportabile' : ''}`, 'ok');
  } catch (err) {
    setStatus('export-status', `Export fallito: ${err.message}`, 'err');
  }
}

/** Stations of one line, ordered along its path (nearest-vertex cumulative
 *  distance — good enough for a human-readable report, not exact point-to-
 *  segment projection). */
function orderedStationsForLine(feature, layer) {
  const stations = (feature.stationIds || [])
    .map((id) => (layer.stations || []).find((s) => s.id === id))
    .filter(Boolean);
  const paramFor = (station) => {
    let best = Infinity;
    let bestParam = 0;
    let cum = 0;
    for (let i = 0; i < feature.coords.length - 1; i++) {
      const a = feature.coords[i];
      const b = feature.coords[i + 1];
      const dA = dist(station.x, station.z, a[0], a[1]);
      if (dA < best) { best = dA; bestParam = cum; }
      cum += dist(a[0], a[1], b[0], b[1]);
    }
    const last = feature.coords[feature.coords.length - 1];
    const dLast = dist(station.x, station.z, last[0], last[1]);
    if (dLast < best) { bestParam = cum; }
    return bestParam;
  };
  return stations
    .map((s) => ({ station: s, param: paramFor(s) }))
    .sort((a, b) => a.param - b.param)
    .map((x) => x.station);
}

function transitReportHtml(layer) {
  const lines = layer.features;
  if (!lines.length) return '<p class="hint" style="margin:0">Nessuna linea in questo layer.</p>';
  return lines.map((f) => {
    const style = styleOf(f, layer);
    const stations = orderedStationsForLine(f, layer);
    const stopsHtml = stations.length
      ? `<ol style="margin:4px 0 0 18px;padding:0">${stations.map((s) => `<li>${escapeHtml(s.name || '(senza nome)')}</li>`).join('')}</ol>`
      : '<div class="hint" style="margin:2px 0 0">Nessuna stazione collegata</div>';
    return `<div style="margin-bottom:12px">
      <div style="display:flex;align-items:center;gap:6px">
        <span class="line-chip" style="background:${style.color || '#4fa3d1'}"></span>
        <b>${escapeHtml(f.name || '(senza nome)')}</b>
      </div>
      ${stopsHtml}
    </div>`;
  }).join('');
}

export {
  initMap, attachWorld, renderAllLayers, refreshFeature, setLayerVisibility, applyLayerVisibility,
  selectFeature, refreshProps, setTool, deleteFeature,
  setTerrainVisible, setRailsVisible, zoomToFeature, goTo, fitWorld, refreshTiles, updateViewInfo,
  currentDimension, exportPNG, exportSVG, exportForReader,
  POI_SHAPES, POI_CATEGORIES, PALETTE,
  // Pure geometry helpers, exported mainly so the test suite can exercise
  // them without a browser (see test/run-tests.js).
  offsetTransitCoords, snapToStations, straightenPolygon, exportPlan, MAX_EXPORT_PX,
  // Read-only rendering pieces, shared with the Lettore so a feature looks
  // and behaves (hover info) exactly the same whether it's being edited or
  // just viewed: one definition of what a road/POI/area/transit/note/station
  // looks like, not two that can drift apart.
  styleOf, dashFor, poiSvg, noteSvg, stationSvg, popupHtml, lengthOf, areaOf,
  bannerMarker, bannerAnchor, isPointLayer,
  beginPlaceStation, orderedStationsForLine, openLineVisibilityMenu, setStationStyle,
};
export function getMap() { return map; }
export function getCurrentTool() { return currentTool; }
