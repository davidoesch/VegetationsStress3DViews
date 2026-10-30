import { Cube } from './cube.js';
import { CLASSES, CLASS_OF, ALL_MASK, STRESS_MASK, NODATA } from './classes.js';
import { COLLECTIONS, listItems, sample } from './stac.js';
import { planGrid, createVolume, loadVolume, classShares } from './loader.js';
import { renderPixelChart, renderAreaChart } from './chart.js';
import { OVERLAYS, ATTRIBUTION, fetchNames, fetchRoads } from './overlay.js';

const { L, proj4 } = window;
proj4.defs('EPSG:2056', '+proj=somerc +lat_0=46.9524055555556 +lon_0=7.43958333333333 +k_0=1 '
  + '+x_0=2600000 +y_0=1200000 +ellps=bessel +towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs');
const toLV95 = ({ lat, lng }) => proj4('EPSG:4326', 'EPSG:2056', [lng, lat]);
const toWGS = (e, n) => proj4('EPSG:2056', 'EPSG:4326', [e, n]).reverse();

const $ = (id) => document.getElementById(id);
const fmt = (v) => Math.round(v).toLocaleString('de-CH');
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const FIRST_10M_DATE = '2017-04-03';
const MAX_VOXELS = 64e6;
// Measured on a forested 5 × 3 km area: ~560 KB per date for 4 tiles plus the COG header.
const KB_PER_TILE = 125;
const KB_PER_HEADER = 64;
const DEFAULT_HEIGHT = 0.7;
const DEFAULT_OVERLAYS = ['names'];

// LV95 bboxes [e0, n0, e1, n1].
const PRESETS = [
  { name: 'La Neuville', bbox: [2570570, 1212120, 2573150, 1214400] },
  { name: 'Ittigen', bbox: [2603040, 1203270, 2603880, 1204030] },
  { name: 'Pfynwald (VS)', bbox: [2610200, 1125800, 2615200, 1128800] },
  { name: 'Ajoie, Porrentruy (JU)', bbox: [2569600, 1249400, 2575600, 1254400] },
  { name: 'Sihlwald (ZH)', bbox: [2682600, 1234300, 2686600, 1238300] },
];

const state = {
  bbox: null, items: null, itemsOk: false, vol: null, shares: null,
  mask: ALL_MASK, pin: null, tab: 'pixel', abort: null, overlays: [...DEFAULT_OVERLAYS],
};

const cube = new Cube($('cube'));

// ---------------------------------------------------------------- map & area

const map = L.map('map', { minZoom: 7, maxBounds: [[45.2, 5.0], [48.4, 11.4]] })
  .fitBounds([[45.8, 5.95], [47.8, 10.5]]);
L.tileLayer('https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-grau/default/current/3857/{z}/{x}/{y}.jpeg', {
  maxZoom: 19, maxNativeZoom: 18, attribution: '© swisstopo',
}).addTo(map);
const overlay = L.tileLayer.wms('https://wms.geo.admin.ch/', {
  layers: 'ch.swisstopo.swisseo_vhi_v100', format: 'image/png', transparent: true, version: '1.3.0', opacity: 0.7,
}).addTo(map);
$('overlay').addEventListener('input', (e) => overlay.setOpacity(+e.target.value));

let areaShape = null;
function showBboxOnMap(b, fit) {
  const ring = [[b.e0, b.n0], [b.e1, b.n0], [b.e1, b.n1], [b.e0, b.n1]].map(([e, n]) => toWGS(e, n));
  if (areaShape) areaShape.setLatLngs(ring);
  else areaShape = L.polygon(ring, { color: cssVar('--accent'), weight: 2, fillOpacity: 0.06 }).addTo(map);
  if (fit) map.fitBounds(areaShape.getBounds(), { padding: [16, 16] });
}

function setBbox(b, { fit = false } = {}) {
  const r = (v) => Math.round(v / 10) * 10;
  state.bbox = {
    e0: r(Math.min(b.e0, b.e1)), e1: r(Math.max(b.e0, b.e1)),
    n0: r(Math.min(b.n0, b.n1)), n1: r(Math.max(b.n0, b.n1)),
  };
  for (const k of ['e0', 'n0', 'e1', 'n1']) $(k).value = state.bbox[k];
  showBboxOnMap(state.bbox, fit);
  scheduleInfo();
  saveHash();
}

