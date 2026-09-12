/**
 * Achievement celebration — the "NEW BADGE UNLOCKED" moment.
 *
 * A tiny FIFO queue shows one full-screen celebration at a time (multiple
 * simultaneous unlocks are queued, never stacked). Celebrations survive a
 * reload only as earned records: if the app closes before the user sees one,
 * startup evaluation re-queues it (unseen records are re-queued; seen ones
 * are not). Escape / Continue / backdrop tap dismiss; a failsafe timer keeps
 * the queue moving if a dismiss event is ever lost. Reduced motion shows the
 * identical information with minimal animation.
 *
 * Layering: celebration.js renders precomputed payloads from achievements.js
 * — it never defines or evaluates rules itself.
 */

import { badgeMarkup, syncAchievements, nextMilestone } from './achievements.js';
import { loadHistoryData } from './history.js';

const SEEN_KEY = 'achievements-celebrated';

let queue = [];
let showing = false;
let failsafeTimer = null;
let seenIds = null;

function seenSet() {
  if (seenIds) return seenIds;
  try {
    seenIds = new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]'));
  } catch {
    seenIds = new Set();
  }
  return seenIds;
}

function persistSeen() {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...seenSet()]));
  } catch {
    /* storage may be unavailable — celebrations then simply re-show */
  }
}

/** Queue a celebration payload { achievement, progress, next, earnedAt }. */
export function queueCelebration(payload) {
  if (!payload || !payload.achievement) return;
  if (seenSet().has(payload.achievement.id)) return; // celebrate once, ever
  queue.push(payload);
  if (!showing) showNext();
}

/** Queue only achievements the user has never seen celebrated. */
export function queueUnseenCelebrations(payloads) {
  for (const p of payloads || []) {
    if (!seenSet().has(p.achievement.id)) queueCelebration(p);
  }
}

export function pendingCelebrationCount() {
  return queue.length + (showing ? 1 : 0);
}

/**
 * Evaluate achievements against current data, persist anything newly earned,
 * and queue one-time celebrations. Called after relevant domain mutations
 * (water add, workout save, goal completion, journal save) and at startup —
 * failures never break the triggering action.
 */
export async function checkAchievementsNow() {
  try {
    const data = await loadHistoryData();
    const { earnedNew, progress } = await syncAchievements(data);
    queueUnseenCelebrations(
      earnedNew.map((achievement) => ({
        achievement,
        progress: progress.get(achievement.id),
        next: nextMilestone(achievement.id, progress),
        earnedAt: Date.now(),
      }))
    );
    return earnedNew.map((a) => a.id);
  } catch (err) {
    console.error('[LifeProgress] Achievement evaluation failed', err);
    return [];
  }
}

/** Test hook: clear the queue without showing anything. */
export function resetCelebrationQueue() {
  queue = [];
  showing = false;
  clearTimeout(failsafeTimer);
  document.getElementById('celebration-root')?.replaceChildren();
}

function showNext() {
  const payload = queue.shift();
  if (!payload) {
    showing = false;
    return;
  }
  showing = true;
  seenSet().add(payload.achievement.id); // mark before showing: reload-safe
  persistSeen();
  render(payload);
}

function finish() {
  clearTimeout(failsafeTimer);
  document.getElementById('celebration-root')?.replaceChildren();
  showing = false;
  showNext(); // chained unlocks play one after another
}

function render({ achievement, progress, next, earnedAt }) {
  const root = document.getElementById('celebration-root');
  if (!root) return; // root missing → skip silently; the badge stays earned

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const nextMarkup = next
    ? `
      <div class="celebration-next">
        <div class="celebration-next-label">Next milestone</div>
        <div class="celebration-next-title">${escapeHtml(next.title)}</div>
        <div class="celebration-next-sub">${escapeHtml(capitalize(next.requirement))}${
          progress && progress.current > 0 ? ` · you're already ${progress.current} / ${next.target}` : ''
        }</div>
      </div>`
    : '';

  root.replaceChildren();
  root.innerHTML = `
    <div class="celebration-backdrop" role="dialog" aria-modal="true" aria-labelledby="celebration-title">
      <div class="celebration-panel ${reduced ? 'reduced' : ''}">
        <div class="celebration-glow" aria-hidden="true"></div>
        <div class="celebration-kicker" aria-hidden="true">✨</div>
        <div class="celebration-badge">${badgeMarkup(achievement, { unlocked: true, size: 120 })}</div>
        <div class="celebration-unlocked">New badge unlocked</div>
        <h2 class="celebration-title" id="celebration-title">${escapeHtml(achievement.title)}</h2>
        <div class="celebration-requirement">${escapeHtml(capitalize(achievement.requirement))}</div>
        <p class="celebration-description">${escapeHtml(achievement.description)}</p>
        <div class="celebration-earned">Earned ${formatDate(earnedAt)}</div>
        ${nextMarkup}
        <div class="celebration-actions">
          <button class="btn btn-primary" data-celebration="close" type="button">Continue</button>
        </div>
      </div>
    </div>`;

  const backdrop = root.querySelector('.celebration-backdrop');
  const close = () => finish();

  backdrop.querySelector('[data-celebration="close"]').addEventListener('click', close);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') {
      document.removeEventListener('keydown', onKey);
      close();
    }
  });

  // Focus the primary action for keyboard / screen-reader users.
  requestAnimationFrame(() => backdrop.querySelector('[data-celebration="close"]')?.focus());

  // Failsafe: never trap the user (the panel remains fully dismissible).
  clearTimeout(failsafeTimer);
  failsafeTimer = setTimeout(close, 30000);
}

// ---------------------------------------------------------------------------
// Small local helpers (kept local to avoid import cycles)
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function capitalize(str) {
  const s = String(str || '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatDate(ts) {
  const d = new Date(Number(ts) || Date.now());
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}
