// Generates minimal PNG and ICO icon files for Tauri build
const fs = require("fs");
const path = require("path");

const iconsDir = path.join(__dirname, "..", "src-tauri", "icons");
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true });

// Minimal valid PNG: 32x32 solid blue (#58a6ff)
function createPng(width, height) {
  function crc32(buf) {
    let c;
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeData = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeData));
    return Buffer.concat([len, typeData, crc]);
  }

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // IDAT - raw image data with zlib
  const rawRow = Buffer.alloc(1 + width * 3); // filter byte + RGB
  rawRow[0] = 0; // no filter
  for (let x = 0; x < width; x++) {
    rawRow[1 + x * 3] = 0x58;     // R
    rawRow[1 + x * 3 + 1] = 0xa6; // G
    rawRow[1 + x * 3 + 2] = 0xff; // B
  }

  const rawData = Buffer.concat(Array(height).fill(rawRow));

  // Simple zlib wrapping (deflate stored blocks)
  const zlibData = [];
  zlibData.push(Buffer.from([0x78, 0x01])); // zlib header

  let offset = 0;
  while (offset < rawData.length) {
    const remaining = rawData.length - offset;
    const blockSize = Math.min(remaining, 65535);
    const isLast = offset + blockSize >= rawData.length;
    const header = Buffer.alloc(5);
    header[0] = isLast ? 1 : 0;
    header.writeUInt16LE(blockSize, 1);
    header.writeUInt16LE(blockSize ^ 0xffff, 3);
    zlibData.push(header);
    zlibData.push(rawData.subarray(offset, offset + blockSize));
    offset += blockSize;
  }

  // Adler-32 checksum
  let a = 1, b = 0;
  for (let i = 0; i < rawData.length; i++) {
    a = (a + rawData[i]) % 65521;
    b = (b + a) % 65521;
  }
  const adler = Buffer.alloc(4);
  adler.writeUInt32BE(((b << 16) | a) >>> 0);
  zlibData.push(adler);

  const compressedData = Buffer.concat(zlibData);

  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", compressedData),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ICO format wrapping a PNG
function createIco(pngBuf, width, height) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // ICO type
  header.writeUInt16LE(1, 4); // 1 image

  const entry = Buffer.alloc(16);
  entry[0] = width >= 256 ? 0 : width;
  entry[1] = height >= 256 ? 0 : height;
  entry[2] = 0; // palette
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(pngBuf.length, 8); // size
  entry.writeUInt32LE(6 + 16, 12); // offset

  return Buffer.concat([header, entry, pngBuf]);
}

// Generate files
const png32 = createPng(32, 32);
const png128 = createPng(128, 128);
const png256 = createPng(256, 256);

fs.writeFileSync(path.join(iconsDir, "32x32.png"), png32);
fs.writeFileSync(path.join(iconsDir, "128x128.png"), png128);
fs.writeFileSync(path.join(iconsDir, "128x128@2x.png"), png256);
fs.writeFileSync(path.join(iconsDir, "icon.ico"), createIco(png32, 32, 32));
fs.writeFileSync(path.join(iconsDir, "icon.png"), png256);

console.log("Icons generated in src-tauri/icons/");