for (const k of ['e0', 'n0', 'e1', 'n1']) {
  $(k).addEventListener('change', () => {
    const b = { e0: +$('e0').value, n0: +$('n0').value, e1: +$('e1').value, n1: +$('n1').value };
    if (Object.values(b).every((v) => v > 0) && b.e1 - b.e0 >= 100 && b.n1 - b.n0 >= 100) setBbox(b, { fit: true });
  });
}

for (const p of PRESETS) $('preset').add(new Option(p.name, p.name));
$('preset').addEventListener('change', (e) => {
  const p = PRESETS.find((x) => x.name === e.target.value);
  if (p) setBbox({ e0: p.bbox[0], n0: p.bbox[1], e1: p.bbox[2], n1: p.bbox[3] }, { fit: true });
  e.target.value = '';
});

// Rectangle drawing: drag on the map while "Draw area" is pressed.
let drawing = false, dragStart = null, dragRect = null;
const mapEl = map.getContainer();
function setDrawing(on) {
  drawing = on;
  $('draw').setAttribute('aria-pressed', on);
  mapEl.classList.toggle('drawing', on);
  mapEl.style.touchAction = on ? 'none' : '';
  if (on) map.dragging.disable(); else map.dragging.enable();
}
$('draw').addEventListener('click', () => setDrawing(!drawing));
mapEl.addEventListener('pointerdown', (e) => {
  if (!drawing) return;
  dragStart = map.mouseEventToLatLng(e);
  mapEl.setPointerCapture(e.pointerId);
  e.stopPropagation();
}, true);
mapEl.addEventListener('pointermove', (e) => {
  if (!dragStart) return;
  const bounds = L.latLngBounds(dragStart, map.mouseEventToLatLng(e));
  if (dragRect) dragRect.setBounds(bounds);
  else dragRect = L.rectangle(bounds, { color: cssVar('--accent'), weight: 1, dashArray: '4 4', fillOpacity: 0.05 }).addTo(map);
});
mapEl.addEventListener('pointerup', (e) => {
  if (!dragStart) return;
  const [ea, na] = toLV95(dragStart);
  const [eb, nb] = toLV95(map.mouseEventToLatLng(e));
  dragStart = null;
  dragRect?.remove();
  dragRect = null;
  setDrawing(false);
  if (Math.abs(eb - ea) >= 100 && Math.abs(nb - na) >= 100) setBbox({ e0: ea, e1: eb, n0: na, n1: nb });
});

// ---------------------------------------------------------------- period, plan & date lookup

const currentPlan = () => state.bbox && planGrid(state.bbox, +$('px').value);

let infoTimer = 0;
function scheduleInfo() {
  clearTimeout(infoTimer);
  infoTimer = setTimeout(refreshInfo, 250);
}
for (const id of ['from', 'to', 'step', 'px', 'collection']) {
  $(id).addEventListener('change', () => { scheduleInfo(); saveHash(); });
}

function describePlan(plan) {
  const b = plan.bbox;
  const km = (m) => (m / 1000).toFixed(m < 20000 ? 1 : 0);
  let s = `${km(b.e1 - b.e0)} × ${km(b.n1 - b.n0)} km → ${plan.nx} × ${plan.ny} cells of ${plan.cell} m`;
  if (plan.level === 0) s += plan.factor > 1 ? ' (mean of the 10 m pixels)' : ' (full resolution)';
  else s += ` (from the ${plan.srcRes} m overview)`;
  return s;
}

