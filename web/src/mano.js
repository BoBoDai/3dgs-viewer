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

/**
 * MANO 模板在手腕处是一个开放边界。把每个边界环用三角扇封上，
 * 新顶点继承环上顶点的蒙皮权重，避免单独放一个腕部网格产生接缝。
 * 返回是否有边界被封闭。
 */
function closeOpenBoundaries(positions, skinIndices, skinWeights, faces) {
  const key = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const edges = new Map();

  for (let f = 0; f < faces.length; f += 3) {
    const a = faces[f];
    const b = faces[f + 1];
    const c = faces[f + 2];
    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const k = key(u, v);
      const edge = edges.get(k);
      if (edge) edge.count += 1;
      else edges.set(k, { u, v, count: 1 });
    }
  }

  const boundary = [...edges.values()].filter((edge) => edge.count === 1);
  if (boundary.length === 0) return false;

  // 手整体中心，用来判断封口应该往哪边凸
  const vertexCount = positions.length / 3;
  let hx = 0;
  let hy = 0;
  let hz = 0;
  for (let i = 0; i < vertexCount; i += 1) {
    hx += positions[i * 3];
    hy += positions[i * 3 + 1];
    hz += positions[i * 3 + 2];
  }
  hx /= vertexCount;
  hy /= vertexCount;
  hz /= vertexCount;

  const adjacent = new Map();
  for (const { u, v } of boundary) {
    if (!adjacent.has(u)) adjacent.set(u, []);
    if (!adjacent.has(v)) adjacent.set(v, []);
    adjacent.get(u).push(v);
    adjacent.get(v).push(u);
  }

  const visited = new Set();
  let closed = 0;

  for (const start of boundary) {
    if (visited.has(key(start.u, start.v))) continue;

    const loop = [start.u];
    visited.add(key(start.u, start.v));
    let prev = start.u;
    let cur = start.v;

    while (cur !== start.u && loop.length < 10000) {
      loop.push(cur);
      const next = (adjacent.get(cur) || []).find(
        (n) => n !== prev && !visited.has(key(cur, n)),
      );
      if (next === undefined) break;
      visited.add(key(cur, next));
      prev = cur;
      cur = next;
    }

    if (loop.length < 3) continue;

    // 环心沿 -Y（前臂方向）偏移一点，形成一个浅的圆顶，而不是平面盖子
    let cx = 0;
    let cy = 0;
    let cz = 0;
    const weights = new Map();
    for (const index of loop) {
      cx += positions[index * 3];
      cy += positions[index * 3 + 1];
      cz += positions[index * 3 + 2];
      for (let k = 0; k < 4; k += 1) {
        const joint = skinIndices[index * 4 + k];
        const weight = skinWeights[index * 4 + k];
        if (weight > 0) weights.set(joint, (weights.get(joint) || 0) + weight);
      }
    }
    const n = loop.length;
    cx /= n;
    cy /= n;
    cz /= n;

    // Newell 法线，再翻到远离手中心的一侧，作为封口外凸方向
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let i = 0; i < n; i += 1) {
      const a = loop[i];
      const b = loop[(i + 1) % n];
      nx += (positions[a * 3 + 1] - positions[b * 3 + 1]) *
        (positions[a * 3 + 2] + positions[b * 3 + 2]);
      ny += (positions[a * 3 + 2] - positions[b * 3 + 2]) *
        (positions[a * 3] + positions[b * 3]);
      nz += (positions[a * 3] - positions[b * 3]) *
        (positions[a * 3 + 1] + positions[b * 3 + 1]);
    }
    const length = Math.hypot(nx, ny, nz) || 1;
    nx /= length;
    ny /= length;
    nz /= length;
    if ((cx - hx) * nx + (cy - hy) * ny + (cz - hz) * nz < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }

    const center = positions.length / 3;
    positions.push(cx + nx * 0.01, cy + ny * 0.01, cz + nz * 0.01);

    const top = [...weights.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4);
    const total = top.reduce((sum, [, weight]) => sum + weight, 0) || 1;
    for (let k = 0; k < 4; k += 1) {
      skinIndices.push(top[k]?.[0] ?? 0);
      skinWeights.push(top[k] ? top[k][1] / total : 0);
    }

    // 边界边的方向来自相邻面的绕序，封口三角形要反过来才能保持法线朝外
    for (let i = 0; i < n; i += 1) {
      faces.push(loop[(i + 1) % n], loop[i], center);
    }
    closed += 1;
  }

  return closed > 0;
}

