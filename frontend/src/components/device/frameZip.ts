/**
 * Minimal store-only ZIP writer for frame export. PNGs are already
 * compressed, so entries are stored without deflate, which keeps this
 * dependency-free and fast. The produced archive is a valid ZIP that any
 * unzip tool and ffmpeg can read.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export const crc32 = (data: Uint8Array): number => {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

export const buildStoredZip = (
  files: Array<{ name: string; data: Uint8Array }>,
): Blob => {
  const encoder = new TextEncoder();
  const parts: BlobPart[] = [];
  const central: BlobPart[] = [];
  let offset = 0;
  let centralBytes = 0;

  files.forEach((file) => {
    const nameBytes = encoder.encode(file.name);
    const crc = crc32(file.data);
    const size = file.data.length;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); // local file header signature
    local.setUint16(4, 20, true); // version needed to extract
    local.setUint16(6, 0x0800, true); // UTF-8 flag
    local.setUint16(8, 0, true); // method: store
    local.setUint16(10, 0, true); // mod time
    local.setUint16(12, 0x21, true); // mod date
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true); // compressed size
    local.setUint32(22, size, true); // uncompressed size
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true); // extra length
    parts.push(local, nameBytes, new Uint8Array(file.data));

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true); // central directory signature
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, 0, true);
    entry.setUint16(12, 0, true);
    entry.setUint16(14, 0x21, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, size, true);
    entry.setUint32(24, size, true);
    entry.setUint16(28, nameBytes.length, true);
    entry.setUint16(30, 0, true); // extra length
    entry.setUint16(32, 0, true); // comment length
    entry.setUint16(34, 0, true); // disk number
    entry.setUint16(36, 0, true); // internal attributes
    entry.setUint32(38, 0, true); // external attributes
    entry.setUint32(42, offset, true); // local header offset
    central.push(entry, nameBytes);

    offset += 30 + nameBytes.length + size;
    centralBytes += 46 + nameBytes.length;
  });

  const centralStart = offset;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); // end of central directory signature
  end.setUint16(4, 0, true); // disk number
  end.setUint16(6, 0, true); // disk with central dir
  end.setUint16(8, files.length, true); // entries on this disk
  end.setUint16(10, files.length, true); // total entries
  end.setUint32(12, centralBytes, true); // central dir size
  end.setUint32(16, centralStart, true); // central dir offset
  end.setUint16(20, 0, true); // comment length

  return new Blob([...parts, ...central, end], { type: 'application/zip' });
};
