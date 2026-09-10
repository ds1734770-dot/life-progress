/**
 * Progress Photos — camera/gallery capture, grid timeline, full view,
 * deletion, and a draggable before/after comparison.
 */
import * as photos from '../photos.js';
import * as ui from '../ui.js';
import { go } from '../router.js';
import { todayKey, formatDate, clamp } from '../utils.js';

export async function mount(root, params, mode) {
  photos.revokePhotoUrls();
  const photoList = await photos.getAllPhotos();
  const state = { photos: photoList };

  if (mode === 'compare') {
    renderCompare(root, state);
    return;
  }
  render(root, state);
  if (params[0] === 'add') openAddSheet(root, state);
}

function render(root, state) {
  const { photos: photoList } = state;
  root.innerHTML = `
    <header class="flex-between" style="margin-top:var(--sp-2)">
      <div>
        <h2 style="font-size:var(--fs-2xl);font-weight:800;letter-spacing:-0.02em">Progress photos</h2>
        <div class="muted" style="font-size:var(--fs-sm);font-weight:600">Your progress will appear here</div>
      </div>
    </header>

    <section class="section stagger">
      <div class="chip-grid">
        <button class="btn btn-primary btn-sm" data-action="photo-camera" style="display:inline-flex">${ui.icon('camera', 16)} Camera</button>
        <button class="btn btn-ghost btn-sm" data-action="photo-gallery" style="display:inline-flex">${ui.icon('image', 16)} Gallery</button>
        <button class="btn btn-ghost btn-sm" data-action="photo-compare" style="display:inline-flex;${photoList.length < 2 ? 'opacity:.5;pointer-events:none' : ''}">${ui.icon('columns', 16)} Compare</button>
      </div>
    </section>

    <section class="section stagger">
      ${photoList.length
        ? `<div class="photo-grid">${photoList.map((p, i) => photoTile(p, i)).join('')}</div>`
        : ui.emptyState({
            iconName: 'camera',
            title: 'No progress photos yet',
            sub: 'Snap a photo today — future you will thank you.',
            actionLabel: 'Add a photo',
            action: () => openAddSheet(root, state),
          }).outerHTML}
    </section>
  `;

  ui.bindActions(root, {
    'photo-camera': () => startCapture('camera', root, state),
    'photo-gallery': () => startCapture('gallery', root, state),
    'photo-compare': () => go('photos/compare'),
    'photo-view': (d) => {
      const photo = state.photos.find((p) => p.id === d.id);
      if (photo) openPhotoView(photo, root, state);
    },
  });
}

function photoTile(p, i) {
  const url = photos.photoUrl(p, 'thumb');
  if (!url) return '';
  const delay = Math.min(i * 40, 240);
  return `
    <button class="photo-tile" data-action="photo-view" data-id="${p.id}" style="animation:popIn 320ms var(--spring) ${delay}ms backwards">
      <img src="${url}" alt="${ui.escapeHtml(p.label || `Progress photo ${formatDate(p.date, { short: true })}`)}" loading="lazy">
      <span class="photo-date">${formatDate(p.date, { short: true })}${p.label ? ` · ${ui.escapeHtml(p.label)}` : ''}</span>
    </button>`;
}

async function startCapture(kind, root, state) {
  let file;
  if (kind === 'camera') {
    file = await ui.pickFromCamera('image/*');
  } else {
    file = await ui.pickFromGallery('image/*');
  }
  if (!file) return;
  try {
    // Quick preview without downscaling.
    const previewUrl = await ui.readFileAsDataURL(file);
    openConfirmSheet(root, state, file, previewUrl);
  } catch {
    ui.toast('Could not read that image.', 'danger');
  }
}

/**
 * Full add sheet — opens via the dashboard Photo quick-action (#/photos/add)
 * and from the photos empty state. Lets the user pick camera or gallery.
 */