let infoToken = 0;
async function refreshInfo() {
  const token = ++infoToken;
  const plan = currentPlan();
  const areaInfo = $('area-info');
  if (plan) {
    areaInfo.textContent = describePlan(plan);
    if (plan.level > 0) {
      const w = document.createElement('span');
      w.className = 'warn';
      w.textContent = ' Large area: swisstopo’s overviews average values and can blend “missing” into VHI. Draw a smaller area for exact values.';
      areaInfo.appendChild(w);
    }
  }

  const info = $('date-info');
  const from = $('from').value, to = $('to').value;
  state.itemsOk = false;
  $('load').disabled = true;
  if (!from || !to || from > to) { info.textContent = 'Choose a valid period.'; return; }
  info.textContent = 'Looking up available dates…';
  let all;
  try {
    all = await listItems(COLLECTIONS[$('collection').value], from, to);
  } catch (err) {
    if (token === infoToken) info.textContent = `Could not reach the STAC catalogue (${err.message}).`;
    return;
  }
  if (token !== infoToken) return;
  const items = sample(all, $('step').value, from);
  state.items = items;

  const parts = [`${items.length} date${items.length === 1 ? '' : 's'}`];
  if ($('step').value !== 'all') parts[0] += ` (sampled from ${all.length} available)`;
  const warnings = [];
  if (from < FIRST_10M_DATE) warnings.push(`FOREST-10M starts on ${FIRST_10M_DATE}.`);
  if (!items.length) warnings.push('No FOREST-10M data in this period.');
  if (plan && items.length) {
    const kb = items.length * (KB_PER_HEADER + plan.tiles * KB_PER_TILE);
    parts.push(`≈ ${Math.max(1, Math.round(kb / 1024))} MB to download`);
    if (items.length > cube.max3D) warnings.push(`Your GPU allows at most ${cube.max3D} dates; choose coarser sampling.`);
    if (plan.nx * plan.ny * items.length > MAX_VOXELS) warnings.push('Too many cells; reduce the area, the cells per side or the number of dates.');
  }
  info.textContent = `${parts.join(' · ')}. `;
  if (warnings.length) {
    const w = document.createElement('span');
    w.className = 'warn';
    w.textContent = warnings.join(' ');
    info.appendChild(w);
  }
  state.itemsOk = !!plan && items.length > 0 && items.length <= cube.max3D
    && plan.nx * plan.ny * items.length <= MAX_VOXELS;
  $('load').disabled = !state.itemsOk;
}

// ---------------------------------------------------------------- loading

$('load').addEventListener('click', () => load());

async function load(restore = {}) {
  state.abort?.abort();
  const ctrl = new AbortController();
  state.abort = ctrl;
  stopPlay();
  clearTimeout(infoTimer);
  await refreshInfo();
  if (!state.itemsOk || ctrl.signal.aborted) return;

  const vol = createVolume(state.items, currentPlan());
  state.vol = vol;
  state.shares = null;
  state.pin = null;
  cube.setVolume(vol);
  $('cube-empty').hidden = true;
  $('overlay-ctl').hidden = false;
  $('overlay-attr').hidden = false;
  refreshOverlay();
  initSliders(vol);
  if (restore.crop) applyCrop(restore.crop);
  if (restore.pin) pinCell(restore.pin);
  renderChart();

  const bar = $('bar'), status = $('status');
  status.textContent = `Loading 0 / ${vol.nt} dates…`;
  bar.style.width = '0';
  let lastRefresh = 0;
  try {
    await loadVolume(vol, {
      signal: ctrl.signal,
      onLayer(done, total) {
        bar.style.width = `${(done / total) * 100}%`;
        status.textContent = `Loading ${done} / ${total} dates…`;
        if (performance.now() - lastRefresh > 400) {
          lastRefresh = performance.now();
          cube.refresh();
          if (state.pin) renderChart();
        }
      },
    });
  } catch (err) {
    if (err.name !== 'AbortError') status.textContent = `Loading failed: ${err.message}`;
    return;
  }
  cube.refresh();
  state.shares = classShares(vol, CLASS_OF, CLASSES.length);
  const forestMax = Math.max(...state.shares.forest);
  status.textContent = `${vol.nt} dates, ${vol.dates[0]} → ${vol.dates[vol.nt - 1]} · ${vol.nx} × ${vol.ny} cells of ${vol.plan.cell} m`;
  const notes = [];
  if (!forestMax) notes.push('No forest cells in this area.');
  if (vol.failed.length) notes.push(`${vol.failed.length} date(s) could not be read and are empty: ${vol.failed.join(', ')}`);
  if (notes.length) {
    const w = document.createElement('div');
    w.className = 'warn';
    w.textContent = notes.join(' ');
    status.appendChild(w);
  }
  renderChart();
}

// ---------------------------------------------------------------- slicing

