/**
 * Journal extras — daily prompts, gratitude mode and "on this day" memories.
 * Pure helpers; no storage.
 */
import { addDays, todayKey } from './utils.js';

export const PROMPTS = [
  'What is one thing that went better than expected today?',
  'What are you proud of this week, however small?',
  'What drained your energy today, and what restored it?',
  'Describe a moment today you would like to remember.',
  'What is one thing you are avoiding, and what is the smallest first step?',
  'Who made your day better, and how could you thank them?',
  'What did your body need today? Did you listen?',
  'What would make tomorrow a 10 out of 10?',
  'What is something you learned recently?',
  'Write a note to yourself one year from now.',
  'What are you looking forward to?',
  'Which habit is helping you most right now?',
  'What would you do today if you were not afraid of failing?',
  'What does a good day look like for you?',
  'What are you letting go of?',
  'Name three small things that made you smile.',
  'What is a boundary you are glad you kept?',
  'How did you take care of yourself today?',
  'What is a goal that feels bigger than it did a month ago?',
  'What is one thing you could forgive yourself for?',
];

export const GRATITUDE_TEMPLATE = 'Three things I am grateful for today:\n1. \n2. \n3. ';

/** Stable prompt for a date (changes daily, same all day). */
export function dailyPrompt(date = todayKey()) {
  let h = 0;
  for (const ch of date) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PROMPTS[h % PROMPTS.length];
}

/**
 * Memories: entries from exactly 7 days, 30 days and 1–5 years ago (same
 * month/day). One entry per date (the most recently created).
 */
export function onThisDay(entries, today = todayKey()) {
  const byDate = new Map();
  for (const e of entries) {
    if (!byDate.has(e.date) || e.createdAt > byDate.get(e.date).createdAt) byDate.set(e.date, e);
  }
  const out = [];
  const push = (label, date) => {
    const entry = byDate.get(date);
    if (entry) out.push({ label, date, entry });
  };
  push('A week ago', addDays(today, -7));
  push('A month ago', addDays(today, -30));
  const [y, m, d] = today.split('-').map(Number);
  for (let back = 1; back <= 5; back++) {
    const key = `${y - back}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    push(back === 1 ? 'One year ago' : `${back} years ago`, key);
  }
  return out;
}
