/**
 * First-launch onboarding — short, polished, asks only what's needed:
 * name, water target, theme, inspirational background.
 */
import { saveSettings } from './settings.js';
import { pickFromGallery, readFileAsDataURL, icon, el, toast, haptic } from './ui.js';
import { processImage } from './photos.js';
import { themeOptions } from './models.js';

const STEPS = [
  {
    iconName: 'sparkles',
    title: 'Build your day.',
    sub: 'Track your progress. Become better every day.',
    build: () => null,
  },
  {
    iconName: 'home',
    title: 'What should we call you?',
    sub: 'Your dashboard will greet you personally.',
    build: (state) =>
      el('input', {
        class: 'input',
        type: 'text',
        placeholder: 'Your name',
        value: state.name,
        id: 'ob-name',
        maxlength: '40',
      }),
  },
  {
    iconName: 'droplet',
    title: 'How much water per day?',
    sub: 'A healthy goal to keep you hydrated. You can change it later.',
    build: (state) => {
      const wrap = el('div', { class: 'chip-grid' });
      for (const ml of [1000, 1500, 2000, 2500, 3000, 3500, 4000]) {
        const chip = el('button', {
          class: `chip ${state.waterTarget === ml ? 'active' : ''}`,
          type: 'button',
          dataset: { ml: String(ml) },
        }, ml >= 1000 ? `${ml / 1000} L` : `${ml} ml`);
        chip.addEventListener('click', () => {
          state.waterTarget = ml;
          wrap.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
          haptic();
        });
        wrap.append(chip);
      }
      return wrap;
    },
  },
  {
    iconName: 'settings',
    title: 'Choose your look.',
    sub: 'A calm dark theme is the default — pick what feels right.',
    build: (state) => {
      const wrap = el('div', { class: 'chip-grid' });
      for (const opt of themeOptions()) {
        const chip = el('button', {
          class: `chip ${state.theme === opt.value ? 'active' : ''}`,
          type: 'button',
          dataset: { theme: opt.value },
        }, opt.label);
        chip.addEventListener('click', () => {
          state.theme = opt.value;
          wrap.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
          saveSettings({ theme: state.theme });
          haptic();
        });
        wrap.append(chip);
      }
      return wrap;
    },
  },
  {
    iconName: 'image',
    title: 'Your space, your vibe.',
    sub: 'Pick an inspirational image for your dashboard. Skip to start with a clean gradient.',
    build: (state) => {
      const wrap = el('div', { class: 'flex-col' });
      const preview = el('div', {
        class: 'card card-tight',
        style: {
          minHeight: 120,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          flexDirection: 'column',
          background: state.backgroundImage
            ? `url(${state.backgroundImage.dataUrl}) center/cover`
            : 'var(--surface-2)',
          color: 'var(--text-2)',
          fontWeight: 600,
          fontSize: 'var(--fs-sm)',
        },
      }, state.backgroundImage ? 'Background set ✓' : 'No background yet');
      const pickBtn = el('button', { class: 'btn btn-primary btn-block', type: 'button' }, icon('image', 18) + ' Choose from gallery');
      pickBtn.addEventListener('click', async () => {
        const file = await pickFromGallery('image/*');
        if (!file) return;
        try {
          const blob = await processImage(file, 1600, 0.82);
          const dataUrl = await readFileAsDataURL(blob);
          state.backgroundImage = { dataUrl, name: file.name };
          preview.style.background = `url(${dataUrl}) center/cover`;
          preview.textContent = 'Background set ✓';
          preview.style.color = '#fff';
          toast('Background selected', 'info');
          haptic();
        } catch {
          toast('Could not read that image.', 'danger');
        }
      });
      wrap.append(preview, pickBtn);
      return wrap;
    },
  },
];

export function showOnboarding() {
  // Resolves only when the user finishes the flow, so the caller (boot)
  // mounts the dashboard with final settings already saved.
  return new Promise((resolve) => {
    startOnboarding(resolve);
  });
}

function startOnboarding(done) {
  const state = { name: '', waterTarget: 3000, theme: 'dark', backgroundImage: null };
  let step = 0;

  const root = el('div', { class: 'onboarding' });
  const body = el('div', { class: 'ob-step' });
  const dots = el('div', { class: 'ob-progress' });
  root.append(body, dots);

  function render() {
    body.replaceChildren();
    const def = STEPS[step];
    body.append(
      el('div', { class: 'ob-icon' }, icon(def.iconName, 38)),
      el('h1', { class: 'ob-title' }, def.title),
      el('p', { class: 'ob-sub' }, def.sub),
      el('div', { style: { height: 24 } }),
      def.build(state),
      el('div', { style: { height: 32 } }),
      el('div', { class: 'flex-row' }, [
        step > 0
          ? el('button', { class: 'btn btn-ghost', type: 'button', id: 'ob-back' }, 'Back')
          : el('span'),
        el('div', { class: 'spacer' }),
        el('button', { class: 'btn btn-primary', type: 'button', id: 'ob-next' }, step === STEPS.length - 1 ? 'Get started' : 'Continue'),
      ])
    );

    const backBtn = body.querySelector('#ob-back');
    if (step > 0 && backBtn) {
      backBtn.addEventListener('click', () => {
        step -= 1;
        render();
      });
    }
    const nextBtn = body.querySelector('#ob-next');
    nextBtn.addEventListener('click', async () => {
      try {
        if (step === 1) {
          const nameInput = body.querySelector('#ob-name');
          const name = (nameInput.value || '').trim();
          if (!name) {
            toast('Enter your name to continue.', 'info');
            nameInput.focus();
            return;
          }
          state.name = name;
        }
        haptic();
        if (step === STEPS.length - 1) {
          await finish();
        } else {
          step += 1;
          render();
        }
      } catch (err) {
        console.error('[LifeProgress] Onboarding step failed', err);
        toast('Something went wrong. Please try again.', 'danger');
      }
    });

    dots.replaceChildren(...STEPS.map((_, i) => el('span', { class: `ob-dot ${i === step ? 'active' : ''}` })));
    body.style.animation = 'none';
    void body.offsetWidth;
    body.style.animation = 'rise 260ms var(--ease-out)';
  }

  async function finish() {
    await saveSettings({
      onboarded: true,
      name: state.name,
      waterTarget: state.waterTarget,
      theme: state.theme,
      backgroundImage: state.backgroundImage,
    });
    root.remove();
    toast(`Welcome, ${state.name}!`, 'success');
    haptic(30);
    done();
  }

  render();
  document.getElementById('onboarding-root').replaceChildren(root);
}