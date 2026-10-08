/**
 * Weekly Wrapped — swipeable story of your week, plus a shareable image.
 * Tap right/left to move, hold to pause. Auto-advances. All on-device.
 */
import { loadHistoryData } from '../history.js';
import { weeklyRecap, recapSlides, rangeLabel } from '../wrapped.js';
import { getSettings } from '../settings.js';
import * as fx from '../fx.js';
import * as ui from '../ui.js';
import { go, registerCleanup } from '../router.js';

const SLIDE_MS = 5200;

const TONES = {
  accent: ['#0f766e', '#0b2a3a'],
  info: ['#1d4ed8', '#0b1a3a'],
  success: ['#047857', '#06261d'],
  warning: ['#b45309', '#2d1606'],
};

export async function mount(root) {
  const data = await loadHistoryData();
  const state = { offset: 0, i: 0, timer: null, paused: false };
  let recap = null;
  let slides = [];

  function load() {
    recap = weeklyRecap(data, state.offset);
    slides = recapSlides(recap);
    state.i = 0;
  }

  function stop() {
    clearTimeout(state.timer);
    state.timer = null;
  }
  registerCleanup(stop);

  function schedule() {
    stop();
    if (state.paused || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    state.timer = setTimeout(() => step(1), SLIDE_MS);
  }

  function step(dir) {
    const next = state.i + dir;
    if (next < 0) return;
    if (next >= slides.length) {
      stop();
      return;
    }
    state.i = next;
    paint();
  }

  function paint() {
    const s = slides[state.i];
    const [c1, c2] = TONES[s.tone] || TONES.accent;
    const stage = root.querySelector('#wr-stage');
    stage.style.setProperty('--wr-a', c1);
    stage.style.setProperty('--wr-b', c2);
    stage.innerHTML = `
      <div class="wr-bars">${slides.map((_, k) => `<span class="wr-seg ${k < state.i ? 'done' : ''} ${k === state.i ? 'active' : ''}"><i style="animation-duration:${SLIDE_MS}ms"></i></span>`).join('')}</div>
      <div class="wr-slide" key="${s.id}">
        <div class="wr-emoji">${s.emoji}</div>
        <div class="wr-kicker">${ui.escapeHtml(s.kicker)}</div>
        <div class="wr-big">${ui.escapeHtml(String(s.big))}</div>
        <div class="wr-caption">${ui.escapeHtml(s.caption)}</div>
      </div>
      <div class="wr-hit wr-prev" data-hit="-1" aria-label="Previous"></div>
      <div class="wr-hit wr-next" data-hit="1" aria-label="Next"></div>`;
    if (s.id === 'intro' && state.i === 0 && !recap.empty) fx.confetti(stage, { count: 50, power: 0.7 });
    root.querySelector('#wr-counter').textContent = `${state.i + 1} / ${slides.length}`;
    schedule();
  }

  function render() {
    root.innerHTML = `
      <header class="flex-between" style="margin-top:var(--sp-2)">
        <div>
          <h2 style="font-size:var(--fs-2xl);font-weight:800;letter-spacing:-0.02em">Weekly Wrapped</h2>
          <div class="muted" id="wr-range" style="font-size:var(--fs-sm);font-weight:600">${rangeLabel(recap)}</div>
        </div>
        <button class="btn-icon" data-action="back" aria-label="Back">${ui.icon('arrow-left', 20)}</button>
      </header>
      <div class="seg" style="margin:var(--sp-3) 0">
        <button class="seg-item" data-action="week" data-offset="0" aria-selected="${state.offset === 0}">This week</button>
        <button class="seg-item" data-action="week" data-offset="-1" aria-selected="${state.offset === -1}">Last week</button>
      </div>
      <div class="wr-stage" id="wr-stage" aria-live="polite"></div>
      <div class="flex-between" style="margin-top:var(--sp-3)">
        <span class="muted" id="wr-counter" style="font-weight:600"></span>
        <div class="flex-row" style="gap:8px">
          <button class="btn btn-ghost btn-sm" data-action="replay">${ui.icon('refresh', 15)} Replay</button>
          <button class="btn btn-primary btn-sm" data-action="share">${ui.icon('send', 15)} Share</button>
        </div>
      </div>`;
    paint();
  }

  load();
  render();

  const stageEvents = () => {
    const stage = root.querySelector('#wr-stage');
    stage.addEventListener('click', (e) => {
      const hit = e.target.closest('[data-hit]');
      if (hit) {
        ui.haptic(6);
        step(Number(hit.dataset.hit));
      }
    });
    const hold = (on) => {
      state.paused = on;
      const bars = stage.querySelector('.wr-seg.active i');
      if (bars) bars.style.animationPlayState = on ? 'paused' : 'running';
      if (on) stop();
      else schedule();
    };
    stage.addEventListener('pointerdown', () => hold(true));
    stage.addEventListener('pointerup', () => hold(false));
    stage.addEventListener('pointercancel', () => hold(false));
    stage.addEventListener('pointerleave', () => state.paused && hold(false));
  };
  stageEvents();

  ui.bindActions(root, {
    back: () => go('insights'),
    week: (d) => {
      state.offset = Number(d.offset);
      load();
      render();
      stageEvents();
    },
    replay: () => {
      state.i = 0;
      paint();
    },
    share: () => shareRecap(recap, slides),
  });
}

// ---------------------------------------------------------------------------
// Shareable image (canvas → PNG). No data leaves the device unless the user
// chooses a share target.
// ---------------------------------------------------------------------------

function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = text.split(' ');
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, y);
      line = w;
      y += lineHeight;
    } else {
      line = test;
    }
  }
  ctx.fillText(line, x, y);
  return y;
}

async function shareRecap(recap, slides) {
  const W = 1080;
  const H = 1350;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#0f766e');
  g.addColorStop(1, '#0a0e14');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = '600 38px system-ui, sans-serif';
  ctx.fillText(`WEEKLY WRAPPED · ${rangeLabel(recap).toUpperCase()}`, 72, 120);
  ctx.fillStyle = '#fff';
  ctx.font = '800 84px system-ui, sans-serif';
  wrapText(ctx, recap.headline, 72, 240, W - 144, 96);

  const name = (getSettings().name || '').trim();
  const rows = slides.filter((s) => !['intro'].includes(s.id)).slice(0, 5);
  let y = 470;
  for (const s of rows) {
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.beginPath();
    ctx.roundRect(72, y - 70, W - 144, 150, 28);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.font = '600 30px system-ui, sans-serif';
    ctx.fillText(`${s.emoji}  ${s.kicker.toUpperCase()}`, 108, y - 18);
    ctx.fillStyle = '#fff';
    ctx.font = '800 56px system-ui, sans-serif';
    ctx.fillText(String(s.big), 108, y + 48);
    y += 180;
  }
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = '600 32px system-ui, sans-serif';
  ctx.fillText(name ? `${name} · Life Progress` : 'Life Progress', 72, H - 72);

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) {
    ui.toast('Could not create the image.', 'danger');
    return;
  }
  const file = new File([blob], 'weekly-wrapped.png', { type: 'image/png' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'My Weekly Wrapped' });
      return;
    }
  } catch (err) {
    if (err && err.name === 'AbortError') return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'weekly-wrapped.png';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  ui.toast('Image saved', 'success');
}
