/**
 * Router — hash-based navigation. Every major feature is a dedicated screen.
 *
 * Routes:
 *   #/dashboard  #/water  #/gym  #/goals  #/journal  #/history  #/settings
 *   #/photos              #/photos/compare        #/journal/edit
 */
import { mount as mountDashboard } from './screens/dashboard.js';
import { mount as mountWater } from './screens/water.js';
import { mount as mountGym } from './screens/gym.js';
import { mount as mountGoals } from './screens/goals.js';
import { mount as mountJournal } from './screens/journal.js';
import { mount as mountHistory } from './screens/history.js';
import { mount as mountSettings } from './screens/settings.js';
import { mount as mountAchievements } from './screens/achievements.js';
import { mount as mountAvatar } from './screens/avatar.js';
import { mount as mountPhotos } from './screens/photos.js';
import { icon } from './ui.js';
import { enhanceTabbar } from './tabbar-dock.js';

export const TABS = [
  { route: 'dashboard', label: 'Home', iconName: 'home' },
  { route: 'water', label: 'Water', iconName: 'droplet' },
  { route: 'gym', label: 'Gym', iconName: 'dumbbell' },
  { route: 'goals', label: 'Goals', iconName: 'target' },
  { route: 'journal', label: 'Journal', iconName: 'book' },
  { route: 'settings', label: 'Settings', iconName: 'settings' },
];

const SCREENS = {
  dashboard: { mount: mountDashboard },
  water: { mount: mountWater },
  gym: { mount: mountGym },
  goals: { mount: mountGoals },
  journal: { mount: mountJournal },
  history: { mount: mountHistory },
  achievements: { mount: mountAchievements },
  settings: { mount: mountSettings },
  avatar: { mount: mountAvatar },
  photos: { mount: mountPhotos },
  'photos/compare': { mount: mountPhotos, mode: 'compare' },
  'journal/edit': { mount: mountJournal, mode: 'edit' },
};

export function currentRouteName() {
  const hash = window.location.hash.replace(/^#\/?/, '');
  return hash || 'dashboard';
}

export function parseHash() {
  const hash = window.location.hash.replace(/^#\/?/, '');
  const [name, ...params] = hash.split('/').filter(Boolean);
  return { name: name || 'dashboard', params };
}

export async function navigate(target) {
  const { name, params } =
    typeof target === 'string' ? parsePath(target) : target;
  const fullKey = params && params.length ? `${name}/${params.join('/')}` : name;
  const def = SCREENS[fullKey] || SCREENS[name];
  if (!def) {
    // Unknown route: fall back to the dashboard instead of crashing.
    console.warn(`[LifeProgress] Unknown route: ${fullKey}`);
    window.location.hash = '#/dashboard';
    return;
  }
  const root = document.getElementById('screen-root');

  // Fresh screen-enter animation on each navigation.
  root.classList.remove('screen-enter');
  root.replaceChildren();
  void root.offsetWidth;
  root.classList.add('screen-enter');

  await def.mount(root, params, def.mode);
  updateTabbar(name);
  window.scrollTo(0, 0);
}

function parsePath(target) {
  const [name, ...params] = target.replace(/^#\/?/, '').split('/').filter(Boolean);
  return { name: name || 'dashboard', params };
}

export function go(path) {
  if (parsePath(path).name === currentRouteName()) {
    navigate(path); // same route: force re-render
  } else {
    window.location.hash = `#/${path.replace(/^#\/?/, '')}`;
  }
}

let dockHandle = null;

export function updateTabbar(name) {
  const active = name === 'photos' || name === 'journal' ? (name === 'photos' ? 'gym' : 'journal') : name;
  document.querySelectorAll('.tab-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.route === active);
    item.setAttribute('aria-current', item.dataset.route === active ? 'page' : 'false');
  });
  // V1.1 — the active capsule slides to the new destination after the
  // route state (.active / aria-current) has been updated.
  dockHandle?.moveCapsule();
}

export function renderTabbar() {
  const bar = document.getElementById('tabbar');
  bar.replaceChildren(
    ...TABS.map((tab) => {
      const btn = document.createElement('button');
      btn.className = 'tab-item';
      btn.dataset.route = tab.route;
      btn.setAttribute('aria-label', tab.label);
      btn.innerHTML = `<span class="tab-icon">${icon(tab.iconName, 22)}</span><span class="tab-label">${tab.label}</span>`;
      btn.addEventListener('click', () => {
        if (currentRouteName() !== tab.route) window.location.hash = `#/${tab.route}`;
      });
      return btn;
    })
  );
  // V1.1 — floating dock + sliding active capsule on the existing items
  // (guarded; the bar is only rendered once per session, and renderTabbar's
  // replaceChildren above wipes any previous dock state, so re-enhancing is
  // safe). The entrance is primed here and plays on the next frame — after
  // the launch experience has finished, so the two never compete.
  dockHandle?.destroy();
  dockHandle = enhanceTabbar(bar);
  dockHandle.primeEntrance();
  requestAnimationFrame(() => dockHandle?.playEntrance());
}

let lastRoute = null;

window.addEventListener('hashchange', () => {
  const name = currentRouteName();
  const previous = lastRoute;
  lastRoute = name;
  // Return to an already-mounted dashboard → re-render it so summaries,
  // the progress ring and the goal list reflect changes made elsewhere.
  if (name === 'dashboard' && previous === 'dashboard' && document.querySelector('#dash-hero')) {
    navigate('dashboard');
    return;
  }
  navigate(name);
});