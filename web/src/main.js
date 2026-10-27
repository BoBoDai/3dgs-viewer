import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { TrackballControls } from "three/addons/controls/TrackballControls.js";
import { GaussianSplatRenderer, SplatMesh } from "gaussian-splat-lite";
import { HandRig, HandTracker } from "./hand.js";
import { ManoHandRig } from "./mano.js";

const params = new URLSearchParams(location.search);
const DEFAULT_FOV = 55;
const GENERIC_MARGIN = 1.15; // 自动取景时给包围球留的边距

const els = {
  video: document.getElementById("camera"),
  canvasHost: document.getElementById("canvas-host"),
  modelStatus: document.getElementById("model-status"),
  handStatus: document.getElementById("hand-status"),
  fps: document.getElementById("fps"),
  hint: document.getElementById("hint"),
  btnCamera: document.getElementById("btn-camera"),
  btnHand: document.getElementById("btn-hand"),
  btnLoad: document.getElementById("btn-load"),
  btnSpin: document.getElementById("btn-spin"),
  btnFlip: document.getElementById("btn-flip"),
  btnReset: document.getElementById("btn-reset"),
  fileInput: document.getElementById("file-input"),
  dropOverlay: document.getElementById("drop-overlay"),
  toast: document.getElementById("toast"),
};

// ---------------------------------------------------------------- Three.js

const renderer = new THREE.WebGLRenderer({
  antialias: false, // Splats 不需要 MSAA，开启反而更慢
  alpha: true,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
// 手部模型是 PBR 材质，用 ACES 压高光，避免直射灯在皮肤上过曝
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
els.canvasHost.appendChild(renderer.domElement);

const scene = new THREE.Scene();

// 给 MANO/占位手补一层环境反射，纯直射灯会让低模手看起来像塑料
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.35;
pmrem.dispose();
const camera = new THREE.PerspectiveCamera(
  DEFAULT_FOV,
  window.innerWidth / window.innerHeight,
  0.01,
  200,
);
camera.position.set(0, 0, 0);

// 模型模式：左键拖动自由旋转、滚轮缩放、按住中键平移。
// 用 TrackballControls 而不是 OrbitControls：前者可以连续翻过顶点/底点，
// 不会在极角 0 / π 处撞到“空气墙”。手部模式会关闭它。
const controls = new TrackballControls(camera, renderer.domElement);
controls.rotateSpeed = 3.0;
controls.zoomSpeed = 2.0;
controls.panSpeed = 0.6;
// CAD 手感：松手即停，不做惯性滑行
controls.staticMoving = true;
controls.enabled = false; // 有模型后才允许交互

controls.mouseButtons = {
  LEFT: THREE.MOUSE.ROTATE,
  MIDDLE: THREE.MOUSE.PAN,
  RIGHT: null,
};

// 关掉 preBlur、改用少量 blur，避免高斯轮廓外出现发白的“光晕”。
const splatRenderer = new GaussianSplatRenderer({
  renderer,
  preBlurAmount: 0,
  blurAmount: 0.3,
});
scene.add(splatRenderer);

// pivot 控制模型在画面中的位置
// orient 负责坐标系转换：3DGS 输出通常是 OpenCV/COLMAP 约定（+Y 向下、+Z 向前）
// holder 负责自旋
const pivot = new THREE.Group();
const orient = new THREE.Group();
const holder = new THREE.Group();
pivot.add(orient);
orient.add(holder);
scene.add(pivot);

pivot.position.set(0, 0, 0);

// 手部模型：优先用 MANO 蒙皮手，加载失败时退回胶囊体占位手。
// 两者的驱动接口一致，后续换成 3DGS 手时也可以复用同一套输入。
const fallbackHand = new HandRig();
fallbackHand.group.visible = false;
fallbackHand.material.side = THREE.DoubleSide;
scene.add(fallbackHand.group);

// 两个手位，每个手位都有左手/右手资产。最多同时显示两只手。
// 实际右手用左手资产、实际左手用右手资产，得到和右上角镜像预览一致的“镜像手”。
const manoRigs = [
  { right: new ManoHandRig(), left: new ManoHandRig() },
  { right: new ManoHandRig(), left: new ManoHandRig() },
];
for (const slot of manoRigs) {
  scene.add(slot.right.group);
  scene.add(slot.left.group);
}

let manoLoaded = false;
let lastHandSeen = 0;
const HAND_HIDE_AFTER = 300;

function hideAllHandModels() {
  fallbackHand.group.visible = false;
  for (const slot of manoRigs) {
    slot.right.group.visible = false;
    slot.left.group.visible = false;
  }
}

scene.add(new THREE.HemisphereLight(0xffffff, 0x1e293b, 0.9));
const keyLight = new THREE.DirectionalLight(0xffffff, 2.0);
keyLight.position.set(1.2, 2.2, 3);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0x93c5fd, 0.6);
fillLight.position.set(-2, 0.5, 2);
scene.add(fillLight);
// 背后的轮廓光，把手指从深色背景里勾出来
const rimLight = new THREE.DirectionalLight(0xffffff, 1.0);
rimLight.position.set(-1.5, 1.2, -2.5);
scene.add(rimLight);

// ---------------------------------------------------------------- State

const state = {
  splat: null,
  modelName: "",
  numSplats: 0,
  radius: 1, // 模型包围球半径（按 2%~98% 分位数）
  baseDistance: 3, // 自动取景的相机距离
  baseFov: 55, // 基准视场角
  zoom: 1,
  spin: false,
  spinAngle: 0,
  // OpenCV/COLMAP 约定是 +Y 向下，默认做一次 X 轴 180° 翻转；
  // ?up=1 表示文件已经是 +Y 向上（例如 Blender 导出的模型）。
  upFlipped: params.get("up") !== "1",
  handEnabled: false,
  handLoading: false,
  frames: 0,
  fpsAt: performance.now(),
};

// ---------------------------------------------------------------- 工具

let toastTimer = 0;
function toast(message, ms = 3200) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), ms);
}

