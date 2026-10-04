import { mkdir, writeFile, cp } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
// Generate small geometric app icons without a platform-specific image dependency.
const crc = (data: Buffer) => {
  let result = 0xffffffff;
  for (const byte of data) {
    result ^= byte;
    for (let i = 0; i < 8; i++) result = (result >>> 1) ^ (result & 1 ? 0xedb88320 : 0);
  }
  return (result ^ 0xffffffff) >>> 0;
};
const chunk = (kind: string, data: Buffer) => {
  const name = Buffer.from(kind),
    length = Buffer.alloc(4),
    checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  checksum.writeUInt32BE(crc(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
};
for (const size of [192, 512]) {
  const pixels = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = x / size,
        v = y / size,
        disk = (u - 0.5) ** 2 + (v - 0.5) ** 2 < 0.36 ** 2;
      const stem = u > 0.36 && u < 0.42 && v > 0.28 && v < 0.72;
      const loop =
        u >= 0.42 && u < 0.65 && v > 0.28 && v < 0.54 && !(u < 0.58 && v > 0.35 && v < 0.47);
      const color = disk ? (stem || loop ? [246, 242, 233] : [44, 78, 63]) : [246, 242, 233];
      const offset = y * (size * 4 + 1) + 1 + x * 4;
      pixels.set([...color, 255], offset);
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  await writeFile(
    `public/icon-${size}.png`,
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(pixels)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}
await mkdir('public/pdf-assets', { recursive: true });
for (const folder of ['cmaps', 'standard_fonts', 'wasm'])
  await cp(`node_modules/pdfjs-dist/${folder}`, `public/pdf-assets/${folder}`, { recursive: true });
console.log('Prepared app icons and offline PDF rendering assets.');
