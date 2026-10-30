// Reference layers for the cube's top face, both from swisstopo in LV95 (EPSG:2056) so they line
// up with the VHI grid without reprojection:
// - names: swissNAMES3D features from the geo.admin identify API, drawn as screen-facing labels;
// - roads: swissTLM3D roads and tracks from the geo.admin WMS, draped as an image.

export const OVERLAYS = [
  { id: 'names', label: 'Names', title: 'Place, area and forest names: swisstopo swissNAMES3D' },
  { id: 'roads', label: 'Roads & tracks', title: 'Roads, forest roads and paths: swisstopo swissTLM3D' },
];
export const ATTRIBUTION = '© swisstopo (swissNAMES3D, swissTLM3D)';

// Lower rank = placed first when labels compete for space.
const KINDS = [
  { kind: 'place', rank: 1, types: ['Ort', 'Quartierteil', 'Siedlung'] },
  { kind: 'area', rank: 2, types: ['Gebiet', 'Lokalname swisstopo', 'Flurname swisstopo', 'Landschaftsname', 'Wald'] },
  { kind: 'water', rank: 3, types: ['See', 'Gletscher'] },
  { kind: 'terrain', rank: 4, types: ['Hauptgipfel', 'Alpiner Gipfel', 'Gipfel', 'Huegel', 'Felskopf'] },
  { kind: 'other', rank: 4, types: ['Grat', 'Massiv', 'Pass', 'Strassenpass'] },
  { kind: 'water', rank: 5, types: ['Fliessgewaesser'] },
  { kind: 'other', rank: 6, types: ['Graben', 'Tal'] },
  { kind: 'road', rank: 7, types: ['Strasse'] },
];
const KIND_OF = new Map(KINDS.flatMap((k) => k.types.map((t) => [t, k])));
const OTHER = { kind: 'other', rank: 8 };
const MAX_NAMES = 150;

const cache = new Map();
const cached = (key, make) => {
  if (!cache.has(key)) cache.set(key, make().catch((err) => { cache.delete(key); throw err; }));
  return cache.get(key);
};
const bboxKey = (b) => `${b.e0},${b.n0},${b.e1},${b.n1}`;

// A label anchor inside the bbox: the feature vertex nearest to the mean of its vertices in the
// bbox, or the centre of the overlap when no vertex falls inside (large areas around the bbox).
function anchor(geometry, b) {
  const pts = [];
  const walk = (c) => (typeof c[0] === 'number' ? pts.push(c) : c.forEach(walk));
  walk(geometry.coordinates);
  const inside = pts.filter(([e, n]) => e >= b.e0 && e <= b.e1 && n >= b.n0 && n <= b.n1);
  if (inside.length) {
    const me = inside.reduce((s, p) => s + p[0], 0) / inside.length;
    const mn = inside.reduce((s, p) => s + p[1], 0) / inside.length;
    return inside.reduce((best, p) => (Math.hypot(p[0] - me, p[1] - mn) < Math.hypot(best[0] - me, best[1] - mn) ? p : best));
  }
  const es = pts.map((p) => p[0]), ns = pts.map((p) => p[1]);
  const e0 = Math.max(b.e0, Math.min(...es)), e1 = Math.min(b.e1, Math.max(...es));
  const n0 = Math.max(b.n0, Math.min(...ns)), n1 = Math.min(b.n1, Math.max(...ns));
  return e0 <= e1 && n0 <= n1 ? [(e0 + e1) / 2, (n0 + n1) / 2] : null;
}

// [{ name, kind, rank, e, n }] sorted by rank. The API picks names suited to the extent's scale.
export function fetchNames(b) {
  return cached(`names|${bboxKey(b)}`, async () => {
    const extent = bboxKey(b);
    const w = 1000, h = Math.max(1, Math.round((1000 * (b.n1 - b.n0)) / (b.e1 - b.e0)));
    const url = 'https://api3.geo.admin.ch/rest/services/api/MapServer/identify?geometryType=esriGeometryEnvelope'
      + `&geometry=${extent}&mapExtent=${extent}&imageDisplay=${w},${h},96&tolerance=0&sr=2056`
      + '&layers=all:ch.swisstopo.swissnames3d&returnGeometry=true&geometryFormat=geojson&limit=200&lang=de';
    const res = await fetch(url);
    if (!res.ok) throw new Error(`swissNAMES3D request failed (${res.status})`);
    const { results = [] } = await res.json();

    // Language variants share one geometry (Rotten / Rodan / Le Rhône …). Keep the official ones,
    // joined like on Swiss maps for bilingual names ("Pfywald / La Forêt de Finges").
    const byGeom = new Map();
    for (const f of results) {
      const key = `${f.properties.objektart}|${JSON.stringify(f.geometry.coordinates).slice(0, 60)}`;
      if (!byGeom.has(key)) byGeom.set(key, []);
      byGeom.get(key).push(f);
    }
    const names = [];
    const seen = new Set();
    for (const group of byGeom.values()) {
      const official = group.filter((f) => f.properties.status === 'offiziell').map((f) => f.properties.name);
      const name = official.length ? [...new Set(official)].join(' / ') : group[0].properties.name;
      const at = anchor(group[0].geometry, b);
      if (!at || seen.has(name)) continue;
      seen.add(name);
      const k = KIND_OF.get(group[0].properties.objektart) ?? OTHER;
      names.push({ name, kind: k.kind, rank: k.rank, e: at[0], n: at[1] });
    }
    return names.sort((x, y) => x.rank - y.rank).slice(0, MAX_NAMES);
  });
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Overlay image failed: ${url}`));
    img.src = url;
  });
}

// swissTLM3D roads for the bbox as a transparent canvas, at most ~1200 px on the long side.
export function fetchRoads(b) {
  return cached(`roads|${bboxKey(b)}`, async () => {
    const res = Math.max(2, Math.max(b.e1 - b.e0, b.n1 - b.n0) / 1200);
    const w = Math.round((b.e1 - b.e0) / res), h = Math.round((b.n1 - b.n0) / res);
    const url = 'https://wms.geo.admin.ch/?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&STYLES=&CRS=EPSG:2056'
      + `&LAYERS=ch.swisstopo.swisstlm3d-strassen&BBOX=${bboxKey(b)}&WIDTH=${w}&HEIGHT=${h}&FORMAT=image/png&TRANSPARENT=true`;
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    return canvas;
  });
}
