/**
 * Generates media/icon.png — the extension marketplace icon (256×256).
 *
 * Zero-dependency: builds the PNG byte stream by hand (IHDR + IDAT + IEND,
 * zlib-deflated raw RGBA scanlines). Draws a clock face: ring + hands at
 * 10:10 + center dot, VS Code-ish blue with anti-aliasing via distance
 * fields.
 *
 * Run: node scripts/make-icon.js
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const SIZE = 256;
const C = SIZE / 2;               // center
const RING_OUT = 104;             // ring outer radius
const RING_IN = 88;               // ring inner radius
const HAND_HALF = 7;              // half thickness of hands
const DOT_R = 9;                  // center dot
const BLUE = [59, 130, 246];      // #3B82F6

// Point on the clock: θ in degrees, clockwise from 12.
const dir = (deg) => {
    const rad = (deg * Math.PI) / 180;
    return [Math.sin(rad), -Math.cos(rad)];
};

// Hands at 10:10 (classic "friendly watch" pose).
const HANDS = [
    { dir: dir(-60), len: 52 },   // hour hand → 10 o'clock
    { dir: dir(60), len: 80 },    // minute hand → 2 o'clock
];

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** Coverage of a stroke drawn from the center along `dir`. */
function handCoverage(x, y, hand) {
    const [dx, dy] = hand.dir;
    // t = projection of (x,y)−center on the hand direction, clamped to segment
    const t = clamp01((x - C) * dx + (y - C) * dy);
    const px = C + t * dx, py = C + t * dy;
    const dist = Math.hypot(x - px, y - py);
    return clamp01(HAND_HALF + 0.5 - dist);
}

function pixel(x, y) {
    const d = Math.hypot(x - C, y - C);
    const ring = clamp01(Math.min(d - RING_IN, RING_OUT - d) + 0.5);
    const dot = clamp01(DOT_R + 0.5 - d);
    const hands = HANDS.reduce((acc, h) => Math.max(acc, handCoverage(x, y, h)), 0);
    return Math.max(ring, dot, hands);
}

// ---- PNG assembly -----------------------------------------------------------

function crc32(buf) {
    let table = crc32.table;
    if (!table) {
        table = crc32.table = [];
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) {
                c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            }
            table[n] = c >>> 0;
        }
    }
    let crc = 0xffffffff;
    for (const b of buf) {
        crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
}

// Raw scanlines: filter byte 0 + RGBA per pixel.
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
let p = 0;
for (let y = 0; y < SIZE; y++) {
    raw[p++] = 0; // filter: None
    for (let x = 0; x < SIZE; x++) {
        const cov = pixel(x, y);
        raw[p++] = BLUE[0];
        raw[p++] = BLUE[1];
        raw[p++] = BLUE[2];
        raw[p++] = Math.round(cov * 255);
    }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // color type: RGBA
ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(__dirname, '..', 'media', 'icon.png');
fs.writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