function dualSlider(root, onChange) {
  const [lo, hi] = root.querySelectorAll('input');
  const fill = root.querySelector('.dual-fill');
  const out = root.querySelector('output');
  const paint = () => {
    const max = +lo.max || 1;
    fill.style.left = `${(lo.value / max) * 100}%`;
    fill.style.right = `${100 - (hi.value / max) * 100}%`;
    // Keep the lower thumb grabbable when both sit at the far end.
    lo.style.zIndex = +lo.value >= max - 1 ? 2 : '';
  };
  const handle = (moved) => () => {
    if (+hi.value - +lo.value < 1) {
      if (moved === lo) lo.value = +hi.value - 1; else hi.value = +lo.value + 1;
    }
    paint();
    onChange();
  };
  lo.addEventListener('input', handle(lo));
  hi.addEventListener('input', handle(hi));
  return {
    out,
    set(max, a, b) {
      lo.max = hi.max = max;
      lo.value = a;
      hi.value = b;
      paint();
    },
    get: () => [+lo.value, +hi.value],
  };
}

const onSlide = () => {
  const vol = state.vol;
  if (!vol) return;
  const [c0, c1] = sliders.e.get();
  const [s0, s1] = sliders.n.get();
  const [t0, t1] = sliders.t.get();
  setCrop({ c0, c1, r0: vol.ny - s1, r1: vol.ny - s0, t0, t1 });
};
const sliders = {
  e: dualSlider($('slice-e'), onSlide),
  n: dualSlider($('slice-n'), onSlide),
  t: dualSlider($('slice-t'), onSlide),
};

function initSliders(vol) {
  sliders.e.set(vol.nx, 0, vol.nx);
  sliders.n.set(vol.ny, 0, vol.ny);
  sliders.t.set(vol.nt, 0, vol.nt);
  setCrop(cube.crop);
}

// Single entry point for crop changes from sliders, buttons, charts and the URL.
function setCrop(crop) {
  const vol = state.vol;
  cube.setCrop(crop);
  const { bbox, cell } = vol.plan;
  sliders.e.out.textContent = `${fmt(bbox.e0 + crop.c0 * cell)} – ${fmt(bbox.e0 + crop.c1 * cell)}`;
  sliders.n.out.textContent = `${fmt(bbox.n1 - crop.r1 * cell)} – ${fmt(bbox.n1 - crop.r0 * cell)}`;
  sliders.t.out.textContent = `${vol.dates[crop.t0]} → ${vol.dates[crop.t1 - 1]}`;
  chartApi?.setCursor(crop.t1 - 1);
  saveHash();
}

function applyCrop(c) {
  const vol = state.vol;
  const clamp = (v, lo, hi) => Math.min(Math.max(Math.round(v), lo), hi);
  const crop = {
    c0: clamp(c.c0, 0, vol.nx - 1), r0: clamp(c.r0, 0, vol.ny - 1), t0: clamp(c.t0, 0, vol.nt - 1),
  };
  crop.c1 = clamp(c.c1, crop.c0 + 1, vol.nx);
  crop.r1 = clamp(c.r1, crop.r0 + 1, vol.ny);
  crop.t1 = clamp(c.t1, crop.t0 + 1, vol.nt);
  sliders.e.set(vol.nx, crop.c0, crop.c1);
  sliders.n.set(vol.ny, vol.ny - crop.r1, vol.ny - crop.r0);
  sliders.t.set(vol.nt, crop.t0, crop.t1);
  setCrop(crop);
}

// Move the top face to layer t (from a chart click or the play button).
function showLayer(t) {
  const crop = { ...cube.crop, t1: t + 1 };
  if (crop.t0 > t) crop.t0 = t;
  applyCrop(crop);
}

$('reset-crop').addEventListener('click', () => {
  const v = state.vol;
  if (v) applyCrop({ c0: 0, c1: v.nx, r0: 0, r1: v.ny, t0: 0, t1: v.nt });
});
// Keep the north-west quarter so both cut faces look towards the default camera (south-east).
$('quarter').addEventListener('click', () => {
  const v = state.vol;
  if (v) applyCrop({ ...cube.crop, c0: 0, c1: Math.ceil(v.nx / 2), r0: 0, r1: Math.ceil(v.ny / 2) });
});
$('reset-view').addEventListener('click', () => cube.resetView());
$('height').addEventListener('input', (e) => { cube.setTimeHeight(+e.target.value); saveHash(); });

