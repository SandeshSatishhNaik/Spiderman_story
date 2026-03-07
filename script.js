/* ═══════════════════════════════════════════════════════════════════════
   SPIDER-MAN: INTO THE NIGHT — Core Animation Engine v2
   ═══════════════════════════════════════════════════════════════════════
   Architecture:
     1. Preloader        — Batched image caching with progress radar.
     2. Canvas Engine    — Draws frames with "cover" math + retina DPR.
     3. Scroll Binding   — GSAP ScrollTrigger maps scroll→frame (0→239).
     4. Panel System     — data-appear/data-disappear drive opacity per
                           scroll progress. Cards slide up with 3D tilt.
     5. Web Particles    — Separate canvas with floating connected dots
                           that react to the mouse cursor (spider-web).
     6. Mouse Tracker    — Sets CSS custom properties (--mouse-x/y) for
                           reactive elements. Drives the follower blob.
     7. 3D Card Tilt     — Cards rotate toward the cursor on hover,
                           with a glare highlight that follows the mouse.
     8. Magnetic Buttons — Buttons subtly shift toward the cursor when
                           hovered, creating a "pull" feel.
     9. Counter Anim     — Stats section numbers count up with GSAP
                           when scrolled into view.
    10. Scroll Progress  — Thin red bar at top shows page progress.
    11. Nav State        — Compact nav on scroll.
   ═══════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ════════════════════════════════════════════════════════════════════
  // CONFIGURATION
  // ════════════════════════════════════════════════════════════════════

  const FRAME_COUNT       = 240;
  const FRAME_PATH        = (i) => `images/ezgif-frame-${String(i).padStart(3, '0')}.png`;
  const SCROLL_PAGES      = 8;     // viewport-heights to scrub all 240 frames
  const SCRUB_SMOOTHNESS  = 0.5;   // GSAP scrub catch-up duration (seconds)
  const PRELOAD_BATCH     = 6;     // concurrent image loads per batch
  const FAST_LOAD_COUNT   = 5;     // frames to load before revealing site
  const KEYFRAME_STEP     = 10;    // priority: load every Nth frame after reveal

  // Particle web config
  const PARTICLE_COUNT    = 60;
  const PARTICLE_CONNECT  = 120;   // max distance (px) to draw thread between particles
  const PARTICLE_SPEED    = 0.25;


  // ════════════════════════════════════════════════════════════════════
  // DOM REFERENCES
  // ════════════════════════════════════════════════════════════════════

  const loader         = document.getElementById('loader');
  const loaderBar      = document.getElementById('loaderBar');
  const loaderPercent  = document.getElementById('loaderPercent');
  const site           = document.getElementById('site');
  const canvas         = document.getElementById('heroCanvas');
  const ctx            = canvas.getContext('2d', { desynchronized: true });
  const heroTitle      = document.getElementById('heroTitle');
  const restartBtn     = document.getElementById('restartBtn');
  const navHamburger   = document.getElementById('navHamburger');
  const navLinks       = document.querySelector('.nav__links');
  const navEl          = document.getElementById('nav');
  const scrollProgress = document.getElementById('scrollProgress');
  const mouseFollower  = document.getElementById('mouseFollower');
  const particleCanvas = document.getElementById('webParticles');
  const pCtx           = particleCanvas.getContext('2d');


  // ════════════════════════════════════════════════════════════════════
  // STATE
  // ════════════════════════════════════════════════════════════════════

  const frames      = [];
  let currentFrame  = 0;
  let canvasW       = 0;
  let canvasH       = 0;

  // Global mouse position (updated every frame via rAF)
  let mouseX = -1000;
  let mouseY = -1000;


  // ════════════════════════════════════════════════════════════════════
  // 1. IMAGE PRELOADER (createImageBitmap + Priority Loading)
  // ════════════════════════════════════════════════════════════════════
  /**
   * Uses fetch + createImageBitmap to decode images OFF the main thread.
   * ImageBitmap draws faster on canvas than HTMLImageElement because
   * decoding is already done. Falls back to Image() for older browsers.
   */
  const hasBitmapSupport = typeof createImageBitmap === 'function';

  function loadFrame(index) {
    const url = FRAME_PATH(index);

    if (hasBitmapSupport) {
      return fetch(url)
        .then((r) => r.blob())
        .then((blob) => createImageBitmap(blob))
        .catch(() => {
          console.warn(`[Preloader] Frame ${index} failed.`);
          return null;
        });
    }

    // Fallback for browsers without createImageBitmap
    return new Promise((resolve) => {
      const img = new Image();
      img.src = url;
      img.onload = () => resolve(img);
      img.onerror = () => { console.warn(`[Preloader] Frame ${index} failed.`); resolve(null); };
    });
  }

  function updateLoaderUI(loaded, total) {
    const pct = Math.round((loaded / total) * 100);
    loaderBar.style.width = pct + '%';
    loaderPercent.textContent = pct + '%';
    loader.setAttribute('aria-valuenow', pct);
  }

  /** Phase 1: load first FAST_LOAD_COUNT frames for instant reveal */
  async function preloadInitialFrames() {
    let loaded = 0;

    // Load frame 1 first (highest priority — user sees this immediately)
    const first = await loadFrame(1);
    frames[0] = first;
    loaded++;
    updateLoaderUI(loaded, FAST_LOAD_COUNT);

    // Load frames 2..FAST_LOAD_COUNT concurrently
    const batch = [];
    for (let i = 2; i <= FAST_LOAD_COUNT; i++) {
      batch.push(
        loadFrame(i).then((bitmap) => {
          frames[i - 1] = bitmap;
          loaded++;
          updateLoaderUI(loaded, FAST_LOAD_COUNT);
        })
      );
    }
    await Promise.all(batch);
  }

  /**
   * Phase 2: background loading with priority strategy:
   *   a) Keyframes first (every KEYFRAME_STEP-th frame) — so scrolling
   *      to any position hits a nearby loaded frame fast.
   *   b) Fill remaining gaps after all keyframes are loaded.
   */
  function preloadRemainingFrames() {
    (async () => {
      // a) Keyframes: 10, 20, 30, 40 ... 240
      const keyframes = [];
      for (let i = FAST_LOAD_COUNT; i < FRAME_COUNT; i += KEYFRAME_STEP) {
        keyframes.push(i);
      }
      // Also include the last frame
      if (keyframes[keyframes.length - 1] !== FRAME_COUNT - 1) {
        keyframes.push(FRAME_COUNT - 1);
      }

      for (let s = 0; s < keyframes.length; s += PRELOAD_BATCH) {
        const end = Math.min(s + PRELOAD_BATCH, keyframes.length);
        const batch = [];
        for (let b = s; b < end; b++) {
          const idx = keyframes[b];
          batch.push(
            loadFrame(idx + 1).then((bitmap) => { frames[idx] = bitmap; })
          );
        }
        await Promise.all(batch);
      }

      // b) Fill all remaining gaps
      const gaps = [];
      for (let i = FAST_LOAD_COUNT; i < FRAME_COUNT; i++) {
        if (!frames[i]) gaps.push(i);
      }

      for (let s = 0; s < gaps.length; s += PRELOAD_BATCH) {
        const end = Math.min(s + PRELOAD_BATCH, gaps.length);
        const batch = [];
        for (let b = s; b < end; b++) {
          const idx = gaps[b];
          batch.push(
            loadFrame(idx + 1).then((bitmap) => { frames[idx] = bitmap; })
          );
        }
        await Promise.all(batch);
      }
    })();
  }


  // ════════════════════════════════════════════════════════════════════
  // 2. CANVAS RENDERING ENGINE
  // ════════════════════════════════════════════════════════════════════

  /** Sizes the canvas to viewport * DPR for retina sharpness. */
  function sizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvasW = window.innerWidth;
    canvasH = window.innerHeight;
    canvas.width  = canvasW * dpr;
    canvas.height = canvasH * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawFrame(currentFrame);
  }

  /**
   * Draws a frame with "object-fit: cover" math.
   * Supports both ImageBitmap (.width) and HTMLImageElement (.naturalWidth).
   * Falls back to nearest loaded frame if requested one isn't ready yet.
   */
  function isReady(f) {
    if (!f) return false;
    return f.width > 0; // works for both ImageBitmap and decoded HTMLImageElement
  }

  function drawFrame(index) {
    let img = frames[index];

    // Fallback: find nearest loaded frame
    if (!isReady(img)) {
      for (let offset = 1; offset <= FRAME_COUNT; offset++) {
        if (isReady(frames[index - offset])) { img = frames[index - offset]; break; }
        if (isReady(frames[index + offset])) { img = frames[index + offset]; break; }
      }
      if (!isReady(img)) return;
    }

    const imgW = img.naturalWidth || img.width;
    const imgH = img.naturalHeight || img.height;
    const scale = Math.max(canvasW / imgW, canvasH / imgH);
    const drawW = imgW * scale;
    const drawH = imgH * scale;
    const offsetX = (canvasW - drawW) / 2;
    const offsetY = (canvasH - drawH) / 2;

    ctx.clearRect(0, 0, canvasW, canvasH);
    ctx.drawImage(img, offsetX, offsetY, drawW, drawH);
  }


  // ════════════════════════════════════════════════════════════════════
  // 3. SCROLL-BOUND ANIMATION (GSAP ScrollTrigger)
  // ════════════════════════════════════════════════════════════════════
  /**
   * SCROLL MATH:
   *   .hero height = SCROLL_PAGES * 100vh (the scroll "runway").
   *   ScrollTrigger progress = 0 (top) → 1 (bottom of hero reaches top).
   *   frame index = round(progress * 239).
   *
   *   scrub: 0.5 = 0.5s catch-up for buttery smoothness.
   *   snap: 'frame' = always whole integers (no flicker).
   *
   *   Scroll DOWN → progress ↑ → frame advances → camera dives.
   *   Scroll UP   → progress ↓ → frame reverses → time rewinds.
   */
  function initScrollAnimation() {
    gsap.registerPlugin(ScrollTrigger);

    // Hero title: fades out immediately on scroll start
    gsap.to(heroTitle, {
      opacity: 0,
      scale: 0.85,
      y: -40,
      ease: 'power2.in',
      scrollTrigger: {
        trigger: '.hero',
        start: 'top top',
        end: '+=500',
        scrub: true,
      },
    });

    // Frame scrubbing
    const frameObj = { frame: 0 };

    gsap.to(frameObj, {
      frame: FRAME_COUNT - 1,
      ease: 'none',
      snap: 'frame',
      scrollTrigger: {
        trigger: '.hero',
        start: 'top top',
        end: () => '+=' + (window.innerHeight * SCROLL_PAGES),
        scrub: SCRUB_SMOOTHNESS,
        pin: false,
        invalidateOnRefresh: true,
        onUpdate: function (self) {
          updatePanelVisibility(self.progress);
        },
      },
      onUpdate: function () {
        const idx = Math.round(frameObj.frame);
        if (idx !== currentFrame) {
          currentFrame = idx;
          drawFrame(currentFrame);
        }
      },
    });
  }


  // ════════════════════════════════════════════════════════════════════
  // 4. STORY PANEL VISIBILITY (Scroll-Progress Driven)
  // ════════════════════════════════════════════════════════════════════

  const storyPanels = [];

  function cachePanels() {
    document.querySelectorAll('.story-panel').forEach((el) => {
      storyPanels.push({
        el,
        card: el.querySelector('.story-card'),
        appear:    parseFloat(el.dataset.appear    || 0),
        disappear: parseFloat(el.dataset.disappear || 1),
      });
    });
  }

  /**
   * For each panel, compute opacity based on scroll progress:
   *   before appear          → 0
   *   appear → appear+fade   → ramp 0→1
   *   plateau                → 1
   *   disappear-fade → disappear → ramp 1→0
   *   after disappear        → 0
   *
   * Also applies a subtle translateY shift proportional to opacity
   * for a parallax-like float effect.
   */
  function updatePanelVisibility(progress) {
    const fadeZone = 0.05;

    storyPanels.forEach(({ el, card, appear, disappear }) => {
      let opacity = 0;

      if (progress < appear) {
        opacity = 0;
      } else if (progress < appear + fadeZone) {
        opacity = (progress - appear) / fadeZone;
      } else if (progress < disappear - fadeZone) {
        opacity = 1;
      } else if (progress < disappear) {
        opacity = 1 - (progress - (disappear - fadeZone)) / fadeZone;
      }

      opacity = Math.max(0, Math.min(1, opacity));
      el.style.opacity = opacity;

      // Subtle parallax float: panels shift up slightly as they fade in
      const panelShift = (1 - opacity) * 30;
      el.style.transform = `translateY(${panelShift}px)`;

      el.classList.toggle('is-active', opacity > 0.1);

      if (opacity > 0.1 && card && !card.classList.contains('is-visible')) {
        card.classList.add('is-visible');
      }
    });
  }


  // ════════════════════════════════════════════════════════════════════
  // 5. WEB PARTICLE SYSTEM (Spider-web threads)
  // ════════════════════════════════════════════════════════════════════
  /**
   * Lightweight particle system on a separate <canvas>.
   * Particles drift slowly; when close enough, a thin line (thread)
   * is drawn between them. Lines also connect to the mouse cursor,
   * creating a reactive "spider-sense web" feel.
   */
  const particles = [];

  function initParticles() {
    // Size the particle canvas to the viewport
    sizeParticleCanvas();

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      particles.push({
        x: Math.random() * particleCanvas.width,
        y: Math.random() * particleCanvas.height,
        vx: (Math.random() - 0.5) * PARTICLE_SPEED,
        vy: (Math.random() - 0.5) * PARTICLE_SPEED,
        r: Math.random() * 1.5 + 0.5,
      });
    }

    animateParticles();
  }

  function sizeParticleCanvas() {
    particleCanvas.width  = window.innerWidth;
    particleCanvas.height = window.innerHeight;
  }

  function animateParticles() {
    const w = particleCanvas.width;
    const h = particleCanvas.height;

    pCtx.clearRect(0, 0, w, h);

    // Update positions
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      p.x += p.vx;
      p.y += p.vy;

      // Bounce off edges
      if (p.x < 0 || p.x > w) p.vx *= -1;
      if (p.y < 0 || p.y > h) p.vy *= -1;

      // Draw particle dot
      pCtx.beginPath();
      pCtx.fillStyle = 'rgba(237, 29, 36, 0.25)';
      pCtx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      pCtx.fill();
    }

    // Draw connections between nearby particles (the "web threads")
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = particles[i].x - particles[j].x;
        const dy = particles[i].y - particles[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < PARTICLE_CONNECT) {
          const alpha = (1 - dist / PARTICLE_CONNECT) * 0.12;
          pCtx.beginPath();
          pCtx.strokeStyle = `rgba(237, 29, 36, ${alpha})`;
          pCtx.lineWidth = 0.5;
          pCtx.moveTo(particles[i].x, particles[i].y);
          pCtx.lineTo(particles[j].x, particles[j].y);
          pCtx.stroke();
        }
      }

      // Mouse connection — threads reach toward the cursor
      if (mouseX > 0 && mouseY > 0) {
        const dx = particles[i].x - mouseX;
        const dy = particles[i].y - mouseY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < PARTICLE_CONNECT * 1.8) {
          const alpha = (1 - dist / (PARTICLE_CONNECT * 1.8)) * 0.3;
          pCtx.beginPath();
          pCtx.strokeStyle = `rgba(237, 29, 36, ${alpha})`;
          pCtx.lineWidth = 0.8;
          pCtx.moveTo(particles[i].x, particles[i].y);
          pCtx.lineTo(mouseX, mouseY);
          pCtx.stroke();
        }
      }
    }

    requestAnimationFrame(animateParticles);
  }


  // ════════════════════════════════════════════════════════════════════
  // 6. MOUSE TRACKER (CSS Custom Properties + Follower Blob)
  // ════════════════════════════════════════════════════════════════════
  /**
   * Tracks mouse position and:
   *   a) Sets --mouse-x, --mouse-y (0→1 normalised)
   *      and --mouse-cx, --mouse-cy (-0.5→0.5 centred)
   *      as CSS custom properties on <html>, so any CSS rule
   *      can react (e.g., hero title parallax shifts).
   *   b) Smoothly moves the .mouse-follower blob toward the cursor
   *      using GSAP's ticker for buttery lerp.
   */
  function initMouseTracker() {
    // Show the follower
    mouseFollower.classList.add('is-active');

    // gsap.quickTo creates a reusable tween — zero GC allocation per frame
    const followerX = gsap.quickTo(mouseFollower, 'x', { duration: 0.4, ease: 'power2.out' });
    const followerY = gsap.quickTo(mouseFollower, 'y', { duration: 0.4, ease: 'power2.out' });

    document.addEventListener('mousemove', (e) => {
      mouseX = e.clientX;
      mouseY = e.clientY;

      // Normalised 0→1
      const nx = mouseX / window.innerWidth;
      const ny = mouseY / window.innerHeight;

      // Centred -0.5→0.5
      document.documentElement.style.setProperty('--mouse-x', nx);
      document.documentElement.style.setProperty('--mouse-y', ny);
      document.documentElement.style.setProperty('--mouse-cx', nx - 0.5);
      document.documentElement.style.setProperty('--mouse-cy', ny - 0.5);

      // Drive follower — just call the quickTo functions
      followerX(mouseX);
      followerY(mouseY);
    });

    document.addEventListener('mouseleave', () => {
      mouseX = -1000;
      mouseY = -1000;
      mouseFollower.classList.remove('is-active');
    });

    document.addEventListener('mouseenter', () => {
      mouseFollower.classList.add('is-active');
    });

    // Intensify follower on interactive elements
    document.querySelectorAll('a, button, .magnetic-btn').forEach((el) => {
      el.addEventListener('mouseenter', () => mouseFollower.classList.add('is-hovering'));
      el.addEventListener('mouseleave', () => mouseFollower.classList.remove('is-hovering'));
    });

    // Per-element mouse-reactive parallax via data-mouse-react="<intensity>"
    initMouseReactiveElements();
  }


  /**
   * Elements with [data-mouse-react] shift subtly in the opposite
   * direction of the cursor, creating a floating parallax feel.
   * The attribute value controls intensity in pixels of max offset.
   */
  function initMouseReactiveElements() {
    const els = gsap.utils.toArray('[data-mouse-react]');
    if (!els.length) return;

    // Pre-create quickTo tweens for each element — zero allocation per frame
    const quickTweens = els.map((el) => ({
      el,
      intensity: parseFloat(el.dataset.mouseReact) || 10,
      qx: gsap.quickTo(el, 'x', { duration: 0.5, ease: 'power2.out' }),
      qy: gsap.quickTo(el, 'y', { duration: 0.5, ease: 'power2.out' }),
    }));

    gsap.ticker.add(() => {
      if (mouseX < 0) return;
      const nx = mouseX / window.innerWidth - 0.5;
      const ny = mouseY / window.innerHeight - 0.5;

      quickTweens.forEach(({ intensity, qx, qy }) => {
        qx(nx * -intensity);
        qy(ny * -intensity);
      });
    });
  }


  // ════════════════════════════════════════════════════════════════════
  // 7. 3D CARD TILT (Mouse-tracking perspective rotation)
  // ════════════════════════════════════════════════════════════════════
  /**
   * For each .tilt-card: on mousemove, compute the cursor's position
   * relative to the card centre, then apply perspective + rotateX/Y.
   * Also sets --glare-x/y for the CSS radial-gradient glare highlight.
   *
   * intensity = degrees of max rotation (default 8).
   */
  function initCardTilt(selector, intensity) {
    intensity = intensity || 8;

    document.querySelectorAll(selector).forEach((card) => {
      card.addEventListener('mousemove', (e) => {
        const rect = card.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const cx = rect.width / 2;
        const cy = rect.height / 2;

        // Normalise to -1..1 then scale by intensity
        const rotX = ((y - cy) / cy) * -intensity;
        const rotY = ((x - cx) / cx) * intensity;

        card.style.transform =
          `perspective(800px) rotateX(${rotX}deg) rotateY(${rotY}deg) translateZ(8px)`;

        // Glare position for CSS ::before radial-gradient
        card.style.setProperty('--glare-x', ((x / rect.width) * 100) + '%');
        card.style.setProperty('--glare-y', ((y / rect.height) * 100) + '%');
      });

      card.addEventListener('mouseleave', () => {
        card.style.transition = 'transform 0.5s cubic-bezier(0.25,0.46,0.45,0.94)';
        card.style.transform = 'perspective(800px) rotateX(0) rotateY(0) translateZ(0)';
      });

      card.addEventListener('mouseenter', () => {
        card.style.transition = 'none'; // Instant response while hovering
      });
    });
  }


  // ════════════════════════════════════════════════════════════════════
  // 8. MAGNETIC BUTTONS (Subtle cursor-pull effect)
  // ════════════════════════════════════════════════════════════════════
  /**
   * On hover, the button shifts toward the cursor by a fraction
   * (strength) of the distance from the button's centre.
   * On leave, it springs back with a smooth transition.
   */
  function initMagneticButtons(selector, strength) {
    strength = strength || 0.3;

    document.querySelectorAll(selector).forEach((btn) => {
      btn.addEventListener('mousemove', (e) => {
        const rect = btn.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const dx = e.clientX - cx;
        const dy = e.clientY - cy;

        btn.style.transform =
          `translate(${dx * strength}px, ${dy * strength}px) scale(1.04)`;
      });

      btn.addEventListener('mouseleave', () => {
        btn.style.transition = 'transform 0.4s cubic-bezier(0.25,0.46,0.45,0.94)';
        btn.style.transform = 'translate(0,0) scale(1)';
      });

      btn.addEventListener('mouseenter', () => {
        btn.style.transition = 'transform 0.12s ease-out';
      });
    });
  }


  // ════════════════════════════════════════════════════════════════════
  // 9. COUNTER ANIMATIONS (Stats section)
  // ════════════════════════════════════════════════════════════════════
  /**
   * Each .counter element has data-target (number) and optional
   * data-suffix (string appended after the number, e.g. "+").
   * GSAP animates a proxy value from 0→target on scroll-triggered entry.
   */
  function initCounters() {
    gsap.utils.toArray('.counter').forEach((counter) => {
      const target = parseInt(counter.dataset.target, 10) || 0;
      const suffix = counter.dataset.suffix || '';
      const obj = { val: 0 };

      gsap.to(obj, {
        val: target,
        duration: 2.5,
        ease: 'power2.out',
        scrollTrigger: {
          trigger: counter,
          start: 'top 85%',
          toggleActions: 'play none none none', // play once on enter
        },
        onUpdate: () => {
          counter.textContent = Math.round(obj.val).toLocaleString() + suffix;
        },
      });
    });
  }


  // ════════════════════════════════════════════════════════════════════
  // 10. SCROLL PROGRESS BAR
  // ════════════════════════════════════════════════════════════════════
  /**
   * Thin bar at the very top of the viewport that grows from 0% → 100%
   * width as the user scrolls through the entire page.
   */
  function initScrollProgress() {
    ScrollTrigger.create({
      trigger: document.body,
      start: 'top top',
      end: 'bottom bottom',
      onUpdate: (self) => {
        scrollProgress.style.width = (self.progress * 100) + '%';
      },
    });
  }


  // ════════════════════════════════════════════════════════════════════
  // 11. NAV SCROLL STATE
  // ════════════════════════════════════════════════════════════════════
  /** Add compact class to nav after scrolling 100px. */
  function initNavScroll() {
    ScrollTrigger.create({
      trigger: document.body,
      start: '100px top',
      onEnter: () => navEl.classList.add('is-scrolled'),
      onLeaveBack: () => navEl.classList.remove('is-scrolled'),
    });
  }


  // ════════════════════════════════════════════════════════════════════
  // 12. INTERSECTION OBSERVER (CTA + Stats entrance)
  // ════════════════════════════════════════════════════════════════════

  function initCardObserver() {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15 }
    );

    document.querySelectorAll('[data-animate]').forEach((card) => {
      if (!card.closest('.story-panel')) {
        observer.observe(card);
      }
    });
  }


  // ════════════════════════════════════════════════════════════════════
  // UTILITIES
  // ════════════════════════════════════════════════════════════════════

  function debounce(fn, ms) {
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  function scrollToTop() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function toggleMobileNav() {
    const isOpen = navLinks.classList.toggle('is-open');
    navHamburger.classList.toggle('is-open', isOpen);
    navHamburger.setAttribute('aria-expanded', isOpen);
  }


  // ════════════════════════════════════════════════════════════════════
  // INITIALISATION SEQUENCE
  // ════════════════════════════════════════════════════════════════════
  /**
   * Boot order:
   *   1.  Lock scroll
   *   2.  Set hero height (scroll runway)
   *   3.  Cache panel references
   *   4.  Preload all 240 frames
   *   5.  Size canvas + draw frame 0
   *   6.  Pause to show "100%"
   *   7.  Dismiss loader, reveal site
   *   8.  Unlock scroll
   *   9.  Init GSAP scroll animation
   *   10. Init panel system + card observer
   *   11. Init web particles
   *   12. Init mouse tracker + follower
   *   13. Init 3D card tilt
   *   14. Init magnetic buttons
   *   15. Init counter animations
   *   16. Init scroll progress bar
   *   17. Init nav scroll state
   *   18. Bind resize, restart, hamburger
   */
  async function init() {
    document.body.style.overflow = 'hidden';

    const hero = document.querySelector('.hero');
    hero.style.height = (SCROLL_PAGES * 100) + 'vh';

    cachePanels();

    try {
      // Phase 1: Load first few frames for instant reveal
      await preloadInitialFrames();

      // Canvas
      sizeCanvas();
      drawFrame(0);

      // Reveal immediately — no artificial delay
      loader.classList.add('loader--done');
      site.classList.remove('site--hidden');
      site.classList.add('site--visible');
      document.body.style.overflow = '';

      // Phase 2: Load remaining frames in background (keyframes first)
      preloadRemainingFrames();

      // GSAP systems
      initScrollAnimation();
      initScrollProgress();
      initNavScroll();
      initCardObserver();
      initCounters();

      // Reactive systems
      initParticles();
      initMouseTracker();
      initCardTilt('.tilt-card', 8);
      initMagneticButtons('.magnetic-btn', 0.3);

      // Resize
      window.addEventListener('resize', debounce(() => {
        sizeCanvas();
        sizeParticleCanvas();
        ScrollTrigger.refresh();
      }, 200));

      // UI bindings
      if (restartBtn) restartBtn.addEventListener('click', scrollToTop);

      if (navHamburger && navLinks) {
        navHamburger.addEventListener('click', toggleMobileNav);
        navLinks.querySelectorAll('a').forEach((link) => {
          link.addEventListener('click', () => {
            if (navLinks.classList.contains('is-open')) toggleMobileNav();
          });
        });
      }

    } catch (err) {
      console.error('[Spider-Man] Init failed:', err);
    }
  }


  // ── Fire ─────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
