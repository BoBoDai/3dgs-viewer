import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { PLYLoader } from "three/addons/loaders/PLYLoader.js";
import { GaussianSplatRenderer, SplatMesh } from "gaussian-splat-lite";
import { readPlyHeader } from "./ply-detect.js";

/**
 * 通用 PLY 浏览器：
 *   - 3DGS PLY → gaussian-splat-lite
 *   - 带 face 的 PLY → Three.js Mesh（支持顶点色/法线/线框）
 *   - 无 face 的 PLY → Three.js Points
 */

const els = {
  host: document.getElementById("canvas-host"),
  stats: document.getElementById("stats"),
  status: document.getElementById("status"),
  fileName: document.getElementById("file-name"),
  loading: document.getElementById("loading"),
  loadingText: document.getElementById("loading-text"),
  drop: document.getElementById("drop-overlay"),
  toast: document.getElementById("toast"),
  btnOpen: document.getElementById("btn-open"),
  btnFit: document.getElementById("btn-fit"),
  btnFlip: document.getElementById("btn-flip"),
  btnWire: document.getElementById("btn-wire"),
  btnPointMinus: document.getElementById("btn-point-minus"),
  btnPointPlus: document.getElementById("btn-point-plus"),
  btnReset: document.getElementById("btn-reset"),
  btnUrl: document.getElementById("btn-url"),
  fileInput: document.getElementById("file-input"),
  urlInput: document.getElementById("url-input"),
};

const params = new URLSearchParams(location.search);

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  alpha: true,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
els.host.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  50,
  window.innerWidth / window.innerHeight,
  0.01,
  1000,
);
camera.position.set(0, 0, 3);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.screenSpacePanning = true;

scene.add(new THREE.HemisphereLight(0xffffff, 0x1e293b, 2.2));
const keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
keyLight.position.set(3, 5, 4);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0x93c5fd, 1.0);
fillLight.position.set(-4, 2, -3);
scene.add(fillLight);

const splatRenderer = new GaussianSplatRenderer({
  renderer,
  preBlurAmount: 0,
  blurAmount: 0.3,
});
scene.add(splatRenderer);

const modelRoot = new THREE.Group();
scene.add(modelRoot);

const plyLoader = new PLYLoader();

let current = null;
let flipY = true;
let wireframe = false;
let pointScale = 1;
let grid = null;
let axes = null;
let loadToken = 0;
let toastTimer = 0;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function typeLabel(type) {
  return { "3dgs": "3DGS", mesh: "Mesh", points: "Point Cloud" }[type] || type;
}

function formatLabel(format) {
  return {
    ascii: "ASCII",
    binary_little_endian: "Binary LE",
    binary_big_endian: "Binary BE",
  }[format] || format;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatVector(size) {
  if (!size) return "—";
  const max = Math.max(size.x, size.y, size.z);
  const digits = max >= 100 ? 0 : max >= 10 ? 1 : max >= 1 ? 2 : 3;
  return `${size.x.toFixed(digits)} × ${size.y.toFixed(digits)} × ${size.z.toFixed(digits)}`;
}

function setStatus(text) {
  els.status.textContent = text;
}

function toast(message, ms = 3600) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), ms);
}

function setLoading(on, text = "加载中…") {
  els.loading.classList.toggle("show", on);
  els.loadingText.textContent = text;
}

function updateControls() {
  const has = !!current;
  const isMesh = current?.type === "mesh";
  const isPoints = current?.type === "points";
  els.btnFit.disabled = !has;
  els.btnFlip.disabled = !has;
  els.btnReset.disabled = !has;
  els.btnWire.disabled = !isMesh;
  els.btnPointMinus.disabled = !isPoints;
  els.btnPointPlus.disabled = !isPoints;
  els.btnWire.textContent = `线框：${wireframe ? "开" : "关"}`;
  els.btnFlip.textContent = `翻转 Y：${flipY ? "开" : "关"}`;
}

