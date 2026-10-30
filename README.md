# Vegetation Stress 3D Views

> **Experimental.** This is a prototype for exploring how forest condition develops over time. It is not an official swisstopo product, and it is not validated for operational use.

**Live demo:** https://davidoesch.github.io/VegetationsStress3DViews/

Pick any forest area in Switzerland and a period. The page stacks the daily swissEO **Vegetation Health Index (VHI)** maps of that area into a space–time cube that you can rotate, slice and filter:

- **east × north × time:** the oldest date is at the bottom and the newest at the top; non-forest cells are empty;
- **slice:** crop the cube along each axis, or move the top face through time (▶ Play);
- **filter:** hide VHI classes, e.g. "Stress only (< 40)", to see the 3D shape of stress events;
- **pixel history:** click any cell to get its VHI time series, and jump the cube to any date from the chart;
- **area summary:** the share of forest cells in each class, per date;
- **share:** the URL keeps the area, period, cut, filter and pinned cell, so a link reopens the same view.

## Inspiration and sources

- **Idea:** the space–time cube in [*Zarr SQL views*](https://gjoremilevski.com/posts/zarr-sql-views/) by Gjore Milevski. There, Zarr chunks are loaded in the browser, queried with DuckDB-WASM and drawn as a deck.gl volume. This project applies the same "slice a data cube in the browser" idea to Cloud Optimized GeoTIFFs.
- **Data:** [swissEO VHI](https://www.swisstopo.admin.ch/en/satelliteimage-swisseo-vhi) by swisstopo, developed with MeteoSwiss for the federal drought portal. It is accessed through the STAC API at [data.geo.admin.ch](https://data.geo.admin.ch/api/stac/v1/collections/ch.swisstopo.swisseo_vhi_v100), using the asset **FOREST-10M** in EPSG:2056 (LV95). Contains modified Copernicus Sentinel data.

## Data notes

| Value | Class | Colour |
|---|---|---|
| 0–9 | Extremely stressed | `#b56a29` |
| 10–19 | Very stressed | `#ce8540` |
| 20–29 | Stressed | `#f5cd85` |
| 30–39 | Slightly stressed | `#fff5ba` |
| 40–49 | Normal | `#cbffca` |
| 50–59 | Good | `#52bd9f` |
| 60–100 | Excellent | `#0470b0` |
| 110 | Missing data (e.g. clouds, snow) | `#b3b6b7` |
| 255 | No data / not forest | not drawn |

- **Coverage:** FOREST-10M exists from **2017-04-03** onwards, as daily composites of the last seven days, with gaps. Earlier VHI data, monthly at 30 m, is not used here.
- **Collections:** `ch.swisstopo.swisseo_vhi_v100` is announced to be **disabled after December 2026**. The page can also read the successor `ch.swisstopo.swisseo_vhi_v200`, which only starts in October 2026.
- **Aggregation:** for areas up to roughly 20 × 20 km the page reads the full 10 m data. When the cube needs coarser cells, it averages the valid 10 m pixels itself. Larger areas fall back to the COG overviews. swisstopo built those overviews by averaging, which can mix "missing" (110) into VHI values, so the page warns when it uses them.
- **Time axis:** each loaded date is one equally thick layer, so gaps between dates are not to scale. The pixel chart uses a true date axis.

## How it works

The site is plain HTML and JavaScript ES modules, with no build step and no backend. Everything happens in the browser:

1. **Find dates:** the STAC API lists the dates in the chosen period, sampled weekly, every two weeks or monthly.
2. **Read data:** [geotiff.js](https://geotiffjs.github.io/) reads only the needed 512 × 512 tiles of each COG via HTTP range requests (data.geo.admin.ch allows cross-origin requests).
3. **Build the cube:** the tiles are stacked into a byte volume, which is uploaded to the GPU as a 3D texture.
4. **Draw it:** a [three.js](https://threejs.org/) shader walks each view ray through the voxels and draws the first visible one. Cropping and class filtering are simply parameters of that shader. Hover and click use the same traversal in JavaScript.
5. **Area picker:** a [Leaflet](https://leafletjs.com/) map with swisstopo base maps; [proj4js](https://proj4js.org/) converts coordinates to LV95.

| File | Purpose |
|---|---|
| `index.html` | Layout, styles, CDN import map |
| `js/main.js` | UI wiring: map, controls, URL state, tooltips |
| `js/stac.js` | STAC queries and date sampling |
| `js/loader.js` | COG window reads, aggregation, volume building |
| `js/cube.js` | three.js voxel ray-marcher, slicing, picking |
| `js/chart.js` | Pixel-history and area-summary charts (SVG) |
| `js/classes.js` | VHI classes, colours, lookup table |

## Run locally

Serve the folder with any static web server, for example:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

A browser with WebGL 2 is required.

## Deployment

Every push to `main` publishes the site to GitHub Pages via [`.github/workflows/pages.yml`](.github/workflows/pages.yml).

## License

Code: [Apache 2.0](LICENSE). The VHI data remains subject to swisstopo's terms of use.