function setModelStatus(text, kind = "") {
  els.modelStatus.textContent = text;
  els.modelStatus.className = kind;
}

function setHandStatus(text, kind = "") {
  els.handStatus.textContent = text;
  els.handStatus.className = kind;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function splatCountText(count) {
  if (count >= 1e6) return `${(count / 1e6).toFixed(2)}M splats`;
  if (count >= 1e3) return `${(count / 1e3).toFixed(1)}K splats`;
  return `${count} splats`;
}

function modelSummary() {
  return `${state.modelName} · ${splatCountText(state.numSplats)}`;
}

function idleHint() {
  return "左键拖动旋转 · 滚轮缩放 · 中键拖动平移";
}

/** 切换“Y 轴是否翻转”，用于校正第三方模型的 up 方向。 */
function applyUpFlip(flipped) {
  state.upFlipped = flipped;
  // 绕 X 轴 180°：把 +Y-down/+Z-forward 转成 Three.js 的 Y-up
  // THREE.Quaternion.set 的参数顺序是 (x, y, z, w)
  orient.quaternion.set(flipped ? 1 : 0, 0, 0, flipped ? 0 : 1);
  if (els.btnFlip) {
    els.btnFlip.textContent = `翻转：${flipped ? "开" : "关"}`;
  }
}
applyUpFlip(state.upFlipped);

// ---------------------------------------------------------------- 模型加载

async function loadSplat(source, label) {
  if (state.handEnabled) disableHandMode();

  const old = state.splat;
  state.splat = null;
  if (old) {
    old.removeFromParent();
    old.dispose();
  }

  setModelStatus(`解码 ${label} …`);
  els.hint.textContent = "正在解码 3DGS 数据，大模型需要几秒钟…";

  let mesh;
  try {
    mesh = source.file
      ? new SplatMesh({ file: source.file })
      : new SplatMesh({ url: source.url });
    holder.add(mesh);
    await mesh.initialized;
  } catch (error) {
    console.error(error);
    mesh?.removeFromParent();
    mesh?.dispose?.();
    const reason = error?.message || String(error);
    setModelStatus(`载入失败：${label}`, "warn");
    if (/compressed|packed_position|min_scale_x|chunk/i.test(reason)) {
      els.hint.textContent =
        "这个 PLY 看起来是压缩/分块格式，解码失败。请确认文件完整，或导出未压缩 .ply / .spz / .sog / .rad。";
    } else {
      els.hint.textContent = `无法解码这个文件：${reason}`;
    }
    toast(`载入失败：${reason}`, 6000);
    return;
  }

  // 重建结果都会散落少量远离主体的高斯，直接包围盒会被它们撑大。
  // 用 2%~98% 分位数取“主体”范围。
  const fit = robustFit(mesh);

  // 自动居中 + 用包围球和固定视场角算出相机距离。
  mesh.position.copy(fit.center).multiplyScalar(-1);
  state.radius = fit.radius;
  state.zoom = 1;
  // 每个新模型都回到默认 up 约定，避免沿用上一个模型的翻转状态
  applyUpFlip(params.get("up") !== "1");
  controls.enabled = true;
  applyFit();
  els.btnFlip.disabled = false;

  state.splat = mesh;
  state.modelName = label;
  state.numSplats = mesh.numSplats;
  holder.scale.setScalar(1);
  if (!state.handEnabled) {
    setModelStatus(modelSummary(), "ok");
    els.hint.textContent = idleHint();
  }
}

/** 对高斯中心做分位数统计，避免离群点主导取景 */
function robustFit(mesh) {
  const xs = [];
  const ys = [];
  const zs = [];
  const total = mesh.numSplats || 1;
  const stride = Math.max(1, Math.floor(total / 200000));

  // 回调签名是 (index, x, y, z)
  mesh.splats.forEachCenter((index, x, y, z) => {
    if (index % stride !== 0) return;
    xs.push(x);
    ys.push(y);
    zs.push(z);
  });

  if (xs.length === 0) {
    return {
      center: new THREE.Vector3(),
      size: new THREE.Vector3(2, 2, 2),
      radius: 1,
    };
  }

  const percentile = (values, q) => {
    if (values.length === 0) return NaN;
    values.sort((a, b) => a - b);
    const position = (values.length - 1) * q;
    const lo = Math.floor(position);
    const hi = Math.ceil(position);
    return values[lo] + (values[hi] - values[lo]) * (position - lo);
  };

  const lo = new THREE.Vector3(percentile(xs, 0.02), percentile(ys, 0.02), percentile(zs, 0.02));
  const hi = new THREE.Vector3(percentile(xs, 0.98), percentile(ys, 0.98), percentile(zs, 0.98));
  const size = hi.clone().sub(lo);

  return {
    center: lo.clone().add(hi).multiplyScalar(0.5),
    size,
    // 用“主体”包围球的半径取景，离群点不会把画面撑爆
    radius: Math.max(size.length() * 0.5, 1e-4),
  };
}

/** 自动取景：模型居中，相机退到包围球外，并重置轨道控制器。 */
function applyFit() {
  const verticalFov = (DEFAULT_FOV * Math.PI) / 180;
  const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
  const halfAngle = Math.max(1e-3, Math.min(verticalFov, horizontalFov) / 2);
  state.baseFov = DEFAULT_FOV;
  state.baseDistance = (state.radius * GENERIC_MARGIN) / Math.sin(halfAngle);

  camera.fov = state.baseFov;
  camera.up.set(0, 1, 0);
  controls.target.set(0, 0, 0);
  camera.position.set(0, 0, state.baseDistance);
  controls.minDistance = Math.max(state.radius * 0.08, 1e-5);
  controls.maxDistance = Math.max(state.radius * 20, state.baseDistance * 2);
  camera.lookAt(controls.target);
  updateClipping();
  controls.update();
}

/** 轨道缩放改了相机距离，near/far 要跟着模型尺度走。 */
function updateClipping() {
  const distance = camera.position.distanceTo(controls.target);
  camera.near = Math.max(distance - state.radius * 2, distance * 0.01, 1e-5);
  camera.far = distance + state.radius * 4 + 1e-3;
  camera.updateProjectionMatrix();
}

function loadDefaultModel() {
  // ?model= 可以是 web/public/models 下的文件名，也可以是完整的 http(s) URL
  const name = new URLSearchParams(location.search).get("model") || "scene.ply";
  let url;
  if (/^(https?:)?\/\//i.test(name) || /^(data|blob):/i.test(name)) {
    url = name;
  } else if (name.startsWith("/")) {
    url = new URL(name, location.origin).href;
  } else {
    url = new URL(`models/${name}`, document.baseURI).href;
  }
  return loadSplat({ url }, name);
}

// ---------------------------------------------------------------- 摄像头预览

let cameraStream = null;
let handTracker = null;
let handInitPromise = null;
let savedView = null; // 进入手部模式前的模型相机姿态

/** 小窗比例跟随摄像头的原生分辨率，避免 16:9 画面被塞进 4:3 的框里 */
function syncCameraAspect() {
  const vw = els.video.videoWidth;
  const vh = els.video.videoHeight;
  if (!vw || !vh) return;
  els.video.style.setProperty("--camera-aspect", `${vw} / ${vh}`);
}

els.video.addEventListener("loadedmetadata", syncCameraAspect);
els.video.addEventListener("resize", syncCameraAspect);

async function ensureCamera() {
  if (cameraStream) return true;

  els.btnCamera.disabled = true;
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
      audio: false,
    });
    els.video.srcObject = cameraStream;
    await els.video.play();
    syncCameraAspect();
    els.video.classList.add("live");
    els.btnCamera.textContent = "关闭摄像头";
    return true;
  } catch (error) {
    console.error(error);
    cameraStream = null;
    toast(
      error?.name === "NotAllowedError"
        ? "摄像头权限被拒绝 — 可在浏览器地址栏重新允许"
        : `无法打开摄像头：${error.message}`,
    );
    return false;
  } finally {
    els.btnCamera.disabled = false;
  }
}

