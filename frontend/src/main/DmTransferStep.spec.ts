import { describe, expect, it } from 'vitest';
import { bandsToStore, countByStatus, type BandProposal } from './DmTransferStep';

const proposal = (id: number, status: BandProposal['status'], hadEnd = false): BandProposal => ({
  id,
  sensor_order: id,
  name: null,
  status,
  had_end: hadEnd,
  nx: status === 'found' || status === 'shared' ? 0.1 : null,
  ny: status === 'found' || status === 'shared' ? 0.2 : null,
  nx_end: status === 'found' || status === 'shared' ? 0.6 : null,
  ny_end: status === 'found' || status === 'shared' ? 0.2 : null,
  start: null,
  end: null,
  length: null,
});

const proposals = [
  proposal(1, 'found'),
  proposal(2, 'shared'),
  proposal(3, 'found', true),
  proposal(4, 'unclear'),
  proposal(5, 'no_line'),
];

describe('bandsToStore', () => {
  it('stores the found bands of points without an end, the guessed splits if wanted', () => {
    const ids = (options: { includeShared: boolean; replaceExisting: boolean }) =>
      bandsToStore(proposals, options).map((entry) => entry.id);

    expect(ids({ includeShared: true, replaceExisting: false })).toEqual([1, 2]);
    expect(ids({ includeShared: false, replaceExisting: false })).toEqual([1]);
    expect(ids({ includeShared: true, replaceExisting: true })).toEqual([1, 2, 3]);
  });
});

describe('countByStatus', () => {
  it('counts every status', () => {
    expect(countByStatus(proposals)).toEqual({ found: 2, shared: 1, unclear: 1, no_line: 1 });
  });
});
