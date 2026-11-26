import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const sourcePngPath = resolve(rootDir, 'assets', 'chaos-tamer-source.png');
const outIconsDir = resolve(rootDir, 'public', 'icons');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Precompute IEEE 802.3 CRC32 lookup table
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

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePngRgba(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Invalid PNG signature in source asset.');
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatChunks = [];

  let offset = 8;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buf.length) {
      throw new Error(`Truncated PNG chunk: ${type}`);
    }
    const chunkData = buf.subarray(dataStart, dataEnd);

    if (type === 'IHDR') {
      width = chunkData.readUInt32BE(0);
      height = chunkData.readUInt32BE(4);
      bitDepth = chunkData[8];
      colorType = chunkData[9];
      interlace = chunkData[12];
    } else if (type === 'IDAT') {
      idatChunks.push(chunkData);
    } else if (type === 'IEND') {
      break;
    }

    offset = dataEnd + 4;
  }

  if (width <= 0 || height <= 0) {
    throw new Error('Missing or invalid IHDR dimensions.');
  }
  if (bitDepth !== 8 || interlace !== 0) {
    throw new Error(`Unsupported PNG bitDepth=${bitDepth} or interlace=${interlace}; expected 8-bit non-interlaced.`);
  }

  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 0 ? 1 : 0;
  if (channels === 0) {
    throw new Error(`Unsupported PNG colorType=${colorType}.`);
  }

  const inflated = inflateSync(Buffer.concat(idatChunks));
  const rowBytes = width * channels;
  const expectedLength = height * (1 + rowBytes);
  if (inflated.length < expectedLength) {
    throw new Error(`Inflated PNG data too short (${inflated.length} < ${expectedLength}).`);
  }

  const recon = new Uint8Array(height * rowBytes);
  for (let y = 0; y < height; y++) {
    const filterType = inflated[y * (1 + rowBytes)];
    const rawRowOffset = y * (1 + rowBytes) + 1;
    const outRowOffset = y * rowBytes;
    const prevRowOffset = (y - 1) * rowBytes;

    for (let x = 0; x < rowBytes; x++) {
      const rawByte = inflated[rawRowOffset + x];
      const a = x >= channels ? recon[outRowOffset + x - channels] : 0;
      const b = y > 0 ? recon[prevRowOffset + x] : 0;
      const c = x >= channels && y > 0 ? recon[prevRowOffset + x - channels] : 0;

      let val = 0;
      switch (filterType) {
        case 0:
          val = rawByte;
          break;
        case 1:
          val = (rawByte + a) & 0xff;
          break;
        case 2:
          val = (rawByte + b) & 0xff;
          break;
        case 3:
          val = (rawByte + ((a + b) >> 1)) & 0xff;
          break;
        case 4:
          val = (rawByte + paethPredictor(a, b, c)) & 0xff;
          break;
        default:
          throw new Error(`Unsupported PNG scanline filter type ${filterType} at row ${y}.`);
      }
      recon[outRowOffset + x] = val;
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    if (channels === 4) {
      rgba[i * 4] = recon[i * 4];
      rgba[i * 4 + 1] = recon[i * 4 + 1];
      rgba[i * 4 + 2] = recon[i * 4 + 2];
      rgba[i * 4 + 3] = recon[i * 4 + 3];
    } else if (channels === 3) {
      rgba[i * 4] = recon[i * 3];
      rgba[i * 4 + 1] = recon[i * 3 + 1];
      rgba[i * 4 + 2] = recon[i * 3 + 2];
      rgba[i * 4 + 3] = 255;
    } else if (channels === 2) {
      rgba[i * 4] = recon[i * 2];
      rgba[i * 4 + 1] = recon[i * 2];
      rgba[i * 4 + 2] = recon[i * 2];
      rgba[i * 4 + 3] = recon[i * 2 + 1];
    } else {
      rgba[i * 4] = recon[i];
      rgba[i * 4 + 1] = recon[i];
      rgba[i * 4 + 2] = recon[i];
      rgba[i * 4 + 3] = 255;
    }
  }

  return { width, height, rgba };
}

function makePngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);

  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);

  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePngRgba(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8-bit
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter: adaptive
  ihdr[12] = 0; // interlace: none

  const rowStride = width * 4;
  const rawScanlines = Buffer.alloc(height * (1 + rowStride));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + rowStride);
    rawScanlines[rowStart] = 0; // Filter 0 (None)
    const srcStart = y * rowStride;
    for (let i = 0; i < rowStride; i++) {
      rawScanlines[rowStart + 1 + i] = rgba[srcStart + i];
    }
  }

  const compressedIdat = deflateSync(rawScanlines, { level: 9 });
  return Buffer.concat([
    PNG_SIGNATURE,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', compressedIdat),
    makePngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Build a 2D Summed-Area Table (Integral Image) over normalized [0..1] alpha
 * so continuous fractional box downsampling integrates every source pixel in O(1).
 */
function buildAlphaIntegralTable(width, height, rgba) {
  const stride = width + 1;
  const sat = new Float64Array((width + 1) * (height + 1));
  for (let y = 1; y <= height; y++) {
    let rowSum = 0;
    for (let x = 1; x <= width; x++) {
      const alpha = rgba[((y - 1) * width + (x - 1)) * 4 + 3] / 255;
      rowSum += alpha;
      sat[y * stride + x] = sat[(y - 1) * stride + x] + rowSum;
    }
  }
  return { sat, width, height, stride };
}

function sampleIntegratedAlpha(integral, u0, v0, u1, v1) {
  const x0 = Math.max(0, Math.min(integral.width, u0));
  const y0 = Math.max(0, Math.min(integral.height, v0));
  const x1 = Math.max(0, Math.min(integral.width, u1));
  const y1 = Math.max(0, Math.min(integral.height, v1));
  if (x1 <= x0 || y1 <= y0) return 0;

  // Bilinear lookup in the summed-area table for exact continuous box integration
  const lookup = (fx, fy) => {
    const ix = Math.min(integral.width - 1, Math.max(0, Math.floor(fx)));
    const iy = Math.min(integral.height - 1, Math.max(0, Math.floor(fy)));
    const tx = fx - ix;
    const ty = fy - iy;
    const s = integral.stride;
    const s00 = integral.sat[iy * s + ix];
    const s10 = integral.sat[iy * s + (ix + 1)];
    const s01 = integral.sat[(iy + 1) * s + ix];
    const s11 = integral.sat[(iy + 1) * s + (ix + 1)];
    const top = s00 + (s10 - s00) * tx;
    const bottom = s01 + (s11 - s01) * tx;
    return top + (bottom - top) * ty;
  };

  const sum = lookup(x1, y1) - lookup(x0, y1) - lookup(x1, y0) + lookup(x0, y0);
  const area = (x1 - x0) * (y1 - y0);
  return Math.max(0, Math.min(1, sum / area));
}

function generateTransparentWhiteLogo(integral, targetSize) {
  const out = new Uint8Array(targetSize * targetSize * 4);
  const scaleX = integral.width / targetSize;
  const scaleY = integral.height / targetSize;

  for (let y = 0; y < targetSize; y++) {
    for (let x = 0; x < targetSize; x++) {
      const alphaNorm = sampleIntegratedAlpha(
        integral,
        x * scaleX,
        y * scaleY,
        (x + 1) * scaleX,
        (y + 1) * scaleY,
      );
      const a = Math.round(alphaNorm * 255);
      const idx = (y * targetSize + x) * 4;
      if (a > 0) {
        // Pure white (#FFFFFF) emblem with exact anti-aliased alpha
        out[idx] = 255;
        out[idx + 1] = 255;
        out[idx + 2] = 255;
        out[idx + 3] = a;
      }
    }
  }
  return out;
}

function roundedBoxSdf(px, py, halfSize, cornerRadius) {
  const qx = Math.abs(px - halfSize) - (halfSize - cornerRadius);
  const qy = Math.abs(py - halfSize) - (halfSize - cornerRadius);
  const outDist = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inDist = Math.min(Math.max(qx, qy), 0);
  return outDist + inDist - cornerRadius;
}

function generateBadgedToolbarIcon(integral, size) {
  const out = new Uint8Array(size * size * 4);
  const half = size / 2;
  const cornerRadius = size * 0.225;
  const borderThickness = 1.0;

  // ~14% padding around the pure white Chaos Tamer emblem
  const pad = size * 0.14;
  const innerSpan = size - pad * 2;

  // Badge colors: #0B0B0F fill (11, 11, 15) + 1px #27272A inner border (39, 39, 42)
  const fillR = 11;
  const fillG = 11;
  const fillB = 15;
  const borderR = 39;
  const borderG = 39;
  const borderB = 42;

  // Subtle perceptual crispness boost for small toolbar sizes (16px / 32px)
  const alphaBoost = size <= 16 ? 1.35 : size <= 32 ? 1.2 : size <= 48 ? 1.1 : 1.04;
  const subSamples = 4; // 4x4 = 16 subpixel samples for silky rounded corners & 1px border

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let accumR = 0;
      let accumG = 0;
      let accumB = 0;
      let accumA = 0;

      for (let sy = 0; sy < subSamples; sy++) {
        const sampleY = y + (sy + 0.5) / subSamples;
        for (let sx = 0; sx < subSamples; sx++) {
          const sampleX = x + (sx + 0.5) / subSamples;
          const dist = roundedBoxSdf(sampleX, sampleY, half, cornerRadius);
          if (dist <= 0) {
            const isBorder = dist >= -borderThickness;
            accumR += isBorder ? borderR : fillR;
            accumG += isBorder ? borderG : fillG;
            accumB += isBorder ? borderB : fillB;
            accumA += 1;
          }
        }
      }

      const totalSub = subSamples * subSamples;
      const badgeAlpha = accumA / totalSub;
      if (badgeAlpha <= 0) {
        continue;
      }

      let baseR = accumR / accumA;
      let baseG = accumG / accumA;
      let baseB = accumB / accumA;

      // Exact box-supersampled white emblem within [pad, size - pad]
      let emblemAlpha = 0;
      if (x + 1 > pad && x < size - pad && y + 1 > pad && y < size - pad) {
        const u0 = ((x - pad) / innerSpan) * integral.width;
        const v0 = ((y - pad) / innerSpan) * integral.height;
        const u1 = ((x + 1 - pad) / innerSpan) * integral.width;
        const v1 = ((y + 1 - pad) / innerSpan) * integral.height;
        emblemAlpha = Math.min(1, sampleIntegratedAlpha(integral, u0, v0, u1, v1) * alphaBoost);
      }

      // Alpha-over composite pure white (255, 255, 255, emblemAlpha) onto the dark squircle badge
      const finalR = baseR * (1 - emblemAlpha) + 255 * emblemAlpha;
      const finalG = baseG * (1 - emblemAlpha) + 255 * emblemAlpha;
      const finalB = baseB * (1 - emblemAlpha) + 255 * emblemAlpha;

      const idx = (y * size + x) * 4;
      out[idx] = Math.round(finalR);
      out[idx + 1] = Math.round(finalG);
      out[idx + 2] = Math.round(finalB);
      out[idx + 3] = Math.round(badgeAlpha * 255);
    }
  }

  return out;
}

