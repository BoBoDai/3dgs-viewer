# 3DGS / PLY 大屏预览

加载任意来源的 3D Gaussian Splatting 模型，在大屏上居中实时渲染；
摄像头画面只作为右上角的小窗预览，点“手部同步”后可以驱动最多两只镜像 SOMA-X 手。

| 环节 | 选型 | 作用 |
| --- | --- | --- |
| 加载 / 变换 / 渲染 | [gaussian-splat-lite](https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite) + Three.js | 解码 3DGS，WebGL2 实时渲染 |
| 手部输入 | [MediaPipe HandLandmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker) + [SOMA-X](https://github.com/NVlabs/SOMA-X) | 浏览器内 21 点手部关键点 → SOMA-X 蒙皮手（MANO 可选） |

## 快速开始

```bash
# 1. 一次性准备（装前端依赖 + MediaPipe 运行时）
scripts/setup.sh

# 2. 启动前端
cd web && npm run dev
# 打开 http://localhost:5173/：默认加载 The Fruit Bowl.sog
# 也可以 ?model=你的模型.ply / .sog / .spz / .rad，或把模型拖进页面
# 手部同步：点“手部同步”，或直接打开 http://localhost:5173/?hand=1
```

默认模型是 `web/public/models/The Fruit Bowl.sog`（13 MB，约 75 万 splats）。
不想加载它时用 `?model=` 指定其他模型。其他模型放进
`web/public/models/` 后用 `?model=文件名` 打开，也可以拖入页面或用“载入 .ply”选择。
需要合成测试模型时，可以用 `tools/make_test_ply.py` 生成一个。

支持 gaussian-splat-lite 能解码的格式：未压缩 `.ply`，以及 `.spz` / `.sog` / `.rad`。
页面会自动识别并解码，不需要手动转换。

主画面只渲染模型：鼠标左键拖动旋转、滚轮缩放、按住中键拖动平移，`F` 回到初始取景，`自旋` 绕屏幕竖直轴展示模型。摄像头可选，开启后只出现在右上角的小窗里；
点“手部同步”后主画面会切换成实时 SOMA-X 手：最多两只、左右镜像、跟着手在画面里的位置摆；
没有检测到手时不显示任何手模型。

默认 SOG 的许可是 **CC BY 4.0**（作者 SuperDelphi，来源
[SuperSplat](https://superspl.at/scene/d8ba72a6)）：需要署名，允许商用。
详见 `web/public/models/NOTICE.md`。

手部默认使用 NVIDIA **SOMA-X** 的 hand layer（Apache 2.0，25 关节，mid LOD）。
`web/public/models/soma_hand_left.json` / `soma_hand_right.json` 已随仓库提供，
由 `tools/export_soma_hand.py` 从 `py-soma-x` 导出；需要重新生成时：

```bash
python3 -m venv /tmp/soma-venv
/tmp/soma-venv/bin/pip install py-soma-x
/tmp/soma-venv/bin/python -I tools/export_soma_hand.py --side right --out web/public/models/soma_hand_right.json
/tmp/soma-venv/bin/python -I tools/export_soma_hand.py --side left  --out web/public/models/soma_hand_left.json
```

MANO 仍可作为本地可选资产：`mano_*.json` 受研究许可限制、已 gitignore，
需要用 MANO pkl 运行 `tools/export_mano.py` 生成。SOMA-X 的许可与使用限制见
`web/public/models/NOTICE.md`。

## 自动取景

不同来源的 3DGS 模型坐标系和尺度都不一样，页面不假设文件来自某一种重建流程：

1. 对高斯中心做 2%~98% 分位数统计，避免少量飞点把包围盒撑大；
2. 把主体中心平移到原点；
3. 用主体包围球和固定视场角算出相机距离，把相机退到包围球外，`near/far` 跟随模型尺度调整；
4. 模型本身不缩放，保持原始尺度，避免破坏重建的透视关系。

第三方模型的 up 轴没有统一约定：默认按 OpenCV/COLMAP（+Y 向下）做一次 X 轴 180° 翻转，
方向不对时点工具栏的 `翻转`，或用 `?up=1` 表示文件已经是 +Y 向上（例如 Blender 导出的模型）。

相机围绕模型旋转和推拉，而不是改视场角，因此近距离查看不会产生透视爆炸。

注意：首页只渲染带 3DGS 属性的 PLY / 压缩 3DGS 格式；纯点云 PLY（只有 x/y/z/颜色，
没有 scale/rot/opacity/SH）和普通三角网格不在当前首页的支持范围内。

## 大模型性能

- 默认 DPR 上限 1.5；拖动/缩放时临时降到 0.7 倍，停手 220 ms 后恢复清晰度。
  `?dpr=1` 更快，`?dpr=2` 更清晰（按设备像素比封顶）。
- 渲染器已按大模型调优：裁掉软边缘、极小、极淡和视口外的高斯，并限制 WebGL 排序频率。
- 百万级以上模型，真正的解法是减少每帧绘制数量：转成 SOG/RAD 并生成 LOD，
  用 `SogStreamScheduler` / `RadStreamScheduler` + `splatBudget`，或离线剪枝低不透明度高斯。
- Python/FastAPI 后端适合做这些离线预处理和分发，但不参与浏览器每帧渲染；
  服务端渲染 + 视频串流是另一套架构。

## 实时手部同步（SOMA-X / MANO 手）

点 `手部同步` 或打开 `?hand=1`，会把 MediaPipe 的 21 个关键点映射到最多两只 SOMA-X 蒙皮手：

1. **推理**：`HandLandmarker` 在 VIDEO 模式下每帧跑一次（`numHands: 2`），优先 GPU delegate，失败退回 CPU；
2. **骨骼**：SOMA-X 的 25 根骨骼来自 `web/public/models/soma_hand_{left,right}.json`，由 `tools/export_soma_hand.py` 从 `py-soma-x` 导出（顶点、三角面、骨骼权重和 MediaPipe 骨骼映射都在 JSON 里）；
3. **镜像**：实际右手用右手资产、实际左手用左手资产，然后对整只手做水平镜像（`scale.x = -1`）；屏幕位置也用镜像后的坐标，所以主画面里的手和右上角预览的方向一致；
4. **两只手**：结果按镜像后的屏幕 x 排序分配到两个手位，各自在自己的位置渲染；两只手同时出现时会自动缩小；
5. **无手**：连续 300 ms 没检测到手就隐藏所有手模型；
6. **重定向**：用 `worldLandmarks` 的 3D 方向算每根骨骼的局部四元数，手腕的完整朝向用世界坐标系下的手部基向量求根骨骼旋转；
7. **平滑**：骨骼四元数做 slerp。

如果 SOMA/MANO JSON 加载失败，会退回 `web/src/hand.js` 里的胶囊体关节手（只支持单只、居中）。
当前手仍然是**通用手模型**，不是 3DGS 手，也不是你本人的外观；下一步换成带骨骼权重的
3DGS 手时，这套推理和重定向可以复用。页面 HUD 里的“追踪中 · X ms”是单帧推理耗时。

SOMA-X 的代码和发布资产是 Apache 2.0（需要署名；不能冒充真人或用于欺骗生物识别）；
MANO 模型和由它导出的 JSON 仅限研究用途，商用前需确认 Max Planck 的许可条款。

## 文件结构

```
3dgs/
├── scripts/
│   └── setup.sh            # 环境准备：前端依赖 + MediaPipe 运行时
├── tools/
│   ├── make_test_ply.py    # 生成合成 3DGS PLY，验证前端链路
│   ├── export_soma_hand.py # py-soma-x → 前端 SkinnedMesh JSON（默认）
│   ├── export_mano.py      # MANO pkl → 前端 SkinnedMesh JSON（可选）
│   └── pw/                 # Playwright 冒烟测试脚本
└── web/
    ├── src/main.js         # 渲染 + 自动取景 + 摄像头 + 手部模式切换
    ├── src/mano.js         # SOMA/MANO JSON → SkinnedMesh + 21 点重定向
    ├── src/hand.js         # 胶囊体占位手（蒙皮手加载失败时兜底）
    ├── src/viewer.js       # 通用 PLY 浏览器原型（3DGS / 网格 / 点云）
    ├── src/ply-detect.js   # PLY 头部解析与类型判断
    ├── public/models/      # 默认 SOG、SOMA 手 JSON；hand_landmarker.task；MANO 可选
    └── index.html
```

调试用的 URL 参数：

- `?model=你的模型.ply` 加载 `web/public/models/` 下的模型；也可以直接给完整 URL，例如 `?model=https://…/scene.sog`；
- `?hand=1` 直接进入手部同步模式；
- `?up=1` 表示模型已经是 +Y 向上，不做默认的 X 轴翻转；
- `?dpr=1.5` 控制渲染倍率上限（默认 1.5；大模型可降到 1.0，清晰度优先可设 2）。

## 实测

Chrome + Metal，1280×800，约 1.04M splats 可稳定 60 fps。

## 限制

- 单个视角重建的 3DGS 只在原视角附近可信，转到侧面会明显劣化。
- 手部同步目前是通用 SOMA-X 蒙皮手（可切换 MANO），不是 3DGS 手，也不是你本人的外观；左右手标签来自 MediaPipe，掌心/手背判断是近似值。
- 两只手靠得很近时模型会重叠；这是按真实手在画面里的位置摆放的结果。
- 单摄像头只能看到手的一面，换成 3DGS 手后手背细节会缺失；要完整外观需要多角度采集和离线训练。
- SOMA-X 资产为 Apache 2.0，需署名并遵守其使用限制；MANO 模型和导出的 JSON 仅限研究用途，商用前需确认许可条款。
- 用 `web/dist` 部署时，`public/models/*.ply` 体积较大（每个约 60 MB），建议按需加载或转成压缩格式（SPZ/SOG）。

## 参考

- gaussian-splat-lite: [GitHub](https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite) · [npm](https://www.npmjs.com/package/gaussian-splat-lite)
- MediaPipe HandLandmarker: [文档](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker)
- SOMA-X: [GitHub](https://github.com/NVlabs/SOMA-X)（Apache 2.0）
- MANO: [官网](https://mano.is.tue.mpg.de/)（可选；模型需要注册下载，研究用途许可）
