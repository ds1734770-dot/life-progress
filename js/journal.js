/**
 * Journal domain logic — entries, search, streaks, stats.
 */
import { dbDelete, dbGet, dbGetAll, dbPut } from './db.js';
import { makeJournalEntry } from './models.js';
import { calculateStreak, todayKey } from './utils.js';

export async function getAllEntries() {
  return (await dbGetAll('journalEntries')).sort(
    (a, b) => (a.date === b.date ? b.createdAt - a.createdAt : b.date.localeCompare(a.date))
  );
}

export async function saveEntry(data) {
  if (data.id) {
    // Editing keeps the original entry id AND the original day — otherwise an
    // edit on a later day would silently move the entry in the timeline,
    // inflate the day count and break the streak.
    const existing = await dbGet('journalEntries', data.id);
    const entry = makeJournalEntry({
      ...existing,
      ...data,
      id: data.id,
      date: existing?.date || data.date || todayKey(),
      createdAt: existing?.createdAt || data.createdAt || Date.now(),
      updatedAt: Date.now(),
    });
    await dbPut('journalEntries', entry);
    return entry;
  }
  const entry = makeJournalEntry(data);
  await dbPut('journalEntries', entry);
  return entry;
}

export async function deleteEntry(id) {
  await dbDelete('journalEntries', id);
}

export function searchEntries(entries, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return entries;
  return entries.filter(
    (e) =>
      e.title.toLowerCase().includes(q) ||
      e.content.toLowerCase().includes(q) ||
      (e.tags || []).some((t) => t.toLowerCase().includes(q))
  );
}

export function journalStreak(entries) {
  // Days (de-duplicated), not entries — multiple entries in one day count once.
  return calculateStreak([...new Set(entries.map((e) => e.date))]);
}

export function journalStats(entries) {
  const month = todayKey().slice(0, 7);
  return {
    streak: journalStreak(entries),
    total: entries.length,
    thisMonth: entries.filter((e) => e.date.startsWith(month)).length,
  };
}

export function allTags(entries) {
  const set = new Set();
  for (const e of entries) for (const t of e.tags || []) set.add(t);
  return [...set].sort();
}

/** Group entries by date key, newest days first. */
export function groupByDay(entries) {
  const groups = new Map();
  for (const e of entries) {
    if (!groups.has(e.date)) groups.set(e.date, []);
    groups.get(e.date).push(e);
  }
  return [...groups.entries()];
}

export function entryPreview(entry, max = 110) {
  const text = entry.content || entry.title;
  return text.length > max ? text.slice(0, max).trimEnd() + '…' : text;
}