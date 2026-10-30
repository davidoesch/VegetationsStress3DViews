// STAC access for the swissEO VHI collections on data.geo.admin.ch.

const API = 'https://data.geo.admin.ch/api/stac/v1';

export const COLLECTIONS = {
  v100: 'ch.swisstopo.swisseo_vhi_v100',
  v200: 'ch.swisstopo.swisseo_vhi_v200',
};

const ASSET_SUFFIX = 'forest-10m.tif';
const cache = new Map();

// All dated items between start and end (YYYY-MM-DD, inclusive) that carry a FOREST-10M COG,
// sorted by date: [{ date, href }].
export async function listItems(collection, start, end, signal) {
  const key = `${collection}|${start}|${end}`;
  if (cache.has(key)) return cache.get(key);

  let url = `${API}/collections/${collection}/items?datetime=${start}T00:00:00Z/${end}T23:59:59Z&limit=100`;
  const out = [];
  while (url) {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`STAC request failed (${res.status})`);
    const page = await res.json();
    for (const f of page.features) {
      // Skip undated items such as v200's rolling "current" mosaic.
      if (!/^\d{4}-\d{2}-\d{2}/.test(f.id)) continue;
      const asset = Object.entries(f.assets).find(([k]) => k.endsWith(ASSET_SUFFIX));
      if (asset) out.push({ date: f.id.slice(0, 10), href: asset[1].href });
    }
    url = page.links.find((l) => l.rel === 'next')?.href;
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  cache.set(key, out);
  return out;
}

const DAY = 86400000;

// Keep the first available item in each week / fortnight (counted from `start`) or calendar month.
export function sample(items, step, start) {
  if (step === 'all') return items;
  const origin = Date.parse(start);
  const bucket = (date) => {
    if (step === 'month') return date.slice(0, 7);
    const days = (Date.parse(date) - origin) / DAY;
    return Math.floor(days / (step === '2week' ? 14 : 7));
  };
  const seen = new Set();
  return items.filter((it) => {
    const b = bucket(it.date);
    if (seen.has(b)) return false;
    seen.add(b);
    return true;
  });
}
