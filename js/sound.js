// Generative city sound, built with the Web Audio API when the viewer turns
// sound on. Nothing is downloaded.
//
//   bed    low city rumble (brown noise) and distant traffic hiss
//   wind   band-passed noise that rises with scroll speed
//   siren  a distant two-tone wail with an echo off the buildings,
//          on the line where the siren turns the corner
//   sense  a faint beating tone under the spider-sense line
//   drone  a low fifth under Act III
//
// In Act II the bed runs through a lower filter: inside the lens, the
// city is muffled.

const BED_LEVEL = 0.5;

export class CitySound {
  constructor() {
    this.ctx = null;
    this.on = false;
    this.actIndex = 0;
    this.lastSiren = -Infinity;
    this.onVisibility = this.onVisibility.bind(this);
  }

  get supported() {
    return Boolean(window.AudioContext || window.webkitAudioContext);
  }

  async enable() {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return false;
    if (!this.ctx) this.build(new Context());
    await this.ctx.resume();
    this.on = true;
    this.ramp(this.master.gain, 0.9, 1.2);
    this.act(this.actIndex);
    document.addEventListener('visibilitychange', this.onVisibility);
    return true;
  }

  disable() {
    if (!this.ctx || !this.on) {
      this.on = false;
      return;
    }
    this.on = false;
    this.ramp(this.master.gain, 0, 0.5);
    this.windGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1);
    clearTimeout(this.suspendTimer);
    this.suspendTimer = setTimeout(() => {
      if (!this.on) this.ctx.suspend();
    }, 700);
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  /** Scroll speed, 0..1. */
  speed(v) {
    if (!this.on) return;
    const t = this.ctx.currentTime;
    this.windGain.gain.setTargetAtTime(v * 0.16, t, 0.12);
    this.windFilter.frequency.setTargetAtTime(480 + v * 1400, t, 0.2);
  }

  act(index) {
    this.actIndex = index;
    if (!this.on) return;
    const t = this.ctx.currentTime;
    this.bedFilter.frequency.setTargetAtTime(index === 1 ? 170 : 340, t, 0.8);
    this.droneGain.gain.setTargetAtTime(index === 2 ? 0.055 : 0, t, 1.5);
  }

  /** A narration cue starting (on) or ending (off). */
  cue(name, on) {
    if (!this.on) return;
    const t = this.ctx.currentTime;
    if (name === 'siren' && on && t - this.lastSiren > 20) {
      this.lastSiren = t;
      this.siren();
    } else if (name === 'sense' && on) {
      this.sense();
    } else if (name === 'fin') {
      this.bedGain.gain.setTargetAtTime(on ? BED_LEVEL * 0.35 : BED_LEVEL, t, on ? 1.4 : 0.6);
      // Scrolling back up out of the end card returns to Act III's drone.
      this.droneGain.gain.setTargetAtTime(on || this.actIndex !== 2 ? 0 : 0.055, t, on ? 1.2 : 1.5);
    }
  }

  // ── graph ──────────────────────────────────────────────────────────

  build(ctx) {
    this.ctx = ctx;

    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.ratio.value = 3;
    compressor.connect(ctx.destination);

    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(compressor);

    const brown = noise(ctx, 8, 'brown');
    const white = noise(ctx, 4, 'white');

    // Bed: rumble
    this.bedFilter = filter(ctx, 'lowpass', 340, 0.5);
    this.bedGain = gain(ctx, BED_LEVEL);
    loop(ctx, brown).connect(this.bedFilter).connect(this.bedGain).connect(this.master);

    // Bed: traffic hiss that breathes slowly
    const hissGain = gain(ctx, 0.016);
    loop(ctx, white, 0.5).connect(filter(ctx, 'bandpass', 1100, 0.6)).connect(hissGain).connect(this.master);
    const breath = ctx.createOscillator();
    breath.frequency.value = 0.06;
    breath.connect(gain(ctx, 0.008)).connect(hissGain.gain);
    breath.start();

    // Wind, driven by scroll speed
    this.windFilter = filter(ctx, 'bandpass', 480, 1.1);
    this.windGain = gain(ctx, 0);
    loop(ctx, white, 0.73).connect(this.windFilter).connect(this.windGain).connect(this.master);

    // Drone
    this.droneGain = gain(ctx, 0);
    const droneFilter = filter(ctx, 'lowpass', 300, 0.7);
    droneFilter.connect(this.droneGain).connect(this.master);
    for (const f of [55, 82.41]) {
      const osc = ctx.createOscillator();
      osc.frequency.value = f;
      osc.connect(droneFilter);
      osc.start();
    }

    // Echo bus: a damped feedback delay, like a sound bouncing down an avenue
    this.echo = gain(ctx, 1);
    const delay = ctx.createDelay(1);
    delay.delayTime.value = 0.27;
    const damp = filter(ctx, 'lowpass', 1400, 0.7);
    const feedback = gain(ctx, 0.38);
    this.echo.connect(delay).connect(damp);
    damp.connect(feedback).connect(delay);
    damp.connect(gain(ctx, 0.5)).connect(this.master);
  }

