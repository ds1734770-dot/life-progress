/**
 * Backup - export everything as one JSON file, and decide when to nudge the
 * user to do it. Because all data lives only on this device, a lost phone
 * means lost data; a gentle weekly reminder is the cheapest insurance.
 */
import { dbExportAll } from './db.js';
import { saveSettings } from './settings.js';
import * as photos from './photos.js';
import * as ui from './ui.js';
import { addDays, todayKey } from './utils.js';

export const BACKUP_EVERY_DAYS = 7;
export const SNOOZE_DAYS = 3;
const DAY = 86400000;

/**
 * Should the dashboard show the backup banner?
 * @param {{lastBackupAt:number|null, backupSnoozeUntil:number|null}} settings
 * @param {string|null} oldestActivityDate date key of the oldest record (null = no data)
 */
export function backupDue(settings, oldestActivityDate, now = Date.now(), today = todayKey()) {
  if (!oldestActivityDate) return false; // nothing worth saving yet
  if (settings.backupSnoozeUntil && now < settings.backupSnoozeUntil) return false;
  if (settings.lastBackupAt) return now - settings.lastBackupAt >= BACKUP_EVERY_DAYS * DAY;
  return oldestActivityDate <= addDays(today, -BACKUP_EVERY_DAYS); // first nudge after a week of use
}

export async function snoozeBackupNudge(now = Date.now()) {
  await saveSettings({ backupSnoozeUntil: now + SNOOZE_DAYS * DAY });
}

export async function exportBackup() {
  try {
    const dump = await dbExportAll(async (record) => ({
      ...record,
      blob: await photos.blobToDataURL(record.blob),
      thumb: await photos.blobToDataURL(record.thumb),
    }));
    // V1.1: the custom avatar image is a Blob in the settings record —
    // serialize it to a data URL so it survives the JSON round-trip.
    const settingsRecord = dump.data.settings?.[0];
    if (settingsRecord && settingsRecord.avatarImage instanceof Blob) {
      settingsRecord.avatarImage = await photos.blobToDataURL(settingsRecord.avatarImage);
    }
    // V2.1 — notification wallpaper prefs participate in export, but only as
    // PREFERENCES (§17): bundled assets are not exported, and the custom
    // photo is device-local — its blob never enters the JSON backup. If an
    // appearance record somehow carries a blob (defensive), strip it here.
    const appearanceRecord = dump.data.notificationState?.find((r) => r?.id === 'appearance');
    if (appearanceRecord) appearanceRecord.recent = appearanceRecord.recent || [];
    dump.data.notificationState = (dump.data.notificationState || []).filter((r) => r?.id !== 'wallpaper-custom');
    const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `life-progress-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    await saveSettings({ lastBackupAt: Date.now() });
    ui.toast('Backup downloaded', 'success');
  } catch (err) {
    console.error(err);
    ui.toast('Export failed.', 'danger');
  }
}
