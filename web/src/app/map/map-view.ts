import { Component, ElementRef, OnDestroy, afterNextRender, inject, signal, viewChild } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import {
  FilterSpecification,
  FullscreenControl,
  GeoJSONSource,
  GeolocateControl,
  LngLatBoundsLike,
  Map,
  MapMouseEvent,
  Marker,
  NavigationControl,
  ScaleControl,
  setWorkerUrl,
} from 'maplibre-gl';
import type { FeatureCollection, MultiPolygon, Point } from 'geojson';
import { Place, PlaceSearch } from '../search/place-search';
import { ResetViewControl } from './reset-view-control';

interface PharmacyProps {
  name: string | null;
  distance_m: number;
}

// Bounding box of North Macedonia, [west, south], [east, north]
const MK_BOUNDS: LngLatBoundsLike = [
  [20.45, 40.85],
  [23.04, 42.37],
];
const MK_PADDING = 20;

// How close to zoom in on a search result, by OSM place type
const PLACE_ZOOM: Record<string, number> = { city: 12, town: 13, village: 14 };
const DEFAULT_PLACE_ZOOM = 15;

// City and town label layers in the OpenFreeMap "liberty" style
const BASE_TOWN_LABEL_LAYERS = ['label_city', 'label_city_capital', 'label_town'];

@Component({
  selector: 'app-map-view',
  imports: [PlaceSearch],
  templateUrl: './map-view.html',
  styleUrl: './map-view.css',
})
export class MapView implements OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly container = viewChild.required<ElementRef<HTMLDivElement>>('map');

  private map?: Map;
  private clickMarker?: Marker;
  private placeMarker?: Marker;

  protected readonly pharmacies = signal<PharmacyProps[]>([]);

  constructor() {
    // MapLibre needs a real DOM element with a size, so create it after the first render
    afterNextRender(() => this.initMap());
  }

  ngOnDestroy(): void {
    this.map?.remove();
  }

  protected flyToPlace(place: Place): void {
    if (!this.map) {
      return;
    }
    const [lng, lat] = place.geometry.coordinates;
    this.placeMarker?.remove();
    this.placeMarker = new Marker({ color: '#2563eb' }).setLngLat([lng, lat]).addTo(this.map);
    this.map.flyTo({ center: [lng, lat], zoom: PLACE_ZOOM[place.properties.place] ?? DEFAULT_PLACE_ZOOM });
  }

  protected clearPlace(): void {
    this.placeMarker?.remove();
    this.placeMarker = undefined;
  }

  private initMap(): void {
    // MapLibre looks for its worker next to its own module, which no longer exists once Angular
    // bundles it. Without the worker nothing renders. angular.json copies the file to /maplibre.
    setWorkerUrl(new URL('maplibre/maplibre-gl-worker.mjs', document.baseURI).href);

    const map = new Map({
      container: this.container().nativeElement,
      style: 'https://tiles.openfreemap.org/styles/liberty',
      // Fit the country to the screen instead of a fixed zoom, so phones and wide screens both work
      bounds: MK_BOUNDS,
      fitBoundsOptions: { padding: MK_PADDING },
    });
    this.map = map;

    map.addControl(new NavigationControl({ visualizePitch: true }), 'top-right');
    map.addControl(new ResetViewControl(MK_BOUNDS, MK_PADDING), 'top-right');
    map.addControl(new GeolocateControl({ positionOptions: { enableHighAccuracy: true } }), 'top-right');
    map.addControl(new FullscreenControl(), 'top-right');
    map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left');

    map.on('load', () => {
      this.addMunicipalities(map);
      this.addPharmacyLayer(map);
      this.addTownLabels(map);
      this.http.get<MultiPolygon>('/api/country').subscribe((country) => this.hideBaseTownLabels(map, country));
    });
    map.on('click', (e) => this.findNearestPharmacies(map, e));
  }

  private addMunicipalities(map: Map): void {
    // A URL source: MapLibre fetches the GeoJSON itself
    map.addSource('municipalities', { type: 'geojson', data: '/api/municipalities' });
    map.addLayer({
      id: 'municipalities-fill',
      type: 'fill',
      source: 'municipalities',
      paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0.08 },
    });
    map.addLayer({
      id: 'municipalities-line',
      type: 'line',
      source: 'municipalities',
      paint: { 'line-color': '#1d4ed8', 'line-width': 1 },
    });
  }

  private addPharmacyLayer(map: Map): void {
    map.addSource('pharmacies', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'pharmacies',
      type: 'circle',
      source: 'pharmacies',
      paint: {
        'circle-radius': 7,
        'circle-color': '#16a34a',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2,
      },
    });
  }

  /** Labels for every city and town from our own data; the base map drops many small towns at country zoom. */
  private addTownLabels(map: Map): void {
    map.addSource('towns', { type: 'geojson', data: '/api/places?type=city&type=town' });
    map.addLayer({
      id: 'towns-dot',
      type: 'circle',
      source: 'towns',
      maxzoom: 11,
      paint: {
        'circle-radius': ['match', ['get', 'place'], 'city', 4, 3],
        'circle-color': '#ffffff',
        'circle-stroke-color': '#374151',
        'circle-stroke-width': 1.5,
      },
    });
    map.addLayer({
      id: 'towns-label',
      type: 'symbol',
      source: 'towns',
      layout: {
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
        // Offset from the dot while it is shown, centred on the town once the dot is gone
        'text-radial-offset': ['step', ['zoom'], 0.6, 11, 0],
        'text-justify': 'auto',
        // Cities win label collisions over towns
        'symbol-sort-key': ['get', 'place_rank'],
      },
      paint: {
        'text-color': '#1f2937',
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.5,
      },
    });
  }

  /**
   * Our town labels replace the base map's inside North Macedonia, so hide the base ones there.
   * Outside the border (Sofia, Thessaloniki, ...) the base labels stay.
   */
  private hideBaseTownLabels(map: Map, country: MultiPolygon): void {
    const outsideCountry = ['!', ['within', country]] as FilterSpecification;
    for (const id of BASE_TOWN_LABEL_LAYERS) {
      if (!map.getLayer(id)) {
        continue; // the base style changed; nothing to hide
      }
      const existing = map.getFilter(id);
      map.setFilter(id, (existing ? ['all', existing, outsideCountry] : outsideCountry) as FilterSpecification);
    }
  }

  private findNearestPharmacies(map: Map, e: MapMouseEvent): void {
    const { lng, lat } = e.lngLat;

    this.clickMarker?.remove();
    this.clickMarker = new Marker({ color: '#dc2626' }).setLngLat([lng, lat]).addTo(map);

    this.http
      .get<FeatureCollection<Point, PharmacyProps>>('/api/pharmacies/nearest', {
        params: { lat, lon: lng, limit: 5 },
      })
      .subscribe((result) => {
        map.getSource<GeoJSONSource>('pharmacies')?.setData(result);
        this.pharmacies.set(result.features.map((f) => f.properties));
      });
  }
}
