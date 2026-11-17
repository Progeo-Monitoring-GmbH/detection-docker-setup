// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MAP_BASE_LAYER,
  MAP_BASE_LAYER_KEY,
  readMapBaseLayer,
  storeMapBaseLayer,
  tileSourcesFor,
} from './mapLayers';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('map base layers', () => {
  it('defaults to the satellite imagery', () => {
    expect(DEFAULT_MAP_BASE_LAYER).toBe('satellite');
    expect(readMapBaseLayer()).toBe('satellite');
    expect(tileSourcesFor('satellite', null)).toHaveLength(1);
    expect(tileSourcesFor('satellite', null)[0].url).toContain('World_Imagery');
  });

  it('stacks the place labels over the imagery for hybrid', () => {
    const urls = tileSourcesFor('hybrid', null).map((source) => source.url);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('World_Imagery');
    expect(urls[1]).toContain('World_Boundaries_and_Places');
  });

  it('uses OpenStreetMap with its copyright link for the street map', () => {
    const [source] = tileSourcesFor('street', null);
    expect(source.url).toContain('tile.openstreetmap.org');
    expect(source.attribution).toContain('openstreetmap.org/copyright');
  });

  it('uses only the own tile server when one is configured', () => {
    expect(tileSourcesFor('hybrid', 'https://tiles.local/{z}/{x}/{y}.png')).toEqual([
      { url: 'https://tiles.local/{z}/{x}/{y}.png', attribution: '' },
    ]);
  });

  it('remembers the choice and ignores unknown stored values', () => {
    storeMapBaseLayer('street');
    expect(readMapBaseLayer()).toBe('street');
    localStorage.setItem(MAP_BASE_LAYER_KEY, 'terrain');
    expect(readMapBaseLayer()).toBe('satellite');
  });

  it('falls back to satellite when the storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => storeMapBaseLayer('street')).not.toThrow();
    expect(readMapBaseLayer()).toBe('satellite');
  });
});