function stopCamera() {
  if (!cameraStream) return;
  cameraStream.getTracks().forEach((track) => track.stop());
  cameraStream = null;
  els.video.srcObject = null;
  els.video.classList.remove("live");
  els.btnCamera.textContent = "开启摄像头";
}

async function toggleCamera() {
  if (cameraStream) {
    if (state.handEnabled) disableHandMode();
    stopCamera();
  } else {
    await ensureCamera();
  }
}

async function ensureHandTracker() {
  if (handTracker?.landmarker) return handTracker;
  if (!handInitPromise) {
    handInitPromise = (async () => {
      const tracker = new HandTracker(els.video);
      await tracker.init();
      handTracker = tracker;
      return tracker;
    })().catch((error) => {
      handInitPromise = null;
      throw error;
    });
  }
  return handInitPromise;
}

async function enableHandMode() {
  if (state.handEnabled || state.handLoading) return;
  if (!(await ensureCamera())) return;

  state.handLoading = true;
  state.handEnabled = true;
  state.zoom = 1;
  savedView = {
    position: camera.position.clone(),
    quaternion: camera.quaternion.clone(),
    up: camera.up.clone(),
    target: controls.target.clone(),
    fov: camera.fov,
    near: camera.near,
    far: camera.far,
  };
  controls.enabled = false;
  pivot.visible = false;
  els.btnHand.textContent = "手部同步：开";
  els.btnHand.classList.add("primary");
  els.btnSpin.disabled = true;
  setModelStatus("手部 · 实时同步", "ok");
  setHandStatus("加载 MANO 手…");
  els.hint.textContent = "把手放在摄像头前 · 手指动作实时同步 · 再点一次关闭";

  try {
    const jobs = [];
    for (const slot of manoRigs) {
      jobs.push(slot.right.load("/models/mano_right.json"));
      jobs.push(slot.left.load("/models/mano_left.json"));
    }
    const loaded = await Promise.allSettled(jobs);
    manoLoaded = loaded.some((item) => item.status === "fulfilled");
    if (!manoLoaded) {
      console.warn("MANO 手加载失败，退回占位手", loaded);
      toast("MANO 手加载失败，已退回占位手");
    }

    hideAllHandModels();
    fallbackHand.relaxTargets();
    for (const slot of manoRigs) {
      slot.right.relaxTargets();
      slot.left.relaxTargets();
    }
    lastHandSeen = 0;

    await ensureHandTracker();
    if (!state.handEnabled) return;
    setHandStatus("未检测到手", "warn");
  } catch (error) {
    console.error(error);
    toast(`手部模型加载失败：${error.message}`);
    disableHandMode();
  } finally {
    state.handLoading = false;
  }
}

