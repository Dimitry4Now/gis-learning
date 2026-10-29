import type { LayerSpecification, Map } from 'maplibre-gl';
import type { LayerDefinition } from '../registry/registry';

const DEFAULT_COLOR = '#2563eb';
const FILL_OPACITY = 0.08;

/** MapLibre style layers for one registry layer. Their ids start with the registry id. */
export function styleLayers(def: LayerDefinition): LayerSpecification[] {
  const color = def.style?.color ?? DEFAULT_COLOR;
  const base = { source: def.id, minzoom: def.minZoom, layout: { visibility: 'none' as const } };

  switch (def.renderer) {
    case 'fill-outline':
      return [
        { ...base, id: `${def.id}:fill`, type: 'fill', paint: { 'fill-color': color, 'fill-opacity': FILL_OPACITY } },
        { ...base, id: `${def.id}:line`, type: 'line', paint: { 'line-color': color, 'line-width': 1 } },
      ];
    case 'circle':
      return [
        {
          ...base,
          id: `${def.id}:circle`,
          type: 'circle',
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 3, 14, 6],
            'circle-color': color,
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 1.5,
          },
        },
      ];
    case 'place-labels':
      return placeLabels(def);
  }
}

/** Dots plus Latin/Cyrillic labels for settlements; cities are larger and win label collisions. */
function placeLabels(def: LayerDefinition): LayerSpecification[] {
  return [
    {
      id: `${def.id}:circle`,
      type: 'circle',
      source: def.id,
      minzoom: def.minZoom,
      maxzoom: 11,
      layout: { visibility: 'none' },
      paint: {
        'circle-radius': ['match', ['get', 'place'], 'city', 4, 3],
        'circle-color': '#ffffff',
        'circle-stroke-color': '#374151',
        'circle-stroke-width': 1.5,
      },
    },
    {
      id: `${def.id}:label`,
      type: 'symbol',
      source: def.id,
      minzoom: def.minZoom,
      layout: {
        visibility: 'none',
        // Latin name on top, Cyrillic below, the same convention as the base map
        'text-field': [
          'format',
          ['coalesce', ['get', 'name_en'], ['get', 'name']], {},
          '\n', {},
          ['get', 'name'], { 'font-scale': 0.85 },
        ],
        // Fonts must exist on the glyph server named in the base style
        'text-font': ['match', ['get', 'place'], 'city', ['literal', ['Noto Sans Bold']], ['literal', ['Noto Sans Regular']]],
        'text-size': ['match', ['get', 'place'], 'city', 13, 12],
        'text-variable-anchor': ['top', 'bottom', 'left', 'right'],
        // Offset from the dot while it is shown, centred on the place once the dot is gone
        'text-radial-offset': ['step', ['zoom'], 0.6, 11, 0],
        'text-justify': 'auto',
        'symbol-sort-key': ['match', ['get', 'place'], 'city', 1, 2],
      },
      paint: { 'text-color': '#1f2937', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
    },
  ];
}

/** Applies the user's opacity (0..1) on top of each style layer's own base opacity. */
export function applyOpacity(map: Map, def: LayerDefinition, opacity: number): void {
  for (const layer of styleLayers(def)) {
    switch (layer.type) {
      case 'fill':
        map.setPaintProperty(layer.id, 'fill-opacity', FILL_OPACITY * opacity);
        break;
      case 'line':
        map.setPaintProperty(layer.id, 'line-opacity', opacity);
        break;
      case 'circle':
        map.setPaintProperty(layer.id, 'circle-opacity', opacity);
        map.setPaintProperty(layer.id, 'circle-stroke-opacity', opacity);
        break;
      case 'symbol':
        map.setPaintProperty(layer.id, 'text-opacity', opacity);
        break;
    }
  }
}

export function styleLayerIds(def: LayerDefinition): string[] {
  return styleLayers(def).map((l) => l.id);
}

/** The registry id a style layer belongs to. */
export function registryIdOf(styleLayerId: string): string {
  return styleLayerId.split(':')[0];
}
