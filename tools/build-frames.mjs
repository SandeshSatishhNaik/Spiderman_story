// Builds the two WebP frame sets the film plays from.
//
//   cd tools && npm install && node build-frames.mjs <dir-with-source-pngs>
//
// The 240 source PNGs (1920x1080) are not in the working tree any more;
// restore them from git history with:
//   git checkout e294c9f -- images/
//
// Output:
//   frames/v1/d/NNN.webp  1600x900, landscape screens
//   frames/v1/m/NNN.webp   608x1080, portrait screens. Each frame is cropped
//                         around the subject (CROP_KEYS), so phones follow
//                         the lens and the mask instead of a fixed centre.
//
// Bump the version folder (v1 -> v2) whenever frames change: vercel.json
// caches everything under /frames as immutable.

import sharp from 'sharp';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';

const SRC = process.argv[2];
if (!SRC) {
  console.error('usage: node build-frames.mjs <dir-with-source-pngs>');
  process.exit(1);
}

const OUT = path.resolve(import.meta.dirname, '../frames/v1');
const SRC_W = 1920;
const SRC_H = 1080;
const PORTRAIT_W = Math.round(SRC_H * 9 / 16); // 608: full-height 9:16 crop

// Horizontal centre of the subject (0..1 of frame width), keyed by frame number.
// Read off the footage by eye: street and police car, then the lens drifting
// left, then the back of the mask and the hand on the ledge.
const CROP_KEYS = [
  [1, 0.55], [45, 0.50], [60, 0.42], [90, 0.42], [120, 0.38], [145, 0.35],
  [165, 0.33], [185, 0.35], [205, 0.34], [225, 0.32], [240, 0.37],
];

function cropCentre(frame) {
  for (let k = 1; k < CROP_KEYS.length; k++) {
    const [f1, c1] = CROP_KEYS[k];
    const [f0, c0] = CROP_KEYS[k - 1];
    if (frame <= f1) {
      const t = (frame - f0) / (f1 - f0);
      const eased = t * t * (3 - 2 * t);
      return c0 + (c1 - c0) * eased;
    }
  }
  return CROP_KEYS.at(-1)[1];
}

const files = (await readdir(SRC)).filter((f) => f.endsWith('.png')).sort();
if (files.length !== 240) console.warn(`expected 240 frames, found ${files.length}`);

await mkdir(path.join(OUT, 'd'), { recursive: true });
await mkdir(path.join(OUT, 'm'), { recursive: true });

const webp = { quality: 70, effort: 6, smartSubsample: true };
let n = 0;
for (const file of files) {
  n++;
  const name = String(n).padStart(3, '0') + '.webp';
  const input = path.join(SRC, file);

  await sharp(input).resize(1600, 900).webp(webp).toFile(path.join(OUT, 'd', name));

  const left = Math.round(cropCentre(n) * SRC_W - PORTRAIT_W / 2);
  const clampedLeft = Math.min(Math.max(left, 0), SRC_W - PORTRAIT_W);
  await sharp(input)
    .extract({ left: clampedLeft, top: 0, width: PORTRAIT_W, height: SRC_H })
    .webp({ ...webp, quality: 68 })
    .toFile(path.join(OUT, 'm', name));

  if (n % 40 === 0) console.log(`${n}/${files.length}`);
}
console.log('done');
