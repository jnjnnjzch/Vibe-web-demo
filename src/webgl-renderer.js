import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { resolvePublicAssetUrl } from './asset-urls.js';

function colorFor(entryId) {
  let hash = 0;
  for (const char of entryId) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return new THREE.Color(`hsl(${Math.abs(hash) % 360} 58% 58%)`);
}

globalThis.D99WebGLRendererFactory = async function createThreeRenderer({ canvas, onPick, onHover, onCameraChange, wholeBrainMesh }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 1000);
  camera.position.set(0, 0, 150);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.target.set(0, 0, 0);
  scene.add(new THREE.AmbientLight(0xffffff, 1.8));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(60, 80, 120);
  scene.add(key);
  const loader = new GLTFLoader();
  const groups = new Map();
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let selectedId = null;
  let hoveredId = null;
  let wholeBrainGroup = null;
  let pointerDown = null;
  let moved = false;
  const DRAG_THRESHOLD = 5;

  function cameraStateFromPosition() {
    const radius = camera.position.length();
    return {
      azimuth: THREE.MathUtils.radToDeg(Math.atan2(camera.position.x, camera.position.z)),
      elevation: THREE.MathUtils.radToDeg(Math.asin(camera.position.y / Math.max(radius, Number.EPSILON))),
      distance: radius / 55,
    };
  }

  controls.addEventListener('change', () => onCameraChange?.(cameraStateFromPosition()));

  function frame() {
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  frame();

  function hitEntryId(event) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects([...groups.values()], true)[0];
    return hit?.object?.userData?.entryId || null;
  }

  canvas.addEventListener('pointerdown', (event) => {
    pointerDown = { x: event.clientX, y: event.clientY };
    moved = false;
  });

  canvas.addEventListener('pointermove', (event) => {
    if (pointerDown) {
      const dx = event.clientX - pointerDown.x;
      const dy = event.clientY - pointerDown.y;
      if (Math.hypot(dx, dy) > DRAG_THRESHOLD) {
        moved = true;
        hoveredId = null;
        onHover?.(null);
      }
    }
    if (moved) {
      canvas.style.cursor = 'grabbing';
      return;
    }
    const entryId = hitEntryId(event);
    hoveredId = entryId;
    canvas.style.cursor = pointerDown ? 'grabbing' : entryId ? 'pointer' : 'grab';
    onHover?.(entryId, { x: event.offsetX + 14, y: event.offsetY + 14 });
  });

  canvas.addEventListener('pointerup', (event) => {
    const entryId = hitEntryId(event);
    if (!moved && entryId) onPick(entryId);
    pointerDown = null;
    moved = false;
  });

  canvas.addEventListener('pointerleave', () => {
    pointerDown = null;
    moved = false;
    hoveredId = null;
    canvas.style.cursor = 'grab';
    onHover?.(null);
  });

  return {
    async load(meshAssets) {
      const failed = [];
      await Promise.all(meshAssets.map(async (asset) => {
        try {
          const gltf = await loader.loadAsync(resolvePublicAssetUrl(asset.mesh));
          gltf.scene.traverse((node) => {
            if (!node.isMesh) return;
            node.userData.entryId = asset.entry_id;
            node.material = new THREE.MeshStandardMaterial({
              color: colorFor(asset.entry_id),
              transparent: true,
              opacity: 0.78,
            });
          });
          groups.set(asset.entry_id, gltf.scene);
          scene.add(gltf.scene);
        } catch {
          failed.push(asset.entry_id);
        }
      }));
      if (wholeBrainMesh) {
        try {
          const gltf = await loader.loadAsync(resolvePublicAssetUrl(wholeBrainMesh.path || wholeBrainMesh));
          gltf.scene.traverse((node) => {
            if (!node.isMesh) return;
            node.material = new THREE.MeshStandardMaterial({
              color: 0xdbe5ef,
              transparent: true,
              opacity: 0.16,
              depthWrite: false,
            });
          });
          wholeBrainGroup = gltf.scene;
          wholeBrainGroup.visible = false;
          scene.add(wholeBrainGroup);
        } catch {
          // whole-brain context is optional enhancement
        }
      }
      return { loaded: groups.size, failed };
    },
    select(entryId) {
      selectedId = entryId;
      for (const [id, group] of groups) {
        group.traverse((node) => {
          if (!node.isMesh) return;
          node.material.opacity = id === selectedId ? 1 : id === hoveredId ? 0.72 : 0.16;
          node.material.emissive = id === selectedId
            ? new THREE.Color(0xff7a59)
            : id === hoveredId
              ? new THREE.Color(0xffc7b6)
              : new THREE.Color(0x000000);
        });
      }
    },
    hover(entryId) {
      hoveredId = entryId;
      this.select(selectedId);
    },
    setContextMode(mode) {
      if (wholeBrainGroup) wholeBrainGroup.visible = mode === 'context';
    },
    setCamera({ azimuth, elevation, distance }) {
      const radius = distance * 55;
      const a = THREE.MathUtils.degToRad(azimuth);
      const e = THREE.MathUtils.degToRad(elevation);
      camera.position.set(
        Math.sin(a) * Math.cos(e) * radius,
        Math.sin(e) * radius,
        Math.cos(a) * Math.cos(e) * radius,
      );
      controls.update();
      camera.lookAt(0, 0, 0);
    },
    resize() {
      const { clientWidth, clientHeight } = canvas;
      renderer.setSize(clientWidth, clientHeight, false);
      camera.aspect = clientWidth / Math.max(clientHeight, 1);
      camera.updateProjectionMatrix();
    },
    dispose() {
      controls.dispose();
      renderer.dispose();
    },
  };
};
