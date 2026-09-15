/**
 * Settings → Notifications (V1.5 + V1.6).
 *
 * Pure presentation + user actions; every rule lives in js/notifications.js
 * and js/pushClient.js. Rendered into the #notif-section host that settings.js
 * provides, so the existing Settings screen keeps its own layout untouched.
 * Toggle UX uses the design system's .switch; permission is only ever
 * requested from an explicit user tap (master toggle or test notification) —
 * never at startup.
 *
 * V1.6 adds the background-delivery status block (§33): honest states for
 * enabled/active, pending sync, permission denied, unsupported browser and
 * errors — never a fake "active".
 */

import * as notif from '../notifications.js';
import * as ui from '../ui.js';

const pushClient = () => import('../pushClient.js');

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
    'notif-diagnostics': () => openDiagnosticsSheet(host),
  });
}

// ---------------------------------------------------------------------------
// Delivery status (§21/§33) — nine DISTINCT states, never conflated.
// `blocker` comes from pushClient.capabilityBlocker (true capability or
// installation problems); `pushState` carries the setup/registration state.
// A supported-but-not-yet-enabled browser reads "Ready to set up", never
// "unsupported".
// ---------------------------------------------------------------------------

/** Map the persisted push state to the UI row. Pure. */
export function deliveryStatusFor(pushState, perm, supported, blocker = null) {
  // Capability/installation problems first — they override setup state.
  if (blocker?.state === 'insecure') {
    return { tone: 'warn', icon: 'lock', label: 'Background reminders need a secure connection', detail: 'Open Life Progress over https (or localhost) to enable them.' };
  }
  if (blocker?.state === 'install-required') {
    return { tone: 'warn', icon: 'download', label: blocker.reason, detail: blocker.hint || 'Use Safari → Share → “Add to Home Screen”, then enable reminders from the installed app.' };
  }
  if (blocker?.state === 'unsupported') {
    return { tone: 'warn', icon: 'alert', label: 'Background reminders aren’t supported on this browser', detail: blocker.reason || 'In-app reminders still work while Life Progress is open.' };
  }
  if (perm === 'denied') {
    return { tone: 'warn', icon: 'alert', label: 'Notifications are disabled', detail: 'Allow notifications for this site in your browser settings to receive reminders.' };
  }
  switch (pushState?.status) {
    case 'active':
      return { tone: 'ok', icon: 'check', label: 'Background reminders active', detail: 'Reminders arrive even when Life Progress is closed.' };
    case 'pending':
      return { tone: 'warn', icon: 'refresh', label: 'Setting up background reminders…', detail: 'Your reminder is saved locally and syncs when the notification server is reachable.' };
    case 'insecure':
      return { tone: 'warn', icon: 'lock', label: 'Background reminders need a secure connection', detail: 'Open Life Progress over https (or localhost) to enable them.' };
    case 'install-required':
      return { tone: 'warn', icon: 'download', label: pushState?.reason || 'Install Life Progress on your Home Screen to enable background reminders.', detail: pushState?.hint || 'Use Safari → Share → “Add to Home Screen”, then enable reminders from the installed app.' };
    case 'error':
      return { tone: 'warn', icon: 'alert', label: 'Couldn’t activate background reminders. Your reminder is saved locally.', detail: pushState?.reason || 'Try again from a connected device.' };
    case 'unsupported':
      return { tone: 'warn', icon: 'alert', label: 'Background reminders aren’t supported on this browser', detail: pushState?.reason || 'In-app reminders still work while Life Progress is open.' };
    default:
      // Supported browser, nothing set up yet (or master off): ready — NOT unsupported.
      return { tone: 'muted', icon: 'bell', label: 'Background reminders are ready to set up', detail: 'Turn reminders on below to activate them.' };
  }
}

