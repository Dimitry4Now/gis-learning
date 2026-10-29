import type { StyleSpecification } from 'maplibre-gl';

/** A background map. Its attribution comes from its style; terms say what its license allows. */
export interface Basemap {
  id: string;
  name: string;
  style: string | StyleSpecification;
  terms: string;
  termsUrl: string;
}

// Our label layers need fonts; raster styles have none of their own, so they borrow OpenFreeMap's
export const GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';

function raster(tiles: string[], attribution: string, maxzoom: number): StyleSpecification {
  return {
    version: 8,
    glyphs: GLYPHS,
    sources: { basemap: { type: 'raster', tiles, tileSize: 256, maxzoom, attribution } },
    layers: [{ id: 'basemap', type: 'raster', source: 'basemap' }],
  };
}

const OPENFREEMAP_TERMS = 'Free, no key. © OpenMapTiles, data © OpenStreetMap contributors.';

export const BASEMAPS: Basemap[] = [
  {
    id: 'liberty',
    name: 'Streets',
    style: 'https://tiles.openfreemap.org/styles/liberty',
    terms: OPENFREEMAP_TERMS,
    termsUrl: 'https://openfreemap.org/',
  },
  {
    id: 'bright',
    name: 'Bright',
    style: 'https://tiles.openfreemap.org/styles/bright',
    terms: OPENFREEMAP_TERMS,
    termsUrl: 'https://openfreemap.org/',
  },
  {
    id: 'positron',
    name: 'Light',
    style: 'https://tiles.openfreemap.org/styles/positron',
    terms: OPENFREEMAP_TERMS,
    termsUrl: 'https://openfreemap.org/',
  },
  {
    id: 'dark',
    name: 'Dark',
    style: 'https://tiles.openfreemap.org/styles/dark',
    terms: OPENFREEMAP_TERMS,
    termsUrl: 'https://openfreemap.org/',
  },
  {
    id: 'satellite-esri',
    name: 'Satellite (Esri)',
    style: raster(
      ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      'Imagery: Esri, Vantor, Earthstar Geographics, and the GIS User Community',
      19,
    ),
    terms:
      'Under the Esri Master License Agreement, intended for ArcGIS apps. Fine for this learning project; check Esri’s terms before publishing.',
    termsUrl: 'https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9',
  },
  {
    id: 'satellite-sentinel',
    name: 'Satellite (Sentinel-2, 10 m)',
    style: raster(
      ['https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg'],
      'Sentinel-2 cloudless 2024 by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2024)',
      14,
    ),
    terms: 'CC BY-NC-SA 4.0: free for non-commercial use with attribution. 10 m pixels, so blurry up close.',
    termsUrl: 'https://cloudless.eox.at/documentation/license',
  },
  {
    id: 'topo',
    name: 'Topographic',
    style: raster(
      ['a', 'b', 'c'].map((s) => `https://${s}.tile.opentopomap.org/{z}/{x}/{y}.png`),
      'Map data © OpenStreetMap contributors, SRTM | Style © OpenTopoMap (CC-BY-SA)',
      17,
    ),
    terms: 'CC-BY-SA. A volunteer service: fine for light use.',
    termsUrl: 'https://opentopomap.org/about',
  },
];

export const DEFAULT_BASEMAP = 'liberty';

export function basemap(id: string | undefined): Basemap {
  return BASEMAPS.find((b) => b.id === id) ?? BASEMAPS.find((b) => b.id === DEFAULT_BASEMAP)!;
}
