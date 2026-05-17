const PLANES = [
  { key: 'axial', label: 'Axial' },
  { key: 'coronal', label: 'Coronal' },
  { key: 'sagittal', label: 'Sagittal' },
];

const REQUIRED_SLICE_FIELDS = ['background', 'overlay'];

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizePlaneAsset(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const normalized = {
    background: text(value.background),
    overlay: text(value.overlay),
    slice_index: Number.isFinite(Number(value.slice_index)) ? Number(value.slice_index) : null,
    voxel: value.voxel && typeof value.voxel === 'object' ? { ...value.voxel } : null,
    world: value.world && typeof value.world === 'object' ? { ...value.world } : null,
  };
  return REQUIRED_SLICE_FIELDS.every((field) => normalized[field]) ? normalized : null;
}

export function getSliceAssets(region) {
  if (region?.asset_status === 'missing_in_volume' || region?.assets?.asset_status === 'missing_in_volume') {
    return Object.fromEntries(PLANES.map(({ key }) => [key, null]));
  }
  const slices = region?.assets?.slices || region?.slices || null;
  return Object.fromEntries(PLANES.map(({ key }) => [key, normalizePlaneAsset(slices?.[key])]));
}

export function hasCompleteSliceSet(region) {
  const assets = getSliceAssets(region);
  return PLANES.every(({ key }) => Boolean(assets[key]));
}

function emit(target, entryId) {
  target.dispatchEvent(new CustomEvent('d99:select', { detail: { entry_id: entryId, source: 'slices' } }));
}

function createImage(className, src, alt, onError) {
  const image = document.createElement('img');
  image.className = className;
  image.src = resolvePublicAssetUrl(src);
  image.alt = alt;
  image.decoding = 'async';
  image.loading = 'lazy';
  image.addEventListener('error', onError, { once: true });
  return image;
}

function createPlaneFigure(plane) {
  const figure = document.createElement('figure');
  figure.className = 'd99-slice';
  figure.dataset.plane = plane.key;

  const caption = document.createElement('figcaption');
  caption.textContent = plane.label;

  const viewport = document.createElement('div');
  viewport.className = 'd99-slice__viewport';
  viewport.setAttribute('role', 'img');
  viewport.setAttribute('aria-label', `${plane.label} anatomical slice`);

  const meta = document.createElement('p');
  meta.className = 'd99-slice__meta';

  figure.append(caption, viewport, meta);
  return { figure, viewport, meta };
}

function renderUnavailable(viewport, meta, plane, region) {
  viewport.innerHTML = '';
  viewport.classList.remove('is-load-failure');
  viewport.classList.add('is-unavailable');
  const message = document.createElement('p');
  message.className = 'd99-slice__empty';
  message.textContent = region?.assets?.asset_status === 'missing_in_volume'
    ? `Official volume has no spatial asset for ${region.entry_id}.`
    : `No real ${plane.label.toLowerCase()} slice asset for ${region?.entry_id || 'selection'}.`;
  viewport.append(message);
  meta.textContent = region?.assets?.asset_status === 'missing_in_volume'
    ? 'Nomenclature exists; no derivable voxel support in the current official volume'
    : 'MRI background + overlay required';
}

function renderPlane(viewport, meta, plane, region, asset) {
  viewport.innerHTML = '';
  viewport.classList.remove('is-unavailable', 'is-load-failure');
  const showLoadFailure = () => {
    viewport.innerHTML = '';
    viewport.classList.add('is-unavailable', 'is-load-failure');
    const message = document.createElement('p');
    message.className = 'd99-slice__empty';
    message.textContent = `Failed to load ${plane.label.toLowerCase()} slice assets for ${region.entry_id}.`;
    viewport.append(message);
    meta.textContent = 'Declared asset could not be loaded';
  };
  viewport.append(
    createImage('d99-slice__background', asset.background, `${plane.label} MRI background for ${region.entry_id}`, showLoadFailure),
    createImage('d99-slice__overlay', asset.overlay, `${plane.label} region overlay for ${region.entry_id}`, showLoadFailure),
  );
  const marker = document.createElement('span');
  marker.className = 'd99-slice__marker';
  marker.setAttribute('aria-hidden', 'true');
  viewport.append(marker);
  const details = [];
  if (asset.slice_index !== null) details.push(`slice ${asset.slice_index}`);
  if (asset.world) {
    const coords = ['x', 'y', 'z']
      .filter((axis) => Number.isFinite(Number(asset.world[axis])))
      .map((axis) => `${axis} ${asset.world[axis]}`);
    if (coords.length) details.push(coords.join(' · '));
  }
  meta.textContent = details.join(' · ') || 'entry-linked anatomical slice';
}

export function createSlices(container, regions = [], options = {}) {
  if (!container) throw new Error('createSlices requires a container');
  container.classList.add('d99-slices');
  container.innerHTML = '';

  const eventTarget = options.eventTarget || document;
  const regionsById = new Map(regions.map((region) => [region.entry_id, region]));
  const state = { selectedId: options.selectedId || null };
  const panels = new Map();

  PLANES.forEach((plane) => {
    const panel = createPlaneFigure(plane);
    container.append(panel.figure);
    panels.set(plane.key, panel);
  });

  function render() {
    const region = regionsById.get(state.selectedId) || null;
    const assets = getSliceAssets(region);
    PLANES.forEach((plane) => {
      const panel = panels.get(plane.key);
      const asset = assets[plane.key];
      if (!region || !asset) renderUnavailable(panel.viewport, panel.meta, plane, region);
      else renderPlane(panel.viewport, panel.meta, plane, region, asset);
      panel.figure.dataset.entryId = region?.entry_id || '';
    });
  }

  function select(entryId, shouldEmit = true) {
    if (!regionsById.has(entryId)) return;
    state.selectedId = entryId;
    render();
    if (shouldEmit) emit(eventTarget, entryId);
  }

  eventTarget.addEventListener('d99:select', (event) => {
    if (event.detail?.source !== 'slices') select(event.detail.entry_id, false);
  });

  render();
  return { select, getState: () => ({ ...state }) };
}
import { resolvePublicAssetUrl } from './asset-urls.js';
