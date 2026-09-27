// Boot: film or reading mode, sound, section highlighting, and the
// Bugle's live dateline. The inline script in <head> has already chosen
// a mode; if this module never runs, the page falls back to reading.

import { Film } from './film.js';
import { CitySound } from './sound.js';

window.ITN_BOOTED = true;

const root = document.documentElement;
const filmSection = document.getElementById('film');
const bugle = document.getElementById('bugle');
const modeButtons = [...document.querySelectorAll('.js-mode')];
const soundButton = document.querySelector('.js-sound');
const soundLabel = document.querySelector('.js-sound-label');
const canFilm = 'createImageBitmap' in window && 'ResizeObserver' in window;

const sound = new CitySound();
let film = null;

// ── Mode ─────────────────────────────────────────────────────────────

function applyMode(mode) {
  if (mode === 'film' && !canFilm) mode = 'read';
  root.dataset.mode = mode;
  for (const button of modeButtons) {
    button.hidden = !canFilm;
    // Fixed markup only; the tail is hidden in the bar on small screens.
    button.innerHTML = mode === 'film'
      ? 'Read<span class="bar__more"> as text</span>'
      : 'Watch<span class="bar__more"> as film</span>';
  }
  if (mode === 'film') {
    film ??= new Film(filmSection, {
      onAct: (n) => sound.act(n),
      onCue: (name, on) => sound.cue(name, on),
      onSpeed: (v) => sound.speed(v),
    });
    film.start().catch((err) => {
      console.error('[film] could not start, switching to reading mode', err);
      applyMode('read');
    });
  } else {
    film?.stop();
    sound.disable();
    syncSoundButton();
  }
  return mode;
}

function jumpTo(y) {
  const previous = root.style.scrollBehavior;
  root.style.scrollBehavior = 'auto';
  window.scrollTo(0, y);
  root.style.scrollBehavior = previous;
}

/** Switch modes and keep the reader in the same part of the story. */
function switchMode() {
  const next = root.dataset.mode === 'film' ? 'read' : 'film';
  const inBugle = bugle.getBoundingClientRect().top < innerHeight / 2;
  const filmAt = film && next === 'read' ? film.scrollProgress() : 0;
  const act = next === 'read' ? (film?.actAt(filmAt) ?? 0) : actInView();
  const pastOpening = next === 'read' ? filmAt > 0.05 : scrollY > innerHeight * 0.6;

  try {
    localStorage.setItem('itn:mode', next);
  } catch (e) {
    /* storage blocked: the choice lasts for this page view only */
  }
  applyMode(next);

  requestAnimationFrame(() => {
    if (inBugle) jumpTo(bugle.getBoundingClientRect().top + scrollY);
    else if (!pastOpening) jumpTo(0);
    else if (next === 'read') jumpTo(document.getElementById(`act-${act + 1}`).getBoundingClientRect().top + scrollY);
    else film.seekToAct(act);
  });
}

/** In reading mode: which act heading is nearest the top of the screen. */
function actInView() {
  let current = 0;
  document.querySelectorAll('.act').forEach((el, k) => {
    if (el.getBoundingClientRect().top < innerHeight * 0.5) current = k;
  });
  return current;
}

for (const button of modeButtons) button.addEventListener('click', switchMode);

// ── Sound ────────────────────────────────────────────────────────────

function syncSoundButton() {
  soundButton.setAttribute('aria-pressed', String(sound.on));
  soundLabel.textContent = sound.on ? 'Sound on' : 'Sound off';
}

if (sound.supported) {
  soundButton.addEventListener('click', async () => {
    if (sound.on) sound.disable();
    else {
      await sound.enable();
      if (film) sound.act(film.currentAct);
    }
    syncSoundButton();
  });
} else {
  soundButton.hidden = true;
}

// ── Replay ───────────────────────────────────────────────────────────

document.querySelector('.js-replay').addEventListener('click', () => {
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (root.dataset.mode === 'film' && film) film.seek(0, !calm);
  else window.scrollTo({ top: 0, behavior: calm ? 'auto' : 'smooth' });
});

// ── Current section in the top bar ───────────────────────────────────

const navLinks = new Map(
  [...document.querySelectorAll('.bar__link')].map((a) => [a.getAttribute('href').slice(1), a])
);
const sectionObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      navLinks.get(entry.target.id)?.setAttribute('aria-current', String(entry.isIntersecting));
    }
  },
  { rootMargin: '-50% 0px -50% 0px' }
);
sectionObserver.observe(filmSection);
sectionObserver.observe(bugle);

// ── The Bugle's dateline ─────────────────────────────────────────────

{
  const now = new Date();
  // Amazing Fantasy #15 carries an August 1962 cover date.
  const years = now.getFullYear() - 1962 - (now.getMonth() < 7 ? 1 : 0);
  document.querySelector('.js-date').textContent = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(now);
  document.querySelector('.js-years').textContent = String(years);
  document.querySelector('.js-vol').textContent = roman(years);
}

function roman(n) {
  const table = [[100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let out = '';
  for (const [value, glyph] of table) {
    while (n >= value) {
      out += glyph;
      n -= value;
    }
  }
  return out;
}

// ── Go ───────────────────────────────────────────────────────────────

applyMode(root.dataset.mode === 'film' ? 'film' : 'read');