/** 混合两个顶点的蒙皮权重，只保留 Three.js 支持的前 4 个骨骼。 */
function mixSkinWeights(skinIndices, skinWeights, a, b) {
  const merged = new Map();
  for (let k = 0; k < 4; k += 1) {
    const ja = skinIndices[a * 4 + k];
    const wa = skinWeights[a * 4 + k];
    if (wa > 0) merged.set(ja, (merged.get(ja) || 0) + wa * 0.5);
    const jb = skinIndices[b * 4 + k];
    const wb = skinWeights[b * 4 + k];
    if (wb > 0) merged.set(jb, (merged.get(jb) || 0) + wb * 0.5);
  }
  const top = [...merged.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4);
  const total = top.reduce((sum, [, weight]) => sum + weight, 0) || 1;
  return {
    indices: [0, 1, 2, 3].map((k) => top[k]?.[0] ?? 0),
    weights: [0, 1, 2, 3].map((k) => (top[k] ? top[k][1] / total : 0)),
  };
}

/**
 * 三角形网格的 Loop 细分。MANO 模板只有 778 个顶点，直接渲染时手指轮廓
 * 和腕部封口都偏硬；细分 2 次后约 1.2 万顶点，蒙皮权重在边中点做混合。
 */
function subdivideLoop(positions, skinIndices, skinWeights, faces, iterations = 2) {
  let p = positions;
  let si = skinIndices;
  let sw = skinWeights;
  let f = faces;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const vertexCount = p.length / 3;
    const edgeMap = new Map();
    const edges = [];

    const edgeFor = (a, b, opposite) => {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      let edge = edgeMap.get(key);
      if (!edge) {
        edge = { a: Math.min(a, b), b: Math.max(a, b), opposite: [] };
        edgeMap.set(key, edge);
        edges.push(edge);
      }
      if (opposite !== undefined) edge.opposite.push(opposite);
      return edge;
    };

    for (let i = 0; i < f.length; i += 3) {
      const a = f[i];
      const b = f[i + 1];
      const c = f[i + 2];
      edgeFor(a, b, c);
      edgeFor(b, c, a);
      edgeFor(c, a, b);
    }

    const neighbors = Array.from({ length: vertexCount }, () => []);
    const boundaryNeighbors = Array.from({ length: vertexCount }, () => []);
    for (const edge of edges) {
      neighbors[edge.a].push(edge.b);
      neighbors[edge.b].push(edge.a);
      if (edge.opposite.length === 1) {
        boundaryNeighbors[edge.a].push(edge.b);
        boundaryNeighbors[edge.b].push(edge.a);
      }
    }

    const nextPositions = new Array(p.length);
    const nextSkinIndices = new Array(si.length);
    const nextSkinWeights = new Array(sw.length);

    for (let i = 0; i < vertexCount; i += 1) {
      const px = p[i * 3];
      const py = p[i * 3 + 1];
      const pz = p[i * 3 + 2];
      let x = px;
      let y = py;
      let z = pz;

      if (boundaryNeighbors[i].length >= 2) {
        const [u, v] = boundaryNeighbors[i];
        x = 0.75 * px + 0.125 * (p[u * 3] + p[v * 3]);
        y = 0.75 * py + 0.125 * (p[u * 3 + 1] + p[v * 3 + 1]);
        z = 0.75 * pz + 0.125 * (p[u * 3 + 2] + p[v * 3 + 2]);
      } else if (neighbors[i].length > 0) {
        const n = neighbors[i].length;
        const beta = n === 3 ? 3 / 16 : 3 / (8 * n);
        let sx = 0;
        let sy = 0;
        let sz = 0;
        for (const j of neighbors[i]) {
          sx += p[j * 3];
          sy += p[j * 3 + 1];
          sz += p[j * 3 + 2];
        }
        x = (1 - n * beta) * px + beta * sx;
        y = (1 - n * beta) * py + beta * sy;
        z = (1 - n * beta) * pz + beta * sz;
      }

      nextPositions[i * 3] = x;
      nextPositions[i * 3 + 1] = y;
      nextPositions[i * 3 + 2] = z;
      for (let k = 0; k < 4; k += 1) {
        nextSkinIndices[i * 4 + k] = si[i * 4 + k];
        nextSkinWeights[i * 4 + k] = sw[i * 4 + k];
      }
    }

    const edgeVertex = new Map();
    let nextIndex = vertexCount;
    for (const edge of edges) {
      const a = edge.a;
      const b = edge.b;
      let x;
      let y;
      let z;
      if (edge.opposite.length >= 2) {
        const [c, d] = edge.opposite;
        x = 0.375 * (p[a * 3] + p[b * 3]) + 0.125 * (p[c * 3] + p[d * 3]);
        y = 0.375 * (p[a * 3 + 1] + p[b * 3 + 1]) +
          0.125 * (p[c * 3 + 1] + p[d * 3 + 1]);
        z = 0.375 * (p[a * 3 + 2] + p[b * 3 + 2]) +
          0.125 * (p[c * 3 + 2] + p[d * 3 + 2]);
      } else {
        x = (p[a * 3] + p[b * 3]) * 0.5;
        y = (p[a * 3 + 1] + p[b * 3 + 1]) * 0.5;
        z = (p[a * 3 + 2] + p[b * 3 + 2]) * 0.5;
      }
      const skin = mixSkinWeights(si, sw, a, b);
      nextPositions.push(x, y, z);
      nextSkinIndices.push(...skin.indices);
      nextSkinWeights.push(...skin.weights);
      edgeVertex.set(edge, nextIndex);
      nextIndex += 1;
    }

    const nextFaces = [];
    for (let i = 0; i < f.length; i += 3) {
      const a = f[i];
      const b = f[i + 1];
      const c = f[i + 2];
      const ab = edgeVertex.get(edgeFor(a, b));
      const bc = edgeVertex.get(edgeFor(b, c));
      const ca = edgeVertex.get(edgeFor(c, a));
      nextFaces.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
    }

    p = nextPositions;
    si = nextSkinIndices;
    sw = nextSkinWeights;
    f = nextFaces;
  }

  return { positions: p, skinIndices: si, skinWeights: sw, faces: f };
}

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

    // 几何 + 蒙皮。手模板在手腕处有开口；先复制一份再封口，
    // 避免修改 fetch 返回的共享数据。
    const positions = Array.from(data.vertices);
    const skinIndices = Array.from(data.skinIndices);
    const skinWeights = Array.from(data.skinWeights);
    const faces = Array.from(data.faces);
    closeOpenBoundaries(positions, skinIndices, skinWeights, faces);
    const subdivided = subdivideLoop(
      positions,
      skinIndices,
      skinWeights,
      faces,
      2,
    );

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(subdivided.positions, 3),
    );
    geometry.setAttribute(
      "skinIndex",
      new THREE.Uint16BufferAttribute(subdivided.skinIndices, 4),
    );
    geometry.setAttribute(
      "skinWeight",
      new THREE.Float32BufferAttribute(subdivided.skinWeights, 4),
    );
    geometry.setIndex(subdivided.faces);
    geometry.computeVertexNormals();

    const material = new THREE.MeshPhysicalMaterial({
      color: 0xd9a078,
      roughness: 0.5,
      metalness: 0,
      // 皮肤高光偏柔：sheen + 轻微 clearcoat，避免低模塑料感
      specularIntensity: 0.5,
      clearcoat: 0.08,
      clearcoatRoughness: 0.8,
      sheen: 0.35,
      sheenColor: new THREE.Color(0xffd2b8),
      sheenRoughness: 0.9,
      side: THREE.DoubleSide,
    });

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
