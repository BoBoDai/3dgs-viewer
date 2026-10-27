import * as THREE from "three";

/**
 * MANO 手（16 骨骼）→ Three.js SkinnedMesh。
 * 资产由 tools/export_mano.py 从 MANO pkl 导出成 JSON。
 *
 * 驱动思路：MediaPipe 的 21 点 → 每根骨骼的目标方向 → 局部四元数；
 * 手腕的完整朝向用世界坐标系下的手部基向量求根骨骼旋转。
 */

const BASE_SCALE = 1.5;
const HAND_Z = -0.56;
const LOST_AFTER = 500;
const SMOOTH = 0.06;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// MANO 骨骼 → MediaPipe 关键点 + MANO 静止关节。
// end 为 null 时，静止方向用指尖顶点计算。
const BONE_MAP = {
  1: [5, 6, 1, 2],
  2: [6, 7, 2, 3],
  3: [7, 8, 3, null],
  4: [9, 10, 4, 5],
  5: [10, 11, 5, 6],
  6: [11, 12, 6, null],
  7: [17, 18, 7, 8],
  8: [18, 19, 8, 9],
  9: [19, 20, 9, null],
  10: [13, 14, 10, 11],
  11: [14, 15, 11, 12],
  12: [15, 16, 12, null],
  13: [2, 3, 13, 14],
  14: [3, 4, 14, 15],
  // 15: 拇指末端没有下一根骨骼，保持静止
};

// MediaPipe worldLandmarks: x 右、y 下、z 朝场景里。转到 Three.js 的 x 右、y 上、z 朝镜头。
const toThree = (p) => new THREE.Vector3(p.x, -p.y, -p.z);

export class ManoHandRig {
  constructor() {
    this.group = new THREE.Group();
    this.targetPos = new THREE.Vector3(0, 0.025, HAND_Z);
    this.group.position.copy(this.targetPos);
    this.group.scale.setScalar(BASE_SCALE);
    this.group.visible = false;

    this.mesh = null;
    this.bones = [];
    this.parents = [];
    this.restJoints = [];
    this.restDirs = [];
    this.targetQuats = [];
    this.currentQuats = [];
    this.restPalmLen = 0.1;
    this.targetScale = 1;
    this.currentScale = 1;
    this.displayScale = 1;
    this.mirror = true; // 和镜像的摄像头预览同向
    this.lastSeen = 0;
    this.hasPose = false;
    this.debug = {};
    this.ready = false;
    this.url = "";
  }

