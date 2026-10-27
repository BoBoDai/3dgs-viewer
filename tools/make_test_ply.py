"""生成一个 3DGS 风格的测试 PLY（不依赖模型），用于验证前端加载链路。

用法: python3 tools/make_test_ply.py web/public/models/test.ply
依赖: numpy、plyfile
"""

import sys

import numpy as np
from plyfile import PlyData, PlyElement

SH_C0 = 0.28209479177387814


def main(path: str) -> None:
    rng = np.random.default_rng(7)
    n = 40_000
    # 球面均匀采样，半径 0.5，放在 OpenCV 坐标系的 z=2 处
    v = rng.normal(size=(n, 3))
    v /= np.linalg.norm(v, axis=1, keepdims=True)
    radius = 0.5
    xyz = v * radius
    xyz[:, 2] += 2.0

    # 颜色 = 法线映射到 0..1，编码成 SH0
    rgb = (v + 1.0) / 2.0
    f_dc = (rgb - 0.5) / SH_C0

    # 每个高斯沿球面切向压扁，看起来更像表面
    scale = np.tile([0.008, 0.008, 0.02], (n, 1))
    opacity = np.full((n, 1), 2.5)  # logit(0.92)
    rot = np.tile([1.0, 0.0, 0.0, 0.0], (n, 1))

    attrs = np.concatenate(
        [xyz, f_dc, opacity, np.log(scale), rot], axis=1
    )
    dtype = [
        (name, "f4")
        for name in ["x", "y", "z"]
        + [f"f_dc_{i}" for i in range(3)]
        + ["opacity"]
        + [f"scale_{i}" for i in range(3)]
        + [f"rot_{i}" for i in range(4)]
    ]
    vertex = np.empty(n, dtype=dtype)
    vertex[:] = list(map(tuple, attrs))

    # 附带一些非 vertex 元素，确认解析器能容忍它们
    extra = []
    for element_name, values, fmt in [
        ("image_size", [640, 480], "u4"),
        ("intrinsic", [512, 0, 320, 0, 512, 240, 0, 0, 1], "f4"),
        ("extrinsic", np.eye(4).flatten().astype(np.float32), "f4"),
        ("frame", [1, n], "i4"),
        ("disparity", [0.4, 0.7], "f4"),
        ("color_space", [1], "u1"),
        ("version", [1, 5, 0], "u1"),
    ]:
        array = np.empty(len(values), dtype=[(element_name, fmt)])
        array[element_name] = np.array(values).astype(array.dtype[element_name])
        extra.append(PlyElement.describe(array, element_name))

    PlyData([PlyElement.describe(vertex, "vertex"), *extra]).write(path)
    print(f"写入 {path}: {n} splats")


if __name__ == "__main__":
    main(sys.argv[1])
