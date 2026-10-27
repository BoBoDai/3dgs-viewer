import * as THREE from "three";
import { GaussianSplatRenderer, SplatMesh } from "gaussian-splat-lite";
import { HandRig, HandTracker } from "./hand.js";
import { ManoHandRig } from "./mano.js";

const params = new URLSearchParams(location.search);
const DEFAULT_FOV = Number(params.get("fov")) || 55;
// 模型保持 SHARP 的度量尺度与真实位置，只通过视场角“退后取景”，
// 这样初始画面和输入照片的透视一致，不会把场景压扁。
const FIT_FRACTION = 0.55; // 主体大约占画面高度的比例

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
els.canvasHost.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  DEFAULT_FOV,
  window.innerWidth / window.innerHeight,
  0.01,
  200,
);
camera.position.set(0, 0, 0);

// SHARP 的高斯带抗锯齿训练，按文档建议关掉 preBlur、改用 blur 补偿，
// 否则轮廓外会出现一圈发白的“光晕”。
const splatRenderer = new GaussianSplatRenderer({
  renderer,
  preBlurAmount: 0,
  blurAmount: 0.3,
});
scene.add(splatRenderer);

// pivot 控制模型在画面中的位置
// orient 负责坐标系转换：SHARP 输出 OpenCV 约定（+Y 向下、+Z 向前）
// holder 负责自旋
const pivot = new THREE.Group();
const orient = new THREE.Group();
orient.quaternion.set(1, 0, 0, 0); // 绕 X 轴 180°，把 +Y-down/+Z-forward 转成 Three.js 的 Y-up
const holder = new THREE.Group();
pivot.add(orient);
orient.add(holder);
scene.add(pivot);

pivot.position.set(0, 0, -3);

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

scene.add(new THREE.HemisphereLight(0xffffff, 0x1e293b, 2.2));
const keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
keyLight.position.set(1.2, 2.2, 3);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0x93c5fd, 1.0);
fillLight.position.set(-2, 0.5, 2);
scene.add(fillLight);

// ---------------------------------------------------------------- State

const state = {
  splat: null,
  modelName: "",
  numSplats: 0,
  basePosition: new THREE.Vector3(0, 0, -3), // 模型在原始重建中的位置
  tanX: 0.6, // 重建点云的半张角正切，用于取景
  tanY: 0.4,
  baseFov: 55, // 取景后的基准视场角，滚轮在此基础上变焦
  zoom: 1,
  spin: false,
  spinAngle: 0,
  // ?raw=1 保留 SHARP 的度量尺度与原始位置，用于和输入照片对比
  raw: new URLSearchParams(location.search).has("raw"),
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
    setModelStatus(`载入失败：${label}`, "warn");
    els.hint.textContent = "没找到模型？先运行 SHARP 生成 .ply，或把文件拖进窗口。";
    return;
  }

  // SHARP 会散落少量远离主体的高斯，直接包围盒会被它们撑大。
  // 用 2%~98% 分位数取“主体”范围，把主体中心挪到原点，
  // 但保留度量尺度与原始深度——透视关系才和照片一致。
  if (state.raw) {
    pivot.position.set(0, 0, 0);
    state.basePosition.set(0, 0, 0);
  } else {
    const { center, tanX, tanY } = robustFit(mesh);
    mesh.position.copy(center).multiplyScalar(-1);
    state.tanX = tanX;
    state.tanY = tanY;

    // 让主体保持在 SHARP 重建时的原始位置：pivot 放回 Rt(center)。
    // 这样初始画面和输入照片的透视完全一致，只是用更广的视场角取景。
    state.basePosition.set(center.x, -center.y, -center.z);
    pivot.position.copy(state.basePosition);
    applyFit();
  }

  state.splat = mesh;
  state.modelName = label;
  state.numSplats = mesh.numSplats;
  holder.scale.setScalar(1);
  if (!state.handEnabled) {
    setModelStatus(
      `${label} · ${(state.numSplats / 1e6).toFixed(2)}M splats`,
      "ok",
    );
    els.hint.textContent = "滚轮缩放 · 自旋展示 · 拖入 .ply 换模型";
  }
}