  siren() {
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.05;
    const length = 9.6;

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(640, t);
    for (let k = 0; k < 4; k++) {
      osc.frequency.linearRampToValueAtTime(1220, t + k * 2.4 + 1.2);
      osc.frequency.linearRampToValueAtTime(640, t + k * 2.4 + 2.4);
    }

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.045, t + 2.5);
    env.gain.setValueAtTime(0.045, t + 6.4);
    env.gain.linearRampToValueAtTime(0, t + length);

    const out = pan(ctx, -0.7, 0.5, t, length);
    osc.connect(filter(ctx, 'lowpass', 1600, 0.7)).connect(env).connect(out);
    out.connect(this.master);
    out.connect(this.echo);
    osc.start(t);
    osc.stop(t + length + 0.1);
  }

  sense() {
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.05;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.018, t + 0.9);
    env.gain.setValueAtTime(0.018, t + 1.6);
    env.gain.linearRampToValueAtTime(0, t + 3.4);
    env.connect(this.master);
    // Two tones 6.5 Hz apart beat against each other: a tremble, not a note.
    for (const [f, level] of [[1318.5, 1], [1325, 1], [1977, 0.35]]) {
      const osc = ctx.createOscillator();
      osc.frequency.value = f;
      osc.connect(gain(ctx, level)).connect(env);
      osc.start(t);
      osc.stop(t + 3.5);
    }
  }

  ramp(param, value, seconds) {
    const t = this.ctx.currentTime;
    param.cancelScheduledValues(t);
    param.setValueAtTime(param.value, t);
    param.linearRampToValueAtTime(value, t + seconds);
  }

  onVisibility() {
    if (!this.ctx) return;
    if (document.hidden) this.ctx.suspend();
    else if (this.on) this.ctx.resume();
  }
}

// ── helpers ──────────────────────────────────────────────────────────

function gain(ctx, value) {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
}

function filter(ctx, type, frequency, q) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = frequency;
  f.Q.value = q;
  return f;
}

function loop(ctx, buffer, rate = 1) {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  src.playbackRate.value = rate;
  src.start();
  return src;
}

function pan(ctx, from, to, t, seconds) {
  if (!ctx.createStereoPanner) return gain(ctx, 1);
  const p = ctx.createStereoPanner();
  p.pan.setValueAtTime(from, t);
  p.pan.linearRampToValueAtTime(to, t + seconds);
  return p;
}

/** Loopable noise. The first `fade` samples are cross-faded with the
 *  samples just past the end, so the loop point does not click. */
function noise(ctx, seconds, color) {
  const rate = ctx.sampleRate;
  const length = Math.floor(rate * seconds);
  const fade = Math.floor(rate * 0.05);
  const raw = new Float32Array(length + fade);
  let last = 0;
  for (let i = 0; i < raw.length; i++) {
    const white = Math.random() * 2 - 1;
    if (color === 'brown') {
      last = (last + 0.02 * white) / 1.02;
      raw[i] = last * 3.5;
    } else {
      raw[i] = white * 0.5;
    }
  }
  const buffer = ctx.createBuffer(1, length, rate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    if (i < fade) {
      const t = i / fade;
      data[i] = raw[i] * t + raw[length + i] * (1 - t);
    } else {
      data[i] = raw[i];
    }
  }
  return buffer;
}
