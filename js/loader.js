// Reads windows of the FOREST-10M COGs straight from data.geo.admin.ch (HTTP range requests)
// and stacks them into a time × north × east byte volume.

import { fromUrl } from 'geotiff';
import { NODATA, MISSING } from './classes.js';

// Layout of the swissEO VHI 10 m mosaics (identical for v100 and v200).
export const GRID = { e0: 2470800, n0: 1312350, res: 10, tile: 512, overviews: 7 };

// Above this many 512×512 tiles per date we read a coarser overview instead of full resolution.
const MAX_TILES_PER_DATE = 16;

function tilesAt(bbox, level) {
  const px = GRID.res * 2 ** level * GRID.tile;
  const cols = Math.floor((bbox.e1 - GRID.e0 - 1e-6) / px) - Math.floor((bbox.e0 - GRID.e0) / px) + 1;
  const rows = Math.floor((GRID.n0 - bbox.n0 - 1e-6) / px) - Math.floor((GRID.n0 - bbox.n1) / px) + 1;
  return cols * rows;
}

// Decide source level, aggregation factor and output grid for a LV95 bbox {e0, n0, e1, n1}.
// targetPx caps the longer side of the cube (0 = native resolution).
export function planGrid(bbox, targetPx) {
  let level = 0;
  while (level < GRID.overviews && tilesAt(bbox, level) > MAX_TILES_PER_DATE) level++;
  const srcRes = GRID.res * 2 ** level;
  const longSide = Math.max(bbox.e1 - bbox.e0, bbox.n1 - bbox.n0) / srcRes;
  const factor = targetPx ? Math.max(1, Math.ceil(longSide / targetPx)) : 1;
  const cell = srcRes * factor;

  // Snap outwards to whole output cells aligned with the mosaic origin.
  const snapped = {
    e0: GRID.e0 + Math.floor((bbox.e0 - GRID.e0) / cell) * cell,
    e1: GRID.e0 + Math.ceil((bbox.e1 - GRID.e0) / cell) * cell,
    n1: GRID.n0 - Math.floor((GRID.n0 - bbox.n1) / cell) * cell,
    n0: GRID.n0 - Math.ceil((GRID.n0 - bbox.n0) / cell) * cell,
  };
  const nx = Math.round((snapped.e1 - snapped.e0) / cell);
  const ny = Math.round((snapped.n1 - snapped.n0) / cell);
  return {
    bbox: snapped, level, factor, cell, srcRes, nx, ny,
    srcW: nx * factor, srcH: ny * factor,
    tiles: tilesAt(snapped, level),
  };
}

// Mean VHI of the valid pixels in each factor×factor block. A block is forest when at least a
// quarter of its pixels are forest; forest blocks without any valid pixel become "missing".
function aggregate(src, plan) {
  const { nx, ny, factor: f, srcW } = plan;
  if (f === 1) {
    for (let i = 0; i < src.length; i++) if (src[i] > 100 && src[i] !== NODATA) src[i] = MISSING;
    return src;
  }
  const out = new Uint8Array(nx * ny);
  const minForest = (f * f) / 4;
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      let sum = 0, valid = 0, forest = 0;
      for (let dy = 0; dy < f; dy++) {
        let i = (y * f + dy) * srcW + x * f;
        for (let dx = 0; dx < f; dx++, i++) {
          const v = src[i];
          if (v === NODATA) continue;
          forest++;
          if (v <= 100) { sum += v; valid++; }
        }
      }
      out[y * nx + x] = forest < minForest ? NODATA : valid ? Math.round(sum / valid) : MISSING;
    }
  }
  return out;
}

async function readLayer(href, plan, signal) {
  const tiff = await fromUrl(href, {}, signal);
  const full = await tiff.getImage(0);
  const count = await tiff.getImageCount();
  const img = plan.level ? await tiff.getImage(Math.min(plan.level, count - 1)) : full;

  // Overviews carry no georeferencing; derive their pixel size from the full-resolution image.
  const [oE, oN] = full.getOrigin();
  const [r0x, r0y] = full.getResolution();
  const rx = r0x * (full.getWidth() / img.getWidth());
  const ry = Math.abs(r0y) * (full.getHeight() / img.getHeight());
  const { e0, n0, e1, n1 } = plan.bbox;
  const window = [
    Math.round((e0 - oE) / rx), Math.round((oN - n1) / ry),
    Math.round((e1 - oE) / rx), Math.round((oN - n0) / ry),
  ];
  const raster = await img.readRasters({
    window, width: plan.srcW, height: plan.srcH, resampleMethod: 'nearest',
    samples: [0], interleave: true, fillValue: NODATA, signal,
  });
  return aggregate(raster, plan);
}

// Decoded layers, keyed by file + grid, so changing the period or sampling only fetches new dates.
const layerCache = new Map();
let cachedBytes = 0;
const MAX_CACHE_BYTES = 256 * 1024 * 1024;

async function readCached(href, plan, signal) {
  const key = `${href}|${plan.level}|${plan.factor}|${plan.bbox.e0},${plan.bbox.n0},${plan.bbox.e1},${plan.bbox.n1}`;
  const hit = layerCache.get(key);
  if (hit) return hit;
  const layer = await readLayer(href, plan, signal);
  layerCache.set(key, layer);
  cachedBytes += layer.length;
  for (const [k, v] of layerCache) {
    if (cachedBytes <= MAX_CACHE_BYTES) break;
    layerCache.delete(k);
    cachedBytes -= v.length;
  }
  return layer;
}

// An empty volume (all no-data) for the given dates; fill it with loadVolume.
export function createVolume(items, plan) {
  const { nx, ny } = plan;
  return {
    nx, ny, nt: items.length, plan,
    dates: items.map((it) => it.date),
    hrefs: items.map((it) => it.href),
    data: new Uint8Array(nx * ny * items.length).fill(NODATA),
    failed: [],
  };
}

// Fetch every date into vol.data with a small pool of concurrent requests.
// onLayer(done, total) fires after each date so the cube can grow while loading.
export async function loadVolume(vol, { onLayer, signal, concurrency = 6 }) {
  const size = vol.nx * vol.ny;
  let next = 0, done = 0;
  const worker = async () => {
    while (next < vol.nt && !signal?.aborted) {
      const t = next++;
      try {
        vol.data.set(await readCached(vol.hrefs[t], vol.plan, signal), t * size);
      } catch (err) {
        if (signal?.aborted) return;
        console.warn(`VHI ${vol.dates[t]}: ${err.message}`);
        vol.failed.push(vol.dates[t]);
      }
      onLayer?.(++done, vol.nt);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, vol.nt) }, worker));
  if (signal?.aborted) throw new DOMException('Loading cancelled', 'AbortError');
  vol.failed.sort();
  return vol;
}

// Share of each class (0–7) among forest pixels, per date: Float32Array(nt * 8) plus pixel counts.
export function classShares(vol, classOf, nClasses) {
  const size = vol.nx * vol.ny;
  const shares = new Float32Array(vol.nt * nClasses);
  const forest = new Uint32Array(vol.nt);
  const counts = new Uint32Array(nClasses);
  for (let t = 0; t < vol.nt; t++) {
    counts.fill(0);
    let n = 0;
    for (let i = t * size, end = i + size; i < end; i++) {
      const k = classOf[vol.data[i]];
      if (k >= 0) { counts[k]++; n++; }
    }
    forest[t] = n;
    for (let k = 0; k < nClasses; k++) shares[t * nClasses + k] = n ? counts[k] / n : 0;
  }
  return { shares, forest };
}
