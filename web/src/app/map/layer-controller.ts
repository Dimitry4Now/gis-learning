import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import type { Subscription } from 'rxjs';
import type { GeoJSONSource, Map } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import type { LayerDefinition, LayerSummary, SourceDefinition } from '../registry/registry';
import type { MapConfig } from '../map-config/map-config';
import { applyOpacity, styleLayerIds, styleLayers } from './layer-renderer';

export type LayerState = 'hidden' | 'zoom' | 'loading' | 'loaded' | 'empty' | 'truncated' | 'error' | 'unavailable';

export interface LayerStatus {
  state: LayerState;
  /** features currently drawn */
  count?: number;
  message?: string;
}

type LayerResponse = FeatureCollection & { truncated: boolean };

/**
 * Puts registry layers on the map and keeps them in line with the user's settings: visibility,
 * opacity, order and data. Each layer loads and fails on its own, so one broken layer never blocks
 * the others.
 */
export class LayerController {
  readonly status = signal<Record<string, LayerStatus>>({});

  private readonly defs: LayerDefinition[];
  private readonly available = new Set<string>();
  private readonly fetchedAll = new Set<string>();
  /** For viewport layers: the bbox whose data is currently on the map */
  private readonly loadedArea = new globalThis.Map<string, string>();
  private readonly requests = new globalThis.Map<string, Subscription>();
  private readonly counts = new globalThis.Map<string, { count: number; truncated: boolean }>();
  private config?: MapConfig;

  constructor(
    private readonly map: Map,
    private readonly http: HttpClient,
    summaries: LayerSummary[],
    sources: SourceDefinition[],
  ) {
    this.defs = summaries.map((s) => s.layer);
    for (const { layer, load } of summaries) {
      if (load) {
        this.available.add(layer.id);
      }
      const attribution = sources.find((s) => s.id === layer.source)?.attribution;
      map.addSource(layer.id, { type: 'geojson', data: emptyCollection(), attribution });
      for (const styleLayer of styleLayers(layer)) {
        map.addLayer(styleLayer);
      }
    }
  }

  definition(id: string): LayerDefinition | undefined {
    return this.defs.find((d) => d.id === id);
  }

  /** Style layer ids of all registry layers that are currently visible. */
  visibleStyleLayerIds(): string[] {
    return this.defs.filter((d) => this.config?.layers[d.id]?.visible).flatMap(styleLayerIds);
  }

  /** Applies the user's settings. Called on every settings change; cheap when nothing changed. */
  sync(config: MapConfig): void {
    this.config = config;
    for (const def of this.defs) {
      const settings = config.layers[def.id];
      const visible = !!settings?.visible && this.available.has(def.id);
      for (const id of styleLayerIds(def)) {
        this.map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
      }
      applyOpacity(this.map, def, settings?.opacity ?? 1);

      if (!this.available.has(def.id)) {
        this.setStatus(def.id, { state: 'unavailable', message: 'This layer has not been loaded into the database.' });
      } else if (visible) {
        this.load(def);
      } else {
        this.cancel(def.id);
        this.setStatus(def.id, { state: 'hidden' });
      }
    }
    this.applyOrder(config.order);
  }

  /** Re-fetches visible viewport layers for the new map area. Call on moveend. */
  refreshViewport(): void {
    for (const def of this.defs) {
      if (def.loading === 'viewport' && this.config?.layers[def.id]?.visible && this.available.has(def.id)) {
        this.load(def, true);
      }
    }
  }

  private load(def: LayerDefinition, force = false): void {
    if (this.map.getZoom() < def.minZoom) {
      this.cancel(def.id);
      this.setStatus(def.id, { state: 'zoom', message: `Zoom in to level ${def.minZoom} to see this layer.` });
      return;
    }
    // Whole layers are fetched once; toggling them off and on reuses the data
    if (def.loading === 'all' && this.fetchedAll.has(def.id)) {
      if (this.status()[def.id]?.state === 'hidden') {
        this.setStatus(def.id, this.loadedStatus(def));
      }
      return;
    }
    const bbox = def.loading === 'viewport' ? this.bbox() : undefined;
    if (!force && bbox && this.loadedArea.get(def.id) === bbox) {
      if (this.status()[def.id]?.state === 'hidden') {
        this.setStatus(def.id, this.loadedStatus(def));
      }
      return; // this exact area is already on the map
    }
    if (this.requests.has(def.id) && !force) {
      return; // already loading this area
    }

    this.cancel(def.id);
    this.setStatus(def.id, { state: 'loading', count: this.status()[def.id]?.count });
    const params = bbox ? { bbox } : undefined;
    const request = this.http.get<LayerResponse>(`/api/layers/${def.id}/features`, { params }).subscribe({
      next: (data) => {
        this.requests.delete(def.id);
        this.map.getSource<GeoJSONSource>(def.id)?.setData(data);
        if (bbox) {
          this.loadedArea.set(def.id, bbox);
        } else {
          this.fetchedAll.add(def.id);
        }
        this.counts.set(def.id, { count: data.features.length, truncated: data.truncated });
        this.setStatus(def.id, this.loadedStatus(def));
      },
      error: (e: HttpErrorResponse) => {
        this.requests.delete(def.id);
        const message =
          e.status === 503 ? 'The layer is registered but its table is not loaded.'
          : e.status === 0 ? 'The API could not be reached.'
          : `The API answered ${e.status}.`;
        this.setStatus(def.id, { state: 'error', message });
      },
    });
    this.requests.set(def.id, request);
  }

  private loadedStatus(def: LayerDefinition): LayerStatus {
    const { count = 0, truncated = false } = this.counts.get(def.id) ?? {};
    if (count === 0) {
      return {
        state: 'empty',
        count,
        message: def.loading === 'viewport' ? 'No features in this area.' : 'The layer has no features.',
      };
    }
    if (truncated) {
      return {
        state: 'truncated',
        count,
        message: `Showing the first ${count} features of this area. Zoom in to see all of them.`,
      };
    }
    return { state: 'loaded', count };
  }

  private cancel(id: string): void {
    this.requests.get(id)?.unsubscribe(); // aborts the HTTP request
    this.requests.delete(id);
  }

  /** order[0] is drawn on top. Moving each layer to the top, bottom-most first, rebuilds the stack. */
  private applyOrder(order: string[]): void {
    for (const id of [...order].reverse()) {
      const def = this.definition(id);
      for (const styleId of def ? styleLayerIds(def) : []) {
        this.map.moveLayer(styleId);
      }
    }
  }

  private bbox(): string {
    const b = this.map.getBounds();
    const clamp = (v: number, limit: number) => Math.max(-limit, Math.min(limit, v));
    return [clamp(b.getWest(), 180), clamp(b.getSouth(), 90), clamp(b.getEast(), 180), clamp(b.getNorth(), 90)]
      .map((v) => v.toFixed(5))
      .join(',');
  }

  private setStatus(id: string, status: LayerStatus): void {
    const current = this.status()[id];
    if (current?.state !== status.state || current.count !== status.count || current.message !== status.message) {
      this.status.update((all) => ({ ...all, [id]: status }));
    }
  }
}

function emptyCollection(): FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}
