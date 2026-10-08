/**
 * Dashboard quotes. Built-in list + the user's own lines (Settings). Only
 * attributions that are well documented are kept; everything else is shown
 * unattributed rather than risk a wrong name.
 */

export const BUILT_IN_QUOTES = [
  { text: 'Discipline is choosing between what you want now and what you want most.', by: 'Abraham Lincoln' },
  { text: 'You don’t have to be extreme, just consistent.', by: '' },
  { text: 'Small progress is still progress.', by: '' },
  { text: 'The pain you feel today will be the strength you feel tomorrow.', by: '' },
  { text: 'Focus on being productive instead of busy.', by: 'Tim Ferriss' },
  { text: 'Push yourself, because no one else is going to do it for you.', by: '' },
  { text: 'Your future is created by what you do today, not tomorrow.', by: 'Robert Kiyosaki' },
  { text: 'The only bad workout is the one that didn’t happen.', by: '' },
  { text: 'We are what we repeatedly do. Excellence, then, is not an act but a habit.', by: 'Will Durant' },
  { text: 'It does not matter how slowly you go as long as you do not stop.', by: 'Confucius' },
  { text: 'A year from now you may wish you had started today.', by: 'Karen Lamb' },
  { text: 'Well done is better than well said.', by: 'Benjamin Franklin' },
  { text: 'Action is the foundational key to all success.', by: 'Pablo Picasso' },
  { text: 'Motivation gets you started. Habit keeps you going.', by: '' },
  { text: 'Do something today that your future self will thank you for.', by: '' },
  { text: 'One percent better every day.', by: '' },
  { text: 'Be stronger than your excuses.', by: '' },
  { text: 'Rest if you must, but don’t quit.', by: '' },
  { text: 'Hydrate, move, reflect. Repeat.', by: '' },
  { text: 'Progress, not perfection.', by: '' },
  { text: 'Start where you are. Use what you have. Do what you can.', by: 'Arthur Ashe' },
  { text: 'The secret of getting ahead is getting started.', by: 'Mark Twain' },
  { text: 'You are one workout away from a good mood.', by: '' },
  { text: 'What you do every day matters more than what you do once in a while.', by: 'Gretchen Rubin' },
  { text: 'Small habits, compounded, change everything.', by: '' },
  { text: 'Show up for yourself today.', by: '' },
  { text: 'Energy flows where attention goes.', by: '' },
  { text: 'Done is better than perfect.', by: '' },
  { text: 'Your body hears everything your mind says. Speak kindly.', by: '' },
  { text: 'Make today count.', by: '' },
];

export const CUSTOM_QUOTE_MAX = 140;
export const CUSTOM_QUOTES_LIMIT = 30;

/** Turn the textarea text into a clean list (trimmed, de-duplicated, capped). */
export function parseCustomQuotes(raw) {
  const lines = String(raw || '')
    .split('\n')
    .map((l) => l.trim().slice(0, CUSTOM_QUOTE_MAX))
    .filter(Boolean);
  return [...new Set(lines)].slice(0, CUSTOM_QUOTES_LIMIT);
}

function dayOfYear(date) {
  const start = new Date(date.getFullYear(), 0, 0);
  return Math.floor((date - start) / 86400000);
}

/**
 * Quote for a given day. With custom quotes present, they take the "main"
 * slots and a built-in appears every third day so the dashboard stays fresh.
 */
export function quoteOfTheDay(date = new Date(), custom = []) {
  const mine = (custom || []).filter((q) => typeof q === 'string' && q.trim());
  const n = dayOfYear(date);
  if (mine.length && n % 3 !== 2) {
    return { text: mine[n % mine.length], by: '' };
  }
  return BUILT_IN_QUOTES[n % BUILT_IN_QUOTES.length];
}
