// Plays the film by scroll position.
//
// The .film section is a tall runway and its .stage sticks to the viewport.
// Scroll position becomes s (0..1). s is eased toward the scroll target
// every animation frame, then:
//   frame  = remap(s)          piecewise-linear, from data-remap on .film,
//                              so footage slows where there is text to read
//   cues   = [data-cue="a b"]  shown while a <= s < b
//   HUD    = timecode, frame counter, reel playhead, current act
// Nothing runs while the scroll position is still.

import { FrameStore } from './frames.js';

const FPS = 24;
const FRAME_SETS = {
  d: { w: 1600, h: 900 },  // landscape
  m: { w: 608, h: 1080 },  // portrait, cropped around the subject
};
const EASE_MS = 120;       // how quickly the picture catches up with the scroll
const SPEED_FOR_FULL_WIND = 0.35; // s per second that counts as "fast"

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const pad = (n, width = 2) => String(n).padStart(width, '0');
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const ROMAN = ['I', 'II', 'III', 'IV', 'V'];

export class Film {
  constructor(section, { onAct, onCue, onSpeed } = {}) {
    this.section = section;
    this.stage = section.querySelector('.stage');
    this.canvas = section.querySelector('.stage__canvas');
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.count = Number(section.dataset.frames);
    this.remap = section.dataset.remap
      .trim()
      .split(/\s+/)
      .map((pair) => pair.split(':').map(Number));

    this.cues = [...section.querySelectorAll('[data-cue]')].map((el) => {
      const [a, b] = el.dataset.cue.split(' ').map(Number);
      return { el, a, b, on: false, sound: el.dataset.sound, link: el.querySelector('a') };
    });
    this.acts = [...section.querySelectorAll('.act')].map((el) => {
      const [a, b] = el.dataset.span.split(' ').map(Number);
      return { el, a, b, slug: el.querySelector('.act__slug')?.textContent.trim() ?? '' };
    });

    this.hud = {
      slug: section.querySelector('.js-slug'),
      tc: section.querySelector('.js-tc'),
      fr: section.querySelector('.js-fr'),
      track: section.querySelector('.js-track'),
      buffer: section.querySelector('.reel__buffer'),
      actButtons: [...section.querySelectorAll('[data-seek]')],
    };
    this.hud.buffer.width = 480;
    this.bufferCtx = this.hud.buffer.getContext('2d');

    this.onAct = onAct;
    this.onCue = onCue;
    this.onSpeed = onSpeed;

    this.s = 0;
    this.target = 0;
    this.dir = 1;
    this.speed = 0;
    this.shownFrame = -1;
    this.drawnFrame = -1;
    this.currentAct = 0;
    this.raf = 0;
    this.last = 0;
    this.running = false;
    this.rolling = false;
    this.dragging = false;

    this.tick = this.tick.bind(this);
    this.onScroll = this.onScroll.bind(this);
    this.onResize = this.onResize.bind(this);
    this.onKey = this.onKey.bind(this);
    this.onPointerDown = this.onPointerDown.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerUp = this.onPointerUp.bind(this);
    this.onActButton = this.onActButton.bind(this);
  }

  // ── lifecycle ──────────────────────────────────────────────────────

  async start() {
    if (this.running) return;
    this.running = true;
    this.resetCues();

    this.resizeObserver = new ResizeObserver(this.onResize);
    this.resizeObserver.observe(this.section);
    this.resizeObserver.observe(this.canvas);
    addEventListener('scroll', this.onScroll, { passive: true });
    const { track, actButtons } = this.hud;
    track.addEventListener('keydown', this.onKey);
    track.addEventListener('pointerdown', this.onPointerDown);
    track.addEventListener('pointermove', this.onPointerMove);
    track.addEventListener('pointerup', this.onPointerUp);
    track.addEventListener('pointercancel', this.onPointerUp);
    for (const b of actButtons) b.addEventListener('click', this.onActButton);

    this.layout();
    this.s = this.target = this.scrollProgress();
    const first = Math.round(this.frameAt(this.s));

    // Wait for the first picture, and briefly for the fonts, so the
    // opening title does its one reveal with the right typeface.
    const fonts = document.fonts ? document.fonts.ready : Promise.resolve();
    await Promise.all([
      this.store.prime(first),
      Promise.race([fonts, new Promise((r) => setTimeout(r, 1200))]),
    ]);
    if (!this.running) return;

    this.rolling = true;
    this.section.classList.add('is-rolling');
    this.store.start();
    this.render(true);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this.rolling = false;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.resizeObserver?.disconnect();
    removeEventListener('scroll', this.onScroll);
    const { track, actButtons } = this.hud;
    track.removeEventListener('keydown', this.onKey);
    track.removeEventListener('pointerdown', this.onPointerDown);
    track.removeEventListener('pointermove', this.onPointerMove);
    track.removeEventListener('pointerup', this.onPointerUp);
    track.removeEventListener('pointercancel', this.onPointerUp);
    for (const b of actButtons) b.removeEventListener('click', this.onActButton);

    this.store?.destroy();
    this.store = null;
    this.set = null;
    this.drawnFrame = -1;
    this.shownFrame = -1;
    this.section.classList.remove('is-rolling');
    this.stage.classList.remove('is-ending');
    this.stage.style.removeProperty('--open');
    this.resetCues();
    // Reading mode shows every cue as plain text, so its links are reachable again.
    for (const cue of this.cues) cue.link?.removeAttribute('tabindex');
    this.onSpeed?.(0);
  }

