import { describe, expect, it } from 'vitest';
import { buildStoredZip, crc32 } from './frameZip';

describe('buildStoredZip', () => {
  it('computes well-known CRC32 values', () => {
    const encoder = new TextEncoder();
    expect(crc32(encoder.encode('hello'))).toBe(0x3610a686);
    expect(crc32(encoder.encode('The quick brown fox jumps over the lazy dog'))).toBe(
      0x414fa339,
    );
  });

  it('produces a structurally valid store-only zip', async () => {
    const encoder = new TextEncoder();
    const blob = buildStoredZip([
      { name: 'a.txt', data: encoder.encode('hello') },
      { name: 'b.txt', data: encoder.encode('world!') },
    ]);

    const bytes = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // Local file header signatures.
    expect(view.getUint32(0, true)).toBe(0x04034b50);

    // End of central directory record at the very end.
    const endOffset = bytes.length - 22;
    expect(view.getUint32(endOffset, true)).toBe(0x06054b50);
    expect(view.getUint16(endOffset + 8, true)).toBe(2); // entries on disk
    expect(view.getUint16(endOffset + 10, true)).toBe(2); // total entries

    // Central directory offset must point into the archive.
    const centralOffset = view.getUint32(endOffset + 16, true);
    expect(view.getUint32(centralOffset, true)).toBe(0x02014b50);

    // Central directory size must be > 0 and the archive must end right
    // after it.
    const centralSize = view.getUint32(endOffset + 12, true);
    expect(centralOffset + centralSize).toBe(endOffset);
  });
});