function disableHandMode() {
  if (!state.handEnabled) return;
  state.handEnabled = false;
  hideAllHandModels();
  fallbackHand.relaxTargets();
  for (const slot of manoRigs) {
    slot.right.relaxTargets();
    slot.left.relaxTargets();
  }
  lastHandSeen = 0;
  pivot.visible = true;

  // 回到进入手部模式前的模型视角
  if (savedView) {
    camera.position.copy(savedView.position);
    camera.quaternion.copy(savedView.quaternion);
    camera.up.copy(savedView.up);
    camera.fov = savedView.fov;
    camera.near = savedView.near;
    camera.far = savedView.far;
    controls.target.copy(savedView.target);
    camera.updateProjectionMatrix();
    savedView = null;
  }
  controls.enabled = !!state.splat;
  if (controls.enabled) controls.update();

  els.btnHand.textContent = "手部同步：关";
  els.btnHand.classList.remove("primary");
  els.btnSpin.disabled = false;
  setHandStatus("关");
  els.hint.textContent = idleHint();
  if (state.splat) {
    setModelStatus(modelSummary(), "ok");
  } else {
    setModelStatus("未加载模型", "warn");
  }
}

function toggleHandMode() {
  if (state.handEnabled) disableHandMode();
  else enableHandMode();
}

