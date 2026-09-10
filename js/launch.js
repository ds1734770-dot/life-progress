/**
 * Cinematic motivational launch experience — a short personal ritual shown
 * once per app session (boot only, never during navigation).
 *
 * Guarantees:
 *  - Uses the user's Dashboard inspirational background (or the bundled
 *    local fallback when none is set — works fully offline).
 *  - Never blocks the app: every wait is bounded and tap/Escape skips.
 *  - Respects prefers-reduced-motion (simple fade instead of the sequence).
 *  - Any failure silently falls through to the Dashboard.
 */
import { getSettings, LAUNCH_FALLBACK_BG } from './settings.js';
import { launchQuote } from './personalization.js';
import { escapeHtml } from './ui.js';

// Total on-screen time. Short by design — a ritual, not a loading screen.
const HOLD_MS = 2200; // quote fully visible before the exit transition
const FADE_MS = 500; // exit transition into the Dashboard
const STAGE_GAP = 420; // delay between animation stages

function prefersReducedMotion() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Resolve the launch background data URL. Always resolves (never rejects):
 * falls back to the bundled asset when no custom background exists or the
 * stored data URL is corrupt (e.g. failed image decode on last load).
 */
async function resolveBackground() {
  try {
    const bg = getSettings().backgroundImage;
    if (bg && typeof bg.dataUrl === 'string' && bg.dataUrl.startsWith('data:image')) {
      const ok = await new Promise((resolve) => {
        const probe = new Image();
        probe.onload = () => resolve(true);
        probe.onerror = () => resolve(false);
        probe.src = bg.dataUrl;
      });
      if (ok) return { url: bg.dataUrl, bundled: false };
    }
  } catch {
    /* fall through to the bundled asset */
  }
  return { url: LAUNCH_FALLBACK_BG, bundled: true };
}

/** Build the overlay DOM. Returns null if anything structural fails. */
function buildOverlay(bgUrl, quoteText, reduced) {
  if (typeof document === 'undefined') return null;
  const root = document.createElement('div');
  root.id = 'launch-screen';
  root.className = 'launch-screen';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Motivational launch');
  if (reduced) root.classList.add('reduced');

  root.innerHTML = `
    <div class="launch-bg" style="background-image:url('${bgUrl}')" aria-hidden="true"></div>
    <div class="launch-veil" aria-hidden="true"></div>
    <div class="launch-content">
      <div class="launch-mark" aria-hidden="true">“</div>
      <p class="launch-quote">${escapeHtml(quoteText)}</p>
      <div class="launch-rule" aria-hidden="true"><span></span></div>
      <div class="launch-brand">Life&nbsp;Progress</div>
    </div>
    <button class="launch-skip" type="button" aria-label="Skip introduction">Skip</button>
  `;
  return root;
}

/**
 * Play the launch sequence. Resolves when the overlay has been dismissed.
 * Never throws; a hard timeout guarantees the Dashboard appears.
 */
export function playLaunchExperience() {
  return new Promise((resolve) => {
    let done = false;
    const timers = [];
    const finish = () => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      window.removeEventListener('keydown', onKey, true);
      const node = document.getElementById('launch-screen');
      if (node) node.remove();
      resolve();
    };
    const onKey = (e) => {
      if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') finish();
    };

    // Hard failsafe: even if every animation hangs, the app continues.
    timers.push(setTimeout(finish, HOLD_MS + FADE_MS + STAGE_GAP * 2 + 1500));

    let overlay;
    try {
      const reduced = prefersReducedMotion();
      const quote = launchQuote(getSettings());
      overlay = buildOverlay(LAUNCH_FALLBACK_BG, quote, reduced);
      if (!overlay) return finish();
      document.body.append(overlay);
    } catch (err) {
      console.error('[LifeProgress] Launch experience failed', err);
      return finish();
    }

    overlay.addEventListener('click', finish);
    window.addEventListener('keydown', onKey, true);

    // Stage 0 — swap in the real background (custom image or bundled asset).
    // The element renders the bundled gradient immediately so first paint is
    // never blank, then upgrades to the user's image if one exists.
    resolveBackground()
      .then((bg) => {
        if (done) return;
        const bgEl = overlay.querySelector('.launch-bg');
        if (bgEl && !bg.bundled) bgEl.style.backgroundImage = `url('${bg.url}')`;
      })
      .catch(() => {});

    if (prefersReducedMotion()) {
      // Reduced motion: everything is already visible via CSS (no staged
      // animation); hold briefly so the quote can be read, then leave.
      timers.push(setTimeout(finish, HOLD_MS + FADE_MS));
      return;
    }

    // Stage 1 — background: fade + gentle scale + blur-to-sharp.
    requestAnimationFrame(() => {
      const bgEl = overlay.querySelector('.launch-bg');
      if (bgEl) bgEl.classList.add('is-in');
    });

    // Stage 2 — quote rises into place.
    timers.push(
      setTimeout(() => overlay.querySelector('.launch-quote')?.classList.add('is-in'), STAGE_GAP)
    );

    // Stage 3 — decorative quote mark + rule + brand settle in.
    timers.push(
      setTimeout(() => {
        overlay.querySelector('.launch-mark')?.classList.add('is-in');
        overlay.querySelector('.launch-rule')?.classList.add('is-in');
      }, STAGE_GAP * 2)
    );
    timers.push(
      setTimeout(() => overlay.querySelector('.launch-brand')?.classList.add('is-in'), STAGE_GAP * 2 + 180)
    );

    // Stage 4 — exit: fade + scale down, then hand over to the Dashboard.
    timers.push(
      setTimeout(() => {
        overlay.classList.add('is-leaving');
        setTimeout(finish, FADE_MS + 60);
      }, STAGE_GAP * 2 + HOLD_MS)
    );
  });
}