function openAddSheet(root, state) {
  ui.openSheet((close) => {
    const wrap = ui.el('div', { class: 'flex-col' });
    wrap.append(ui.el('h2', { style: { fontSize: 'var(--fs-xl)', fontWeight: 800 } }, 'Add a photo'));
    const cameraBtn = ui.el('button', { class: 'btn btn-primary btn-block', type: 'button' }, ui.icon('camera', 18) + ' Take a photo');
    const galleryBtn = ui.el('button', { class: 'btn btn-ghost btn-block', type: 'button' }, ui.icon('image', 18) + ' Choose from gallery');
    cameraBtn.addEventListener('click', async () => {
      close();
      await startCapture('camera', root, state);
    });
    galleryBtn.addEventListener('click', async () => {
      close();
      await startCapture('gallery', root, state);
    });
    wrap.append(cameraBtn, galleryBtn);
    return wrap;
  });
}

function openConfirmSheet(root, state, file, previewUrl) {
  ui.openSheet((close) => {
    const wrap = ui.el('div', { class: 'flex-col' });
    wrap.append(ui.el('h2', { style: { fontSize: 'var(--fs-xl)', fontWeight: 800 } }, 'Save photo'));
    wrap.append(
      ui.el('img', {
        src: previewUrl,
        style: {
          width: '100%',
          maxHeight: 240,
          objectFit: 'cover',
          borderRadius: 'var(--r-m)',
          border: '1px solid var(--border)',
        },
      })
    );
    const date = ui.el('input', { class: 'input', type: 'date', value: todayKey() });
    const label = ui.el('input', { class: 'input', placeholder: 'Label (optional)', maxlength: '40' });
    const notes = ui.el('textarea', { class: 'textarea', placeholder: 'Notes (optional)', style: { minHeight: 56 } });
    const save = ui.el('button', { class: 'btn btn-primary btn-block', type: 'button' }, 'Save photo');
    save.addEventListener('click', async () => {
      try {
        const photo = await photos.addPhoto(file, {
          date: date.value || todayKey(),
          label: label.value,
          notes: notes.value,
        });
        state.photos = photos.sortPhotos([photo, ...state.photos]);
        ui.haptic(20);
        ui.toast('Photo saved', 'success');
        close();
        render(root, state);
      } catch {
        ui.toast('Could not save that image.', 'danger');
      }
    });
    wrap.append(
      ui.el('div', { class: 'field' }, [ui.el('label', { class: 'field-label' }, 'Date'), date]),
      ui.el('div', { class: 'field' }, [ui.el('label', { class: 'field-label' }, 'Label'), label]),
      ui.el('div', { class: 'field' }, [ui.el('label', { class: 'field-label' }, 'Notes'), notes]),
      save
    );
    return wrap;
  });
}

function openPhotoView(photo, root, state) {
  const url = photos.photoUrl(photo, 'blob') || photos.photoUrl(photo, 'thumb');
  const view = ui.el('div', { class: 'photo-view' }, [
    ui.el('button', {
      class: 'btn-icon',
      style: { position: 'absolute', top: 'calc(env(safe-area-inset-top,0px) + 12px)', right: 16, background: 'rgba(255,255,255,.12)', color: '#fff', border: 'none' },
      'aria-label': 'Close',
      onclick: () => view.remove(),
    }, ui.icon('x', 20)),
    url ? ui.el('img', { src: url, alt: photo.label || 'Progress photo' }) : null,
    ui.el('div', { class: 'photo-view-meta' }, [
      ui.el('div', { style: { fontWeight: 700, fontSize: 'var(--fs-lg)' } }, formatDate(photo.date)),
      photo.label ? ui.el('div', {}, photo.label) : null,
      photo.notes ? ui.el('div', { style: { opacity: 0.7, fontSize: 'var(--fs-sm)', maxWidth: 320, margin: '0 auto' } }, photo.notes) : null,
      ui.el('div', { class: 'dialog-actions', style: { marginTop: 16 } }, [
        ui.el('button', {
          class: 'btn btn-soft-danger',
          type: 'button',
          onclick: async () => {
            const ok = await ui.openDialog({
              title: 'Delete photo?',
              message: photo.label ? `“${photo.label}” will be removed.` : 'This progress photo will be removed.',
              confirmLabel: 'Delete',
              danger: true,
            });
            if (!ok) return;
            await photos.deletePhoto(photo.id);
            state.photos = state.photos.filter((p) => p.id !== photo.id);
            view.remove();
            ui.toast('Photo deleted', 'info');
            render(root, state);
          },
        }, ui.icon('trash', 16) + ' Delete'),
      ]),
    ]),
  ]);
  document.getElementById('modal-root').replaceChildren(view);
}

