"""去掉 SHARP 输出里的离群点与图像边缘的“白边”，便于在浏览器里展示。

1. 按坐标分位数裁掉远离主体的飞点；
2. 用 PLY 里的内参把高斯投回图像，丢掉贴着图像边框的一圈
   （SHARP 在画面边缘会产生发白的高斯，放大看像一圈相框）；
3. 丢掉几乎透明的高斯。

用法: .venv/bin/python tools/clean_ply.py in.ply out.ply [保留百分比] [边缘像素]
"""

import sys

import numpy as np
from plyfile import PlyData, PlyElement


def read_camera(ply):
    """从 SHARP 的附加元素里读内参和图像尺寸。"""
    try:
        intrinsic = np.asarray(ply["intrinsic"]["intrinsic"], dtype=np.float64).reshape(3, 3)
        width, height = np.asarray(ply["image_size"]["image_size"])
        return intrinsic, int(width), int(height)
    except (KeyError, ValueError):
        return None, 0, 0


def main(src: str, dst: str, keep: float = 0.995, border: int = 10) -> None:
    ply = PlyData.read(src)
    vertex = ply["vertex"]
    xyz = np.stack([vertex["x"], vertex["y"], vertex["z"]], axis=1)

    tail = (1.0 - keep) / 2.0 * 100.0
    lo, hi = np.percentile(xyz, [tail, 100.0 - tail], axis=0)
    margin = (hi - lo) * 0.1

    mask = np.all((xyz >= lo - margin) & (xyz <= hi + margin), axis=1)
    mask &= vertex["opacity"] > -3.0  # sigmoid(x) > 0.047

    intrinsic, width, height = read_camera(ply)
    if intrinsic is not None and border > 0:
        z = xyz[:, 2]
        safe_z = np.maximum(z, 1e-6)
        u = intrinsic[0, 0] * xyz[:, 0] / safe_z + intrinsic[0, 2]
        v = intrinsic[1, 1] * xyz[:, 1] / safe_z + intrinsic[1, 2]
        mask &= (z > 0.05) & (u > border) & (u < width - border)
        mask &= (v > border) & (v < height - border)

    cleaned = vertex.data[mask]
    PlyData([PlyElement.describe(cleaned, "vertex")]).write(dst)

    print(
        f"{src}: {len(xyz):,} → {mask.sum():,} splats "
        f"({(1 - mask.sum() / len(xyz)) * 100:.2f}% 被裁掉)"
    )
    print(f"主体范围 {np.round(hi - lo, 3)}（米）")


if __name__ == "__main__":
    main(
        sys.argv[1],
        sys.argv[2],
        float(sys.argv[3]) if len(sys.argv) > 3 else 0.995,
        int(sys.argv[4]) if len(sys.argv) > 4 else 10,
    )
