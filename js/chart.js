// SVG charts under the cube: one pixel's VHI history, and class shares across the whole area.

import { CLASSES, CLASS_OF, MISSING, NODATA } from './classes.js';

const NS = 'http://www.w3.org/2000/svg';
const DAY = 86400000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const GAP = 2;

function el(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  parent?.appendChild(e);
  return e;
}

function text(parent, x, y, str, cls, anchor = 'start') {
  const t = el('text', { x, y, class: cls, 'text-anchor': anchor, 'dominant-baseline': 'middle' }, parent);
  t.textContent = str;
  return t;
}

const toTime = (date) => Date.parse(`${date}T12:00:00Z`);

// Same hue, darker: keeps the pale classes (Normal, Slightly stressed) visible on their own band.
function darken(hex, f = 0.62) {
  const ch = (i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * f).toString(16).padStart(2, '0');
  return `#${ch(1)}${ch(3)}${ch(5)}`;
}

function timeScale(dates, x0, x1) {
  const ts = dates.map(toTime);
  const pad = Math.max(3 * DAY, (ts[ts.length - 1] - ts[0]) * 0.02);
  const lo = ts[0] - pad, hi = ts[ts.length - 1] + pad;
  return { ts, lo, hi, x: (t) => x0 + ((t - lo) / (hi - lo)) * (x1 - x0) };
}

// Month-boundary ticks, thinned to fit: every 1/2/3/6 months, or every 1/2/5 years.
function timeAxis(svg, scale, y, width) {
  const maxTicks = Math.max(2, Math.floor(width / 72));
  const first = new Date(scale.lo), last = new Date(scale.hi);
  const months = (last.getUTCFullYear() - first.getUTCFullYear()) * 12 + last.getUTCMonth() - first.getUTCMonth() + 1;
  const step = [1, 2, 3, 6, 12, 24, 60].find((s) => months / s <= maxTicks) ?? 60;
  let shownYear = null;
  for (let i = first.getUTCFullYear() * 12 + first.getUTCMonth() + 1; ; i++) {
    const year = Math.floor(i / 12), month = i % 12;
    const t = Date.UTC(year, month, 1);
    if (t > scale.hi) break;
    if (i % step) continue;
    let str;
    if (step >= 12) str = String(year);
    else if (shownYear !== year) { str = `${MONTHS[month]} ${year}`; shownYear = year; }
    else str = MONTHS[month];
    text(svg, scale.x(t), y, str, 'axis-label', 'middle');
  }
}

function nearestIndex(ts, t) {
  let lo = 0, hi = ts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] < t) lo = mid; else hi = mid;
  }
  return Math.abs(ts[lo] - t) <= Math.abs(ts[hi] - t) ? lo : hi;
}

// Tooltip rows: { value, label, color }; the value leads, the label follows.
function showTip(tip, host, px, py, title, rows) {
  tip.replaceChildren();
  const head = document.createElement('div');
  head.className = 'tip-title';
  head.textContent = title;
  tip.appendChild(head);
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'tip-row';
    if (r.color) {
      const key = document.createElement('span');
      key.className = 'tip-key';
      key.style.background = r.color;
      row.appendChild(key);
    }
    const v = document.createElement('strong');
    v.textContent = r.value;
    const l = document.createElement('span');
    l.textContent = r.label;
    row.append(v, l);
    tip.appendChild(row);
  }
  tip.hidden = false;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  const left = px + 14 + w > host.clientWidth - 4 ? px - 14 - w : px + 14;
  tip.style.left = `${Math.max(4, left)}px`;
  tip.style.top = `${Math.max(4, Math.min(py - h / 2, host.clientHeight - h - 4))}px`;
}

function setupHover(svg, host, box, ts, scale, onHover, onPick) {
  const tip = document.createElement('div');
  tip.className = 'tip';
  tip.hidden = true;
  host.appendChild(tip);
  const hit = el('rect', { ...box, class: 'hit' }, svg);
  const index = (e) => {
    const r = svg.getBoundingClientRect();
    const px = e.clientX - r.left;
    const t = scale.lo + ((px - box.x) / box.width) * (scale.hi - scale.lo);
    return { i: nearestIndex(ts, t), py: e.clientY - r.top };
  };
  hit.addEventListener('pointermove', (e) => { const { i, py } = index(e); onHover(i, tip, py); });
  hit.addEventListener('pointerleave', () => { tip.hidden = true; onHover(-1, tip); });
  hit.addEventListener('click', (e) => onPick?.(index(e).i));
}