window.addEventListener(
  "wheel",
  (event) => {
    // 模型模式的滚轮由 OrbitControls 处理；手部模式没有控制器，用滚轮改视场角
    if (!state.handEnabled) return;
    state.zoom = clamp(state.zoom * (1 - Math.sign(event.deltaY) * 0.08), 0.5, 3);
  },
  { passive: true },
);

// SolidWorks 的“缩放到合适大小”快捷键
window.addEventListener("keydown", (event) => {
  if (event.key !== "f" && event.key !== "F") return;
  if (
    event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLTextAreaElement
  ) {
    return;
  }
  if (!state.handEnabled && state.splat) applyFit();
});

// ---------------------------------------------------------------- 逐帧更新

let lastFrame = performance.now();

function frame(now) {
  const dt = clamp((now - lastFrame) / 1000, 0, 0.1) || 1 / 60;
  lastFrame = now;

  if (state.handEnabled) {
    // 手部模式：固定相机，手模型按各自在画面里的位置摆放。
    // 手部场景的实际尺度约 0.5，不能沿用 3DGS 模型按包围球算出的 near/far，
    // 否则手会落在近裁剪面之前被整只裁掉。
    camera.fov = clamp(55 / state.zoom, 32, 85);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.near = 0.01;
    camera.far = 20;
    camera.updateProjectionMatrix();
    camera.position.set(0, 0, 0);
    camera.quaternion.identity();

    if (handTracker?.landmarker) {
      const result = handTracker.detect(now);
      if (result) {
        const allLandmarks = result.landmarks || [];
        const allWorld = result.worldLandmarks || [];
        const allHanded = result.handednesses || [];
        const count = Math.min(allLandmarks.length, 2);

        if (count > 0) {
          lastHandSeen = now;
          const aspect =
            (els.video.videoWidth || 1280) / (els.video.videoHeight || 720);

          const hands = [];
          for (let i = 0; i < count; i += 1) {
            const lm = allLandmarks[i];
            const palm = lm[9] || lm[0];
            hands.push({
              lm,
              world: allWorld[i],
              handed: allHanded[i],
              label: allHanded[i]?.[0]?.categoryName || "",
              // 镜像后的屏幕坐标：和右上角的镜像预览一致
              ndc: {
                x: clamp(1 - 2 * palm.x, -1, 1),
                y: clamp(1 - 2 * palm.y, -1, 1),
              },
            });
          }
          hands.sort((a, b) => a.ndc.x - b.ndc.x);

          hideAllHandModels();
          const twoHands = hands.length > 1;

          if (!manoLoaded) {
            // MANO 加载失败：只显示一个居中的占位手
            fallbackHand.group.visible = true;
            fallbackHand.update(
              hands[0].lm,
              hands[0].world,
              hands[0].handed,
              aspect,
              now,
            );
          } else {
            for (let slot = 0; slot < hands.length; slot += 1) {
              const hand = hands[slot];
              // 用同侧资产，再对整只手做水平镜像：方向和摄像头里的手一致
              const modelSide = hand.label === "Left" ? "left" : "right";
              let rig = manoRigs[slot]?.[modelSide];
              if (!rig?.ready) {
                rig = manoRigs[slot]?.[modelSide === "left" ? "right" : "left"];
              }
              if (!rig?.ready) continue;

              rig.group.visible = true;
              rig.setView(hand.ndc, twoHands);
              rig.update(hand.lm, hand.world, hand.handed, aspect, now);
            }
          }

          const label =
            hands.length === 2
              ? "2 只手"
              : hands[0].label === "Right"
                ? "镜像右手"
                : hands[0].label === "Left"
                  ? "镜像左手"
                  : "1 只手";
          setHandStatus(
            `追踪中 · ${handTracker.lastMs.toFixed(1)} ms · ${label}`,
            "ok",
          );
        }
      }
    }

    if (now - lastHandSeen > HAND_HIDE_AFTER) {
      hideAllHandModels();
      setHandStatus("未检测到手", "warn");
    }

    for (const slot of manoRigs) {
      slot.right.tick(dt, now);
      slot.left.tick(dt, now);
    }
    fallbackHand.tick(dt, now);
  } else {
    if (camera.aspect !== window.innerWidth / window.innerHeight) {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
    }

    // 轨道控制器负责拖动旋转 / 滚轮缩放 / 右键平移
    if (state.splat && controls.enabled) {
      controls.update();
      updateClipping();
    }

    // 自旋：只改模型自身姿态
    if (state.spin) state.spinAngle += dt * 0.5;
    holder.rotation.y = state.spinAngle;
  }

  renderer.render(scene, camera);

  state.frames++;
  if (now - state.fpsAt >= 500) {
    const fps = (state.frames * 1000) / (now - state.fpsAt);
    els.fps.textContent = `${fps.toFixed(0)} fps`;
    state.frames = 0;
    state.fpsAt = now;
  }
}

