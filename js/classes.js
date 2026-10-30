// VHI classes as published by swisstopo for ch.swisstopo.swisseo_vhi_v100 (FOREST-10M).
// Pixel values are integers: 0–100 = VHI, 110 = missing data (clouds, snow…), 255 = no forest / outside.

export const NODATA = 255;
export const MISSING = 110;

export const CLASSES = [
  { label: 'Extremely stressed', range: '0–9', min: 0, max: 9, color: '#b56a29' },
  { label: 'Very stressed', range: '10–19', min: 10, max: 19, color: '#ce8540' },
  { label: 'Stressed', range: '20–29', min: 20, max: 29, color: '#f5cd85' },
  { label: 'Slightly stressed', range: '30–39', min: 30, max: 39, color: '#fff5ba' },
  { label: 'Normal', range: '40–49', min: 40, max: 49, color: '#cbffca' },
  { label: 'Good', range: '50–59', min: 50, max: 59, color: '#52bd9f' },
  { label: 'Excellent', range: '60–100', min: 60, max: 100, color: '#0470b0' },
  { label: 'Missing data', range: '110', min: 110, max: 110, color: '#b3b6b7' },
];

export const MISSING_CLASS = 7;
export const ALL_MASK = (1 << CLASSES.length) - 1;
export const STRESS_MASK = 0b1111; // classes 0–3: VHI < 40

// Class index per byte value; -1 = empty voxel (no forest).
export const CLASS_OF = new Int8Array(256).fill(-1);
CLASSES.forEach((c, i) => { for (let v = c.min; v <= c.max; v++) CLASS_OF[v] = i; });

export function classOf(v) { return CLASS_OF[v]; }

// Values 101–109 and 111–254 never occur at full resolution; overviews contain them where
// swisstopo's averaging mixed VHI with 110. Fold them into "missing" so they render honestly.
export function normalizeValue(v) {
  return v <= 100 || v === NODATA ? v : MISSING;
}

// 256×1 RGBA lookup table for the shader: rgb = class colour, a = class index + 1 (0 = empty).
export function buildLut() {
  const lut = new Uint8Array(256 * 4);
  for (let v = 0; v < 256; v++) {
    const k = CLASS_OF[v];
    if (k < 0) continue;
    const hex = CLASSES[k].color;
    lut[v * 4] = parseInt(hex.slice(1, 3), 16);
    lut[v * 4 + 1] = parseInt(hex.slice(3, 5), 16);
    lut[v * 4 + 2] = parseInt(hex.slice(5, 7), 16);
    lut[v * 4 + 3] = k + 1;
  }
  return lut;
}
