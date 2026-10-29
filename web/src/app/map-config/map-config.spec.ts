import { describe, expect, it } from 'vitest';
import type { LayerDefinition } from '../registry/registry';
import { mergeConfig, unavailableIds } from './map-config';

function layer(id: string, defaultVisible = true): LayerDefinition {
  return {
    id,
    name: id,
    category: 'Test',
    source: 'osm',
    geometryType: 'point',
    crs: 'EPSG:4326',
    idField: 'osm_id',
    fields: [{ name: 'name', label: 'Name', type: 'string' }],
    loading: 'all',
    simplify: null,
    minZoom: 0,
    maxFeatures: 100,
    defaultVisible,
    renderer: 'circle',
    style: null,
  };
}

describe('mergeConfig', () => {
  it('uses registry defaults when nothing is saved', () => {
    const config = mergeConfig(null, [layer('a', true), layer('b', false)]);
    expect(config.order).toEqual(['a', 'b']);
    expect(config.layers['a']).toEqual({ visible: true, opacity: 1 });
    expect(config.layers['b']).toEqual({ visible: false, opacity: 1 });
    expect(config.view).toBeNull();
  });

  it('keeps saved choices over registry defaults', () => {
    const saved = { version: 1, order: ['b', 'a'], layers: { a: { visible: false, opacity: 0.5 } }, view: null };
    const config = mergeConfig(saved, [layer('a', true), layer('b', false)]);
    expect(config.order).toEqual(['b', 'a']);
    expect(config.layers['a']).toEqual({ visible: false, opacity: 0.5 });
  });

  it('adds new registry layers at the bottom without touching saved ones', () => {
    const saved = { version: 1, order: ['a'], layers: { a: { visible: false, opacity: 1 } }, view: null };
    const config = mergeConfig(saved, [layer('new'), layer('a')]);
    expect(config.order).toEqual(['a', 'new']);
    expect(config.layers['a'].visible).toBe(false);
    expect(config.layers['new'].visible).toBe(true);
  });

  it('keeps settings for layers that left the registry and reports them', () => {
    const saved = { version: 1, order: ['gone', 'a'], layers: { gone: { visible: true, opacity: 0.3 } }, view: null };
    const registry = [layer('a')];
    const config = mergeConfig(saved, registry);
    expect(config.layers['gone']).toEqual({ visible: true, opacity: 0.3 });
    expect(unavailableIds(config, registry)).toEqual(['gone']);
  });

  it('ignores corrupt or foreign data instead of failing', () => {
    for (const junk of ['text', 42, { version: 2 }, { version: 1, order: 'a', layers: {} }]) {
      expect(mergeConfig(junk, [layer('a')]).order).toEqual(['a']);
    }
  });

  it('drops invalid per-layer settings and falls back to defaults', () => {
    const saved = { version: 1, order: ['a'], layers: { a: { visible: 'yes', opacity: 7 } }, view: { center: [1], zoom: 3 } };
    const config = mergeConfig(saved, [layer('a', false)]);
    expect(config.layers['a']).toEqual({ visible: false, opacity: 1 });
    expect(config.view).toBeNull();
  });
});