/** Diagnostics sheet (§29): every setup stage observed, in plain order. */
async function openDiagnosticsSheet(host) {
  const pushClient = await import('../pushClient.js');
  const r = await pushClient.pushReadiness();
  const line = (label, value) => {
    const good = value === true || value === 'granted' || value === 'active' || value === 'registered' || value === 'reachable';
    const bad = value === false || /unavailable|unreachable|error|denied|none/i.test(String(value));
    const color = good ? 'var(--success, #2fbf71)' : bad ? 'var(--warning)' : 'var(--text-2)';
    return `<div class="settings-row" style="padding-block:8px">
      <div class="settings-row-main">
        <div class="settings-row-title" style="font-size:var(--fs-sm)">${label}</div>
      </div>
      <span style="font-weight:700;font-size:var(--fs-sm);color:${color}">${typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value)}</span>
    </div>`;
  };
  ui.openSheet((close) => {
    const wrap = ui.el('div', { class: 'flex-col', style: { gap: '6px' } });
    wrap.append(ui.el('h2', { style: { fontSize: 'var(--fs-xl)', fontWeight: 800 } }, 'Background reminders diagnostics'));
    wrap.append(ui.el('div', { class: 'muted', style: { fontSize: 'var(--fs-sm)', lineHeight: 1.6 } },
      'Everything checked below is observed from this device only. Share this screen with support if reminders don’t arrive.'));
    const box = ui.el('div', { class: 'settings-group', style: { marginTop: '8px' } });
    box.innerHTML = [
      line('Secure connection (https / localhost)', r.secureContext),
      line('Service worker support', r.serviceWorkerApi),
      line('Notifications support', r.notificationsApi),
      line('Background push support', r.pushApi),
      line('Notification permission', r.notificationPermission),
      line('Installed as app (standalone)', r.standalone),
      line('Platform is iOS/iPadOS', r.ios),
      line('Service worker registration', r.serviceWorker),
      line('Push manager on registration', r.pushManagerOnRegistration),
      line('Push subscription', r.subscription),
      line('Server registration', r.serverRegistration),
      line('Notification server reachability', r.vapid),
      line('Background reminders state', r.backgroundReminders),
    ].join('');
    const done = ui.el('button', { class: 'btn btn-primary btn-block', type: 'button', style: { marginTop: '10px' } }, 'Done');
    done.addEventListener('click', () => close());
    wrap.append(box, done);
    return wrap;
  });
}

