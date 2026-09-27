// Renders the static images that are not film frames:
//   img/bugle-ledge.webp   halftone "newspaper photo" for the Daily Bugle page
//   og.jpg                 1200x630 social share card
//   favicon.svg, apple-touch-icon.png
//
//   cd tools && npm install && npx playwright install chromium && node build-images.mjs
//
// Needs network access to Google Fonts for the share card.

import { chromium } from 'playwright';
import sharp from 'sharp';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const frame = async (set, n) =>
  'data:image/webp;base64,' +
  (await readFile(path.join(ROOT, 'frames/v1', set, String(n).padStart(3, '0') + '.webp'))).toString('base64');

const browser = await chromium.launch(
  process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}
);
const page = await browser.newPage();

// ── Halftone photo ───────────────────────────────────────────────────
// Frame 225: the hand on the ledge and the back of the mask. Cropped to
// 3:2, levels stretched like a press photo, then screened at 45 degrees.
await mkdir(path.join(ROOT, 'img'), { recursive: true });
const halftone = await page.evaluate(async (src) => {
  const img = new Image();
  img.src = src;
  await img.decode();
  const W = 1200, H = 800, CELL = 7, ANGLE = Math.PI / 4;
  const srcCanvas = new OffscreenCanvas(W, H);
  const sctx = srcCanvas.getContext('2d');
  sctx.filter = 'grayscale(1)';
  // source crop: x 0..1350 of the 1600x900 frame -> 3:2
  sctx.drawImage(img, 0, 0, 1350, 900, 0, 0, W, H);
  const px = sctx.getImageData(0, 0, W, H).data;
  // The footage is dark and low-contrast. Stretch levels between the 2nd and
  // 98.5th percentile and lift the mids, or the screen turns to solid black.
  const L = new Float32Array(W * H);
  for (let i = 0; i < L.length; i++) L[i] = px[i * 4] / 255;
  const sorted = Float32Array.from(L).sort();
  const lo = sorted[Math.floor(L.length * 0.02)];
  const hi = sorted[Math.floor(L.length * 0.985)];
  const lum = (x, y) => {
    x = Math.max(0, Math.min(W - 1, x | 0));
    y = Math.max(0, Math.min(H - 1, y | 0));
    const v = Math.max(0, Math.min(1, (L[y * W + x] - lo) / (hi - lo)));
    return Math.pow(v, 0.62);
  };
  const out = new OffscreenCanvas(W, H);
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#16140f';
  const cos = Math.cos(ANGLE), sin = Math.sin(ANGLE);
  const R = Math.hypot(W, H);
  for (let u = -R; u < R; u += CELL) {
    for (let v = -R; v < R; v += CELL) {
      const x = W / 2 + u * cos - v * sin;
      const y = H / 2 + u * sin + v * cos;
      if (x < -CELL || y < -CELL || x > W + CELL || y > H + CELL) continue;
      let dark = 0;
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) dark += 1 - lum(x + i * 2, y + j * 2);
      dark /= 9;
      const r = (CELL / 2) * Math.sqrt(dark) * 1.28;
      if (r < 0.35) continue;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const blob = await out.convertToBlob({ type: 'image/png' });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
  return btoa(s);
}, await frame('d', 225));
await sharp(Buffer.from(halftone, 'base64'))
  .webp({ quality: 80, alphaQuality: 70, effort: 6 })
  .toFile(path.join(ROOT, 'img/bugle-ledge.webp'));

// ── Share card ───────────────────────────────────────────────────────
await page.setViewportSize({ width: 1200, height: 630 });
await page.setContent(`<!doctype html><html><head>
<link href="https://fonts.googleapis.com/css2?family=Anybody:wdth,wght@50..150,100..900&family=Newsreader:ital,opsz,wght@1,6..72,300..500&family=IBM+Plex+Mono:wght@400;500&display=block" rel="stylesheet">
<style>
  *{margin:0;box-sizing:border-box}
  body{width:1200px;height:630px;background:#000;color:#f3efe6;font-family:'IBM Plex Mono',monospace;position:relative;overflow:hidden}
  .pic{position:absolute;left:0;right:0;top:54px;bottom:54px;background:url(${await frame('d', 1)}) center 40%/cover}
  .pic::after{content:'';position:absolute;inset:0;background:linear-gradient(90deg,rgba(6,7,9,.92) 0%,rgba(6,7,9,.65) 45%,rgba(6,7,9,.05) 80%)}
  .bar{position:absolute;left:0;right:0;height:54px;display:flex;align-items:center;justify-content:space-between;padding:0 48px;font-size:14px;letter-spacing:.14em;text-transform:uppercase;color:#8e8a82}
  .top{top:0}.bot{bottom:0}
  .amber{color:#f0a640}
  .t{position:absolute;left:48px;top:150px}
  .eyebrow{font-size:15px;letter-spacing:.16em;text-transform:uppercase;color:#f0a640;margin-bottom:22px}
  h1{font-family:Anybody;font-weight:900;font-stretch:58%;font-size:168px;line-height:.8;letter-spacing:-.01em;text-transform:uppercase}
  h2{font-family:Newsreader;font-style:italic;font-weight:350;font-size:62px;margin-top:18px}
</style></head><body>
<div class="pic"></div>
<div class="bar top"><span>Into the Night</span><span>Unofficial fan film</span></div>
<div class="t"><p class="eyebrow">A fan film in three acts</p><h1>Spider-Man</h1><h2>Into the Night</h2></div>
<div class="bar bot"><span>EXT. Rooftop above 8th Avenue - Night</span><span><span class="amber">▮</span> 00:00:00:00 · FR 001/240</span></div>
</body></html>`);
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(ROOT, 'og.jpg'), type: 'jpeg', quality: 84 });
await browser.close();

// ── Icons ────────────────────────────────────────────────────────────
// A red disc crossed by web lines: reads as "spider" at 16px without
// borrowing the character's eye shape or logo.
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="7" fill="#0a0b0e"/>
  <circle cx="16" cy="16" r="10.5" fill="#c8352b"/>
  <g fill="none" stroke="#0a0b0e" stroke-width="1.3" stroke-linecap="round">
    <path d="M16 5.5v21M5.5 16h21M8.6 8.6l14.8 14.8M23.4 8.6 8.6 23.4"/>
    <path d="M16 10.2l4.1 1.7 1.7 4.1-1.7 4.1-4.1 1.7-4.1-1.7-1.7-4.1 1.7-4.1z"/>
  </g>
</svg>
`;
await writeFile(path.join(ROOT, 'favicon.svg'), favicon);
await sharp(Buffer.from(favicon.replace('rx="7"', 'rx="0"')), { density: 600 })
  .resize(180, 180)
  .png()
  .toFile(path.join(ROOT, 'apple-touch-icon.png'));

console.log('done');