  async load(url) {
    if (this.ready && this.url === url) return this;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`MANO asset ${url}: HTTP ${response.status}`);
    const data = await response.json();
    this.build(data);
    this.url = url;
    this.ready = true;
    return this;
  }

  build(data) {
    if (this.mesh) {
      this.mesh.removeFromParent();
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
    }

    this.parents = data.parents;
    const joint = (i) =>
      new THREE.Vector3(
        data.joints[i * 3],
        data.joints[i * 3 + 1],
        data.joints[i * 3 + 2],
      );
    this.restJoints = data.parents.map((_, i) => joint(i));
    this.restPalmLen = this.restJoints[4].distanceTo(this.restJoints[0]);

    // 每根手指末端的虚拟指尖：取该末端骨骼权重最高的顶点里最远的那个
    const tips = {};
    const wrist = this.restJoints[0];
    for (let v = 0; v < data.skinIndices.length / 4; v += 1) {
      let bestJoint = -1;
      let bestWeight = 0;
      for (let k = 0; k < 4; k += 1) {
        const idx = data.skinIndices[v * 4 + k];
        const w = data.skinWeights[v * 4 + k];
        if (w > bestWeight) {
          bestWeight = w;
          bestJoint = idx;
        }
      }
      if (![3, 6, 9, 12, 15].includes(bestJoint)) continue;
      const p = new THREE.Vector3(
        data.vertices[v * 3],
        data.vertices[v * 3 + 1],
        data.vertices[v * 3 + 2],
      );
      const d = p.distanceTo(wrist);
      if (!tips[bestJoint] || d > tips[bestJoint].d) tips[bestJoint] = { p, d };
    }

    this.restDirs = this.parents.map((_, i) => {
      const map = BONE_MAP[i];
      if (!map) return new THREE.Vector3(0, 1, 0);
      const [, , rs, re] = map;
      const from = this.restJoints[rs];
      let to;
      if (re === null) {
        to = tips[rs]?.p ?? this.restJoints[rs].clone().add(new THREE.Vector3(0, 0.02, 0));
      } else {
        to = this.restJoints[re];
      }
      const d = to.clone().sub(from);
      return d.lengthSq() > 1e-12 ? d.normalize() : new THREE.Vector3(0, 1, 0);
    });

    // 骨骼层级（先建数组，再挂父子，避免初始化时引用自身）
    const bones = this.parents.map(() => new THREE.Bone());
    this.parents.forEach((parent, i) => {
      if (parent < 0) {
        bones[i].position.copy(this.restJoints[i]);
      } else {
        bones[i].position.copy(this.restJoints[i]).sub(this.restJoints[parent]);
        bones[parent].add(bones[i]);
      }
    });
    const rootBone = bones[0];

    // 几何 + 蒙皮
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(data.vertices, 3),
    );
    geometry.setAttribute(
      "skinIndex",
      new THREE.Uint16BufferAttribute(data.skinIndices, 4),
    );
    geometry.setAttribute(
      "skinWeight",
      new THREE.Float32BufferAttribute(data.skinWeights, 4),
    );
    geometry.setIndex(data.faces);
    geometry.computeVertexNormals();

    const material = new THREE.MeshStandardMaterial({
      color: 0xd9a27e,
      roughness: 0.58,
      metalness: 0.02,
      side: THREE.DoubleSide,
    });
    // MANO 网格在手腕处是开口的，加一小段腕部遮住截面
    const cuff = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.025, 0.008, 6, 16),
      material,
    );
    cuff.position.set(0, -0.03, 0);
    rootBone.add(cuff);

    const mesh = new THREE.SkinnedMesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.add(rootBone);
    mesh.updateMatrixWorld(true);
    mesh.bind(new THREE.Skeleton(bones));
    mesh.visible = true;

    // 先绑定再挂到带缩放/位移的 group，避免 bindMatrix 把展示变换算进去
    this.group.add(mesh);
    this.mesh = mesh;
    this.bones = bones;
    this.rootBone = rootBone;
    this.targetQuats = bones.map(() => new THREE.Quaternion());
    this.currentQuats = bones.map(() => new THREE.Quaternion());
    this.hasPose = false;
  }

  relaxTargets() {
    for (const q of this.targetQuats) q.identity();
    this.targetScale = 1;
  }

  /** ndc 是镜像后（和右上角预览一致）的屏幕坐标 */
  setView(ndc, twoHands) {
    this.displayScale = twoHands ? 0.42 : 1;
    const x = clamp(ndc.x, -0.85, 0.85) * 0.26;
    const y = clamp(ndc.y, -0.85, 0.85) * 0.16;
    this.targetPos.set(x, 0.025 + y, HAND_Z);
  }

  update(landmarks, worldLandmarks, handednesses, aspect, now) {
    if (!this.ready || !worldLandmarks || worldLandmarks.length < 21) return false;
    this.lastSeen = now;

    const wrist = toThree(worldLandmarks[0]);
    const mcpMiddle = toThree(worldLandmarks[9]);
    const mcpIndex = toThree(worldLandmarks[5]);
    const mcpPinky = toThree(worldLandmarks[17]);

    const up = mcpMiddle.clone().sub(wrist);
    const across = mcpIndex.clone().sub(mcpPinky);
    if (up.lengthSq() < 1e-10 || across.lengthSq() < 1e-10) return false;
    up.normalize();
    across.normalize();
    up.addScaledVector(across, -up.dot(across)).normalize();
    if (up.lengthSq() < 1e-8) return false;
    const normal = new THREE.Vector3().crossVectors(across, up).normalize();

    // 模型静止坐标系：+X 食指侧、+Y 手指方向、+Z 掌心
    const basis = new THREE.Matrix4().makeBasis(across, up, normal);
    const rootQ = new THREE.Quaternion().setFromRotationMatrix(basis);
    this.targetQuats[0].copy(rootQ);

    const worldQ = [rootQ];
    for (let i = 1; i < this.bones.length; i += 1) {
      const map = BONE_MAP[i];
      if (!map) {
        this.targetQuats[i].identity();
        worldQ[i] = worldQ[this.parents[i]].clone();
        continue;
      }
      const [ls, le] = map;
      const obs = toThree(worldLandmarks[le]).sub(toThree(worldLandmarks[ls]));
      if (obs.lengthSq() < 1e-10) {
        this.targetQuats[i].identity();
        worldQ[i] = worldQ[this.parents[i]].clone();
        continue;
      }
      obs.normalize();

      const parentQ = worldQ[this.parents[i]];
      const obsLocal = obs
        .clone()
        .applyQuaternion(parentQ.clone().invert())
        .normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(
        this.restDirs[i],
        obsLocal,
      );
      this.targetQuats[i].copy(q);
      worldQ[i] = parentQ.clone().multiply(q);
    }

    const obsPalm = mcpMiddle.distanceTo(wrist);
    this.targetScale = clamp(obsPalm / this.restPalmLen, 0.72, 1.45);

    this.debug = {
      handedness: handednesses?.[0]?.[0]?.categoryName ?? null,
      obsPalm: +obsPalm.toFixed(4),
      scale: +this.targetScale.toFixed(2),
      root: rootQ.toArray().map((v) => +v.toFixed(2)),
    };
    return true;
  }

  tick(dt, now) {
    if (!this.ready) return;
    if (now - this.lastSeen > LOST_AFTER) this.relaxTargets();

    const k = 1 - Math.exp(-dt / SMOOTH);
    for (let i = 0; i < this.bones.length; i += 1) {
      this.currentQuats[i].slerp(this.targetQuats[i], k);
      this.bones[i].quaternion.copy(this.currentQuats[i]);
    }
    this.currentScale += (this.targetScale - this.currentScale) * k;
    const s = BASE_SCALE * this.displayScale * this.currentScale;
    // 水平镜像整只手，让主画面和右上角的镜像预览同向
    this.group.scale.set(this.mirror ? -s : s, s, s);
    this.group.position.lerp(this.targetPos, k);
  }
}