  // ── scroll → progress ──────────────────────────────────────────────

  layout() {
    const rect = this.section.getBoundingClientRect();
    this.top = rect.top + scrollY;
    this.length = Math.max(1, this.section.offsetHeight - this.stage.offsetHeight);
    this.sizeCanvas();
  }

  scrollProgress() {
    return clamp((scrollY - this.top) / this.length, 0, 1);
  }

  onScroll() {
    this.target = this.scrollProgress();
    this.kick();
  }

  onResize() {
    if (!this.running) return;
    this.layout();
    this.target = this.scrollProgress();
    this.drawnFrame = -1;
    this.kick();
  }

  kick() {
    if (!this.raf && this.running) {
      this.last = performance.now();
      this.raf = requestAnimationFrame(this.tick);
    }
  }

  tick(now) {
    const dt = clamp(now - this.last, 1, 100);
    this.last = now;
    const before = this.s;
    this.s += (this.target - this.s) * (1 - Math.exp(-dt / EASE_MS));
    if (Math.abs(this.target - this.s) < 1e-4) this.s = this.target;
    if (this.s !== before) this.dir = this.s > before ? 1 : -1;

    const instant = Math.abs(this.s - before) / (dt / 1000);
    this.speed += (instant - this.speed) * (1 - Math.exp(-dt / 250));
    const settled = this.s === this.target && this.speed < 0.003;
    if (settled) this.speed = 0;
    this.onSpeed?.(Math.min(1, this.speed / SPEED_FOR_FULL_WIND));

    this.render();
    this.raf = settled ? 0 : requestAnimationFrame(this.tick);
  }

  // ── time remapping ─────────────────────────────────────────────────

  frameAt(s) {
    const r = this.remap;
    for (let k = 1; k < r.length; k++) {
      const [s0, f0] = r[k - 1];
      const [s1, f1] = r[k];
      if (s <= s1) return f0 + (f1 - f0) * clamp((s - s0) / (s1 - s0), 0, 1);
    }
    return r[r.length - 1][1];
  }

  progressAt(frame) {
    const r = this.remap;
    for (let k = 1; k < r.length; k++) {
      const [s0, f0] = r[k - 1];
      const [s1, f1] = r[k];
      if (f1 > f0 && frame <= f1) return s0 + (s1 - s0) * clamp((frame - f0) / (f1 - f0), 0, 1);
    }
    return 1;
  }

  // ── drawing ────────────────────────────────────────────────────────

  sizeCanvas() {
    const box = this.canvas.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(box.width * dpr);
    const h = Math.round(box.height * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.drawnFrame = -1;
    }
    this.chooseFrameSet(box.width / box.height);
  }

  chooseFrameSet(aspect) {
    const set = aspect < 0.9 ? 'm' : 'd';
    if (set === this.set) return;
    this.store?.destroy();
    this.set = set;
    this.drawnFrame = -1;
    const { w, h } = FRAME_SETS[set];
    this.store = new FrameStore({
      count: this.count,
      url: (i) => `frames/v1/${set}/${pad(i + 1, 3)}.webp`,
      pixels: w * h,
      onLoad: (i) => this.paintBuffer(i),
      onDecode: (i) => {
        const want = Math.round(this.frameAt(this.s));
        if (this.drawnFrame < 0 || Math.abs(i - want) < Math.abs(this.drawnFrame - want)) this.kick();
      },
    });
    this.bufferCtx.clearRect(0, 0, this.hud.buffer.width, 1);
    if (this.rolling) {
      const first = Math.round(this.frameAt(this.s));
      this.store.prime(first).then(() => this.render(true));
      this.store.start();
    }
  }

  draw(bitmap) {
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const scale = Math.max(cw / bitmap.width, ch / bitmap.height);
    const w = bitmap.width * scale;
    const h = bitmap.height * scale;
    this.ctx.drawImage(bitmap, (cw - w) / 2, (ch - h) / 2, w, h);
  }

