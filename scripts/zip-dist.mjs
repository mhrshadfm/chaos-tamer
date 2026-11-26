import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const distDir = resolve(rootDir, 'dist');
const releaseDir = resolve(rootDir, 'release');

// Precompute IEEE 802.3 CRC32 table
const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC32_TABLE[i] = c >>> 0;
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function collectFilesRecursive(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFilesRecursive(fullPath));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

function toDosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((date.getSeconds() >> 1) & 0x1f);
  const dosDate =
    (((year - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f);
  return { dosTime, dosDate };
}

function buildPkZipBuffer(baseDir) {
  const absFiles = collectFilesRecursive(baseDir);
  if (absFiles.length === 0) {
    throw new Error(`No files found in ${baseDir} to package.`);
  }

  const entries = absFiles
    .map((fullPath) => ({
      fullPath,
      relPath: relative(baseDir, fullPath).split(sep).join('/'),
    }))
    .sort((a, b) => a.relPath.localeCompare(b.relPath));

  const localChunks = [];
  const centralChunks = [];
  let localOffset = 0;

  for (const entry of entries) {
    const rawData = readFileSync(entry.fullPath);
    const stat = statSync(entry.fullPath);
    const { dosTime, dosDate } = toDosDateTime(stat.mtime);
    const nameBytes = Buffer.from(entry.relPath, 'utf8');
    const fileCrc = crc32(rawData);

    const deflated = rawData.length > 0 ? deflateRawSync(rawData, { level: 9 }) : rawData;
    const useDeflate = rawData.length > 0 && deflated.length < rawData.length;
    const method = useDeflate ? 8 : 0;
    const compressedData = useDeflate ? deflated : rawData;

    // Local File Header (30 bytes + filename)
    const localHeader = Buffer.alloc(30 + nameBytes.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4); // version needed to extract (2.0)
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    localHeader.writeUInt16LE(method, 8); // compression method
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(fileCrc, 14);
    localHeader.writeUInt32LE(compressedData.length, 18);
    localHeader.writeUInt32LE(rawData.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length
    nameBytes.copy(localHeader, 30);

    localChunks.push(localHeader, compressedData);

    // Central Directory File Header (46 bytes + filename)
    const centralHeader = Buffer.alloc(46 + nameBytes.length);
    centralHeader.writeUInt32LE(0x02014b50, 0); // signature
    centralHeader.writeUInt16LE(20, 4); // version made by (2.0)
    centralHeader.writeUInt16LE(20, 6); // version needed to extract (2.0)
    centralHeader.writeUInt16LE(0x0800, 8); // UTF-8 filename flag
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(fileCrc, 16);
    centralHeader.writeUInt32LE(compressedData.length, 20);
    centralHeader.writeUInt32LE(rawData.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal file attrs
    centralHeader.writeUInt32LE(0, 38); // external file attrs
    centralHeader.writeUInt32LE(localOffset, 42);
    nameBytes.copy(centralHeader, 46);

    centralChunks.push(centralHeader);
    localOffset += localHeader.length + compressedData.length;
  }

  const centralBuffer = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4); // number of this disk
  eocd.writeUInt16LE(0, 6); // disk where central directory starts
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralBuffer.length, 12); // size of central directory
  eocd.writeUInt32LE(localOffset, 16); // offset of central directory
  eocd.writeUInt16LE(0, 20); // comment length

  return {
    buffer: Buffer.concat([...localChunks, centralBuffer, eocd]),
    entryCount: entries.length,
  };
}

function main() {
  if (!existsSync(distDir)) {
    console.error('[zip-dist] Error: dist/ directory does not exist. Run "npm run build" first.');
    process.exit(1);
  }

  mkdirSync(releaseDir, { recursive: true });
  const { buffer, entryCount } = buildPkZipBuffer(distDir);

  const pkg = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8'));
  const targets = [
    resolve(releaseDir, 'chaos-tamer.zip'),
    resolve(releaseDir, `chaos-tamer-v${pkg.version}.zip`),
    resolve(releaseDir, 'ig-flow-migrator.zip'),
  ];

  for (const outZip of targets) {
    writeFileSync(outZip, buffer);
    console.log(`[zip-dist] Created ${relative(rootDir, outZip).split(sep).join('/')} (${entryCount} files, ${buffer.length} bytes)`);
  }
}

main();