function updateStats() {
  els.stats.replaceChildren();
  if (!current) {
    const hint = document.createElement("div");
    hint.className = "stats-empty";
    hint.textContent = "把 .ply 拖进窗口，或点“打开文件”";
    els.stats.appendChild(hint);
    els.fileName.textContent = "";
    return;
  }

  const header = current.header;
  const rows = [
    ["类型", typeLabel(current.type)],
    ["顶点", header.vertexCount.toLocaleString()],
    ["面", current.type === "mesh" ? header.faceCount.toLocaleString() : "—"],
    ["格式", formatLabel(header.format)],
    ["文件", formatBytes(current.fileSize)],
    ["包围盒", formatVector(current.boundsSize)],
    ["加载", current.loadMs ? `${current.loadMs.toFixed(0)} ms` : "—"],
  ];

  for (const [key, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = key;
    const dd = document.createElement("dd");
    dd.textContent = value;
    els.stats.append(dt, dd);
  }
  els.fileName.textContent = current.name || "";
}

function removeHelpers() {
  if (grid) {
    scene.remove(grid);
    grid.geometry.dispose();
    const mats = Array.isArray(grid.material) ? grid.material : [grid.material];
    mats.forEach((m) => m.dispose());
    grid = null;
  }
  if (axes) {
    scene.remove(axes);
    axes.geometry.dispose();
    axes.material.dispose();
    axes = null;
  }
}

function clearModel() {
  if (current?.object) {
    current.object.removeFromParent();
    if (current.type === "3dgs") {
      current.object.dispose?.();
    }
  }
  current?.geometry?.dispose?.();
  current?.material?.dispose?.();
  current = null;
  modelRoot.clear();
  modelRoot.rotation.set(0, 0, 0);
  modelRoot.position.set(0, 0, 0);
  removeHelpers();
  wireframe = false;
  pointScale = 1;
  updateControls();
  updateStats();
}

async function computeSplatBounds(mesh) {
  mesh.updateMatrixWorld(true);
  const total = mesh.numSplats || 1;
  const stride = Math.max(1, Math.floor(total / 80000));
  const xs = [];
  const ys = [];
  const zs = [];
  const point = new THREE.Vector3();
  mesh.splats.forEachCenter((index, x, y, z) => {
    if (index % stride !== 0) return;
    point.set(x, y, z).applyMatrix4(mesh.matrixWorld);
    xs.push(point.x);
    ys.push(point.y);
    zs.push(point.z);
  });
  if (!xs.length) return null;

  const percentile = (values, q) => {
    values.sort((a, b) => a - b);
    const pos = (values.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return values[lo] + (values[hi] - values[lo]) * (pos - lo);
  };

  return new THREE.Box3(
    new THREE.Vector3(percentile(xs, 0.005), percentile(ys, 0.005), percentile(zs, 0.005)),
    new THREE.Vector3(percentile(xs, 0.995), percentile(ys, 0.995), percentile(zs, 0.995)),
  );
}

function computeBounds() {
  if (!current) return null;
  if (current.type === "3dgs") return computeSplatBounds(current.object);
  const box = new THREE.Box3().setFromObject(current.object);
  return box.isEmpty() ? null : box;
}

function updateHelpers(center, radius, groundY) {
  removeHelpers();
  if (!current || current.type === "3dgs") return;

  const gridSize = Math.max(radius * 2.6, 1e-4);
  grid = new THREE.GridHelper(gridSize, 20, 0x38bdf8, 0x334155);
  grid.position.set(center.x, groundY, center.z);
  const gridMats = Array.isArray(grid.material) ? grid.material : [grid.material];
  gridMats.forEach((m) => {
    m.transparent = true;
    m.opacity = 0.22;
    m.depthWrite = false;
  });
  scene.add(grid);

  axes = new THREE.AxesHelper(Math.max(radius * 0.6, 1e-4));
  axes.position.copy(center);
  scene.add(axes);
}

function frameModel() {
  if (!current) return;
  const box = computeBounds();
  if (!box) return;

  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.length() * 0.5, 1e-4);
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const distance = (radius / Math.sin(fov / 2)) * 1.2;

  const direction =
    current.type === "3dgs"
      ? new THREE.Vector3(0, 0.15, 1)
      : new THREE.Vector3(0.55, 0.35, 0.8);
  direction.normalize();

  camera.position.copy(center).addScaledVector(direction, distance);
  camera.near = Math.max(distance - radius * 3, radius * 1e-4, 1e-6);
  camera.far = distance + radius * 4 + 1e-3;
  camera.updateProjectionMatrix();

  controls.target.copy(center);
  controls.minDistance = radius * 0.05;
  controls.maxDistance = radius * 20;
  controls.update();

  if (current.type === "points") {
    current.basePointSize = Math.max(radius * 0.006, 1e-5);
    current.material.size = current.basePointSize * pointScale;
  }

  updateHelpers(center, radius, box.min.y);
  current.boundsSize = size;
  updateStats();
}

function applyFlip(value, doFrame = true) {
  flipY = value;
  modelRoot.rotation.x = flipY ? Math.PI : 0;
  modelRoot.updateMatrixWorld(true);
  updateControls();
  if (doFrame) frameModel();
}

function setPointScale(value) {
  if (!current || current.type !== "points") return;
  pointScale = clamp(value, 0.15, 10);
  current.material.size = (current.basePointSize || 0.01) * pointScale;
}

function releaseCurrentObjects() {
  if (!current?.object) return;
  current.object.removeFromParent();
  if (current.type === "3dgs") current.object.dispose?.();
  current.geometry?.dispose?.();
  current.material?.dispose?.();
}

async function loadFile(file) {
  if (!file) return;
  const token = ++loadToken;
  setLoading(true, "读取 PLY 头…");
  setStatus("读取中…");
  els.fileName.textContent = file.name || "";

  try {
    // 让 loading 先画出来，避免大文件解析时界面像卡死
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const header = await readPlyHeader(file);
    if (token !== loadToken) return;

    clearModel();
    current = {
      name: file.name || "model.ply",
      fileSize: file.size,
      header,
      type: header.type,
      loadMs: 0,
      boundsSize: null,
    };
    updateControls();
    updateStats();
    setLoading(
      true,
      header.type === "3dgs" ? "加载 3DGS…" : header.type === "mesh" ? "加载网格…" : "加载点云…",
    );

    const started = performance.now();

    if (header.type === "3dgs") {
      flipY = true;
      const mesh = new SplatMesh({ file });
      modelRoot.add(mesh);
      await mesh.initialized;
      if (token !== loadToken) {
        mesh.removeFromParent();
        mesh.dispose?.();
        return;
      }
      current.object = mesh;
      current.numSplats = mesh.numSplats;
    } else {
      flipY = false;
      const buffer = await file.arrayBuffer();
      if (token !== loadToken) return;
      const geometry = plyLoader.parse(buffer);
      if (!geometry.getAttribute("position")) {
        throw new Error("PLY 没有 position 属性");
      }
      geometry.computeBoundingBox();

      const hasColors = !!geometry.getAttribute("color");
      const hasFaces = !!(geometry.index && geometry.index.count > 0);
      if (hasFaces) {
        if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
        const material = new THREE.MeshStandardMaterial({
          vertexColors: hasColors,
          color: hasColors ? 0xffffff : 0x9db7d5,
          roughness: 0.82,
          metalness: 0.05,
          side: THREE.DoubleSide,
          wireframe,
        });
        const mesh = new THREE.Mesh(geometry, material);
        modelRoot.add(mesh);
        current.type = "mesh";
        current.object = mesh;
        current.geometry = geometry;
        current.material = material;
      } else {
        const material = new THREE.PointsMaterial({
          size: 0.01,
          sizeAttenuation: true,
          vertexColors: hasColors,
          color: hasColors ? 0xffffff : 0x9db7d5,
        });
        const points = new THREE.Points(geometry, material);
        modelRoot.add(points);
        current.type = "points";
        current.object = points;
        current.geometry = geometry;
        current.material = material;
      }
    }

    current.loadMs = performance.now() - started;
    applyFlip(flipY, false);
    frameModel();
    updateControls();
    updateStats();
    setLoading(false);
    setStatus(`已载入 · ${typeLabel(current.type)}`);
  } catch (error) {
    console.error(error);
    if (token === loadToken) {
      clearModel();
      setLoading(false);
      setStatus("载入失败");
      toast(`载入失败：${error.message}`, 6000);
    }
  }
}

async function loadUrl(url) {
  if (!url) return;
  setLoading(true, "下载 PLY…");
  setStatus("下载中…");
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    let name = "model.ply";
    try {
      name = decodeURIComponent(new URL(url, location.href).pathname.split("/").pop()) || name;
    } catch {
      // 保留默认文件名
    }
    const file = new File([blob], name, {
      type: blob.type || "application/octet-stream",
    });
    await loadFile(file);
  } catch (error) {
    console.error(error);
    setLoading(false);
    setStatus("下载失败");
    toast(`下载失败：${error.message}`, 6000);
  }
}

