import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";

/**
 * 路线 A 的占位手：用 Three.js 的关节层级拼出来的一只右手。
 * 它不是最终的手部 3DGS，但骨骼结构和驱动信号可以原样复用。
 */

const PALM_LEN = 0.1; // 手腕 → 中指根部的模型长度，用来把 2D 投影归一化

const FINGERS = {
  thumb: {
    landmarks: [1, 2, 3, 4],
    lengths: [0.034, 0.03, 0.024],
    radius: 0.009,
    base: [-0.043, 0.004, 0.01],
    restSpread: 1.05,
    baseTiltX: 0.2,
    isThumb: true,
  },
  index: {
    landmarks: [5, 6, 7, 8],
    lengths: [0.04, 0.025, 0.02],
    radius: 0.0082,
    base: [-0.031, 0.05, 0],
    restSpread: 0.07,
    baseTiltX: 0,
  },
  middle: {
    landmarks: [9, 10, 11, 12],
    lengths: [0.044, 0.028, 0.021],
    radius: 0.0085,
    base: [-0.008, 0.055, 0],
    restSpread: 0.01,
    baseTiltX: 0,
  },
  ring: {
    landmarks: [13, 14, 15, 16],
    lengths: [0.04, 0.026, 0.02],
    radius: 0.0082,
    base: [0.014, 0.051, 0],
    restSpread: -0.05,
    baseTiltX: 0,
  },
  pinky: {
    landmarks: [17, 18, 19, 20],
    lengths: [0.032, 0.021, 0.018],
    radius: 0.0072,
    base: [0.032, 0.044, 0],
    restSpread: -0.13,
    baseTiltX: 0,
  },
};

const MAX_BEND = [1.35, 1.55, 1.0];
const BASE_SCALE = 1.15;
const HAND_Z = -0.56;
const SMOOTH_JOINT = 0.055;
const SMOOTH_ROOT = 0.11;
const LOST_AFTER = 500;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const vec = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });

function angleBetween(a, b) {
  const la = Math.hypot(a.x, a.y, a.z) || 1e-6;
  const lb = Math.hypot(b.x, b.y, b.z) || 1e-6;
  const cos = (a.x * b.x + a.y * b.y + a.z * b.z) / (la * lb);
  return Math.acos(clamp(cos, -1, 1));
}

function segmentMesh(radius, length, material) {
  const middle = Math.max(length - 2 * radius, 0.002);
  const geo = new THREE.CapsuleGeometry(radius, middle, 6, 12);
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.y = length / 2;
  return mesh;
}

function buildChain(spec, material) {
  const base = new THREE.Group();
  base.position.fromArray(spec.base);
  base.rotation.z = spec.restSpread;
  if (spec.baseTiltX) base.rotation.x = spec.baseTiltX;

  const joints = [base];
  const restBends = [0, 0, 0];
  const currentBends = [0, 0, 0];
  const targetBends = [0, 0, 0];

  let link = base;
  for (let i = 0; i < spec.lengths.length; i += 1) {
    if (i > 0) {
      const joint = new THREE.Group();
      joint.position.y = spec.lengths[i - 1];
      link.add(joint);
      joints.push(joint);
      link = joint;
    }
    link.add(segmentMesh(spec.radius, spec.lengths[i], material));
  }

  return {
    ...spec,
    joints,
    restBends,
    currentBends,
    targetBends,
    restSpread: spec.restSpread,
    currentSpread: spec.restSpread,
    targetSpread: spec.restSpread,
    restRatios: spec.lengths.map((l) => l / PALM_LEN),
  };
}

