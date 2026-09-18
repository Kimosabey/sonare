/**
 * Re-encodes an opaque RGBA PNG as RGB, losslessly.
 *
 * The splash exports and the brand images arrive as 8-bit RGBA with **every
 * pixel fully opaque** — an alpha channel carrying one value across a megabyte
 * of image. A splash is a wordmark on a flat ground; it has nothing to be
 * transparent for. Dropping that channel is about 45% of the bytes, and not
 * one pixel changes.
 *
 * `docs/design/assets/splash/WHERE-THE-PNGS-ARE.md` said this repository could
 * not do it — "there is no `sharp`, `pngjs`, `optipng`, `pngquant` or
 * `zopflipng`, and adding one is a new dependency". That was wrong about the
 * conclusion rather than the premise. None of those is installed and none is
 * needed: a PNG is IHDR, deflated scanlines and IEND, and Node ships zlib.
 *
 * ── what it refuses to do ──────────────────────────────────────────────────
 *
 * It converts a file only when **every** pixel is fully opaque. The brand
 * favicons are 66% transparent by design — the mark sits on nothing so it
 * takes the colour of whatever chrome is behind it — and stripping their alpha
 * would put a black square in the browser tab. The check is per file and the
 * refusal is the default.
 *
 * It also re-decodes its own output and compares every RGB byte against the
 * input before writing. A "lossless" conversion that is not is the one failure
 * here nobody would notice until a learner saw it.
 *
 * Usage: node scripts/strip-png-alpha.mjs <file>... [--write]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** CRC-32, which every PNG chunk carries and no decoder will skip. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunks(buf) {
  const out = [];
  let pos = 8;
  while (pos < buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    out.push({ type, data: buf.subarray(pos + 8, pos + 8 + length) });
    pos += 12 + length;
    if (type === "IEND") break;
  }
  return out;
}

/** The Paeth predictor, byte for byte as the spec defines it. */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Undoes the per-scanline filters. Returns raw pixel bytes. */
function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  let prev = Buffer.alloc(stride);
  let at = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[at];
    at += 1;
    const line = Buffer.from(raw.subarray(at, at + stride));
    at += stride;

    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? line[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      if (filter === 1) line[x] = (line[x] + a) & 0xff;
      else if (filter === 2) line[x] = (line[x] + b) & 0xff;
      else if (filter === 3) line[x] = (line[x] + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) line[x] = (line[x] + paeth(a, b, c)) & 0xff;
    }

    line.copy(out, y * stride);
    prev = line;
  }

  return out;
}

/**
 * Filters each scanline, choosing per line by the heuristic the PNG spec
 * suggests: the filter whose output has the smallest sum of absolute
 * differences. Cheap, and it is most of what a dedicated encoder buys.
 */
function filterScanlines(pixels, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(height * (stride + 1));
  let prev = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const line = pixels.subarray(y * stride, (y + 1) * stride);
    let best = null;

    for (let filter = 0; filter <= 4; filter += 1) {
      const candidate = Buffer.alloc(stride);
      let score = 0;
      for (let x = 0; x < stride; x += 1) {
        const a = x >= bpp ? line[x - bpp] : 0;
        const b = prev[x];
        const c = x >= bpp ? prev[x - bpp] : 0;
        const value =
          filter === 0 ? line[x]
          : filter === 1 ? line[x] - a
          : filter === 2 ? line[x] - b
          : filter === 3 ? line[x] - ((a + b) >> 1)
          : line[x] - paeth(a, b, c);
        candidate[x] = value & 0xff;
        score += Math.min(candidate[x], 256 - candidate[x]);
      }
      if (best === null || score < best.score) best = { filter, candidate, score };
    }

    out[y * (stride + 1)] = best.filter;
    best.candidate.copy(out, y * (stride + 1) + 1);
    prev = line;
  }

  return out;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function decode(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  const parts = chunks(buf);
  const ihdr = parts.find((c) => c.type === "IHDR");
  if (ihdr === undefined) throw new Error("no IHDR");

  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const depth = ihdr.data[8];
  const colour = ihdr.data[9];
  const interlace = ihdr.data[12];

  const idat = Buffer.concat(parts.filter((c) => c.type === "IDAT").map((c) => c.data));
  const bpp = colour === 6 ? 4 : colour === 2 ? 3 : 0;

  return { width, height, depth, colour, interlace, bpp, idat, parts };
}

/** Converts one file. Returns a report; writes only when asked and only if safe. */
export function stripAlpha(path, write = false) {
  const original = readFileSync(path);
  const png = decode(original);

  if (png.depth !== 8 || png.colour !== 6 || png.interlace !== 0) {
    return { path, skipped: `not 8-bit non-interlaced RGBA (depth ${png.depth}, colour ${png.colour})` };
  }

  const pixels = unfilter(inflateSync(png.idat), png.width, png.height, 4);

  // Refused unless every pixel is opaque. The brand favicons are 66%
  // transparent by design, and flattening them would put a black square in a
  // browser tab.
  let transparent = 0;
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] !== 255) transparent += 1;
  if (transparent > 0) {
    return { path, skipped: `${transparent} pixels are not fully opaque` };
  }

  const rgb = Buffer.alloc(png.width * png.height * 3);
  for (let i = 0, j = 0; i < pixels.length; i += 4, j += 3) {
    rgb[j] = pixels[i];
    rgb[j + 1] = pixels[i + 1];
    rgb[j + 2] = pixels[i + 2];
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(png.width, 0);
  ihdr.writeUInt32BE(png.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // truecolour, no alpha
  const idat = deflateSync(filterScanlines(rgb, png.width, png.height, 3), { level: 9 });

  const out = Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);

  // Re-decoded and compared before anything is written. A "lossless"
  // conversion that is not is the one failure here nobody would notice until a
  // learner saw it.
  const back = decode(out);
  const check = unfilter(inflateSync(back.idat), back.width, back.height, 3);
  if (!check.equals(rgb)) throw new Error(`${path}: round trip changed the pixels`);

  if (write) writeFileSync(path, out);

  return {
    path,
    before: original.length,
    after: out.length,
    saved: original.length - out.length,
    width: png.width,
    height: png.height,
  };
}

const files = process.argv.slice(2).filter((a) => a !== "--write");
const write = process.argv.includes("--write");

if (files.length > 0) {
  let before = 0;
  let after = 0;
  for (const file of files) {
    const report = stripAlpha(file, write);
    if (report.skipped !== undefined) {
      console.log(`  skipped  ${file}  — ${report.skipped}`);
      continue;
    }
    before += report.before;
    after += report.after;
    const pct = ((report.saved / report.before) * 100).toFixed(1);
    console.log(
      `  ${write ? "wrote" : "would"}  ${file.padEnd(42)} ${String(report.before).padStart(8)} → ${String(report.after).padStart(8)}  −${pct}%`,
    );
  }
  if (before > 0) {
    console.log(
      `\n  total ${before.toLocaleString()} → ${after.toLocaleString()} bytes  (−${(((before - after) / before) * 100).toFixed(1)}%)`,
    );
  }
}