function statusRowMarkup(status) {
  const color = { ok: 'var(--success, #2fbf71)', warn: 'var(--warning)', muted: 'var(--text-2)' }[status.tone] || 'var(--text-2)';
  return `
    <div class="settings-row notif-status" data-status="${status.tone}">
      <div class="settings-row-icon" style="background:color-mix(in srgb,${color} 12%,transparent);color:${color}">${ui.icon(status.icon, 18)}</div>
      <div class="settings-row-main">
        <div class="settings-row-title">${ui.escapeHtml(status.label)}</div>
        <div class="settings-row-sub">${ui.escapeHtml(status.detail || '')}</div>
      </div>
    </div>`;
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
  const pushMod = await pushClient();
  const pushState = await pushMod.currentPushState().catch(() => ({ status: 'off' }));
  // Capability blockers (insecure / unsupported / iOS install-required) are
  // computed live so a stale persisted status can never mislabel a working
  // browser — the current environment always wins for these states.
  const blocker = pushMod.capabilityBlocker(pushMod.pushCapabilities());
  const status = deliveryStatusFor(pushState, perm, supported, blocker);
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
        ${prefs.enabled ? statusRowMarkup(status) : ''}
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
        <button class="settings-row pressable" data-action="notif-diagnostics" style="text-align:left;background:transparent;border:none;width:100%" aria-label="Open background reminders diagnostics">
          <div class="settings-row-icon">${ui.icon('alert', 18)}</div>
          <div class="settings-row-main">
            <div class="settings-row-title">Diagnostics</div>
            <div class="settings-row-sub">Check background reminder setup on this device</div>
          </div>
          ${ui.icon('chevron-right', 18)}
        </button>
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
    // V1.6.1 — check capability/installation BEFORE requesting anything, so
    // an iOS Safari tab gets the Home Screen guidance instead of a dead end.
    const pc = await pushClient();
    const blocker = pc.capabilityBlocker(pc.pushCapabilities());
    if (blocker) {
      await notif.saveNotificationPrefs({ enabled: true }); // local reminders stay useful
      await pc.saveBlockerState(blocker).catch(() => {});
      ui.toast(blocker.reason, 'info');
      renderNotifications(root, host);
      return;
    }
    // V1.6 — register background push NOW, from this explicit user action.
    ui.toast('Setting up background reminders…', 'info');
    const nextPrefs = await notif.saveNotificationPrefs({ enabled: true });
    const reg = await pc.subscribeAndRegister(nextPrefs).catch((err) => ({ ok: false, state: { status: 'error', reason: String(err?.message || err) } }));
    ui.haptic();
    if (reg.ok) {
      ui.toast('Background reminders active', 'success');
    } else if (reg.state?.status === 'pending') {
      ui.toast('Reminder saved — will sync when the server is reachable', 'info');
    } else if (reg.state?.status === 'install-required') {
      ui.toast(reg.state.reason || 'Install Life Progress on your Home Screen first.', 'info');
    } else if (reg.state?.status === 'unsupported' || reg.state?.status === 'insecure') {
      ui.toast(reg.state.reason || 'Background reminders aren’t available here.', 'info');
    } else {
      ui.toast('Reminder saved locally, but background delivery failed.', 'info');
    }
    renderNotifications(root, host);
    return;
  }

  // Disabling: stop background delivery too (§26 — no orphaned registrations).
  await notif.saveNotificationPrefs({ enabled: false });
  const { disablePush } = await pushClient();
  await disablePush().catch(() => {});
  ui.haptic();
  ui.toast('Reminders off', 'info');
  renderNotifications(root, host);
}

async function toggleCategory(root, host, category) {
  const prefs = await notif.getNotificationPrefs();
  const next = await notif.saveNotificationPrefs({ categories: { ...prefs.categories, [category]: !prefs.categories[category] } });
  ui.haptic();
  // Keep the server schedule in step with the new category state (§8).
  pushClient()
    .then((m) => m.syncPushRegistration(next))
    .catch(() => {});
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
      const next = await notif.saveNotificationPrefs({ times: { ...prefs.times, [category]: t } });
      ui.toast('Reminder time updated', 'success');
      // Re-register so the server schedules the new time (§8/§21).
      pushClient()
        .then((m) => m.syncPushRegistration(next))
        .catch(() => {});
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
      const next = await notif.saveNotificationPrefs({ quietStart: start, quietEnd: end });
      ui.toast('Quiet hours updated', 'success');
      close();
      pushClient()
        .then((m) => m.syncPushRegistration(next))
        .catch(() => {});
      renderNotifications(root, host);
    });
    wrap.append(startRow, endRow, save);
    return wrap;
  });
}

async function sendTest(root, host) {
  const result = await notif.sendTestNotification();
  if (result.ok) {
    // §14 — say exactly which path delivered: real push vs local-only.
    ui.toast(result.via === 'push'
      ? 'Test sent through the real push path — check your notifications'
      : 'Background push unavailable — local test only', 'success');
  } else if (result.reason === 'unsupported') {
    ui.toast('This browser doesn’t support notifications.', 'info');
  } else if (result.reason === 'denied') {
    ui.toast('Notifications are blocked in your browser settings.', 'info');
  } else if (result.reason === 'not-registered') {
    ui.toast('Background reminders aren’t active yet — turn reminders on first.', 'info');
  } else if (String(result.reason).startsWith('push-failed')) {
    ui.toast('The push server couldn’t deliver the test. Check that the notification server is running.', 'info');
  } else {
    ui.toast('Permission not granted — reminders stay off.', 'info');
  }
  renderNotifications(root, host);
}