function changePointSize(factor) {
  setPointScale(pointScale * factor);
}

els.btnOpen.addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", () => {
  const file = els.fileInput.files?.[0];
  if (file) loadFile(file);
  els.fileInput.value = "";
});

els.btnFit.addEventListener("click", () => frameModel());
els.btnFlip.addEventListener("click", () => applyFlip(!flipY));
els.btnReset.addEventListener("click", () => {
  pointScale = 1;
  applyFlip(current?.type === "3dgs", true);
});
els.btnWire.addEventListener("click", () => {
  if (!current || current.type !== "mesh") return;
  wireframe = !wireframe;
  current.material.wireframe = wireframe;
  updateControls();
});
els.btnPointMinus.addEventListener("click", () => changePointSize(1 / 1.5));
els.btnPointPlus.addEventListener("click", () => changePointSize(1.5));

els.btnUrl.addEventListener("click", () => {
  const url = els.urlInput.value.trim();
  if (!url) {
    toast("先粘贴一个 .ply URL");
    return;
  }
  loadUrl(url);
});
els.urlInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") els.btnUrl.click();
});

window.addEventListener("dragover", (event) => {
  event.preventDefault();
  els.drop.classList.add("active");
});
window.addEventListener("dragleave", (event) => {
  if (event.relatedTarget === null) els.drop.classList.remove("active");
});
window.addEventListener("drop", (event) => {
  event.preventDefault();
  els.drop.classList.remove("active");
  const file = event.dataTransfer?.files?.[0];
  if (file) loadFile(file);
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

updateControls();
updateStats();
setStatus("等待文件");
setLoading(false);

const initialUrl = params.get("url");
if (initialUrl) loadUrl(initialUrl);

// 调试入口
window.__viewer = {
  get current() {
    return current;
  },
  camera,
  controls,
  scene,
  modelRoot,
  loadFile,
  loadUrl,
  frameModel,
};
