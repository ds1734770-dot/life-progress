/**
 * Water — dedicated hydration page.
 * Big animated ring, quick-add chips, custom amount, configurable target,
 * 7-day chart, recent entries (with correction), stats and streak.
 */
import { saveSettings } from '../settings.js';
import * as water from '../water.js';
import { checkAchievementsNow } from '../celebration.js';
import * as ui from '../ui.js';
import { todayKey, formatWater, formatClock, formatDate } from '../utils.js';

export async function mount(root, params) {
  const entries = await water.getAllEntries();
  render(root, entries);
}

function render(root, entries) {
  const unit = water.waterUnit();
  const target = water.waterTarget();
  const today = todayKey();
  const todayTotal = water.totalOn(entries, today);
  const frac = todayTotal / target;
  // Ring/bars clamp at 100% — the number should match, never read 150%.
  const displayPct = Math.min(100, Math.round(frac * 100));
  const week = water.last7Days(entries);
  const streak = water.waterStreak(entries);
  const metCount = week.filter((d) => d.met).length;

  root.innerHTML = `
    <header class="flex-between" style="margin-top:var(--sp-2)">
      <div>
        <h2 style="font-size:var(--fs-2xl);font-weight:800;letter-spacing:-0.02em">Water</h2>
        <div class="muted" style="font-size:var(--fs-sm);font-weight:600">Stay hydrated 💧</div>
      </div>
      ${streak > 0 ? `<span class="pill pill-accent" style="font-size:var(--fs-sm)">${ui.icon('flame', 14)} ${streak} day streak</span>` : ''}
    </header>

    <div class="card water-hero stagger">
      <div class="ring-wrap" id="water-ring-wrap">
        ${ui.ringMarkup(136, 12)}
        <div class="ring-center">
          <div id="water-total" style="font-size:26px;font-weight:800;letter-spacing:-0.02em;font-variant-numeric:tabular-nums">0</div>
          <div class="muted" style="font-size:11px;font-weight:600" id="water-pct">${displayPct}%</div>
        </div>
      </div>
      <div class="water-numbers grow">
        <div style="font-size:var(--fs-lg);font-weight:700">${formatWater(target, unit)} <span class="muted" style="font-weight:600;font-size:var(--fs-sm)">daily goal</span></div>
        <div class="muted" style="font-size:var(--fs-sm);font-weight:600;margin-top:4px" id="water-remaining">${frac >= 1 ? 'Goal reached — well done' : `${formatWater(Math.max(0, target - todayTotal), unit)} remaining`}</div>
        <button class="btn btn-ghost btn-sm" data-action="water-target" style="margin-top:10px">${ui.icon('settings', 14)} Set goal</button>
      </div>
    </div>

    <section class="section stagger">
      <div class="section-head">
        <h3 class="section-title" style="font-size:var(--fs-lg)">Quick add</h3>
      </div>
      <div class="chip-grid">
        <button class="chip" data-action="water-add" data-amount="100">100 ml</button>
        <button class="chip" data-action="water-add" data-amount="250">250 ml</button>
        <button class="chip" data-action="water-add" data-amount="500">500 ml</button>
        <button class="chip" data-action="water-add" data-amount="750">750 ml</button>
        <button class="chip" data-action="water-custom">Custom…</button>
      </div>
    </section>

    <section class="section stagger">
      <div class="section-head">
        <h3 class="section-title" style="font-size:var(--fs-lg)">This week</h3>
        <span class="pill ${metCount >= 7 ? 'pill-success' : 'pill-info'}">${metCount}/7 days on target</span>
      </div>
      <div class="card">
        <div class="bars" style="height:140px">
          ${week
            .map(
              (d) => `
            <div class="bar-col" style="gap:4px">
              <div class="bar-value" style="font-size:10px">${d.total > 0 ? formatWater(d.total, unit) : ''}</div>
              <div class="bar ${d.met ? 'done' : ''}" data-daybar="${d.key}" style="height:0"></div>
              <div class="bar-label">${d.label}</div>
            </div>`
            )
            .join('')}
        </div>
      </div>
    </section>

    <section class="section stagger">
      <div class="section-head">
        <h3 class="section-title" style="font-size:var(--fs-lg)">Statistics</h3>
      </div>
      <div class="stat-grid">
        <div class="stat"><div class="stat-value" id="water-avg">${formatWater(water.averageDaily(entries), unit)}</div><div class="stat-label">Daily avg</div></div>
        <div class="stat"><div class="stat-value">${metCount}</div><div class="stat-label">Days on target</div></div>
        <div class="stat"><div class="stat-value">${streak}</div><div class="stat-label">Streak</div></div>
      </div>
    </section>

    <section class="section stagger">
      <div class="section-head">
        <h3 class="section-title" style="font-size:var(--fs-lg)">Today's entries</h3>
      </div>
      <div class="card card-tight" id="water-today-list"></div>
    </section>

    <section class="section stagger">
      <div class="section-head">
        <h3 class="section-title" style="font-size:var(--fs-lg)">Last 7 days</h3>
      </div>
      <div class="card card-tight">
        ${week
          .slice()
          .reverse()
          .map(
            (d) => `
          <div class="row">
            <div class="row-main">
              <div class="row-title">${d.key === today ? 'Today' : formatDate(d.key, { short: true })}</div>
            </div>
            <span class="muted" style="font-size:var(--fs-sm);font-weight:600">${formatWater(d.total, unit)}</span>
            <span class="pill ${d.met ? 'pill-success' : d.total > 0 ? 'pill-warning' : 'pill'}">${d.met ? 'Goal met' : d.total > 0 ? `${d.pct}%` : '—'}</span>
          </div>`
          )
          .join('')}
      </div>
    </section>
  `;

  renderTodayList(root, entries);

  // Animate ring + bars after paint. Nodes are captured synchronously: the
  // callback runs a frame later, and if navigation replaced the screen in
  // between, detached-node writes are harmless while re-queries would crash.
  const ringWrap = root.querySelector('#water-ring-wrap');
  const totalNode = root.querySelector('#water-total');
  const pctNode = root.querySelector('#water-pct');
  const dayBars = root.querySelectorAll('[data-daybar]');
  requestAnimationFrame(() => {
    ui.setRing(ringWrap, frac * 100);
    if (totalNode) totalNode.textContent = formatWater(todayTotal, unit);
    if (pctNode) pctNode.textContent = `${displayPct}%`;
    dayBars.forEach((bar) => {
      const key = bar.dataset.daybar;
      const day = week.find((d) => d.key === key);
      if (day) bar.style.height = `${Math.min(100, day.pct)}%`;
    });
  });

  bindActions(root, entries);
}

