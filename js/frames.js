// Loads the film's frames and keeps a small window of them decoded.
//
// Every compressed WebP is fetched and kept as a Blob (about 24 MB for the
// landscape set, 11 MB for portrait). Decoding is the expensive part: one
// 1600x900 ImageBitmap holds 5.8 MB of pixels, so only the frames around
// the playhead stay decoded and the rest are closed as the playhead moves.

const CONCURRENCY = 6;
const KEY_STRIDE = 8;
const MAX_TRIES = 5;       // retried after 1, 2, 4 and 8 seconds

export class FrameStore {
  /**
   * @param {object} o
   * @param {number} o.count         number of frames
   * @param {(i: number) => string} o.url
   * @param {number} o.pixels        width * height of one frame
   * @param {(i: number) => void} [o.onLoad]    a frame's bytes arrived
   * @param {(i: number) => void} [o.onDecode]  a frame is ready to draw
   */
  constructor({ count, url, pixels, onLoad, onDecode }) {
    this.count = count;
    this.url = url;
    this.onLoad = onLoad;
    this.onDecode = onDecode;

    this.blobs = new Array(count);
    this.state = new Uint8Array(count); // 0 idle, 1 fetching, 2 loaded, 3 failed
    this.tries = new Uint8Array(count);
    this.bitmaps = new Map();
    this.decoding = new Set();

    this.focus = 0;
    this.dir = 1;
    this.inFlight = 0;
    this.closed = false;
    this.pumping = false;
    this.abort = new AbortController();
    this.onOnline = this.onOnline.bind(this);
    addEventListener('online', this.onOnline);

    const lowMemory = navigator.deviceMemory !== undefined && navigator.deviceMemory <= 4;
    const budget = (lowMemory ? 96 : 160) * 1024 * 1024;
    this.maxBitmaps = Math.max(12, Math.min(60, Math.floor(budget / (pixels * 4))));
    this.ahead = Math.min(12, this.maxBitmaps - 6);
    this.behind = 4;
  }

  /** Fetch and decode one frame before anything else (the first picture). */
  async prime(i) {
    this.focus = i;
    await this.fetch(i);
    return this.decode(i);
  }

  /** Start background loading of every remaining frame. */
  start() {
    this.pumping = true;
    this.pump();
  }

  /** The frame on screen and the scroll direction; steers loading and decoding. */
  want(i, dir) {
    this.focus = i;
    if (dir) this.dir = dir;
    for (let k = 0; k <= this.ahead; k++) this.decode(i + this.dir * k);
    for (let k = 1; k <= this.behind; k++) this.decode(i - this.dir * k);
    if (this.pumping) this.pump();
  }

  get(i) {
    return this.bitmaps.get(i);
  }

  /** Closest decoded frame to i, as { i, bitmap }, or null. */
  nearest(i) {
    let best = null;
    let bestDistance = Infinity;
    for (const [k, bitmap] of this.bitmaps) {
      const d = Math.abs(k - i);
      if (d < bestDistance) {
        bestDistance = d;
        best = { i: k, bitmap };
      }
    }
    return best;
  }

  isLoaded(i) {
    return this.state[i] === 2;
  }

  destroy() {
    this.closed = true;
    removeEventListener('online', this.onOnline);
    this.abort.abort();
    for (const bitmap of this.bitmaps.values()) bitmap.close();
    this.bitmaps.clear();
    this.blobs.fill(undefined);
  }

  // ── internals ──────────────────────────────────────────────────────

  pump() {
    while (!this.closed && this.inFlight < CONCURRENCY) {
      const i = this.next();
      if (i < 0) return;
      this.fetch(i).then(() => this.pump());
    }
  }

  /** Loading order: just ahead of the playhead, then an even spread over
   *  the whole film so a jump always lands near something, then the rest. */
  next() {
    for (let k = 0; k < 24; k++) {
      const i = this.focus + this.dir * k;
      if (this.idle(i)) return i;
    }
    for (let k = 1; k < 8; k++) {
      const i = this.focus - this.dir * k;
      if (this.idle(i)) return i;
    }
    for (let i = 0; i < this.count; i += KEY_STRIDE) {
      if (this.idle(i)) return i;
    }
    for (let k = 1; k < this.count; k++) {
      if (this.idle(this.focus + k)) return this.focus + k;
      if (this.idle(this.focus - k)) return this.focus - k;
    }
    return -1;
  }

  idle(i) {
    return i >= 0 && i < this.count && this.state[i] === 0;
  }

  async fetch(i) {
    this.state[i] = 1;
    this.inFlight++;
    try {
      const res = await fetch(this.url(i), { signal: this.abort.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      if (this.closed) return;
      this.blobs[i] = blob;
      this.state[i] = 2;
      this.onLoad?.(i);
      if (Math.abs(i - this.focus) <= this.ahead) this.decode(i);
    } catch (err) {
      if (this.closed) return;
      this.state[i] = 3;
      this.tries[i]++;
      if (this.tries[i] < MAX_TRIES) {
        setTimeout(() => this.retry(i), 1000 * 2 ** (this.tries[i] - 1));
      } else {
        console.warn(`[film] frame ${i + 1} failed to load`, err);
      }
    } finally {
      this.inFlight--;
    }
  }

  retry(i) {
    if (this.closed || this.state[i] !== 3) return;
    this.state[i] = 0;
    if (this.pumping) this.pump();
  }

  /** Back online: give every frame that gave up another full set of tries. */
  onOnline() {
    for (let i = 0; i < this.count; i++) {
      if (this.state[i] === 3 && this.tries[i] >= MAX_TRIES) {
        this.tries[i] = 0;
        this.state[i] = 0;
      }
    }
    if (this.pumping) this.pump();
  }

  decode(i) {
    if (this.closed || this.state[i] !== 2 || this.bitmaps.has(i) || this.decoding.has(i)) {
      return Promise.resolve(this.bitmaps.get(i) ?? null);
    }
    this.decoding.add(i);
    return createImageBitmap(this.blobs[i]).then(
      (bitmap) => {
        this.decoding.delete(i);
        if (this.closed) {
          bitmap.close();
          return null;
        }
        this.bitmaps.set(i, bitmap);
        this.evict();
        if (!this.bitmaps.has(i)) return null;
        this.onDecode?.(i);
        return bitmap;
      },
      () => {
        this.decoding.delete(i);
        return null;
      }
    );
  }

  /** Close the decoded frames furthest from the playhead until within budget. */
  evict() {
    while (this.bitmaps.size > this.maxBitmaps) {
      let far = -1;
      let farDistance = -1;
      for (const k of this.bitmaps.keys()) {
        const d = Math.abs(k - this.focus);
        if (d > farDistance) {
          farDistance = d;
          far = k;
        }
      }
      this.bitmaps.get(far).close();
      this.bitmaps.delete(far);
    }
  }
}
