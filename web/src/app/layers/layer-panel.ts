import { Component, computed, input, output, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import type { LayerDefinition, LayerLoad, LayerSummary, SourceDefinition } from '../registry/registry';
import type { LayerSettings, MapConfig } from '../map-config/map-config';
import type { LayerStatus } from '../map/layer-controller';
import type { Basemap } from '../map/basemaps';

interface Row {
  id: string;
  /** undefined: the layer is in the user's settings but no longer in the registry */
  def?: LayerDefinition;
  load?: LayerLoad | null;
  source?: SourceDefinition;
  settings: LayerSettings;
  status?: LayerStatus;
  first: boolean;
  last: boolean;
}

/** Layer list: toggles, opacity, order, status, and where each layer's data comes from. */
@Component({
  selector: 'app-layer-panel',
  imports: [DatePipe],
  templateUrl: './layer-panel.html',
  styleUrl: './layer-panel.css',
})
export class LayerPanel {
  readonly summaries = input.required<LayerSummary[]>();
  readonly sources = input.required<SourceDefinition[]>();
  readonly config = input.required<MapConfig | null>();
  readonly statuses = input.required<Record<string, LayerStatus>>();
  readonly failed = input(false);
  readonly basemaps = input.required<Basemap[]>();
  readonly basemapChange = output<string>();

  protected readonly selectedBasemap = computed(() =>
    this.basemaps().find((b) => b.id === this.config()?.basemap),
  );

  readonly visibleChange = output<{ id: string; visible: boolean }>();
  readonly opacityChange = output<{ id: string; opacity: number }>();
  readonly move = output<{ id: string; delta: -1 | 1 }>();
  readonly forget = output<string>();
  readonly retry = output<void>();

  protected readonly expanded = signal<ReadonlySet<string>>(new Set());

  protected readonly rows = computed<Row[]>(() => {
    const config = this.config();
    if (!config) {
      return [];
    }
    return config.order.map((id, i) => {
      const summary = this.summaries().find((s) => s.layer.id === id);
      return {
        id,
        def: summary?.layer,
        load: summary?.load,
        source: this.sources().find((s) => s.id === summary?.layer.source),
        settings: config.layers[id],
        status: this.statuses()[id],
        first: i === 0,
        last: i === config.order.length - 1,
      };
    });
  });

  protected toggleExpanded(id: string): void {
    this.expanded.update((set) => {
      const next = new Set(set);
      if (!next.delete(id)) {
        next.add(id);
      }
      return next;
    });
  }

  protected visibleFields(def: LayerDefinition) {
    return def.fields.filter((f) => !f.internal);
  }

  protected statusText(row: Row): string {
    if (!row.def) {
      return 'No longer available';
    }
    switch (row.status?.state) {
      case 'loading':
        return 'Loading…';
      case 'loaded':
        return `${row.status.count}`;
      case 'truncated':
        return `${row.status.count}+`;
      case 'empty':
        return 'None here';
      case 'zoom':
        return 'Zoom in';
      case 'error':
        return 'Failed';
      case 'unavailable':
        return 'Not loaded';
      default:
        return '';
    }
  }
}