function renderTodayList(root, entries) {
  const unit = water.waterUnit();
  const today = todayKey();
  const todays = entries.filter((e) => e.date === today);
  const list = root.querySelector('#water-today-list');
  if (!list) return;
  list.innerHTML = todays.length
    ? todays
        .slice(0, 12)
        .map(
          (e) => `
        <div class="row">
          <div class="row-main">
            <div class="row-title">${formatClock(e.timestamp)}</div>
          </div>
          <span style="font-weight:700;font-variant-numeric:tabular-nums">+${formatWater(e.amount, unit)}</span>
          <button class="btn-icon" style="width:34px;height:34px" data-action="water-remove" data-id="${e.id}" aria-label="Remove entry">${ui.icon('trash', 15)}</button>
        </div>`
        )
        .join('')
    : ui.emptyState({
        iconName: 'droplet',
        title: 'Start tracking your hydration',
        sub: 'Tap a quick amount above to log your first glass.',
      }).outerHTML;
}

function bindActions(root, entries) {
  ui.bindActions(root, {
    'water-add': async (d) => {
      const amount = Number(d.amount);
      await addAndRefresh(root, amount);
    },
    'water-custom': () => {
      ui.openSheet((close) => {
        const wrap = ui.el('div', { class: 'flex-col' });
        wrap.append(ui.el('h2', { style: { fontSize: 'var(--fs-xl)', fontWeight: 800 } }, 'Custom amount'));
        const input = ui.el('input', { class: 'input', type: 'number', inputmode: 'decimal', min: 50, max: 5000, placeholder: 'Amount in ml' });
    requestAnimationFrame(() => input.focus());
        const goBtn = ui.el('button', { class: 'btn btn-primary btn-block', type: 'button' }, 'Add');
        goBtn.addEventListener('click', async () => {
          const value = Number(input.value);
          if (!Number.isFinite(value) || value <= 0) {
            ui.toast('Enter a valid amount.', 'info');
            return;
          }
          await addAndRefresh(root, Math.round(value));
          close();
        });
        wrap.append(input, goBtn);
        return wrap;
      });
    },
    'water-remove': async (d) => {
      await water.removeWaterEntry(d.id);
      ui.haptic();
      ui.toast('Entry removed', 'info');
      const fresh = await water.getAllEntries();
      render(root, fresh);
    },
    'water-target': () => openTargetSheet(root),
  });
}