let playTimer = 0;
function stopPlay() {
  clearInterval(playTimer);
  playTimer = 0;
  $('play').textContent = '▶ Play';
  $('play').setAttribute('aria-pressed', 'false');
}
$('play').addEventListener('click', () => {
  if (playTimer) { stopPlay(); return; }
  if (!state.vol) return;
  $('play').textContent = '❚❚ Pause';
  $('play').setAttribute('aria-pressed', 'true');
  playTimer = setInterval(() => {
    const { t0, t1 } = cube.crop;
    showLayer(t1 >= state.vol.nt ? t0 : t1);
  }, 350);
});

// ---------------------------------------------------------------- class filter

const chips = CLASSES.map((c, k) => {
  const b = document.createElement('button');
  b.className = 'cls';
  b.setAttribute('aria-pressed', 'true');
  const sw = document.createElement('i');
  sw.style.background = c.color;
  const name = document.createElement('span');
  name.textContent = c.label;
  const range = document.createElement('small');
  range.textContent = c.range;
  b.append(sw, name, range);
  b.addEventListener('click', () => setMask(state.mask ^ (1 << k)));
  $('classes').appendChild(b);
  return b;
});

function setMask(mask) {
  state.mask = mask;
  chips.forEach((b, k) => b.setAttribute('aria-pressed', String(Boolean((mask >> k) & 1))));
  cube.setMask(mask);
  saveHash();
}
$('mask-all').addEventListener('click', () => setMask(ALL_MASK));
$('mask-stress').addEventListener('click', () => setMask(STRESS_MASK));

// ---------------------------------------------------------------- map overlay on the top face

const overlayCtl = $('overlay-ctl');
// Keep clicks on the toggles from orbiting the camera or pinning the cell underneath.
for (const type of ['pointerdown', 'pointerup', 'pointermove']) overlayCtl.addEventListener(type, (e) => e.stopPropagation());
const overlayButtons = OVERLAYS.map((o) => {
  const b = document.createElement('button');
  b.textContent = o.label;
  b.title = o.title;
  b.addEventListener('click', () => {
    const on = state.overlays.includes(o.id);
    setOverlays(on ? state.overlays.filter((id) => id !== o.id) : [...state.overlays, o.id]);
  });
  overlayCtl.appendChild(b);
  return b;
});

function setOverlays(ids) {
  state.overlays = OVERLAYS.map((o) => o.id).filter((id) => ids.includes(id));
  overlayButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(state.overlays.includes(OVERLAYS[i].id))));
  $('overlay-attr').textContent = state.overlays.length ? ATTRIBUTION : '';
  refreshOverlay();
  saveHash();
}

let overlayToken = 0;
async function refreshOverlay() {
  const token = ++overlayToken;
  const vol = state.vol;
  if (!vol) return;
  const skip = (err) => { console.warn(err.message); return null; };
  const on = (id) => state.overlays.includes(id);
  const [names, roads] = await Promise.all([
    on('names') ? fetchNames(vol.plan.bbox).catch(skip) : null,
    on('roads') ? fetchRoads(vol.plan.bbox).catch(skip) : null,
  ]);
  if (token !== overlayToken || vol !== state.vol) return;
  cube.setNames(names);
  cube.setRoads(roads);
}

// ---------------------------------------------------------------- hover & pick in the cube

const cubeEl = $('cube');
const cubeTip = $('cube-tip');

const cellCenter = (vol, { col, row }) => {
  const { bbox, cell } = vol.plan;
  return [bbox.e0 + (col + 0.5) * cell, bbox.n1 - (row + 0.5) * cell];
};

function describeValue(v) {
  if (v <= 100) { const c = CLASSES[CLASS_OF[v]]; return { value: `VHI ${v}`, label: c.label, color: c.color }; }
  if (v === NODATA) return { value: 'No forest', label: '' };
  return { value: 'Missing', label: 'no valid observation', color: CLASSES[7].color };
}

function fillTip(tip, title, row, foot) {
  tip.replaceChildren();
  const head = document.createElement('div');
  head.className = 'tip-title';
  head.textContent = title;
  const line = document.createElement('div');
  line.className = 'tip-row';
  if (row.color) {
    const key = document.createElement('span');
    key.className = 'tip-key';
    key.style.background = row.color;
    line.appendChild(key);
  }
  const v = document.createElement('strong');
  v.textContent = row.value;
  const l = document.createElement('span');
  l.textContent = row.label;
  line.append(v, l);
  const f = document.createElement('div');
  f.className = 'tip-title';
  f.textContent = foot;
  tip.append(head, line, f);
}

