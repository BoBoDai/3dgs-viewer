#!/usr/bin/env python3
"""把 MANO 的 pkl 导出成前端可直接构建 SkinnedMesh 的 JSON。

用法：
  .venv/bin/python -I tools/export_mano.py MANO_RIGHT.pkl web/public/models/mano_right.json
  .venv/bin/python -I tools/export_mano.py MANO_LEFT.pkl  web/public/models/mano_left.json

只读取 v_template / f / J / weights / kintree_table，不依赖 smplx。
MANO 模型仅限研究用途，商用前请确认 Max Planck 的许可条款。
"""

import argparse
import json
import pickle

import numpy as np

JOINT_NAMES = [
    "wrist",
    "index1", "index2", "index3",
    "middle1", "middle2", "middle3",
    "pinky1", "pinky2", "pinky3",
    "ring1", "ring2", "ring3",
    "thumb1", "thumb2", "thumb3",
]


def unit(v):
    n = np.linalg.norm(v)
    return v / n if n > 1e-12 else v


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pkl")
    ap.add_argument("out")
    ap.add_argument("--flip-y", action="store_true", help="绕 Y 轴翻 180°，用于检查掌心方向")
    ap.add_argument("--no-center", action="store_true")
    args = ap.parse_args()

    with open(args.pkl, "rb") as f:
        d = pickle.load(f, encoding="latin1")

    verts = np.asarray(d["v_template"], dtype=np.float64)
    faces = np.asarray(d["f"], dtype=np.int64)
    joints = np.asarray(d["J"], dtype=np.float64)
    weights = np.asarray(d["weights"], dtype=np.float64)
    parents = np.asarray(d["kintree_table"])[0].astype(np.int64)
    parents = np.where(parents >= 2**31, -1, parents)

    # 把 MANO 的原始姿态转成前端约定的：手指 +Y，掌心 +Z，右手拇指 +X。
    up = unit(joints[4] - joints[0])          # 手腕 → 中指根
    across = unit(joints[1] - joints[7])      # 食指根 → 小指根
    normal = unit(np.cross(across, up))       # 掌心方向

    source = np.column_stack([across, up, normal])
    target = np.eye(3)                        # [X, Y, Z]
    rot = target @ source.T
    if np.linalg.det(rot) < 0:
        raise SystemExit("basis is left-handed; refusing to export")

    verts = verts @ rot.T
    joints = joints @ rot.T

    if args.flip_y:
        flip = np.diag([-1.0, 1.0, -1.0])
        verts = verts @ flip.T
        joints = joints @ flip.T

    if not args.no_center:
        center = (verts.min(0) + verts.max(0)) * 0.5
        verts -= center
        joints -= center

    # Three.js 每个顶点最多 4 个骨骼影响
    top = np.argsort(-weights, axis=1)[:, :4]
    w = np.take_along_axis(weights, top, axis=1)
    w /= np.maximum(w.sum(1, keepdims=True), 1e-12)

    out = {
        "version": 1,
        "jointNames": JOINT_NAMES,
        "parents": parents.tolist(),
        "vertices": np.round(verts, 6).reshape(-1).tolist(),
        "faces": faces.reshape(-1).tolist(),
        "joints": np.round(joints, 6).reshape(-1).tolist(),
        "skinIndices": top.astype(int).reshape(-1).tolist(),
        "skinWeights": np.round(w, 6).reshape(-1).tolist(),
    }
    with open(args.out, "w") as f:
        json.dump(out, f, separators=(",", ":"))

    print(
        f"wrote {args.out}: {len(verts)} verts, {len(faces)} faces, "
        f"bbox={np.round(verts.max(0) - verts.min(0), 4).tolist()}"
    )


if __name__ == "__main__":
    main()
