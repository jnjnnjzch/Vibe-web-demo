import { resolvePublicAssetUrl } from './asset-urls.js';

const DEFAULT_VIEW = Object.freeze({ azimuth: -18, elevation: 12, distance: 2.8 });
const CAMERA_PRESETS = Object.freeze({
  home: DEFAULT_VIEW,
  axial: { azimuth: 0, elevation: 90, distance: DEFAULT_VIEW.distance },
  coronal: { azimuth: 0, elevation: 0, distance: DEFAULT_VIEW.distance },
  sagittal: { azimuth: 90, elevation: 0, distance: DEFAULT_VIEW.distance },
});
const SUPPORTED_MESH_EXTENSIONS = new Set(['glb', 'gltf']);

function dispatchSelection(target, entryId, source = 'viewer') {
  target.dispatchEvent(new CustomEvent('d99:select', {
    detail: { entry_id: entryId, source },
  }));
}

function createTooltip() {
  const node = document.createElement('div');
  node.className = 'd99-viewer__tooltip';
  node.hidden = true;
  return node;
}

function createLegend() {
  const node = document.createElement('div');
  node.className = 'd99-viewer__legend';
  node.innerHTML = `
    <span><i class="is-selected"></i>Selected</span>
    <span><i class="is-hovered"></i>Hovered</span>
    <span><i class="is-machine"></i>自动翻译</span>
  `;
  return node;
}

