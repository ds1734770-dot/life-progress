/**
 * Body — weight and measurements. Log, see the trend line, BMI (optional,
 * needs your height) and your history. kg/lb is a display choice only.
 */
import * as body from '../bodyMetrics.js';
import { getSettings, saveSettings } from '../settings.js';
import * as ui from '../ui.js';
import { go } from '../router.js';
import { todayKey, formatDate } from '../utils.js';

export async function mount(root) {
  const state = { entries: await body.getAllEntries(), range: 90 };
  render(root, state);
}

function chartMarkup(series, unit) {
  if (series.length < 2) {
    return `<div class="muted" style="text-align:center;padding:28px 8px;font-size:var(--fs-sm)">Log your weight on two different days to see your trend line.</div>`;
  }
  const W = 320, H = 150, pl = 8, pr = 8, pt = 14, pb = 22;
  const vals = series.map((s) => (unit === 'lb' ? body.kgToLb(s.weight) : s.weight));
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = Math.max(0.5, (hi - lo) * 0.2);
  const min = lo - pad, max = hi + pad;
  const x = (i) => pl + (i * (W - pl - pr)) / (series.length - 1);
  const y = (v) => pt + ((max - v) / (max - min)) * (H - pt - pb);
  const pts = vals.map((v, i) => [x(i), y(v)]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)} ${H - pb} L${pts[0][0].toFixed(1)} ${H - pb} Z`;
  const last = pts[pts.length - 1];
  const r1 = (v) => Math.round(v * 10) / 10;
  return `<svg class="mood-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Weight trend, ${series.length} measurements">
    <defs><linearGradient id="body-grad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity="0.35"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
    <line class="mood-grid" x1="${pl}" x2="${W - pr}" y1="${y(hi)}" y2="${y(hi)}"/>
    <line class="mood-grid" x1="${pl}" x2="${W - pr}" y1="${y(lo)}" y2="${y(lo)}"/>
    <path d="${area}" fill="url(#body-grad)"/>
    <path class="mood-line" d="${line}"/>
    ${pts.map((p) => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3" fill="var(--accent)"/>`).join('')}
    <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="6" fill="none" stroke="var(--accent)" stroke-width="2" opacity="0.5"/>
    <text class="mood-axis" x="${pl + 2}" y="${H - 6}" text-anchor="start">${formatDate(series[0].date, { short: true })}</text>
    <text class="mood-axis" x="${W - pr - 2}" y="${H - 6}" text-anchor="end">${formatDate(series[series.length - 1].date, { short: true })}</text>
    <text class="mood-axis" x="${pl + 2}" y="${y(hi) - 4}" text-anchor="start">${r1(hi)}</text>
    <text class="mood-axis" x="${pl + 2}" y="${y(lo) + 11}" text-anchor="start">${r1(lo)}</text>
  </svg>`;
}

function render(root, state) {
  const settings = getSettings();
  const unit = settings.bodyUnit === 'lb' ? 'lb' : 'kg';
  const series = body.weightSeries(state.entries, { days: state.range === 0 ? null : state.range });
  const stats = body.weightStats(series);
  const latestAll = body.weightSeries(state.entries);
  const current = latestAll.length ? latestAll[latestAll.length - 1].weight : null;
  const bmiVal = body.bmi(current, settings.heightCm);
  const ranges = [[30, '30d'], [90, '90d'], [0, 'All']];

  root.innerHTML = `
    <header class="flex-between" style="margin-top:var(--sp-2)">
      <div>
        <h2 style="font-size:var(--fs-2xl);font-weight:800;letter-spacing:-0.02em">Body</h2>
        <div class="muted" style="font-size:var(--fs-sm);font-weight:600">Weight &amp; measurements</div>
      </div>
      <button class="btn-icon" data-action="back" aria-label="Back to Home">${ui.icon('arrow-left', 20)}</button>
    </header>

    <section class="section stagger">
      <div class="stat-grid">
        <div class="stat"><div class="stat-value">${current == null ? '—' : body.displayWeight(current, unit)}</div><div class="stat-label">Current</div></div>
        <div class="stat"><div class="stat-value ${stats && stats.change < 0 ? 'text-success' : ''}">${stats ? `${stats.change > 0 ? '+' : ''}${unit === 'lb' ? Math.round(body.kgToLb(stats.change) * 10) / 10 : stats.change}` : '—'}</div><div class="stat-label">Change (${state.range ? state.range + 'd' : 'all'})</div></div>
        <div class="stat"><div class="stat-value">${bmiVal ?? '—'}</div><div class="stat-label">BMI</div></div>
      </div>
      ${bmiVal ? `<div class="muted" style="text-align:center;font-size:var(--fs-sm);margin-top:8px">${body.bmiCategory(bmiVal)}. BMI is a rough guide and ignores muscle mass.</div>` : `<button class="section-link" data-action="set-height" style="margin:8px auto 0;display:block">Add your height for BMI</button>`}
    </section>

    <section class="section stagger">
      <div class="section-head">
        <h3 class="section-title" style="font-size:var(--fs-lg)">Trend</h3>
        <div class="seg" style="max-width:180px">${ranges.map(([v, l]) => `<button class="seg-item" data-action="range" data-range="${v}" aria-selected="${state.range === v}">${l}</button>`).join('')}</div>
      </div>
      <div class="card">${chartMarkup(series, unit)}</div>
    </section>

    <button class="btn btn-primary btn-block" data-action="log">${ui.icon('plus', 18)} Log measurement</button>

    <section class="section stagger">
      <div class="section-head">
        <h3 class="section-title" style="font-size:var(--fs-lg)">History</h3>
        <div class="seg" style="max-width:130px"><button class="seg-item" data-action="unit" data-unit="kg" aria-selected="${unit === 'kg'}">kg</button><button class="seg-item" data-action="unit" data-unit="lb" aria-selected="${unit === 'lb'}">lb</button></div>
      </div>
      <div class="card card-tight">
        ${
          state.entries.length
            ? state.entries.slice(0, 30).map((e) => `
          <div class="row">
            <div class="row-main">
              <div class="row-title">${e.weight != null ? body.displayWeight(e.weight, unit) : 'Measurements'}</div>
              <div class="row-sub">${formatDate(e.date, { short: true })}${[e.waist && `waist ${e.waist} cm`, e.chest && `chest ${e.chest} cm`, e.hips && `hips ${e.hips} cm`].filter(Boolean).map((t) => ` · ${t}`).join('')}${e.note ? ` · ${ui.escapeHtml(e.note)}` : ''}</div>
            </div>
            <button class="btn-icon" style="width:34px;height:34px" data-action="del" data-id="${e.id}" aria-label="Delete entry">${ui.icon('trash', 15)}</button>
          </div>`).join('')
            : `<div class="muted" style="padding:20px;text-align:center">No entries yet. Log your first measurement to start your trend.</div>`
        }
      </div>
    </section>`;

  ui.bindActions(root, {
    back: () => go('dashboard'),
    range: (d) => {
      state.range = Number(d.range);
      render(root, state);
    },
    unit: async (d) => {
      await saveSettings({ bodyUnit: d.unit });
      render(root, state);
    },
    log: () => openLogSheet(root, state, unit),
    'set-height': () => openHeightSheet(root, state),
    del: async (d) => {
      const ok = await ui.openDialog({ title: 'Delete this entry?', message: 'This cannot be undone.', confirmLabel: 'Delete', danger: true });
      if (!ok) return;
      await body.deleteEntry(d.id);
      state.entries = state.entries.filter((e) => e.id !== d.id);
      render(root, state);
    },
  });
}

function field(label, input) {
  return ui.el('div', { class: 'field' }, [ui.el('label', { class: 'field-label' }, label), input]);
}

function openLogSheet(root, state, unit) {
  ui.openSheet((close) => {
    const wrap = ui.el('div', { class: 'flex-col' });
    wrap.append(ui.el('h2', { style: { fontSize: 'var(--fs-xl)', fontWeight: 800 } }, 'Log measurement'));
    const last = body.weightSeries(state.entries).slice(-1)[0];
    const num = (ph, step = '0.1') => ui.el('input', { class: 'input', type: 'number', inputmode: 'decimal', step, min: '0', placeholder: ph });
    const date = ui.el('input', { class: 'input', type: 'date', value: todayKey(), max: todayKey() });
    const weight = num(last ? String(unit === 'lb' ? Math.round(body.kgToLb(last.weight) * 10) / 10 : last.weight) : `Weight (${unit})`);
    const waist = num('Waist (cm)');
    const chest = num('Chest (cm)');
    const hips = num('Hips (cm)');
    const note = ui.el('input', { class: 'input', type: 'text', maxlength: '140', placeholder: 'Note (optional)' });
    const error = ui.el('div', { style: { color: 'var(--danger)', fontSize: 'var(--fs-sm)', minHeight: 18 } });
    const save = ui.el('button', { class: 'btn btn-primary btn-block', type: 'button' }, 'Save');
    save.addEventListener('click', async () => {
      const raw = {
        date: date.value || todayKey(),
        weight: weight.value === '' ? null : body.toKg(weight.value, unit),
        waist: waist.value,
        chest: chest.value,
        hips: hips.value,
        note: note.value,
      };
      const entry = body.makeBodyEntry(raw);
      const err = body.validateBodyEntry(entry);
      if (err) {
        error.textContent = err;
        return;
      }
      await body.saveEntry(entry);
      state.entries = await body.getAllEntries();
      ui.haptic();
      ui.toast('Saved', 'success');
      close();
      render(root, state);
    });
    wrap.append(field('Date', date), field(`Weight (${unit})`, weight), ui.el('div', { class: 'form-grid' }, [field('Waist (cm)', waist), field('Chest (cm)', chest)]), field('Hips (cm)', hips), field('Note', note), error, save);
    return wrap;
  });
}

function openHeightSheet(root, state) {
  ui.openSheet((close) => {
    const wrap = ui.el('div', { class: 'flex-col' });
    wrap.append(ui.el('h2', { style: { fontSize: 'var(--fs-xl)', fontWeight: 800 } }, 'Your height'));
    const input = ui.el('input', { class: 'input', type: 'number', inputmode: 'numeric', min: '100', max: '230', placeholder: 'Height in cm', value: getSettings().heightCm || '' });
    const save = ui.el('button', { class: 'btn btn-primary btn-block', type: 'button' }, 'Save');
    save.addEventListener('click', async () => {
      const cm = Number(input.value);
      if (!Number.isFinite(cm) || cm < 100 || cm > 230) {
        ui.toast('Enter a height between 100 and 230 cm.', 'info');
        return;
      }
      await saveSettings({ heightCm: Math.round(cm) });
      close();
      render(root, state);
    });
    wrap.append(input, save);
    return wrap;
  });
}
