import { Injectable, signal } from '@angular/core';
import type { LayerDefinition } from '../registry/registry';
import { BASEMAPS, DEFAULT_BASEMAP } from '../map/basemaps';

/**
 * The user's map settings: which layers are on, how they look, their order, and where the map is.
 * Kept separate from the registry (what CAN be shown) so registry changes never overwrite user choices.
 */
export interface MapConfig {
  version: 1;
  /** Layer ids, top of the map first. May contain ids that are no longer in the registry. */
  order: string[];
  layers: Record<string, LayerSettings>;
  view: MapViewState | null;
  basemap: string;
}

export interface LayerSettings {
  visible: boolean;
  /** 0..1 */
  opacity: number;
}

export interface MapViewState {
  center: [number, number];
  zoom: number;
}

export const STORAGE_KEY = 'gis-learning.map-config';

/**
 * Combines saved settings with the current registry. Saved choices win; new layers get their registry
 * defaults and go to the bottom; layers that left the registry are kept, so the user's settings
 * survive if the layer comes back, and the panel can show them as unavailable.
 */
export function mergeConfig(
  saved: unknown,
  registry: LayerDefinition[],
  basemapIds: string[] = BASEMAPS.map((b) => b.id),
): MapConfig {
  const valid = isConfig(saved) ? saved : null;
  const order = [...new Set(valid?.order ?? [])];
  for (const layer of registry) {
    if (!order.includes(layer.id)) {
      order.push(layer.id);
    }
  }

  const layers: Record<string, LayerSettings> = {};
  for (const id of order) {
    const savedSettings = valid?.layers[id];
    const definition = registry.find((l) => l.id === id);
    layers[id] = isSettings(savedSettings)
      ? savedSettings
      : { visible: definition?.defaultVisible ?? false, opacity: 1 };
  }

  const basemap = valid && basemapIds.includes(valid.basemap) ? valid.basemap : DEFAULT_BASEMAP;
  return { version: 1, order, layers, view: isView(valid?.view) ? valid.view : null, basemap };
}

/** Ids in the user's settings that the registry no longer has. */
export function unavailableIds(config: MapConfig, registry: LayerDefinition[]): string[] {
  return config.order.filter((id) => !registry.some((l) => l.id === id));
}

@Injectable({ providedIn: 'root' })
export class MapConfigStore {
  private readonly saved = readStorage();
  readonly config = signal<MapConfig | null>(null);

  /** The last map position, available before the registry has loaded. */
  savedView(): MapViewState | null {
    return isConfig(this.saved) && isView(this.saved.view) ? this.saved.view : null;
  }

  /** The last background map, available before the registry has loaded. */
  savedBasemap(): string | undefined {
    return isConfig(this.saved) ? this.saved.basemap : undefined;
  }

  setBasemap(id: string): void {
    this.update((c) => ({ ...c, basemap: id }));
  }

  init(registry: LayerDefinition[]): void {
    this.config.set(mergeConfig(this.config() ?? this.saved, registry));
  }

  setVisible(id: string, visible: boolean): void {
    this.updateLayer(id, { visible });
  }

  setOpacity(id: string, opacity: number): void {
    this.updateLayer(id, { opacity: Math.min(1, Math.max(0, opacity)) });
  }

  /** Moves a layer up (-1, towards the top of the map) or down (+1). */
  move(id: string, delta: -1 | 1): void {
    this.update((c) => {
      const from = c.order.indexOf(id);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= c.order.length) {
        return c;
      }
      const order = [...c.order];
      [order[from], order[to]] = [order[to], order[from]];
      return { ...c, order };
    });
  }

  /** Drops the saved settings of a layer that is no longer in the registry. */
  forget(id: string): void {
    this.update((c) => {
      const { [id]: _, ...layers } = c.layers;
      return { ...c, order: c.order.filter((o) => o !== id), layers };
    });
  }

  setView(view: MapViewState): void {
    this.update((c) => ({ ...c, view }));
  }

  private updateLayer(id: string, change: Partial<LayerSettings>): void {
    this.update((c) => (c.layers[id] ? { ...c, layers: { ...c.layers, [id]: { ...c.layers[id], ...change } } } : c));
  }

  private update(fn: (config: MapConfig) => MapConfig): void {
    const current = this.config();
    if (!current) {
      return;
    }
    const next = fn(current);
    this.config.set(next);
    writeStorage(next);
  }
}

// Browser storage can be missing or throw (private windows, blocked site data); the map works without it.
function readStorage(): unknown {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeStorage(config: MapConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // settings simply won't survive a reload
  }
}

function isConfig(value: unknown): value is MapConfig {
  const c = value as MapConfig | null;
  return (
    !!c &&
    c.version === 1 &&
    Array.isArray(c.order) &&
    c.order.every((id) => typeof id === 'string') &&
    typeof c.layers === 'object' &&
    c.layers !== null
  );
}

function isSettings(value: unknown): value is LayerSettings {
  const s = value as LayerSettings | undefined;
  return !!s && typeof s.visible === 'boolean' && typeof s.opacity === 'number' && s.opacity >= 0 && s.opacity <= 1;
}

function isView(value: unknown): value is MapViewState {
  const v = value as MapViewState | null | undefined;
  return (
    !!v &&
    Array.isArray(v.center) &&
    v.center.length === 2 &&
    v.center.every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    typeof v.zoom === 'number'
  );
}