async function addAndRefresh(root, amount) {
  await water.addWater(amount);
  checkAchievementsNow(); // V1.2: evaluate + celebrate (fire-and-forget)
  ui.haptic();
  const entries = await water.getAllEntries();
  const unit = water.waterUnit();
  const target = water.waterTarget();
  const today = todayKey();
  const todayTotal = water.totalOn(entries, today);
  const frac = todayTotal / target;

  // All DOM updates below are guarded: the screen may have been replaced by
  // navigation while the entry was being written (the node is gone then).
  const totalNode = root.querySelector('#water-total');
  if (!totalNode) return;
  ui.animateCount(totalNode, todayTotal, { format: (n) => formatWater(Math.round(n), unit) });
  ui.pulse(totalNode);
  const pctNode = root.querySelector('#water-pct');
  if (pctNode) pctNode.textContent = `${Math.min(100, Math.round(frac * 100))}%`;
  const remaining = root.querySelector('#water-remaining');
  if (remaining) {
    remaining.textContent =
      frac >= 1 ? 'Goal reached — well done' : `${formatWater(Math.max(0, target - todayTotal), unit)} remaining`;
  }
  ui.setRing(root.querySelector('#water-ring-wrap'), frac * 100);

  const todayBar = root.querySelector(`[data-daybar="${today}"]`);
  if (todayBar) {
    const day = water.last7Days(entries).find((d) => d.key === today);
    todayBar.style.height = `${Math.min(100, day.pct)}%`;
    todayBar.classList.toggle('done', day.met);
  }
  renderTodayList(root, entries);
  const avg = root.querySelector('#water-avg');
  if (avg) avg.textContent = formatWater(water.averageDaily(entries), unit);
  ui.toast(`+${amount} ml`, 'success');
}

function openTargetSheet(root) {
  const current = water.waterTarget();
  ui.openSheet((close) => {
    const wrap = ui.el('div', { class: 'flex-col' });
    wrap.append(ui.el('h2', { style: { fontSize: 'var(--fs-xl)', fontWeight: 800 } }, 'Daily water goal'));
    const chips = ui.el('div', { class: 'chip-grid' });
    const presets = [1000, 1500, 2000, 2500, 3000, 3500, 4000, 5000];
    const chosen = { value: current };
    for (const ml of presets) {
      const chip = ui.el('button', { class: `chip ${current === ml ? 'active' : ''}`, type: 'button' }, ml >= 1000 ? `${(ml / 1000).toFixed(ml % 1000 ? 1 : 0)} L` : `${ml} ml`);
      chip.addEventListener('click', () => {
        chosen.value = ml;
        chips.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
        ui.haptic();
      });
      chips.append(chip);
    }
    const customRow = ui.el('div', { class: 'flex-row' }, [
      ui.el('input', { class: 'input grow', type: 'number', min: 500, max: 10000, placeholder: 'Custom ml', value: current }),
      ui.el('button', { class: 'btn btn-ghost', type: 'button' }, 'Set'),
    ]);
    customRow.querySelector('button').addEventListener('click', async () => {
      const value = Number(customRow.querySelector('input').value);
      if (!Number.isFinite(value) || value < 250) {
        ui.toast('Enter a valid target.', 'info');
        return;
      }
      await saveSettings({ waterTarget: value });
      ui.toast('Daily goal updated', 'success');
      ui.haptic();
      close();
      const entries = await water.getAllEntries();
      render(root, entries);
    });
    const saveBtn = ui.el('button', { class: 'btn btn-primary btn-block', type: 'button' }, 'Save goal');
    saveBtn.addEventListener('click', async () => {
      await saveSettings({ waterTarget: chosen.value });
      ui.toast('Daily goal updated', 'success');
      ui.haptic();
      close();
      const entries = await water.getAllEntries();
      render(root, entries);
    });
    wrap.append(chips, customRow, saveBtn);
    return wrap;
  });
}