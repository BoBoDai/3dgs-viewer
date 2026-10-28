#!/usr/bin/env python3
"""Export a SOMA-X hand to the JSON schema consumed by web/src/mano.js.

Usage:
  python tools/export_soma_hand.py --side right --out web/public/models/soma_hand_right.json
  python tools/export_soma_hand.py --side left  --out web/public/models/soma_hand_left.json

Requires the optional `py-soma-x` package (Apache-2.0). This tool only runs
offline; the browser uses the generated JSON.
"""

import argparse
import json

import numpy as np

from soma import SOMAHandLayer


def unit(v: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(v)
    return v / n if n > 1e-12 else v


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--side", choices=["left", "right"], required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--lod", choices=["mid", "low", "xlo"], default="mid")
    ap.add_argument("--subdivisions", type=int, default=1)
    args = ap.parse_args()

    hand = SOMAHandLayer(hand_type=args.side, lod=args.lod, device="cpu")
    verts = hand.bind_shape.detach().cpu().numpy().astype(np.float64)
    joints = (
        hand.bind_pose_world.detach().cpu().numpy()[:, :3, 3].astype(np.float64)
    )
    faces = hand.faces.detach().cpu().numpy().astype(np.int64).reshape(-1)
    weights = hand.skinning_weights.detach().cpu().numpy().astype(np.float64)
    parents = hand.joint_parent_ids.detach().cpu().numpy().astype(np.int64)
    names = [str(name) for name in hand.rig_data["joint_names"]]

    # Map to the app convention: fingers +Y, palm +Z, thumb +X.
    up = unit(joints[10] - joints[0])          # wrist -> middle MCP
    across = joints[5] - joints[20]            # index MCP -> pinky MCP
    across = unit(across - up * np.dot(across, up))
    normal = unit(np.cross(across, up))
    source = np.column_stack([across, up, normal])
    verts = verts @ source
    joints = joints @ source

    center = (verts.min(0) + verts.max(0)) * 0.5
    verts -= center
    joints -= center

    top = np.argsort(-weights, axis=1)[:, :4]
    top_weights = np.take_along_axis(weights, top, axis=1)
    top_weights /= np.maximum(top_weights.sum(1, keepdims=True), 1e-12)

    # SOMA joints: 0 wrist; 1-4 thumb; 5-9 index; 10-14 middle;
    # 15-19 ring; 20-24 pinky. The long fingers have an extra metacarpal
    # joint, so map: wrist->MCP->PIP->DIP->tip (SOMA chain 0..3).
    bones = [None] * len(names)

    # Thumb: SOMA Thumb1..3 + End; MediaPipe 1..4.
    thumb_chain = [1, 2, 3, 4]
    for k in range(3):
        bones[thumb_chain[k]] = [k + 1, k + 2, thumb_chain[k], thumb_chain[k + 1]]

    long_chains = [
        ([5, 6, 7, 8, 9], [0, 5, 6, 7, 8]),
        ([10, 11, 12, 13, 14], [0, 9, 10, 11, 12]),
        ([15, 16, 17, 18, 19], [0, 13, 14, 15, 16]),
        ([20, 21, 22, 23, 24], [0, 17, 18, 19, 20]),
    ]
    for chain, mp in long_chains:
        for k in range(4):
            bones[chain[k]] = [mp[k], mp[k + 1], chain[k], chain[k + 1]]

    parents[0] = -1

    out = {
        "version": 2,
        "source": "SOMA-X",
        "lod": args.lod,
        "jointNames": names,
        "parents": parents.tolist(),
        "vertices": np.round(verts, 6).reshape(-1).tolist(),
        "faces": faces.tolist(),
        "joints": np.round(joints, 6).reshape(-1).tolist(),
        "skinIndices": top.astype(int).reshape(-1).tolist(),
        "skinWeights": np.round(top_weights, 6).reshape(-1).tolist(),
        "bones": bones,
        "palmJoint": 11,
        "subdivisions": args.subdivisions,
    }
    with open(args.out, "w") as f:
        json.dump(out, f, separators=(",", ":"))

    lo = verts.min(0)
    hi = verts.max(0)
    print(
        f"wrote {args.out}: {len(verts)} verts, {len(faces) // 3} faces, "
        f"bbox={np.round(hi - lo, 4).tolist()}"
    )


if __name__ == "__main__":
    main()