export function renderPixelChart(host, { dates, values, cursor, onPick }) {
  host.replaceChildren();
  const W = host.clientWidth, H = host.clientHeight;
  if (W < 50 || H < 50) return;
  const m = { l: 34, r: 128, t: 8, b: 42 };
  const x0 = m.l, x1 = W - m.r, y0 = m.t, y1 = H - m.b;
  const laneY = y1 + 12;
  const svg = el('svg', { width: W, height: H, class: 'chart' }, host);
  const ys = (v) => y1 - (v / 100) * (y1 - y0);
  const scale = timeScale(dates, x0, x1);

  // Class bands double as the y-scale legend.
  CLASSES.slice(0, 7).forEach((c, k) => {
    const top = ys(k === 6 ? 100 : c.max + 1), bottom = ys(c.min);
    el('rect', { x: x0, y: top, width: x1 - x0, height: bottom - top, fill: c.color, class: 'band' }, svg);
    if (bottom - top >= 11) {
      el('rect', { x: x1 + 8, y: (top + bottom) / 2 - 4, width: 8, height: 8, rx: 2, fill: c.color, class: 'swatch' }, svg);
      text(svg, x1 + 22, (top + bottom) / 2, c.label, 'band-label');
    }
  });
  for (let v = 0; v <= 100; v += 20) {
    el('line', { x1: x0, x2: x1, y1: ys(v), y2: ys(v), class: 'grid' }, svg);
    text(svg, x0 - 6, ys(v), String(v), 'axis-label', 'end');
  }
  el('rect', { x: x1 + 8, y: laneY - 4, width: 8, height: 8, rx: 2, fill: CLASSES[7].color, class: 'swatch' }, svg);
  text(svg, x1 + 22, laneY, 'Missing data', 'band-label');
  timeAxis(svg, scale, H - 12, x1 - x0);

  const cursorLine = el('line', { y1: y0, y2: laneY + 6, class: 'cursor' }, svg);
  const setCursor = (i) => {
    const x = scale.x(scale.ts[i]);
    cursorLine.setAttribute('x1', x);
    cursorLine.setAttribute('x2', x);
  };
  setCursor(cursor);

  let d = '', pen = false;
  values.forEach((v, i) => {
    if (v > 100) { pen = false; return; }
    d += `${pen ? 'L' : 'M'}${scale.x(scale.ts[i]).toFixed(1)},${ys(v).toFixed(1)}`;
    pen = true;
  });
  el('path', { d, class: 'series' }, svg);
  values.forEach((v, i) => {
    const x = scale.x(scale.ts[i]);
    if (v === MISSING) el('rect', { x: x - 1, y: laneY - 5, width: 2, height: 10, rx: 1, fill: CLASSES[7].color }, svg);
    else if (v <= 100) {
      const c = CLASSES[CLASS_OF[v]].color;
      el('circle', { cx: x, cy: ys(v), r: 6, class: 'dot-ring' }, svg);
      el('circle', { cx: x, cy: ys(v), r: 4, fill: c, stroke: darken(c), 'stroke-width': 1 }, svg);
    }
  });

  const cross = el('line', { y1: y0, y2: laneY + 6, class: 'crosshair', visibility: 'hidden' }, svg);
  setupHover(svg, host, { x: x0, y: y0, width: x1 - x0, height: laneY + 6 - y0 }, scale.ts, scale, (i, tip, py) => {
    if (i < 0) { cross.setAttribute('visibility', 'hidden'); return; }
    const x = scale.x(scale.ts[i]);
    cross.setAttribute('x1', x);
    cross.setAttribute('x2', x);
    cross.setAttribute('visibility', 'visible');
    const v = values[i];
    const row = v <= 100
      ? { value: `VHI ${v}`, label: CLASSES[CLASS_OF[v]].label, color: CLASSES[CLASS_OF[v]].color }
      : v === NODATA ? { value: 'No data', label: 'not loaded' } : { value: 'Missing', label: 'value 110', color: CLASSES[7].color };
    showTip(tip, host, x, py, dates[i], [row]);
  }, onPick);

  return { setCursor };
}

