import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

/** A data provider and dataset: who supplies it, how, and under which terms. Mirrors the API's SourceDefinition. */
export interface SourceDefinition {
  id: string;
  name: string;
  provider: string;
  type: string;
  access: string | null;
  url: string | null;
  license: string;
  licenseUrl: string | null;
  attribution: string;
  coverage: string | null;
  updateFrequency: string | null;
  knownLimitations: string | null;
}

export interface FieldDefinition {
  name: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'date';
}

/** A dataset the map can show. Mirrors the API's LayerDefinition. */
export interface LayerDefinition {
  id: string;
  name: string;
  category: string;
  source: string;
  geometryType: 'point' | 'line' | 'polygon';
  crs: string;
  idField: string;
  fields: FieldDefinition[];
  /** all: fetched once; viewport: the visible area is fetched after every move */
  loading: 'all' | 'viewport';
  simplify: number | null;
  minZoom: number;
  maxFeatures: number;
  defaultVisible: boolean;
  renderer: 'fill-outline' | 'circle' | 'place-labels';
  style: { color?: string } | null;
}

/** When and from what the layer's table was last loaded by the ETL. */
export interface LayerLoad {
  tableName: string;
  rowCount: number;
  loadedAt: string;
  sourceFile: string;
  sourceModified: string;
}

/** load is null when the table was never loaded, so the layer is unavailable. */
export interface LayerSummary {
  layer: LayerDefinition;
  load: LayerLoad | null;
}

@Injectable({ providedIn: 'root' })
export class RegistryClient {
  private readonly http = inject(HttpClient);

  sources(): Observable<SourceDefinition[]> {
    return this.http.get<SourceDefinition[]>('/api/sources');
  }

  layers(): Observable<LayerSummary[]> {
    return this.http.get<LayerSummary[]>('/api/layers');
  }
}