function main() {
  if (!existsSync(sourcePngPath)) {
    throw new Error(`Missing source logo at ${sourcePngPath}`);
  }

  mkdirSync(outIconsDir, { recursive: true });

  const srcBuf = readFileSync(sourcePngPath);
  const decoded = decodePngRgba(srcBuf);

  // Convert all non-transparent emblem pixels to pure white (255, 255, 255, alpha)
  for (let i = 0; i < decoded.width * decoded.height; i++) {
    const a = decoded.rgba[i * 4 + 3];
    if (a > 0) {
      decoded.rgba[i * 4] = 255;
      decoded.rgba[i * 4 + 1] = 255;
      decoded.rgba[i * 4 + 2] = 255;
    } else {
      decoded.rgba[i * 4] = 0;
      decoded.rgba[i * 4 + 1] = 0;
      decoded.rgba[i * 4 + 2] = 0;
    }
  }

  const integral = buildAlphaIntegralTable(decoded.width, decoded.height, decoded.rgba);

  // 1. 256x256 pure white emblem on transparent background for UI headers
  const logoWhiteSize = 256;
  const logoWhiteRgba = generateTransparentWhiteLogo(integral, logoWhiteSize);
  const logoWhitePng = encodePngRgba(logoWhiteSize, logoWhiteSize, logoWhiteRgba);
  const logoWhiteOut = resolve(outIconsDir, 'logo-white.png');
  writeFileSync(logoWhiteOut, logoWhitePng);
  console.log(`[icons] Generated public/icons/logo-white.png (${logoWhiteSize}x${logoWhiteSize}, ${logoWhitePng.length} bytes)`);

  // 2. Chrome Extension badged squircle icons (16, 32, 48, 128)
  for (const size of [16, 32, 48, 128]) {
    const iconRgba = generateBadgedToolbarIcon(integral, size);
    const iconPng = encodePngRgba(size, size, iconRgba);
    const outPath = resolve(outIconsDir, `icon-${size}.png`);
    writeFileSync(outPath, iconPng);
    console.log(`[icons] Generated public/icons/icon-${size}.png (${size}x${size}, ${iconPng.length} bytes)`);
  }
}

main();