// ---------------------------------------------------------------------------
// Compare mode
// ---------------------------------------------------------------------------

function renderCompare(root, state) {
  const { photos: photoList } = state;
  const [before, after] = pickPair(photoList);
  root.innerHTML = `
    <header class="flex-between" style="margin-top:var(--sp-2)">
      <div class="flex-row">
        <button class="btn-icon" data-action="back" aria-label="Back">${ui.icon('arrow-left', 18)}</button>
        <div style="margin-left:6px">
          <h2 style="font-size:var(--fs-2xl);font-weight:800;letter-spacing:-0.02em">Compare</h2>
          <div class="muted" style="font-size:var(--fs-sm);font-weight:600">Drag to reveal your progress</div>
        </div>
      </div>
    </header>

    <section class="section stagger">
      <div class="form-grid">
        <div class="field">
          <label class="field-label" for="cmp-before">Before</label>
          <select class="select" id="cmp-before">
            ${photoList.map((p) => `<option value="${p.id}">${formatDate(p.date, { short: true })}${p.label ? ` · ${ui.escapeHtml(p.label)}` : ''}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label class="field-label" for="cmp-after">After</label>
          <select class="select" id="cmp-after">
            ${photoList.map((p) => `<option value="${p.id}">${formatDate(p.date, { short: true })}${p.label ? ` · ${ui.escapeHtml(p.label)}` : ''}</option>`).join('')}
          </select>
        </div>
      </div>
    </section>

    <section class="section stagger">
      <div class="compare" id="compare-stage">
        <img class="compare-img" id="cmp-back" alt="Before" src="">
        <img class="compare-img compare-top" id="cmp-front" alt="After" src="">
        <span class="compare-label before" id="cmp-label-before">Before</span>
        <span class="compare-label after" id="cmp-label-after">After</span>
        <div class="compare-divider" id="cmp-divider"><div class="compare-handle">${ui.icon('chevron-left', 14)}${ui.icon('chevron-right', 14)}</div></div>
      </div>
    </section>
  `;

  const stage = root.querySelector('#compare-stage');
  const backImg = root.querySelector('#cmp-back');
  const frontImg = root.querySelector('#cmp-front');

  function apply() {
    const beforePhoto = photoList.find((p) => p.id === root.querySelector('#cmp-before').value);
    const afterPhoto = photoList.find((p) => p.id === root.querySelector('#cmp-after').value);
    if (!beforePhoto || !afterPhoto) return;
    backImg.src = photos.photoUrl(beforePhoto, 'blob') || photos.photoUrl(beforePhoto, 'thumb');
    frontImg.src = photos.photoUrl(afterPhoto, 'blob') || photos.photoUrl(afterPhoto, 'thumb');
    root.querySelector('#cmp-label-before').textContent = formatDate(beforePhoto.date, { short: true });
    root.querySelector('#cmp-label-after').textContent = formatDate(afterPhoto.date, { short: true });
  }

  root.querySelector('#cmp-before').addEventListener('change', apply);
  root.querySelector('#cmp-after').addEventListener('change', apply);
  apply();

  // Drag interaction.
  const divider = root.querySelector('#cmp-divider');
  let dragging = false;
  const setSplit = (clientX) => {
    const rect = stage.getBoundingClientRect();
    const pct = clamp(((clientX - rect.left) / rect.width) * 100, 0, 100);
    frontImg.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
    divider.style.left = `${pct}%`;
  };
  stage.addEventListener('pointerdown', (e) => {
    dragging = true;
    stage.setPointerCapture(e.pointerId);
    setSplit(e.clientX);
  });
  stage.addEventListener('pointermove', (e) => {
    if (dragging) setSplit(e.clientX);
  });
  stage.addEventListener('pointerup', () => (dragging = false));
  stage.addEventListener('pointercancel', () => (dragging = false));

  ui.bindActions(root, { back: () => go('photos') });
}

/**
 * Default compare pair. Photos arrive newest-first, so the oldest photo is
 * the last element. Defaulting both sides to the newest photo made the slider
 * meaningless — pick oldest vs newest instead.
 */
function pickPair(photoList) {
  if (photoList.length < 2) return [photoList[0], photoList[0]];
  return [photoList[photoList.length - 1], photoList[0]];
}