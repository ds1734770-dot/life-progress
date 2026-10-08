/**
 * Insights — Life Score, 14-day trend, what moved today, smart insights,
 * streak freezes and the Weekly Wrapped entry. Everything is derived from
 * local data; nothing leaves the device.
 */
import { loadHistoryData, completedDaySet } from '../history.js';
import { lifeScoreSeries, scoreTrend, scoreLabel, whatMoved } from '../lifeScore.js';
import { buildInsights, activeDayCount } from '../insights.js';
import { weeklyRecap } from '../wrapped.js';
import { getSettings } from '../settings.js';
import { normalizeFreeze, MAX_FREEZES, FREEZE_EVERY } from '../streakFreeze.js';
import * as fx from '../fx.js';
import * as ui from '../ui.js';
import { go } from '../router.js';
import { todayKey, formatDate } from '../utils.js';

const GAUGE_R = 52;
const GAUGE_C = 2 * Math.PI * GAUGE_R * 0.75; // 270° arc

function gaugeMarkup(score) {
  const track = `<circle class="gauge-track" cx="60" cy="60" r="${GAUGE_R}" stroke-dasharray="${GAUGE_C.toFixed(2)} 999"/>`;
  const fill = `<circle class="gauge-fill" id="gauge-fill" cx="60" cy="60" r="${GAUGE_R}" stroke-dasharray="${GAUGE_C.toFixed(2)} 999" stroke-dashoffset="${GAUGE_C.toFixed(2)}" data-score="${score}"/>`;
  return `<svg class="gauge" viewBox="0 0 120 120" role="img" aria-label="Life Score ${score} out of 100">${track}${fill}</svg>`;
}

function trendBars(series) {
  return `<div class="trend" role="img" aria-label="Life Score for the last 14 days">
    ${series
      .map(
        (s, i) => `<div class="trend-col" title="${formatDate(s.date, { short: true })}: ${s.score}">
          <div class="trend-bar ${i === series.length - 1 ? 'today' : ''}" style="height:${Math.max(4, s.score)}%"></div>
          <span class="trend-day">${new Date(s.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'narrow' })}</span>
        </div>`
      )
      .join('')}
  </div>`;
}

export async function mount(root) {
  const data = await loadHistoryData();
  const today = todayKey();
  const series = lifeScoreSeries(data, 14, today);
  const now = series[series.length - 1];
  const trend = scoreTrend(data, today);
  const moved = whatMoved(data, today);
  const insights = buildInsights(data, today);
  const freeze = normalizeFreeze(getSettings().freeze);
  const active = activeDayCount(data, today, 30);
  const recap = weeklyRecap(data, 0, today);
  const completed = completedDaySet(data, today);
  const wrappedReady = !recap.empty;

  const movedText = moved
    ? `Biggest swing today: ${moved.label.toLowerCase()} is ${moved.delta > 0 ? 'above' : 'below'} your usual.`
    : 'Right on your usual pace today.';

  root.innerHTML = `
    <header class="flex-between" style="margin-top:var(--sp-2)">
      <div>
        <h2 style="font-size:var(--fs-2xl);font-weight:800;letter-spacing:-0.02em">Insights</h2>
        <div class="muted" style="font-size:var(--fs-sm);font-weight:600">Understand your patterns</div>
      </div>
      <button class="btn-icon" data-action="back" aria-label="Back to Home">${ui.icon('arrow-left', 20)}</button>
    </header>

    <section class="card score-card stagger">
      <div class="gauge-wrap">
        ${gaugeMarkup(now.score)}
        <div class="gauge-center">
          <div class="gauge-num" id="gauge-num">0</div>
          <div class="muted gauge-label">${scoreLabel(now.score)}</div>
        </div>
      </div>
      <div class="score-side">
        <div class="score-title">Life Score today</div>
        <div class="score-delta ${trend.delta >= 0 ? 'up' : 'down'}">${trend.delta === 0 ? 'Level with last week' : `${trend.delta > 0 ? '▲' : '▼'} ${Math.abs(trend.delta)} vs last week`}</div>
        <div class="muted" style="font-size:var(--fs-sm);margin-top:6px">${ui.escapeHtml(movedText)}</div>
      </div>
    </section>

    <section class="section stagger">
      <div class="section-head"><h3 class="section-title" style="font-size:var(--fs-lg)">Last 14 days</h3><span class="pill pill-accent">avg ${trend.current}</span></div>
      <div class="card">${trendBars(series)}</div>
    </section>

    <section class="section stagger">
      <div class="section-head"><h3 class="section-title" style="font-size:var(--fs-lg)">What we noticed</h3></div>
      ${
        insights.length
          ? `<div class="flex-col">${insights.map(insightCard).join('')}</div>`
          : `<div class="card empty-insight">
              <div class="empty-insight-icon">${ui.icon('sparkles', 22)}</div>
              <div style="font-weight:700">Insights unlock as you log</div>
              <div class="muted" style="font-size:var(--fs-sm);margin-top:4px">${active} of the last 30 days have activity. A couple of weeks of water, workouts and journal entries is enough for patterns to appear.</div>
            </div>`
      }
    </section>

    <section class="section stagger">
      <div class="card freeze-card">
        <div class="freeze-icon">❄️</div>
        <div class="grow">
          <div style="font-weight:700">Streak freezes: ${freeze.banked}/${MAX_FREEZES}</div>
          <div class="muted" style="font-size:var(--fs-sm)">Earn one for every ${FREEZE_EVERY} complete days in a row. If you miss a day after a 3+ day streak, a freeze is used automatically.</div>
        </div>
      </div>
    </section>

    <section class="section stagger">
      <div class="card card-interactive wrapped-entry" data-action="open-wrapped" role="button" tabindex="0">
        <div class="wrapped-badge">✨</div>
        <div class="grow">
          <div style="font-weight:800;font-size:var(--fs-lg)">Your Weekly Wrapped</div>
          <div class="muted" style="font-size:var(--fs-sm)">${wrappedReady ? `${recap.headline}. Tap to play your week.` : 'Log something this week to unlock your recap.'}</div>
        </div>
        ${ui.icon('chevron-right', 18)}
      </div>
    </section>
    <span class="visually-hidden">${completed.size} complete days recorded.</span>
  `;

  // Animate the gauge + number after paint.
  const fill = root.querySelector('#gauge-fill');
  const frac = Math.min(1, now.score / 100);
  requestAnimationFrame(() => {
    void fill.getBoundingClientRect();
    fill.style.strokeDashoffset = String(GAUGE_C * (1 - frac));
  });
  ui.animateCount(root.querySelector('#gauge-num'), now.score, { format: (n) => String(Math.round(n)) });
  if (now.score >= 100) fx.confetti(root.querySelector('.gauge-wrap'), { count: 80 });

  ui.bindActions(root, {
    back: () => go('dashboard'),
    'open-wrapped': () => go('wrapped'),
  });
  root.querySelector('.wrapped-entry')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      go('wrapped');
    }
  });
}

function insightCard(i) {
  return `<div class="card insight insight-${i.tone}">
    <div class="insight-icon">${ui.icon(i.icon, 20)}</div>
    <div>
      <div class="insight-title">${ui.escapeHtml(i.title)}</div>
      <div class="muted insight-text">${ui.escapeHtml(i.text)}</div>
    </div>
  </div>`;
}
