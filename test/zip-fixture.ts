import { deflateRawSync } from "node:zlib";

export type ZipItem = {
  name: string;
  data?: string;
  mode?: number;
  declaredSize?: number;
  method?: 0 | 8;
};

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function makeZip(items: ZipItem[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const item of items) {
    const name = Buffer.from(item.name);
    const data = Buffer.from(item.data ?? "");
    const compressed = item.method === 8 ? deflateRawSync(data) : data;
    const declaredSize = item.declaredSize ?? data.length;
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(0x800, 6);
    header.writeUInt16LE(item.method ?? 0, 8);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(declaredSize, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, compressed);
    const row = Buffer.alloc(46);
    row.writeUInt32LE(0x02014b50, 0);
    row.writeUInt16LE(0x031e, 4);
    row.writeUInt16LE(20, 6);
    row.writeUInt16LE(0x800, 8);
    row.writeUInt16LE(item.method ?? 0, 10);
    row.writeUInt32LE(crc, 16);
    row.writeUInt32LE(compressed.length, 20);
    row.writeUInt32LE(declaredSize, 24);
    row.writeUInt16LE(name.length, 28);
    row.writeUInt32LE(((item.mode ?? 0o100644) << 16) >>> 0, 38);
    row.writeUInt32LE(offset, 42);
    central.push(row, name);
    offset += header.length + name.length + compressed.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(items.length, 8);
  end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}
