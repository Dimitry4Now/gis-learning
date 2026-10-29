import {
  Component,
  ElementRef,
  OnDestroy,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { forkJoin } from 'rxjs';
import {
  FilterSpecification,
  FullscreenControl,
  GeolocateControl,
  LngLatBoundsLike,
  Map,
  MapMouseEvent,
  Marker,
  NavigationControl,
  Popup,
  ScaleControl,
  setWorkerUrl,
} from 'maplibre-gl';
import type { MultiPolygon } from 'geojson';
import { Place, PlaceSearch } from '../search/place-search';
import { LayerPanel } from '../layers/layer-panel';
import { MapConfigStore } from '../map-config/map-config';
import { LayerSummary, RegistryClient, SourceDefinition } from '../registry/registry';
import { LayerController } from './layer-controller';
import { featurePopup } from './feature-popup';
import { registryIdOf } from './layer-renderer';
import { ResetViewControl } from './reset-view-control';

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
// Our layer that replaces them inside the country
const TOWNS_LAYER = 'osm-towns';

@Component({
  selector: 'app-map-view',
  imports: [PlaceSearch, LayerPanel],
  templateUrl: './map-view.html',
  styleUrl: './map-view.css',
})
export class MapView implements OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly registry = inject(RegistryClient);
  protected readonly store = inject(MapConfigStore);
  private readonly container = viewChild.required<ElementRef<HTMLDivElement>>('map');

  private map?: Map;
  private mapLoaded = false;
  private placeMarker?: Marker;
  private popup?: Popup;
  private country?: MultiPolygon;
  private readonly baseLabelFilters = new globalThis.Map<string, FilterSpecification | undefined>();

  protected readonly summaries = signal<LayerSummary[]>([]);
  protected readonly sources = signal<SourceDefinition[]>([]);
  protected readonly registryFailed = signal(false);
  private readonly controller = signal<LayerController | undefined>(undefined);
  protected readonly statuses = computed(() => this.controller()?.status() ?? {});

  constructor() {
    // MapLibre needs a real DOM element with a size, so create it after the first render
    afterNextRender(() => this.initMap());
    this.loadRegistry();

    // Every settings change (toggle, opacity, order) is pushed to the map. untracked: sync reads and
    // writes layer status, which must not re-trigger this effect, or each finished load starts another.
    effect(() => {
      const config = this.store.config();
      const controller = this.controller();
      if (config && controller) {
        untracked(() => {
          controller.sync(config);
          this.setBaseTownLabelsHidden(!!config.layers[TOWNS_LAYER]?.visible);
        });
      }
    });
  }

  ngOnDestroy(): void {
    this.map?.remove();
  }

  protected loadRegistry(): void {
    this.registryFailed.set(false);
    forkJoin([this.registry.sources(), this.registry.layers()]).subscribe({
      next: ([sources, summaries]) => {
        this.sources.set(sources);
        this.summaries.set(summaries);
        this.store.init(summaries.map((s) => s.layer));
        this.startLayers();
      },
      error: () => this.registryFailed.set(true),
    });
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

    const saved = this.store.savedView();
    const map = new Map({
      container: this.container().nativeElement,
      style: 'https://tiles.openfreemap.org/styles/liberty',
      // Reopen where the user left off; otherwise fit the country to the screen
      ...(saved ? { center: saved.center, zoom: saved.zoom } : { bounds: MK_BOUNDS, fitBoundsOptions: { padding: MK_PADDING } }),
    });
    this.map = map;

    map.addControl(new NavigationControl({ visualizePitch: true }), 'top-right');
    map.addControl(new ResetViewControl(MK_BOUNDS, MK_PADDING), 'top-right');
    map.addControl(new GeolocateControl({ positionOptions: { enableHighAccuracy: true } }), 'top-right');
    map.addControl(new FullscreenControl(), 'top-right');
    map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left');

    map.on('load', () => {
      this.mapLoaded = true;
      this.startLayers();
      this.http.get<MultiPolygon>('/api/country').subscribe((country) => {
        this.country = country;
        this.setBaseTownLabelsHidden(!!this.store.config()?.layers[TOWNS_LAYER]?.visible);
      });
    });
    map.on('moveend', () => {
      this.controller()?.refreshViewport();
      const { lng, lat } = map.getCenter();
      this.store.setView({ center: [lng, lat], zoom: map.getZoom() });
    });
    map.on('click', (e) => this.inspect(map, e));
    map.on('mousemove', (e) => {
      const hit = this.featuresAt(map, e).length > 0;
      map.getCanvas().style.cursor = hit ? 'pointer' : '';
    });
  }

  /** Adds registry layers once both the map and the registry are ready, whichever comes last. */
  private startLayers(): void {
    if (!this.map || !this.mapLoaded || !this.summaries().length || this.controller()) {
      return;
    }
    this.controller.set(new LayerController(this.map, this.http, this.summaries(), this.sources()));
  }

  private featuresAt(map: Map, e: MapMouseEvent) {
    const layers = this.controller()?.visibleStyleLayerIds() ?? [];
    return layers.length ? map.queryRenderedFeatures(e.point, { layers }) : [];
  }

  /** Shows the attributes of the top-most feature under the click. */
  private inspect(map: Map, e: MapMouseEvent): void {
    const feature = this.featuresAt(map, e)[0];
    const def = feature && this.controller()?.definition(registryIdOf(feature.layer.id));
    this.popup?.remove();
    if (!feature || !def) {
      return;
    }
    const source = this.sources().find((s) => s.id === def.source);
    this.popup = new Popup({ maxWidth: '280px' })
      .setLngLat(e.lngLat)
      .setDOMContent(featurePopup(def, source, feature.properties))
      .addTo(map);
  }

  /**
   * Our town labels replace the base map's inside North Macedonia, so the base ones are hidden there
   * while our layer is on. Outside the border (Sofia, Thessaloniki, ...) the base labels always stay.
   */
  private setBaseTownLabelsHidden(hidden: boolean): void {
    const map = this.map;
    if (!map || !this.mapLoaded || !this.country) {
      return;
    }
    const outsideCountry = ['!', ['within', this.country]];
    for (const id of BASE_TOWN_LABEL_LAYERS) {
      if (!map.getLayer(id)) {
        continue; // the base style changed; nothing to hide
      }
      if (!this.baseLabelFilters.has(id)) {
        this.baseLabelFilters.set(id, map.getFilter(id) ?? undefined);
      }
      const original = this.baseLabelFilters.get(id);
      const filter = hidden ? (original ? ['all', original, outsideCountry] : outsideCountry) : original;
      map.setFilter(id, (filter ?? null) as FilterSpecification | null);
    }
  }
}
