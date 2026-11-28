// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The URLs requested - nothing answers (no state change needed here). */
const api = vi.hoisted(() => ({ urls: [] as string[] }));
vi.mock('../axiosConfig', () => ({
  default: {
    perform_get: (_auth: unknown, url: string) => {
      api.urls.push(url);
      return Promise.resolve();
    },
  },
}));
vi.mock('../../hooks/CoreAuthProvider.tsx', () => ({ useAuth: () => ({}) }));
vi.mock('notistack', () => ({ useSnackbar: () => ({ enqueueSnackbar: vi.fn() }) }));

const { default: useMeasurementRange } = await import('./useMeasurementRange');
const { useLocationHistory } = await import('./useLocationHistory');

type Kind = 'leak' | 'climate';

const RangeProbe = ({ kind }: { kind?: Kind }) => {
  useMeasurementRange(12, false, true, kind);
  return null;
};

const HistoryProbe = ({ kind }: { kind?: Kind }) => {
  useLocationHistory(12, false, 'latest', 'diff', 0, kind);
  return null;
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  root = createRoot(container);
  api.urls = [];
});

afterEach(() => {
  act(() => root.unmount());
});

describe('per device kind', () => {
  it('asks for the range of one kind', () => {
    act(() => root.render(<RangeProbe kind="leak" />));
    expect(api.urls).toEqual(['/v1/location/12/measurement-range/?kind=leak']);
  });

  it('asks for the whole range without a kind, as before', () => {
    act(() => root.render(<RangeProbe />));
    expect(api.urls).toEqual(['/v1/location/12/measurement-range/']);
  });

  it('asks for the history of one kind', () => {
    act(() => root.render(<HistoryProbe kind="leak" />));
    expect(api.urls).toEqual(['/v1/location/12/heatmap/?latest=1&kind=leak']);
  });

  it('asks for the history without a kind, as before', () => {
    act(() => root.render(<HistoryProbe />));
    expect(api.urls).toEqual(['/v1/location/12/heatmap/?latest=1']);
  });
});