export class HandRig {
  constructor() {
    this.group = new THREE.Group();
    this.group.position.set(0, -0.015, HAND_Z);
    this.group.scale.setScalar(BASE_SCALE);

    const material = new THREE.MeshStandardMaterial({
      color: 0xd9a27e,
      roughness: 0.62,
      metalness: 0.02,
    });
    this.material = material;

    // 手掌 + 手腕
    const palm = new THREE.Mesh(
      new RoundedBoxGeometry(0.086, 0.1, 0.032, 4, 0.014),
      material,
    );
    palm.position.set(0, 0, 0);
    this.group.add(palm);

    const wrist = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.026, 0.07, 6, 14),
      material,
    );
    wrist.position.set(0, -0.098, 0);
    this.group.add(wrist);

    this.chains = {};
    for (const [key, spec] of Object.entries(FINGERS)) {
      const chain = buildChain(spec, material);
      this.chains[key] = chain;
      this.group.add(chain.joints[0]);
    }

    this.lastSeen = 0;
    this.mirror = false;
    this.targetRoll = 0;
    this.currentRoll = 0;
    this.targetScale = 1;
    this.currentScale = 1;
    this.debug = {};
  }

  /** 关闭时把手收成自然放松的姿态 */
  relaxTargets() {
    for (const chain of Object.values(this.chains)) {
      chain.targetBends.fill(0);
      chain.targetSpread = chain.restSpread;
    }
    this.targetRoll = 0;
    this.targetScale = 1;
  }

  /**
   * 用 MediaPipe 的归一化 2D 点驱动。
   * 用 2D 投影长度 / 静止长度做余弦，避免 worldLandmarks 的 z 轴符号问题；
   * 手指朝镜头弯曲时投影变短，正好对应关节弯曲。
   */
  update(landmarks, worldLandmarks, handednesses, aspect, now) {
    if (!landmarks || landmarks.length < 21) return false;
    this.lastSeen = now;

    const p = (i) => ({ x: landmarks[i].x * aspect, y: landmarks[i].y });
    const wrist = p(0);
    const middleMcp = p(9);
    const palmLen2D = dist(wrist, middleMcp);
    if (palmLen2D < 1e-4) return false;

    // 模型正面朝镜头。根据拇指在原始画面里的左右，决定是否水平镜像，
    // 让主画面里看到的拇指方向和角落的镜像预览一致。
    const thumbDelta = landmarks[4].x - landmarks[0].x;
    this.mirror = thumbDelta < 0;

    const rawLabel = handednesses?.[0]?.[0]?.categoryName;
    const middleSpread = Math.atan2(
      middleMcp.x - wrist.x,
      -(middleMcp.y - wrist.y),
    );

    const debugBends = {};
    for (const [key, chain] of Object.entries(this.chains)) {
      const [a, b, c, d] = chain.landmarks;

      if (worldLandmarks) {
        // 3D 关节角：不受投影缩短影响，握拳时 MCP/PIP/DIP 都能拿到真实弯曲。
        const v1 = vec(worldLandmarks[b], worldLandmarks[a]);
        const v2 = vec(worldLandmarks[c], worldLandmarks[b]);
        const v3 = vec(worldLandmarks[d], worldLandmarks[c]);
        const up = vec(worldLandmarks[9], worldLandmarks[0]);
        const angles = [
          angleBetween(up, v1),
          angleBetween(v1, v2),
          angleBetween(v2, v3),
        ];
        // 拇指的姿态更多靠外展/内收，X 轴弯曲收一点，避免整根拇指戳向镜头
        const bendScale = chain.isThumb ? 0.55 : 1;
        for (let i = 0; i < 3; i += 1) {
          chain.targetBends[i] = clamp(
            angles[i] * bendScale,
            0,
            MAX_BEND[i],
          );
        }
      } else {
        // 没有 worldLandmarks 时退回 2D 投影长度：手指朝镜头弯曲会变短
        const segs = [
          [a, b],
          [b, c],
          [c, d],
        ];
        for (let i = 0; i < 3; i += 1) {
          const [from, to] = segs[i];
          const projected = dist(p(from), p(to)) / palmLen2D;
          const ratio = projected / chain.restRatios[i];
          const bend = Math.acos(clamp(ratio, 0, 1));
          const bendScale = chain.isThumb ? 0.55 : 1;
          chain.targetBends[i] = clamp(
            (bend / (Math.PI / 2)) * MAX_BEND[i] * bendScale,
            0,
            MAX_BEND[i],
          );
        }
      }
      debugBends[key] = chain.targetBends.map(
        (v) => +((v * 180) / Math.PI).toFixed(0),
      );

      if (!chain.isThumb) {
        const mcp = p(a);
        const angle = Math.atan2(mcp.x - wrist.x, -(mcp.y - wrist.y));
        // 中指为 0，其余手指按相对张开角映射到 rotation.z（正方向朝 -X）
        let rel = angle - middleSpread;
        rel = Math.atan2(Math.sin(rel), Math.cos(rel));
        chain.targetSpread = clamp(-rel, -0.38, 0.38);
      } else {
        // 拇指用 CMC→MCP 的画面方向决定外展/内收：
        // 张开时指向斜上方，握拳时会横着收进掌心。
        const cmc = p(1);
        const mcp = p(2);
        const thumbAngle = Math.atan2(mcp.x - cmc.x, -(mcp.y - cmc.y));
        // 相对手掌朝向，而不是相对画面竖直方向
        let rel = thumbAngle - middleSpread;
        rel = Math.atan2(Math.sin(rel), Math.cos(rel));
        chain.targetSpread = clamp(-rel, -1.2, 1.2);
      }
    }

    const roll = Math.atan2(
      middleMcp.x - wrist.x,
      -(middleMcp.y - wrist.y),
    );
    this.targetRoll = roll * (this.mirror ? -1 : 1);
    this.targetScale = clamp(palmLen2D / 0.19, 0.8, 1.4);

    this.debug = {
      handedness: rawLabel,
      mirror: this.mirror,
      palmLen2D: +palmLen2D.toFixed(4),
      bendsDeg: debugBends,
      roll: +roll.toFixed(3),
    };
    return true;
  }

  tick(dt, now) {
    if (now - this.lastSeen > LOST_AFTER) this.relaxTargets();

    const kj = 1 - Math.exp(-dt / SMOOTH_JOINT);
    const kr = 1 - Math.exp(-dt / SMOOTH_ROOT);
    for (const chain of Object.values(this.chains)) {
      for (let i = 0; i < 3; i += 1) {
        chain.currentBends[i] += (chain.targetBends[i] - chain.currentBends[i]) * kj;
      }
      chain.currentSpread += (chain.targetSpread - chain.currentSpread) * kr;

      const base = chain.joints[0];
      base.rotation.x = (chain.baseTiltX || 0) + chain.currentBends[0];
      base.rotation.z = chain.currentSpread;
      chain.joints[1].rotation.x = chain.currentBends[1];
      chain.joints[2].rotation.x = chain.currentBends[2];
    }

    this.currentRoll += (this.targetRoll - this.currentRoll) * kr;
    this.currentScale += (this.targetScale - this.currentScale) * kr;
    this.group.rotation.z = this.currentRoll;
    const s = BASE_SCALE * this.currentScale;
    this.group.scale.set(this.mirror ? -s : s, s, s);
  }
}

export class HandTracker {
  constructor(video) {
    this.video = video;
    this.landmarker = null;
    this.lastVideoTime = -1;
    this.lastResult = null;
    this.lastMs = 0;
  }

  async init() {
    const base = import.meta.env.BASE_URL;
    const vision = await FilesetResolver.forVisionTasks(`${base}wasm/`);
    const options = {
      baseOptions: {
        modelAssetPath: `${base}models/hand_landmarker.task`,
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    };
    try {
      this.landmarker = await HandLandmarker.createFromOptions(vision, options);
    } catch (error) {
      console.warn("手部 GPU delegate 不可用，退回 CPU", error);
      options.baseOptions.delegate = "CPU";
      this.landmarker = await HandLandmarker.createFromOptions(vision, options);
    }
    return this.landmarker;
  }

  /** 只在摄像头出了新帧时推理 */
  detect(now) {
    if (!this.landmarker || this.video.readyState < 2) return null;
    if (this.video.currentTime === this.lastVideoTime) return null;
    this.lastVideoTime = this.video.currentTime;

    const t0 = performance.now();
    const result = this.landmarker.detectForVideo(this.video, now);
    this.lastMs = performance.now() - t0;
    this.lastResult = result;
    return result;
  }
}