let pointer = null, hoverFrame = 0, downAt = null;
cubeEl.addEventListener('pointermove', (e) => {
  pointer = e;
  if (!hoverFrame) hoverFrame = requestAnimationFrame(updateHover);
});
cubeEl.addEventListener('pointerleave', () => { pointer = null; cubeTip.hidden = true; cube.setHover(null); });
cubeEl.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
cubeEl.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  const hit = cube.pick(e.clientX, e.clientY);
  if (hit) pinCell(hit);
});

function updateHover() {
  hoverFrame = 0;
  if (!state.vol || !pointer) return;
  if (pointer.buttons) { cubeTip.hidden = true; return; }
  const hit = cube.pick(pointer.clientX, pointer.clientY);
  const prev = cube.hover;
  if (!hit) {
    cubeTip.hidden = true;
    if (prev) cube.setHover(null);
    return;
  }
  if (!prev || prev.col !== hit.col || prev.row !== hit.row || prev.t !== hit.t) cube.setHover(hit);
  const [e, n] = cellCenter(state.vol, hit);
  fillTip(cubeTip, state.vol.dates[hit.t], describeValue(hit.value), `E ${fmt(e)} · N ${fmt(n)} · click for history`);
  cubeTip.hidden = false;
  const r = cubeEl.getBoundingClientRect();
  const x = pointer.clientX - r.left, y = pointer.clientY - r.top;
  const w = cubeTip.offsetWidth, h = cubeTip.offsetHeight;
  cubeTip.style.left = `${x + 16 + w > r.width ? x - 16 - w : x + 16}px`;
  cubeTip.style.top = `${Math.min(Math.max(4, y - h - 8), r.height - h - 4)}px`;
}

function pinCell({ col, row }) {
  const vol = state.vol;
  if (!vol || col >= vol.nx || row >= vol.ny) return;
  state.pin = { col, row };
  state.tab = 'pixel';
  cube.setPin(state.pin);
  renderChart();
  saveHash();
}

// ---------------------------------------------------------------- charts

let chartApi = null;

function pixelSeries(vol, { col, row }) {
  const out = new Uint8Array(vol.nt);
  for (let t = 0; t < vol.nt; t++) out[t] = vol.data[(t * vol.ny + row) * vol.nx + col];
  return out;
}

function placeholder(host, msg) {
  const p = document.createElement('div');
  p.className = 'placeholder';
  p.textContent = msg;
  host.replaceChildren(p);
  chartApi = null;
}

function renderChart() {
  const host = $('chart');
  const meta = $('chart-meta');
  const vol = state.vol;
  for (const b of document.querySelectorAll('[role="tab"]')) b.setAttribute('aria-selected', String(b.dataset.tab === state.tab));
  meta.replaceChildren();
  $('csv').disabled = true;
  if (!vol) { placeholder(host, 'Load a cube, then click a cell to see its VHI history.'); return; }
  const cursor = cube.crop ? cube.crop.t1 - 1 : vol.nt - 1;

  if (state.tab === 'pixel') {
    if (!state.pin) { placeholder(host, 'Click a cell in the cube to see its VHI history.'); return; }
    const [e, n] = cellCenter(vol, state.pin);
    chartApi = renderPixelChart(host, { dates: vol.dates, values: pixelSeries(vol, state.pin), cursor, onPick: showLayer });
    const a = document.createElement('a');
    a.href = `https://map.geo.admin.ch/#/map?lang=en&center=${Math.round(e)},${Math.round(n)}&z=11`
      + '&bgLayer=ch.swisstopo.pixelkarte-grau&layers=ch.swisstopo.swisseo_vhi_v100&crosshair=marker';
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'map.geo.admin.ch ↗';
    meta.append(`Cell E ${fmt(e)} · N ${fmt(n)} (${vol.plan.cell} m) · click a date to show it on top · `, a);
  } else {
    if (!state.shares) { placeholder(host, 'The area summary appears when loading has finished.'); return; }
    chartApi = renderAreaChart(host, { dates: vol.dates, shares: state.shares.shares, forest: state.shares.forest, cursor, onPick: showLayer });
    meta.textContent = 'Share of forest cells in each class, per date · click a date to show it on top';
  }
  $('csv').disabled = !chartApi;
}

