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
        { ...base, id: `${def.id}:fill`, type: 'fill', paint: { 'fill-color': color, 'fill-opacity': fillOpacity(def) } },
        { ...base, id: `${def.id}:line`, type: 'line', paint: { 'line-color': color, 'line-width': 1 } },
      ];
    case 'line':
      return [
        {
          ...base,
          id: `${def.id}:line`,
          type: 'line',
          layout: { ...base.layout, 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': color,
            // thin at country zoom, the configured width from street level
            'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 14, def.style?.width ?? 1.5],
          },
        },
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
    case 'border-crossings':
      return borderCrossings(def, color);
  }
}

// Text offset (in ems) that moves a label away from its point in the direction of its anchor
const ANCHOR_OFFSET = [
  'match', ['get', 'label_anchor'],
  'bottom', ['literal', [0, -0.9]],
  'bottom-left', ['literal', [0.7, -0.7]],
  'left', ['literal', [0.9, 0]],
  'top-left', ['literal', [0.7, 0.7]],
  'top', ['literal', [0, 0.9]],
  'top-right', ['literal', [-0.7, 0.7]],
  'right', ['literal', [-0.9, 0]],
  'bottom-right', ['literal', [-0.7, -0.7]],
  ['literal', [0, 0]],
] as const;

/**
 * Border crossings: a marker on the crossing and its name on the outer side of the border, as
 * computed by the ETL (label_anchor). Crossings that are not in use are grey.
 */
function borderCrossings(def: LayerDefinition, color: string): LayerSpecification[] {
  const statusColor = ['match', ['get', 'status'], 'no closure recorded', color, '#6b7280'] as const;
  return [
    {
      id: `${def.id}:circle`,
      type: 'circle',
      source: def.id,
      minzoom: def.minZoom,
      layout: { visibility: 'none' },
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 4, 12, 7],
        'circle-color': '#ffffff',
        'circle-stroke-color': statusColor as never,
        'circle-stroke-width': 3,
      },
    },
    {
      id: `${def.id}:label`,
      type: 'symbol',
      source: def.id,
      minzoom: def.minZoom,
      layout: {
        visibility: 'none',
        // Crossings that are not open get their status as a smaller second line
        'text-field': [
          'case',
          ['==', ['get', 'status'], 'no closure recorded'],
          ['get', 'label'],
          ['format', ['get', 'label'], {}, '\n', {}, ['get', 'status'], { 'font-scale': 0.85 }],
        ],
        'text-font': ['literal', ['Noto Sans Bold']],
        'text-size': 11,
        'text-anchor': ['get', 'label_anchor'] as never,
        'text-offset': ANCHOR_OFFSET as never,
      },
      paint: {
        'text-color': statusColor as never,
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.5,
      },
    },
  ];
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
        map.setPaintProperty(layer.id, 'fill-opacity', fillOpacity(def) * opacity);
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

function fillOpacity(def: LayerDefinition): number {
  return def.style?.fillOpacity ?? FILL_OPACITY;
}

export function styleLayerIds(def: LayerDefinition): string[] {
  return styleLayers(def).map((l) => l.id);
}

/** The registry id a style layer belongs to. */
export function registryIdOf(styleLayerId: string): string {
  return styleLayerId.split(':')[0];
}
