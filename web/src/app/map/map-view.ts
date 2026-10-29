import { Component, ElementRef, OnDestroy, afterNextRender, inject, signal, viewChild } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import {
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
import type { FeatureCollection, Point } from 'geojson';
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
