import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LAUNCH_QUOTE,
  LAUNCH_QUOTE_MAX,
  sanitizeLaunchQuote,
  launchQuote,
  initialsFor,
  builtinAvatarList,
  isBuiltinAvatar,
  normalizeAvatar,
  defaultAvatar,
  avatarMarkup,
} from '../js/personalization.js';
import { defaultSettings } from '../js/models.js';
import { getSettings } from '../js/settings.js';

// ---------------------------------------------------------------------------
// Motivational launch quote
// ---------------------------------------------------------------------------

test('default quote is exactly "Don\'t forget why u started."', () => {
  assert.equal(DEFAULT_LAUNCH_QUOTE, "Don't forget why u started.");
  assert.equal(sanitizeLaunchQuote(''), DEFAULT_LAUNCH_QUOTE);
  assert.equal(sanitizeLaunchQuote(null), DEFAULT_LAUNCH_QUOTE);
  assert.equal(sanitizeLaunchQuote('   '), DEFAULT_LAUNCH_QUOTE);
  assert.equal(launchQuote({}), DEFAULT_LAUNCH_QUOTE);
  assert.equal(launchQuote(null), DEFAULT_LAUNCH_QUOTE);
  assert.equal(launchQuote({ launchQuote: '  ' }), DEFAULT_LAUNCH_QUOTE);
  // First-launch settings default to the exact required quote.
  assert.equal(defaultSettings().launchQuote, DEFAULT_LAUNCH_QUOTE);
  // Node-side cache (no DB) also resolves to the default quote.
  assert.equal(launchQuote(getSettings()), DEFAULT_LAUNCH_QUOTE);
});

test('sanitizeLaunchQuote collapses whitespace and trims', () => {
  assert.equal(sanitizeLaunchQuote('  Discipline   today.\n\nKeep going. '), 'Discipline today. Keep going.');
});

test('custom quote persists through the settings shape', () => {
  assert.equal(launchQuote({ launchQuote: 'Small steps. Big results.' }), 'Small steps. Big results.');
  assert.equal(launchQuote({ launchQuote: '  Discipline today creates a better tomorrow. ' }), 'Discipline today creates a better tomorrow.');
});

test('reset restores the default quote', () => {
  const s = { launchQuote: 'Custom words' };
  assert.equal(launchQuote(s), 'Custom words');
  s.launchQuote = DEFAULT_LAUNCH_QUOTE;
  assert.equal(launchQuote(s), DEFAULT_LAUNCH_QUOTE);
});

test('very long quotes are hard-capped and still render', () => {
  const long = 'ab '.repeat(200); // 600 chars
  const capped = sanitizeLaunchQuote(long);
  assert.ok(capped.length <= LAUNCH_QUOTE_MAX, `capped length ${capped.length} > ${LAUNCH_QUOTE_MAX}`);
  assert.ok(capped.length >= LAUNCH_QUOTE_MAX - 3, 'cap should keep nearly the whole window');
  // No trailing space from slicing.
  assert.ok(!capped.endsWith(' '));
  assert.equal(launchQuote({ launchQuote: long }), capped);
});

test('LAUNCH_QUOTE_MAX is sensible for a phone screen', () => {
  assert.ok(LAUNCH_QUOTE_MAX >= 60 && LAUNCH_QUOTE_MAX <= 160);
});

// ---------------------------------------------------------------------------
// Initials
// ---------------------------------------------------------------------------

test('initials use the first two words, uppercased', () => {
  assert.equal(initialsFor('Santhosh Kumar'), 'SK');
  assert.equal(initialsFor('alex'), 'A');
  assert.equal(initialsFor('  mary   jane  watson '), 'MJ');
  assert.equal(initialsFor(''), '');
  assert.equal(initialsFor(null), '');
  // Non-Latin scripts still produce a usable initial.
  assert.equal(initialsFor('李明'), '李');
});

// ---------------------------------------------------------------------------
// Built-in avatars
// ---------------------------------------------------------------------------

test('built-in avatar collection is varied and offline-safe', () => {
  const list = builtinAvatarList();
  assert.ok(list.length >= 6, 'need a real collection');
  const ids = new Set(list.map((a) => a.id));
  assert.equal(ids.size, list.length, 'ids unique');
  for (const a of list) {
    assert.ok(a.id && a.label);
    assert.equal(isBuiltinAvatar(a.id), true);
  }
  assert.equal(isBuiltinAvatar('not-a-real-avatar'), false);
});

// ---------------------------------------------------------------------------
// Avatar normalization (persistence + import hardening)
// ---------------------------------------------------------------------------

test('default avatar is a built-in', () => {
  const d = defaultAvatar();
  assert.equal(d.type, 'builtin');
  assert.equal(isBuiltinAvatar(d.value), true);
  assert.equal(normalizeAvatar(undefined).type, 'builtin');
  assert.equal(normalizeAvatar(null).type, 'builtin');
  assert.equal(normalizeAvatar('junk').type, 'builtin');
});

test('normalizeAvatar keeps valid selections and repairs invalid ones', () => {
  assert.deepEqual(normalizeAvatar({ type: 'builtin', value: 'dusk' }), { type: 'builtin', value: 'dusk' });
  assert.deepEqual(normalizeAvatar({ type: 'initials', value: 'XY' }), { type: 'initials', value: '' });
  assert.deepEqual(normalizeAvatar({ type: 'custom', value: 'whatever' }), { type: 'custom', value: '' });
  // Unknown builtin id → default; unknown type → default.
  assert.deepEqual(normalizeAvatar({ type: 'builtin', value: 'ghost' }), defaultAvatar());
  assert.deepEqual(normalizeAvatar({ type: 'telepathy', value: 'x' }), defaultAvatar());
});

test('defaultSettings carries V1.1 personalization fields', () => {
  const s = defaultSettings();
  assert.equal(s.launchQuote, DEFAULT_LAUNCH_QUOTE);
  assert.deepEqual(s.avatar, defaultAvatar());
  assert.equal(s.avatarImage, null);
});

// ---------------------------------------------------------------------------
// Avatar markup (DOM-level builders — string assertions only, no rendering)
// ---------------------------------------------------------------------------

test('avatarMarkup renders built-in SVG, initials and fallbacks in order', () => {
  const builtin = avatarMarkup({ avatar: { type: 'builtin', value: 'sunrise' } });
  assert.match(builtin, /<svg/);
  assert.match(builtin, /class="avatar/);

  const initials = avatarMarkup({ name: 'Santhosh Kumar', avatar: { type: 'initials', value: '' } });
  assert.match(initials, />SK</);

  // Custom without an image and without a name → default built-in.
  const customNoImage = avatarMarkup({ name: '', avatar: { type: 'custom', value: '' } });
  assert.match(customNoImage, /<svg/);

  // Custom without an image but with a name → initials fallback.
  const customWithName = avatarMarkup({ name: 'Alex', avatar: { type: 'custom', value: '' } });
  assert.match(customWithName, />A</);
});

test('avatarMarkup sizes scale the initials font', () => {
  const small = avatarMarkup({ name: 'Alex', avatar: { type: 'initials', value: '' } }, 42);
  const large = avatarMarkup({ name: 'Alex', avatar: { type: 'initials', value: '' } }, 84);
  assert.match(small, /font-size:1[78]px/);
  assert.match(large, /font-size:3[45]px/);
});
