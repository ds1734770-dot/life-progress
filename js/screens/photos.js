/**
 * Progress Photos — camera/gallery capture, grid timeline, full view,
 * deletion, and a draggable before/after comparison.
 */
import * as photos from '../photos.js';
import * as ui from '../ui.js';
import { go } from '../router.js';
import { todayKey, formatDate, clamp } from '../utils.js';
import { REFERENCE_QUALITY_COPY } from '../pose/reference.js';
import { analyzePhotoReference, NoPoseDetectedError } from '../pose/analyze.js';
import { PoseAssetsMissingError } from '../pose/detector.js';

export async function mount(root, params, mode) {
  photos.revokePhotoUrls();
  // Defensive reconciliation: reference metadata can never outlive its photo
  // (e.g. a backup that carried profiles but no photos).
  await photos.pruneReferences().catch(() => {});
  const photoList = await photos.getAllPhotos();
  const active = await photos.getActiveTemplate(photoList).catch(() => null);
  const state = { photos: photoList, templateId: active ? active.photo.id : null };

  if (mode === 'compare') {
    renderCompare(root, state);
    return;
  }
  render(root, state);
  if (params[0] === 'add') openAddSheet(root, state);
}

function render(root, state) {
  const { photos: photoList } = state;
  const template = state.templateId ? photoList.find((p) => p.id === state.templateId) : null;
  root.innerHTML = `
    <header class="flex-between" style="margin-top:var(--sp-2)">
      <div>
        <h2 style="font-size:var(--fs-2xl);font-weight:800;letter-spacing:-0.02em">Progress photos</h2>
        <div class="muted" style="font-size:var(--fs-sm);font-weight:600">Your progress will appear here</div>
      </div>
    </header>

    ${
      template
        ? `<div class="photo-template-bar">
             <span class="photo-template-dot" aria-hidden="true"></span>
             <span class="photo-template-text">Photo template · ${formatDate(template.date, { short: true })}</span>
             <button class="photo-template-clear" data-action="photo-template-clear" type="button" aria-label="Remove photo template">Remove</button>
           </div>`
        : ''
    }

    <section class="section stagger">
      <div class="chip-grid">
        ${
          // With a template set, matching it becomes the primary action (the
          // whole point of the feature); without one, the original V1 chip row
          // is unchanged.
          template
            ? `<button class="btn btn-primary btn-sm" data-action="photo-smart" style="display:inline-flex">${ui.icon('sparkles', 16)} Match photo</button>
               <button class="btn btn-ghost btn-sm" data-action="photo-camera" style="display:inline-flex">${ui.icon('camera', 16)} Camera</button>`
            : `<button class="btn btn-primary btn-sm" data-action="photo-camera" style="display:inline-flex">${ui.icon('camera', 16)} Camera</button>`
        }
        <button class="btn btn-ghost btn-sm" data-action="photo-gallery" style="display:inline-flex">${ui.icon('image', 16)} Gallery</button>
        <button class="btn btn-ghost btn-sm" data-action="photo-compare" style="display:inline-flex;${photoList.length < 2 ? 'opacity:.5;pointer-events:none' : ''}">${ui.icon('columns', 16)} Compare</button>
      </div>
      ${template ? '<div class="photo-hint">Match your template for an easier comparison later.</div>' : ''}
    </section>

    <section class="section stagger">
      ${photoList.length
        ? `<div class="photo-grid">${photoList.map((p, i) => photoTile(p, i, state)).join('')}</div>`
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
    // The V1 system-camera capture is untouched; the smart camera is an
    // additional entry point that only appears once a template exists.
    'photo-camera': () => startCapture('camera', root, state),
    'photo-smart': () => go('photos/camera'),
    'photo-gallery': () => startCapture('gallery', root, state),
    'photo-compare': () => go('photos/compare'),
    'photo-template-clear': async () => {
      await photos.clearActiveTemplate();
      state.templateId = null;
      ui.toast('Photo template removed', 'info');
      render(root, state);
    },
    'photo-view': (d) => {
      const photo = state.photos.find((p) => p.id === d.id);
      if (photo) openPhotoView(photo, root, state);
    },
  });
}

function photoTile(p, i, state) {
  const url = photos.photoUrl(p, 'thumb');
  if (!url) return '';
  const delay = Math.min(i * 40, 240);
  const isTemplate = state && state.templateId === p.id;
  return `
    <button class="photo-tile" data-action="photo-view" data-id="${p.id}" style="animation:popIn 320ms var(--spring) ${delay}ms backwards">
      <img src="${url}" alt="${ui.escapeHtml(p.label || `Progress photo ${formatDate(p.date, { short: true })}`)}" loading="lazy">
      ${isTemplate ? '<span class="photo-template-badge">Template</span>' : ''}
      <span class="photo-date">${formatDate(p.date, { short: true })}${p.label ? ` · ${ui.escapeHtml(p.label)}` : ''}</span>
    </button>`;
}

async function startCapture(kind, root, state) {
  // The system camera picker (unchanged V1 behavior) — used by the gallery
  // path and by the smart camera's "standard camera" fallback.
  const file = kind === 'camera' ? await ui.pickFromCamera('image/*') : await ui.pickFromGallery('image/*');
  if (!file) return;
  try {
    // Quick preview without downscaling.
    const previewUrl = await ui.readFileAsDataURL(file);
    openSaveSheet({
      file,
      previewUrl,
      onSaved: (photo) => {
        state.photos = photos.sortPhotos([photo, ...state.photos]);
        render(root, state);
      },
    });
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
    const smartBtn = ui.el('button', { class: 'btn btn-primary btn-block', type: 'button' }, ui.icon('sparkles', 18) + ' Match my previous photo');
    const cameraBtn = ui.el('button', { class: `btn ${state.templateId ? 'btn-ghost' : 'btn-primary'} btn-block`, type: 'button' }, ui.icon('camera', 18) + ' Take a photo');
    const galleryBtn = ui.el('button', { class: 'btn btn-ghost btn-block', type: 'button' }, ui.icon('image', 18) + ' Choose from gallery');
    smartBtn.addEventListener('click', () => {
      close();
      go('photos/camera');
    });
    cameraBtn.addEventListener('click', async () => {
      close();
      await startCapture('camera', root, state);
    });
    galleryBtn.addEventListener('click', async () => {
      close();
      await startCapture('gallery', root, state);
    });
    // Only offer the alignment flow when there is actually something to match.
    if (state.templateId) wrap.append(smartBtn);
    wrap.append(cameraBtn, galleryBtn);
    return wrap;
  });
}

/**
 * "Save photo" sheet — the single confirmation step every capture path funnels
 * into (gallery, standard camera, and the smart camera's captured frame), so
 * date/label/notes behavior stays identical everywhere (§21/§22).
 */
export function openSaveSheet({ file, previewUrl, onSaved, onCancel }) {
  return ui.openSheet((close) => {
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
    let saving = false;
    save.addEventListener('click', async () => {
      if (saving) return;
      saving = true;
      try {
        const photo = await photos.addPhoto(file, {
          date: date.value || todayKey(),
          label: label.value,
          notes: notes.value,
        });
        ui.haptic(20);
        ui.toast('Photo saved', 'success');
        close();
        if (onSaved) onSaved(photo);
      } catch {
        saving = false;
        ui.toast('Could not save that image.', 'danger');
      }
    });
    // A dismissed sheet returns the user to the capture screen without saving.
    if (onCancel) {
      const backdrop = document.querySelector('#modal-root .modal-backdrop');
      backdrop?.addEventListener('click', (e) => {
        if (e.target === backdrop) onCancel();
      });
    }
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
  const deleteActions = ui.el('div', { class: 'dialog-actions', style: { marginTop: 16 } }, [
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
        if (state.templateId === photo.id) state.templateId = null;
        view.remove();
        ui.toast('Photo deleted', 'info');
        render(root, state);
      },
    }, ui.icon('trash', 16) + ' Delete'),
  ]);
  const meta = ui.el('div', { class: 'photo-view-meta' }, [
    ui.el('div', { style: { fontWeight: 700, fontSize: 'var(--fs-lg)' } }, formatDate(photo.date)),
    photo.label ? ui.el('div', {}, photo.label) : null,
    photo.notes ? ui.el('div', { style: { opacity: 0.7, fontSize: 'var(--fs-sm)', maxWidth: 320, margin: '0 auto' } }, photo.notes) : null,
    deleteActions,
  ]);
  const view = ui.el('div', { class: 'photo-view' }, [
    ui.el('button', {
      class: 'btn-icon',
      style: { position: 'absolute', top: 'calc(env(safe-area-inset-top,0px) + 12px)', right: 16, background: 'rgba(255,255,255,.12)', color: '#fff', border: 'none' },
      'aria-label': 'Close',
      onclick: () => view.remove(),
    }, ui.icon('x', 20)),
    url ? ui.el('img', { src: url, alt: photo.label || 'Progress photo' }) : null,
    meta,
  ]);
  // The template flow needs the modal element for its "remove the view" steps,
  // so it is inserted once the view itself exists.
  meta.insertBefore(templateControls(photo, root, state, view), deleteActions);
  document.getElementById('modal-root').replaceChildren(view);
}

// ---------------------------------------------------------------------------
// Photo template — analyse a photo locally and use it as the alignment
// reference for the smart progress camera (§5 / §38).
// ---------------------------------------------------------------------------

function templateControls(photo, root, state, view) {
  const wrap = ui.el('div', { class: 'photo-template-controls', id: 'photo-template-controls' });
  const status = ui.el('div', { class: 'photo-template-status', id: 'photo-template-status', role: 'status' });
  const action = ui.el('button', { class: 'btn btn-primary btn-block', type: 'button' });
  let pendingProfile = null;
  let analysing = false;

  const isTemplate = () => state.templateId === photo.id;

  function paint() {
    const remove = isTemplate();
    action.textContent = remove ? 'Template matching on — remove' : pendingProfile ? REFERENCE_QUALITY_COPY.confirmLabel : 'Use as Photo Template';
    action.classList.toggle('btn-ghost', remove);
    action.classList.toggle('btn-primary', !remove);
    action.setAttribute('aria-pressed', String(remove));
    action.setAttribute('aria-label', remove ? 'Remove this photo template' : 'Use this photo as your progress template');
  }

  function paintChecks(quality) {
    status.replaceChildren(
      ...quality.checks.map((check) =>
        ui.el('div', { class: `photo-template-check ${check.ok ? 'ok' : ''}` }, `${check.ok ? '✓' : '·'} ${check.label}`)
      ),
      quality.usable
        ? ui.el('div', { class: 'photo-template-note' }, quality.partial ? REFERENCE_QUALITY_COPY.partialHint : 'Reference ready for the smart camera.')
        : ui.el('div', { class: 'photo-template-note' }, REFERENCE_QUALITY_COPY.retryHint)
    );
  }

  action.addEventListener('click', async () => {
    if (analysing) return;
    if (isTemplate()) {
      await photos.clearActiveTemplate();
      state.templateId = null;
      pendingProfile = null;
      status.textContent = 'Template removed.';
      ui.toast('Photo template removed', 'info');
      render(root, state);
      paint();
      return;
    }
    if (!pendingProfile) {
      analysing = true;
      action.disabled = true;
      status.className = 'photo-template-status analysing';
      status.textContent = 'Analyzing photo on this device…';
      try {
        const { profile } = await analyzePhotoReference(photo, {
          onProgress: (stage) => {
            status.textContent = stage === 'decoding' ? 'Analyzing photo on this device…' : 'Checking your pose…';
          },
        });
        const saved = await photos.saveReferenceProfile(profile);
        pendingProfile = saved;
        status.className = 'photo-template-status';
        paintChecks(saved.quality);
        if (!saved.quality.usable) {
          status.prepend(ui.el('div', { class: 'photo-template-retry' }, REFERENCE_QUALITY_COPY.retryTitle));
          action.textContent = REFERENCE_QUALITY_COPY.chooseAnother;
        }
      } catch (err) {
        status.className = 'photo-template-status';
        if (err instanceof NoPoseDetectedError || err?.reason === 'no-pose') {
          status.textContent = REFERENCE_QUALITY_COPY.retryTitle;
        } else if (err instanceof PoseAssetsMissingError || err?.reason === 'assets-missing') {
          status.textContent = 'The on-device pose model is not available in this build, so photo templates are off.';
        } else {
          status.textContent = "Something interrupted the analysis. You can try again.";
        }
        ui.toast('Could not analyze that photo', 'info');
      } finally {
        analysing = false;
        action.disabled = false;
        paint();
      }
      return;
    }

    // Second tap = confirmation ("Use this as your progress template").
    if (!pendingProfile.quality.usable) {
      view.remove();
      return;
    }
    const applied = await photos.setActiveTemplate(photo.id);
    if (!applied) {
      ui.toast('Could not set that template.', 'danger');
      return;
    }
    state.templateId = photo.id;
    ui.haptic(18);
    ui.toast('Photo template ready', 'success');
    render(root, state);
    view.remove();
  });

  wrap.append(action, status);
  paint();
  return wrap;
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