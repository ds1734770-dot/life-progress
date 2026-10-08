/**
 * FX — shared visual delight: confetti, concentric activity rings, animated
 * water waves and the streak flame. Pure presentation; no data access.
 * Every effect is a no-op (or static) under prefers-reduced-motion.
 */

function reducedMotion() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ---------------------------------------------------------------------------
// Confetti
// ---------------------------------------------------------------------------

const CONFETTI_COLORS = ['#2dd4bf', '#60a5fa', '#fbbf24', '#f87171', '#a78bfa', '#34d399'];

/**
 * Fire a short confetti burst. `origin` is an element or {x,y} in viewport
 * px (defaults to the lower-middle of the screen). Self-cleaning canvas.
 */
export function confetti(origin, { count = 90, power = 1 } = {}) {
  if (reducedMotion() || typeof document === 'undefined') return;
  let ox = window.innerWidth / 2;
  let oy = window.innerHeight * 0.6;
  if (origin && typeof origin.getBoundingClientRect === 'function') {
    const r = origin.getBoundingClientRect();
    ox = r.left + r.width / 2;
    oy = r.top + r.height / 2;
  } else if (origin && Number.isFinite(origin.x)) {
    ox = origin.x;
    oy = origin.y;
  }

  const canvas = document.createElement('canvas');
  canvas.className = 'fx-confetti';
  canvas.setAttribute('aria-hidden', 'true');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    canvas.remove();
    return;
  }
  ctx.scale(dpr, dpr);

  const parts = Array.from({ length: count }, () => {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.1;
    const speed = (6 + Math.random() * 9) * power;
    return {
      x: ox,
      y: oy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      w: 5 + Math.random() * 6,
      h: 3 + Math.random() * 5,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.4,
      color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
    };
  });

  const start = performance.now();
  const DURATION = 1900;
  function frame(now) {
    const t = now - start;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    const fade = t > DURATION - 500 ? Math.max(0, (DURATION - t) / 500) : 1;
    for (const p of parts) {
      p.vy += 0.32;
      p.vx *= 0.99;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      ctx.save();
      ctx.globalAlpha = fade;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (t < DURATION) requestAnimationFrame(frame);
    else canvas.remove();
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Concentric activity rings (goals · water · gym · journal)
// ---------------------------------------------------------------------------

export const RING_DEFS = [
  { key: 'goals', label: 'Goals', r: 56, color: 'var(--success)' },
  { key: 'water', label: 'Water', r: 47, color: 'var(--info)' },
  { key: 'gym', label: 'Gym', r: 38, color: 'var(--accent)' },
  { key: 'journal', label: 'Journal', r: 29, color: 'var(--warning)' },
];

const circ = (r) => 2 * Math.PI * r;

export function concentricRingsMarkup(size = 140) {
  const rings = RING_DEFS.map((d) => {
    const c = circ(d.r).toFixed(3);
    return `
      <circle class="cr-track" cx="60" cy="60" r="${d.r}" stroke="${d.color}"></circle>
      <circle class="cr-fill" data-ring="${d.key}" cx="60" cy="60" r="${d.r}" stroke="${d.color}"
        stroke-dasharray="${c}" stroke-dashoffset="${c}"></circle>`;
  }).join('');
  return `<svg class="cr" width="${size}" height="${size}" viewBox="0 0 120 120" role="img" aria-label="Today's four activity rings">${rings}</svg>`;
}

/** Fill the rings. `fractions` = { goals, water, gym, journal } each 0..1. */
export function setConcentricRings(root, fractions) {
  for (const d of RING_DEFS) {
    const node = root.querySelector(`.cr-fill[data-ring="${d.key}"]`);
    if (!node) continue;
    const f = Math.min(1, Math.max(0, Number(fractions[d.key]) || 0));
    // Force a layout read so the transition runs from the empty state.
    void node.getBoundingClientRect();
    node.style.strokeDashoffset = String(circ(d.r) * (1 - f));
    node.classList.toggle('complete', f >= 1);
  }
}

export function ringLegendMarkup(fractions) {
  return RING_DEFS.map((d) => {
    const pct = Math.round(Math.min(1, Math.max(0, fractions[d.key] || 0)) * 100);
    return `<span class="cr-legend-item"><i style="background:${d.color}"></i>${d.label} <b>${pct}%</b></span>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// Water wave orb
// ---------------------------------------------------------------------------

const WAVE_PATH = 'M0 10 Q25 0 50 10 T100 10 T150 10 T200 10 T250 10 T300 10 T350 10 T400 10 V30 H0Z';

export function waveOrbMarkup() {
  return `
    <div class="wave-orb" aria-hidden="true">
      <div class="wave-level">
        <svg class="wave wave-back" viewBox="0 0 200 30" preserveAspectRatio="none"><path d="${WAVE_PATH}"/></svg>
        <svg class="wave wave-front" viewBox="0 0 200 30" preserveAspectRatio="none"><path d="${WAVE_PATH}"/></svg>
        <div class="wave-body"></div>
      </div>
    </div>`;
}

/** Raise/lower the water. fraction 0..1. */
export function setWave(root, fraction) {
  const orb = root.querySelector('.wave-orb');
  if (!orb) return;
  const f = Math.min(1, Math.max(0, fraction));
  orb.style.setProperty('--wave-level', String(f));
  orb.classList.toggle('full', f >= 1);
  orb.classList.remove('slosh');
  void orb.offsetWidth;
  orb.classList.add('slosh');
}

// ---------------------------------------------------------------------------
// Streak flame — grows with the streak
// ---------------------------------------------------------------------------

/** 0 = no streak, 1 = spark (1–2d), 2 = flame (3–6d), 3 = blaze (7–29d), 4 = inferno (30+). */
export function flameTier(days) {
  if (days >= 30) return 4;
  if (days >= 7) return 3;
  if (days >= 3) return 2;
  if (days >= 1) return 1;
  return 0;
}

export function flameMarkup(days, size = 40) {
  const tier = flameTier(days);
  return `
    <span class="flame flame-t${tier}" style="--flame-size:${size}px" aria-hidden="true">
      <svg viewBox="0 0 24 32">
        <path class="flame-outer" d="M12 1c1.5 5 8 8.500 8 16a8 8 0 0 1-16 0c0-3 1.500-5 3-7 .8 1.800 2 2.800 3 3.200C9.500 9 10 5 12 1z"/>
        <path class="flame-inner" d="M12 15c.8 2 4 3.500 4 7a4 4 0 0 1-8 0c0-1.800 1-3 1.800-4 .4.800 1 1.200 1.600 1.400C11 18 11.200 16.500 12 15z"/>
      </svg>
    </span>`;
}