renderer.setAnimationLoop(frame);

// ---------------------------------------------------------------- 交互

els.btnCamera.addEventListener("click", toggleCamera);
els.btnHand.addEventListener("click", toggleHandMode);

els.btnLoad.addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", () => {
  const file = els.fileInput.files?.[0];
  if (file) loadSplat({ file }, file.name);
  els.fileInput.value = "";
});

els.btnFlip.addEventListener("click", () => {
  applyUpFlip(!state.upFlipped);
});

els.btnSpin.addEventListener("click", () => {
  state.spin = !state.spin;
  els.btnSpin.textContent = `自旋：${state.spin ? "开" : "关"}`;
});

els.btnReset.addEventListener("click", () => {
  state.spinAngle = 0;
  state.zoom = 1;
  if (!state.handEnabled && state.splat) applyFit();
});

window.addEventListener("dragover", (event) => {
  event.preventDefault();
  els.dropOverlay.classList.add("active");
});
window.addEventListener("dragleave", (event) => {
  if (event.relatedTarget === null) els.dropOverlay.classList.remove("active");
});
window.addEventListener("drop", (event) => {
  event.preventDefault();
  els.dropOverlay.classList.remove("active");
  const file = event.dataTransfer?.files?.[0];
  if (file) loadSplat({ file }, file.name);
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  controls.handleResize();
  // 保留用户当前的视角，只更新裁剪面
  if (!state.handEnabled && state.splat && controls.enabled) {
    controls.update();
    updateClipping();
  }
});

// 方便在控制台里调试
window.__demo = { THREE, scene, camera, controls, renderer, splatRenderer, pivot, orient, holder, state, loadSplat };
window.__hand = {
  get rig() {
    for (const slot of manoRigs) {
      for (const side of ["right", "left"]) {
        if (slot[side].group.visible) return slot[side];
      }
    }
    return fallbackHand;
  },
  get mano() {
    for (const slot of manoRigs) {
      for (const side of ["right", "left"]) {
        if (slot[side].group.visible) return slot[side];
      }
    }
    for (const slot of manoRigs) {
      for (const side of ["right", "left"]) {
        if (slot[side].ready) return slot[side];
      }
    }
    return null;
  },
  manoRigs,
  fallback: fallbackHand,
  tracker: () => handTracker,
  enable: enableHandMode,
  disable: disableHandMode,
};

loadDefaultModel().then(() => {
  // ?hand=1 直接进入手部同步模式（等默认模型加载完再切，避免状态被覆盖）
  if (params.has("hand")) enableHandMode();
});