for (const b of document.querySelectorAll('[role="tab"]')) {
  b.addEventListener('click', () => { state.tab = b.dataset.tab; renderChart(); });
}
let chartFrame = 0;
new ResizeObserver(() => {
  cancelAnimationFrame(chartFrame);
  chartFrame = requestAnimationFrame(renderChart);
}).observe($('chart'));

// The table view: every value behind the active chart as CSV.
$('csv').addEventListener('click', () => {
  const vol = state.vol;
  let rows, name;
  if (state.tab === 'pixel' && state.pin) {
    const [e, n] = cellCenter(vol, state.pin).map(Math.round);
    const values = pixelSeries(vol, state.pin);
    rows = [['date', 'E', 'N', 'cell_m', 'value', 'class']];
    vol.dates.forEach((d, t) => {
      const v = values[t];
      rows.push([d, e, n, vol.plan.cell, v === NODATA ? '' : v, v === NODATA ? 'no data' : CLASSES[CLASS_OF[v]].label]);
    });
    name = `vhi_cell_${e}_${n}.csv`;
  } else if (state.shares) {
    const k = CLASSES.length;
    rows = [['date', 'forest_cells', ...CLASSES.map((c) => `${c.label} %`)]];
    vol.dates.forEach((d, t) => rows.push([d, state.shares.forest[t],
      ...CLASSES.map((_, i) => (state.shares.shares[t * k + i] * 100).toFixed(2))]));
    name = 'vhi_area_summary.csv';
  } else return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([rows.map((r) => r.join(',')).join('\n')], { type: 'text/csv' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// ---------------------------------------------------------------- URL state & theme

let hashTimer = 0;
function saveHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const p = [
      ['c', $('collection').value], ['from', $('from').value], ['to', $('to').value],
      ['step', $('step').value], ['px', $('px').value],
    ];
    const b = state.bbox;
    if (b) p.push(['bbox', [b.e0, b.n0, b.e1, b.n1].join(',')]);
    // Crop and pin are grid indices: only meaningful while the loaded cube matches the inputs.
    const plan = currentPlan();
    const current = state.vol && plan && JSON.stringify(plan.bbox) === JSON.stringify(state.vol.plan.bbox)
      && plan.cell === state.vol.plan.cell;
    const c = current && cube.crop;
    if (c) p.push(['crop', [c.c0, c.c1, c.r0, c.r1, c.t0, c.t1].join(',')]);
    if (state.mask !== ALL_MASK) p.push(['mask', state.mask]);
    if (+$('height').value !== DEFAULT_HEIGHT) p.push(['h', $('height').value]);
    if (current && state.pin) p.push(['pin', `${state.pin.col},${state.pin.row}`]);
    if (state.overlays.join() !== DEFAULT_OVERLAYS.join()) p.push(['ov', state.overlays.join(',') || 'none']);
    history.replaceState(null, '', `#${p.map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%2C/g, ',')}`).join('&')}`);
  }, 250);
}

function restoreFromHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const nums = (k, n) => {
    const v = p.get(k)?.split(',').map(Number);
    return v?.length === n && v.every(Number.isFinite) ? v : null;
  };
  for (const [k, id] of [['c', 'collection'], ['from', 'from'], ['to', 'to'], ['step', 'step'], ['px', 'px']]) {
    if (p.get(k)) $(id).value = p.get(k);
  }
  if (p.get('h')) { $('height').value = p.get('h'); cube.setTimeHeight(+p.get('h')); }
  if (p.get('mask')) setMask(+p.get('mask') & ALL_MASK);
  setOverlays(p.has('ov') ? p.get('ov').split(',') : DEFAULT_OVERLAYS);
  const bbox = nums('bbox', 4);
  if (!bbox) { scheduleInfo(); return; }
  setBbox({ e0: bbox[0], n0: bbox[1], e1: bbox[2], n1: bbox[3] }, { fit: true });
  const crop = nums('crop', 6);
  const pin = nums('pin', 2);
  load({
    crop: crop && { c0: crop[0], c1: crop[1], r0: crop[2], r1: crop[3], t0: crop[4], t1: crop[5] },
    pin: pin && { col: pin[0], row: pin[1] },
  });
}

function applyTheme() {
  cube.setTheme({ ink: cssVar('--ink'), muted: cssVar('--muted'), accent: cssVar('--accent') });
  areaShape?.setStyle({ color: cssVar('--accent') });
  renderChart();
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

applyTheme();
restoreFromHash();
