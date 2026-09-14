/**
 * Settings → Notifications (V1.5).
 *
 * Pure presentation + user actions; every rule lives in js/notifications.js.
 * Rendered into the #notif-section host that settings.js provides, so the
 * existing Settings screen keeps its own layout untouched. Toggle UX uses the
 * design system's .switch; permission is only ever requested from an explicit
 * user tap (master toggle or test notification) — never at startup.
 */

import { getSettings } from '../settings.js';
import * as notif from '../notifications.js';
import * as ui from '../ui.js';

/** Category rows: icon, label, sub. Order matches notif.CATEGORIES. */
const CATEGORY_META = {
  water: { icon: 'droplet', label: 'Water', sub: 'Nudge when today’s target isn’t reached yet' },
  gym: { icon: 'dumbbell', label: 'Gym', sub: 'Gentle reminder after a few rest days' },
  goals: { icon: 'target', label: 'Goals', sub: 'What’s left for today' },
  journal: { icon: 'book', label: 'Journal', sub: 'An evening check-in prompt' },
  streaks: { icon: 'flame', label: 'Streaks', sub: 'Encouragement while a streak is alive' },
  achievements: { icon: 'star', label: 'Achievements', sub: 'Celebrate new badges' },
};

/** Reminders with a configurable time (streaks/achievements are event-based). */
const TIMED_CATEGORIES = ['water', 'gym', 'goals', 'journal'];

/**
 * Mount into the host element inside the Settings screen. Re-renders only its
 * own subtree, so the surrounding Settings layout never flashes.
 */