function meshExtension(path = '') {
  const clean = String(path).split(/[?#]/, 1)[0];
  return clean.includes('.') ? clean.split('.').pop().toLowerCase() : '';
}

export function extractMeshAssets(regions = []) {
  return regions
    .map((region) => ({
      entry_id: region.entry_id,
      label: region.recommended_display_name || region.official_long_name || region.label || region.entry_id,
      mesh: region.mesh || region.assets?.mesh || null,
      asset_status: region.asset_status || region.assets?.asset_status || null,
      centroid: Array.isArray(region.centroid) ? region.centroid.map(Number) : null,
    }))
    .filter((asset) => asset.entry_id && asset.asset_status !== 'missing_in_volume' && asset.mesh)
    .map(({ asset_status, ...asset }) => asset);
}

export function validateMeshAssets(meshAssets = []) {
  const issues = [];
  const seen = new Set();
  meshAssets.forEach((asset) => {
    if (seen.has(asset.entry_id)) issues.push(`duplicate mesh entry_id: ${asset.entry_id}`);
    seen.add(asset.entry_id);
    const extension = meshExtension(asset.mesh);
    if (!SUPPORTED_MESH_EXTENSIONS.has(extension)) issues.push(`unsupported mesh format for ${asset.entry_id}: ${asset.mesh}`);
  });
  return issues;
}

function createStatusNode(message, tone = 'loading') {
  const node = document.createElement('div');
  node.className = `d99-viewer__status is-${tone}`;
  node.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  node.textContent = message;
  return node;
}

function createToolbar() {
  const toolbar = document.createElement('div');
  toolbar.className = 'd99-viewer__toolbar';
  toolbar.innerHTML = `
    <button type="button" data-action="left" aria-label="Rotate left">↺</button>
    <button type="button" data-action="right" aria-label="Rotate right">↻</button>
    <button type="button" data-action="in" aria-label="Zoom in">＋</button>
    <button type="button" data-action="out" aria-label="Zoom out">−</button>
    <button type="button" data-action="home">Home</button>
    <button type="button" data-action="axial">Axial</button>
    <button type="button" data-action="coronal">Coronal</button>
    <button type="button" data-action="sagittal">Sagittal</button>
    <button type="button" data-action="context">Context</button>
  `;
  return toolbar;
}

function noopRenderer() {
  return {
    load: async () => ({ loaded: 0, failed: [] }),
    select: () => {},
    setCamera: () => {},
    resize: () => {},
    dispose: () => {},
  };
}

export async function createDefaultRenderer({ canvas, meshAssets, onPick, onHover, onCameraChange, wholeBrainMesh }) {
  const factory = globalThis.D99WebGLRendererFactory;
  if (typeof factory !== 'function') {
    throw new Error('No WebGL renderer factory registered. Provide globalThis.D99WebGLRendererFactory or inject rendererFactory.');
  }
  return factory({ canvas, meshAssets, onPick, onHover, onCameraChange, wholeBrainMesh });
}

export function createViewer(container, regions = [], options = {}) {
  if (!container) throw new Error('createViewer requires a container');
  container.classList.add('d99-viewer');
  container.innerHTML = '';

  const eventTarget = options.eventTarget || document;
  const rendererFactory = options.rendererFactory || createDefaultRenderer;
  const meshAssets = extractMeshAssets(regions);
  const meshIssues = validateMeshAssets(meshAssets);
  const state = {
    ...DEFAULT_VIEW,
    selectedId: options.selectedId || null,
    ready: false,
    loadedMeshes: 0,
    failedMeshes: [],
    hoveredId: null,
    contextMode: 'focus',
    language: options.language || 'en',
  };

  const toolbar = createToolbar();
  const canvas = document.createElement('canvas');
  canvas.className = 'd99-viewer__scene';
  canvas.setAttribute('aria-label', 'Interactive whole-brain atlas 3D view');
  canvas.setAttribute('role', 'img');
  const status = createStatusNode('Preparing WebGL atlas…');
  const tooltip = createTooltip();
  const legend = createLegend();
  container.append(toolbar, canvas, tooltip, legend, status);

  let renderer = noopRenderer();
  let disposed = false;
  let hoverCloseTimer = null;

  function cancelHoverClose() {
    if (hoverCloseTimer) clearTimeout(hoverCloseTimer);
    hoverCloseTimer = null;
  }

  function closeHoverSoon() {
    if (hoverCloseTimer) return;
    hoverCloseTimer = setTimeout(() => {
      hoverCloseTimer = null;
      state.hoveredId = null;
      renderer.hover?.(null);
      tooltip.hidden = true;
    }, 120);
  }

  function setStatus(message, tone = 'loading') {
    status.className = `d99-viewer__status is-${tone}`;
    status.setAttribute('role', tone === 'error' ? 'alert' : 'status');
    status.textContent = message;
  }

  function setCamera(next) {
    Object.assign(state, next);
    renderer.setCamera({ azimuth: state.azimuth, elevation: state.elevation, distance: state.distance });
  }

  function select(entryId, emit = true) {
    closeHoverSoon();
    state.selectedId = entryId;
    const hasMesh = meshAssets.some((asset) => asset.entry_id === entryId);
    renderer.select(hasMesh ? entryId : null);
    if (!hasMesh && state.ready) setStatus(`No official spatial mesh for ${entryId}.`, 'warning');
    if (hasMesh && state.ready) {
      setStatus(
        state.failedMeshes.length
          ? `${state.loadedMeshes} meshes loaded; ${state.failedMeshes.length} unavailable.`
          : `${state.loadedMeshes} meshes loaded.`,
        state.failedMeshes.length ? 'warning' : 'ready',
      );
    }
    if (emit) dispatchSelection(eventTarget, entryId);
  }

  function hover(entryId, point = null) {
    if (!entryId || !point) {
      closeHoverSoon();
      return;
    }
    cancelHoverClose();
    state.hoveredId = entryId;
    renderer.hover?.(state.hoveredId);
    const label = state.hoveredId ? options.getRegionLabel?.(state.hoveredId) : null;
    if (!label) {
      closeHoverSoon();
      return;
    }
    tooltip.hidden = false;
    tooltip.style.left = `${point.x}px`;
    tooltip.style.top = `${point.y}px`;
    tooltip.innerHTML = `
      <strong>${label.english || ''}</strong>
      ${label.chinese ? `<span class="is-${label.status}">${label.chinese}${label.status === 'machine_translated' ? ' <em>自动翻译</em>' : ''}</span>` : ''}
    `;
  }

  async function bootRenderer() {
    if (!meshAssets.length) {
      setStatus('No mesh assets declared for this atlas export.', 'error');
      return;
    }
    if (meshIssues.length) {
      setStatus(`Mesh contract invalid: ${meshIssues.join('; ')}`, 'error');
      return;
    }
    try {
      renderer = await rendererFactory({
        canvas,
        meshAssets,
        selectedId: state.selectedId,
        camera: { ...DEFAULT_VIEW },
        onPick: (entryId) => select(entryId),
        onHover: hover,
        onCameraChange: (camera) => Object.assign(state, camera),
        wholeBrainMesh: options.wholeBrainMesh,
      });
      const result = await renderer.load(meshAssets);
      if (disposed) return;
      state.ready = true;
      state.loadedMeshes = Number(result?.loaded || 0);
      state.failedMeshes = Array.isArray(result?.failed) ? result.failed : [];
      renderer.setCamera({ azimuth: state.azimuth, elevation: state.elevation, distance: state.distance });
      renderer.resize?.();
      renderer.select(state.selectedId);
      if (state.loadedMeshes > 0) {
        setStatus(
          state.failedMeshes.length
            ? `${state.loadedMeshes} meshes loaded; ${state.failedMeshes.length} unavailable.`
            : `${state.loadedMeshes} meshes loaded.`,
          state.failedMeshes.length ? 'warning' : 'ready',
        );
      } else {
        setStatus('Mesh assets declared, but none could be loaded.', 'error');
      }
    } catch (error) {
      setStatus(`WebGL viewer unavailable: ${error.message}`, 'error');
    }
  }

  toolbar.addEventListener('click', (event) => {
    const action = event.target.closest('button')?.dataset.action;
    if (!action) return;
    if (action === 'left') setCamera({ azimuth: state.azimuth - 12 });
    if (action === 'right') setCamera({ azimuth: state.azimuth + 12 });
    if (action === 'in') setCamera({ distance: Math.max(1.2, state.distance - 0.18) });
    if (action === 'out') setCamera({ distance: Math.min(6, state.distance + 0.18) });
    if (CAMERA_PRESETS[action]) setCamera({ ...CAMERA_PRESETS[action] });
    if (action === 'context') {
      state.contextMode = state.contextMode === 'focus' ? 'context' : 'focus';
      renderer.setContextMode?.(state.contextMode);
      event.target.closest('button').textContent = state.contextMode === 'context' ? 'Focus' : 'Context';
    }
  });

  eventTarget.addEventListener('d99:select', (event) => {
    if (event.detail?.source !== 'viewer') select(event.detail.entry_id, false);
  });

  bootRenderer();
  globalThis.addEventListener?.('resize', () => renderer.resize?.());

  return {
    select,
    reset: () => setCamera({ ...DEFAULT_VIEW }),
    getState: () => ({ ...state, meshCount: meshAssets.length, meshIssues: [...meshIssues] }),
    setLanguage: (language) => { state.language = language; },
    dispose: () => {
      disposed = true;
      cancelHoverClose();
      state.hoveredId = null;
      tooltip.hidden = true;
      renderer.hover?.(null);
      renderer.dispose();
    },
  };
}

export { CAMERA_PRESETS, resolvePublicAssetUrl };