// Stacked columns of class shares, Extremely stressed at the baseline so stress reads from the floor.
export function renderAreaChart(host, { dates, shares, forest, cursor, onPick }) {
  host.replaceChildren();
  const legend = document.createElement('div');
  legend.className = 'chart-legend';
  for (const c of CLASSES) {
    const item = document.createElement('span');
    const sw = document.createElement('i');
    sw.style.background = c.color;
    item.append(sw, c.label);
    legend.appendChild(item);
  }
  host.appendChild(legend);

  const W = host.clientWidth, H = host.clientHeight - legend.offsetHeight;
  if (W < 50 || H < 50) return;
  const n = CLASSES.length;
  const m = { l: 40, r: 12, t: 8, b: 24 };
  const x0 = m.l, x1 = W - m.r, y0 = m.t, y1 = H - m.b;
  const svg = el('svg', { width: W, height: H, class: 'chart' }, host);
  const scale = timeScale(dates, x0, x1);
  const xs = scale.ts.map(scale.x);
  let spacing = x1 - x0;
  for (let i = 1; i < xs.length; i++) spacing = Math.min(spacing, xs[i] - xs[i - 1]);
  const w = Math.max(1, Math.min(24, spacing - GAP));

  for (let p = 0; p <= 100; p += 25) {
    const y = y1 - (p / 100) * (y1 - y0);
    el('line', { x1: x0, x2: x1, y1: y, y2: y, class: 'grid' }, svg);
    text(svg, x0 - 6, y, `${p}%`, 'axis-label', 'end');
  }
  timeAxis(svg, scale, H - 10, x1 - x0);
  const wash = el('rect', { y: y0, width: w + 6, height: y1 - y0, class: 'wash', visibility: 'hidden' }, svg);

  for (let t = 0; t < dates.length; t++) {
    if (!forest[t]) continue;
    const x = xs[t] - w / 2;
    let y = y1;
    let top = -1;
    for (let k = 0; k < n; k++) if (shares[t * n + k] > 0) top = k;
    let first = true;
    for (let k = 0; k <= top; k++) {
      const h = shares[t * n + k] * (y1 - y0);
      if (h <= 0) continue;
      const bottom = first ? y : y - GAP;
      const yTop = y - h;
      y = yTop;
      first = false;
      if (bottom - yTop <= 0) continue;
      if (k === top && w >= 8) {
        const r = Math.min(4, bottom - yTop);
        el('path', {
          d: `M${x},${bottom}V${yTop + r}Q${x},${yTop} ${x + r},${yTop}H${x + w - r}Q${x + w},${yTop} ${x + w},${yTop + r}V${bottom}Z`,
          fill: CLASSES[k].color,
        }, svg);
      } else {
        el('rect', { x, y: yTop, width: w, height: bottom - yTop, fill: CLASSES[k].color }, svg);
      }
    }
  }

  const cursorLine = el('line', { y1: y0 - 4, y2: y1, class: 'cursor' }, svg);
  const setCursor = (i) => {
    cursorLine.setAttribute('x1', xs[i]);
    cursorLine.setAttribute('x2', xs[i]);
  };
  setCursor(cursor);

  setupHover(svg, host, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, scale.ts, scale, (i, tip, py) => {
    if (i < 0) { wash.setAttribute('visibility', 'hidden'); return; }
    wash.setAttribute('x', xs[i] - w / 2 - 3);
    wash.setAttribute('visibility', 'visible');
    const rows = [];
    for (let k = n - 1; k >= 0; k--) {
      const s = shares[i * n + k];
      if (s > 0) rows.push({ value: `${(s * 100).toFixed(s < 0.1 ? 1 : 0)}%`, label: CLASSES[k].label, color: CLASSES[k].color });
    }
    if (!rows.length) rows.push({ value: '—', label: 'no forest pixels loaded' });
    showTip(tip, host, xs[i], py, `${dates[i]} · ${forest[i].toLocaleString('de-CH')} forest cells`, rows);
  }, onPick);

  return { setCursor };
}