export function mountNotifications(root) {
  const host = root.querySelector('#notif-section');
  if (!host) return;
  renderNotifications(root, host);
  ui.bindActions(host, {
    'notif-toggle': () => toggleNotifications(root, host),
    'notif-category': (d) => toggleCategory(root, host, d.category),
    'notif-time': (d) => openReminderTimeSheet(root, host, d.category),
    'notif-quiet': () => openQuietHoursSheet(root, host),
    'notif-test': () => sendTest(root, host),
  });
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

async function renderNotifications(root, host) {
  let prefs;
  try {
    prefs = await notif.getNotificationPrefs();
  } catch {
    host.replaceChildren();
    return;
  }
  const perm = notif.permissionState();
  const supported = notif.notificationsSupported();
  const permNote = {
    unsupported: 'This browser doesn’t support notifications.',
    denied: 'Notifications are blocked in your browser settings.',
    default: 'Permission is requested only when you turn reminders on.',
    granted: 'Permission granted — reminders follow your settings.',
  }[perm];

  const categoryRows = notif.CATEGORIES.map((c) => {
    const meta = CATEGORY_META[c];
    const on = prefs.categories[c];
    const timeRow = TIMED_CATEGORIES.includes(c)
      ? `<button class="notif-time-row pressable" data-action="notif-time" data-category="${c}"
             aria-label="Reminder time for ${meta.label}, currently ${notif.formatTime12h(prefs.times[c])}">
           <span>Reminder time</span>
           <span class="notif-time-value">${notif.formatTime12h(prefs.times[c])}</span>
         </button>`
      : '';
    return `
      <div class="notif-category${on ? '' : ' off'}">
        <div class="settings-row">
          <div class="settings-row-icon">${ui.icon(meta.icon, 18)}</div>
          <div class="settings-row-main">
            <div class="settings-row-title">${meta.label}</div>
            <div class="settings-row-sub">${meta.sub}</div>
          </div>
          <button class="switch${on ? ' on' : ''}" role="switch" aria-checked="${on}"
                  aria-label="${meta.label} reminders" data-action="notif-category" data-category="${c}"></button>
        </div>
        ${on ? timeRow : ''}
      </div>`;
  }).join('');

  host.innerHTML = `
    <section class="section stagger">
      <h3 class="section-title" style="font-size:var(--fs-lg)">Notifications</h3>
      <div class="muted" style="font-size:var(--fs-xs);margin:-2px 2px 10px">
        Stay consistent without the noise — only reminders you actually need.
      </div>
      <div class="settings-group">
        <div class="settings-row">
          <div class="settings-row-icon" style="background:color-mix(in srgb,var(--accent) 12%,transparent);color:var(--accent)">${ui.icon('bell', 18)}</div>
          <div class="settings-row-main">
            <div class="settings-row-title">Reminders</div>
            <div class="settings-row-sub" id="notif-perm-note">${permNote}</div>
          </div>
          <button class="switch${prefs.enabled ? ' on' : ''}" role="switch" aria-checked="${prefs.enabled}"
                  aria-label="Notifications" data-action="notif-toggle" ${supported ? '' : 'disabled'}></button>
        </div>
        ${prefs.enabled
          ? `<div class="notif-categories">
               ${categoryRows}
               <div class="settings-row">
                 <div class="settings-row-icon">${ui.icon('moon', 18)}</div>
                 <div class="settings-row-main">
                   <div class="settings-row-title">Quiet hours</div>
                   <div class="settings-row-sub">No reminders during this window</div>
                 </div>
                 <button class="btn btn-ghost btn-sm" data-action="notif-quiet" aria-label="Edit quiet hours">
                   ${notif.formatTime12h(prefs.quietStart)} – ${notif.formatTime12h(prefs.quietEnd)}
                 </button>
               </div>
             </div>
             <div class="settings-row">
               <div class="settings-row-icon">${ui.icon('send', 18)}</div>
               <div class="settings-row-main">
                 <div class="settings-row-title">Try it now</div>
                 <div class="settings-row-sub">Send a test notification</div>
               </div>
               <button class="btn btn-ghost btn-sm" data-action="notif-test">Send</button>
             </div>`
          : ''}
      </div>
      ${prefs.enabled && perm === 'denied'
        ? `<div class="notif-denied-note">Reminders are on, but your browser is blocking notifications. Allow them for this site in the browser’s site settings.</div>`
        : ''}
    </section>`;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Master toggle: one of only two places that ever requests permission. */
async function toggleNotifications(root, host) {
  const prefs = await notif.getNotificationPrefs();
  const enabling = !prefs.enabled;
  if (enabling) {
    const state = notif.permissionState();
    if (state === 'unsupported') {
      ui.toast('Notifications aren’t supported in this browser.', 'info');
      return;
    }
    if (state === 'denied') {
      ui.toast('Notifications are blocked in your browser settings.', 'info');
      return;
    }
    if (state === 'default') {
      const result = await notif.requestPermission();
      if (result !== 'granted') {
        ui.toast('No problem — you can enable reminders anytime.', 'info');
        renderNotifications(root, host); // stays OFF; permission unchanged
        return;
      }
    }
  }
  await notif.saveNotificationPrefs({ enabled: enabling });
  ui.haptic();
  ui.toast(enabling ? 'Reminders on — set them up below' : 'Reminders off', enabling ? 'success' : 'info');
  renderNotifications(root, host);
}

async function toggleCategory(root, host, category) {
  const prefs = await notif.getNotificationPrefs();
  await notif.saveNotificationPrefs({ categories: { ...prefs.categories, [category]: !prefs.categories[category] } });
  ui.haptic();
  renderNotifications(root, host);
}

/** "HH:MM" editor in the existing sheet pattern (native time control). */
function openTimeSheet({ title, value, onSave }) {
  ui.openSheet((close) => {
    const wrap = ui.el('div', { class: 'flex-col' });
    wrap.append(ui.el('h2', { style: { fontSize: 'var(--fs-xl)', fontWeight: 800 } }, title));
    const input = ui.el('input', {
      class: 'input',
      type: 'time',
      value,
      style: { padding: '12px', fontSize: 'var(--fs-lg)', fontWeight: 700 },
    });
    const save = ui.el('button', { class: 'btn btn-primary btn-block', type: 'button' }, 'Save');
    save.addEventListener('click', async () => {
      if (!notif.isValidTime(input.value)) {
        ui.toast('Choose a valid time.', 'info');
        return;
      }
      await onSave(input.value);
      ui.haptic();
      close();
    });
    wrap.append(input, save);
    return wrap;
  });
}

async function openReminderTimeSheet(root, host, category) {
  const prefs = await notif.getNotificationPrefs();
  openTimeSheet({
    title: `${CATEGORY_META[category].label} reminder time`,
    value: prefs.times[category],
    onSave: async (t) => {
      await notif.saveNotificationPrefs({ times: { ...prefs.times, [category]: t } });
      ui.toast('Reminder time updated', 'success');
      renderNotifications(root, host);
    },
  });
}

async function openQuietHoursSheet(root, host) {
  const prefs = await notif.getNotificationPrefs();
  ui.openSheet((close) => {
    const wrap = ui.el('div', { class: 'flex-col', style: { gap: '14px' } });
    wrap.append(ui.el('h2', { style: { fontSize: 'var(--fs-xl)', fontWeight: 800 } }, 'Quiet hours'));
    wrap.append(
      ui.el('div', { class: 'muted', style: { fontSize: 'var(--fs-sm)' } },
        'No reminders are delivered during this window — even across midnight.')
    );
    const row = (label, value) => {
      const r = ui.el('div', { class: 'flex-row', style: { gap: '10px', alignItems: 'center' } });
      r.append(ui.el('span', { style: { fontWeight: 700, minWidth: '52px' } }, label));
      r.append(ui.el('input', { class: 'input', type: 'time', value, style: { flex: 1, padding: '10px' } }));
      return r;
    };
    const startRow = row('From', prefs.quietStart);
    const endRow = row('Until', prefs.quietEnd);
    const save = ui.el('button', { class: 'btn btn-primary btn-block', type: 'button' }, 'Save');
    save.addEventListener('click', async () => {
      const start = startRow.querySelector('input').value;
      const end = endRow.querySelector('input').value;
      if (!notif.isValidTime(start) || !notif.isValidTime(end)) {
        ui.toast('Choose valid times.', 'info');
        return;
      }
      await notif.saveNotificationPrefs({ quietStart: start, quietEnd: end });
      ui.toast('Quiet hours updated', 'success');
      close();
      renderNotifications(root, host);
    });
    wrap.append(startRow, endRow, save);
    return wrap;
  });
}

async function sendTest(root, host) {
  const result = await notif.sendTestNotification();
  if (result.ok) {
    ui.toast('Test notification sent — check your notifications', 'success');
  } else if (result.reason === 'unsupported') {
    ui.toast('This browser doesn’t support notifications.', 'info');
  } else if (result.reason === 'denied') {
    ui.toast('Notifications are blocked in your browser settings.', 'info');
  } else {
    ui.toast('Permission not granted — reminders stay off.', 'info');
  }
  renderNotifications(root, host);
}