  /** Draw frame i, or the closest decoded frame if i is not ready yet. */
  show(i) {
    if (!this.store) return;
    const exact = this.store.get(i);
    if (exact) {
      if (this.drawnFrame !== i) {
        this.draw(exact);
        this.drawnFrame = i;
      }
      return;
    }
    const near = this.store.nearest(i);
    if (near && (this.drawnFrame < 0 || Math.abs(near.i - i) < Math.abs(this.drawnFrame - i))) {
      this.draw(near.bitmap);
      this.drawnFrame = near.i;
    }
  }

  paintBuffer(i) {
    const W = this.hud.buffer.width;
    const x0 = Math.floor(this.progressAt(i - 0.5) * W);
    const x1 = Math.ceil(this.progressAt(i + 0.5) * W);
    this.bufferCtx.fillStyle = 'rgba(243, 239, 230, 0.4)';
    this.bufferCtx.fillRect(x0, 0, Math.max(1, x1 - x0), 1);
  }

  // ── per-frame render ───────────────────────────────────────────────

  render(force = false) {
    if (!this.store) return;
    const s = this.s;
    const frame = clamp(Math.round(this.frameAt(s)), 0, this.count - 1);

    this.store.want(frame, this.dir);
    this.show(frame);

    this.stage.style.setProperty('--open', (1 - smoothstep(0.004, 0.045, s)).toFixed(3));
    this.hud.track.style.setProperty('--p', s.toFixed(4));
    this.stage.classList.toggle('is-ending', s > 0.97);

    for (const cue of this.cues) {
      const on = s >= cue.a && s < cue.b;
      if (on === cue.on) continue;
      cue.on = on;
      cue.el.classList.toggle('is-on', on);
      if (cue.link) cue.link.tabIndex = on ? 0 : -1;
      if (cue.sound) this.onCue?.(cue.sound, on);
    }

    const act = this.actAt(s);
    if (act !== this.currentAct || force) {
      this.currentAct = act;
      this.hud.slug.textContent = this.acts[act].slug;
      this.hud.actButtons.forEach((b, k) => b.setAttribute('aria-current', String(k === act)));
      this.onAct?.(act);
    }

    if (frame !== this.shownFrame || force) {
      this.shownFrame = frame;
      const seconds = Math.floor(frame / FPS);
      this.hud.tc.textContent = `00:00:${pad(seconds)}:${pad(frame % FPS)}`;
      this.hud.fr.textContent = pad(frame + 1, 3);
      const t = this.hud.track;
      t.setAttribute('aria-valuenow', String(frame + 1));
      t.setAttribute('aria-valuetext', `Frame ${frame + 1} of ${this.count}, Act ${ROMAN[act]}`);
    }
  }

  actAt(s) {
    let act = 0;
    for (let k = 0; k < this.acts.length; k++) if (s >= this.acts[k].a) act = k;
    return act;
  }

  resetCues() {
    for (const cue of this.cues) {
      cue.on = false;
      cue.el.classList.remove('is-on');
      if (cue.link) cue.link.tabIndex = -1;
    }
  }

  // ── seeking ────────────────────────────────────────────────────────

  seek(s, smooth) {
    const y = this.top + clamp(s, 0, 1) * this.length;
    const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (smooth && !calm) {
      window.scrollTo({ top: y, behavior: 'smooth' });
      return;
    }
    const root = document.documentElement;
    const previous = root.style.scrollBehavior;
    root.style.scrollBehavior = 'auto';
    window.scrollTo(0, y);
    root.style.scrollBehavior = previous;
  }

  seekToAct(k) {
    this.seek(Number(this.hud.actButtons[k]?.dataset.seek ?? 0), false);
  }

  onActButton(e) {
    this.seek(Number(e.currentTarget.dataset.seek), true);
  }

  onKey(e) {
    const steps = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 };
    const starts = this.hud.actButtons.map((b) => Number(b.dataset.seek));
    let s = null;
    if (e.key in steps) s = this.target + steps[e.key] * (e.shiftKey ? 0.04 : 0.004);
    else if (e.key === 'Home') s = 0;
    else if (e.key === 'End') s = 1;
    else if (e.key === 'PageDown') s = starts.find((a) => a > this.target + 0.001) ?? 1;
    else if (e.key === 'PageUp') s = [...starts].reverse().find((a) => a < this.target - 0.001) ?? 0;
    if (s === null) return;
    e.preventDefault();
    this.seek(s, false);
  }

  onPointerDown(e) {
    if (e.button !== 0) return;
    this.dragging = true;
    this.hud.track.setPointerCapture(e.pointerId);
    this.seekToPointer(e);
  }

  onPointerMove(e) {
    if (this.dragging) this.seekToPointer(e);
  }

  onPointerUp() {
    this.dragging = false;
  }

  seekToPointer(e) {
    const r = this.hud.track.getBoundingClientRect();
    this.seek((e.clientX - r.left) / r.width, false);
  }
}