/** 对高斯中心做分位数统计，避免离群点主导取景 */
function robustFit(mesh) {
  const xs = [];
  const ys = [];
  const zs = [];
  const ratioX = [];
  const ratioY = [];
  const total = mesh.numSplats || 1;
  const stride = Math.max(1, Math.floor(total / 200000));

  // 回调签名是 (index, x, y, z)
  mesh.splats.forEachCenter((index, x, y, z) => {
    if (index % stride !== 0) return;
    xs.push(x);
    ys.push(y);
    zs.push(z);
    if (z > 0.05) {
      ratioX.push(Math.abs(x) / z);
      ratioY.push(Math.abs(y) / z);
    }
  });

  const percentile = (values, q) => {
    values.sort((a, b) => a - b);
    const position = (values.length - 1) * q;
    const lo = Math.floor(position);
    const hi = Math.ceil(position);
    return values[lo] + (values[hi] - values[lo]) * (position - lo);
  };

  const lo = new THREE.Vector3(percentile(xs, 0.02), percentile(ys, 0.02), percentile(zs, 0.02));
  const hi = new THREE.Vector3(percentile(xs, 0.98), percentile(ys, 0.98), percentile(zs, 0.98));

  return {
    center: lo.clone().add(hi).multiplyScalar(0.5),
    size: hi.sub(lo),
    // 重建点云的张角 ≈ 原照片的视场角，用它来做取景
    tanX: Math.max(percentile(ratioX, 0.995), 0.2),
    tanY: Math.max(percentile(ratioY, 0.995), 0.15),
  };
}

/** 用视场角给主体“取景”，模型本身不缩放，透视保持原样 */
function applyFit() {
  if (state.raw) return;
  const tanHalf = Math.max(state.tanY, state.tanX / camera.aspect) / FIT_FRACTION;
  state.baseFov = clamp((2 * Math.atan(tanHalf) * 180) / Math.PI, 30, 90);
  camera.fov = state.baseFov;
  camera.updateProjectionMatrix();
}

function loadDefaultModel() {
  // ?model=xxx.ply 可以加载 web/public/models 下的其他模型
  const name = new URLSearchParams(location.search).get("model") || "scene.ply";
  const url = new URL(`models/${name}`, document.baseURI).href;
  return loadSplat({ url }, name);
}

// ---------------------------------------------------------------- 摄像头预览

let cameraStream = null;
let handTracker = null;
let handInitPromise = null;

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
  els.btnHand.textContent = "手部同步：关";
  els.btnHand.classList.remove("primary");
  els.btnSpin.disabled = false;
  setHandStatus("关");
  els.hint.textContent = "滚轮缩放 · 自旋展示 · 拖入 .ply 换模型";
  if (state.splat) {
    setModelStatus(
      `${state.modelName} · ${(state.numSplats / 1e6).toFixed(2)}M splats`,
      "ok",
    );
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
    // 滚轮相当于推拉相机
    state.zoom = clamp(state.zoom * (1 - Math.sign(event.deltaY) * 0.08), 0.8, 1.25);
  },
  { passive: true },
);

// ---------------------------------------------------------------- 逐帧更新

let lastFrame = performance.now();

function frame(now) {
  const dt = clamp((now - lastFrame) / 1000, 0, 0.1) || 1 / 60;
  lastFrame = now;

  if (state.handEnabled) {
    // 手部模式：固定相机，手模型按各自在画面里的位置摆放
    camera.fov = clamp(55 / state.zoom, 32, 85);
    camera.aspect = window.innerWidth / window.innerHeight;
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
  } else if (!state.raw) {
    // 滚轮变焦用视场角，避免近距离缩放的透视爆炸。
    camera.fov = clamp(state.baseFov / state.zoom, 40, 100);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    camera.position.set(0, 0, 0);
    camera.quaternion.identity();

    // 模型保持居中，只改自身姿态
    pivot.position.copy(state.basePosition);

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

els.btnSpin.addEventListener("click", () => {
  state.spin = !state.spin;
  els.btnSpin.textContent = `自旋：${state.spin ? "开" : "关"}`;
});

els.btnReset.addEventListener("click", () => {
  state.spinAngle = 0;
  state.zoom = 1;
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
  applyFit();
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// 方便在控制台里调试
window.__demo = { THREE, scene, camera, renderer, splatRenderer, pivot, orient, holder, state, loadSplat };
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
