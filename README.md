# 单图 → 3DGS → 大屏预览

把一张照片变成可实时渲染的 3D Gaussian Splatting 场景，在大屏上居中展示；
摄像头画面只作为右上角的小窗预览，点“手部同步”后可以驱动最多两只镜像 MANO 手。

链路拆成三段，每段都换成了实测可用的组件：

| 环节 | 选型 | 作用 |
| --- | --- | --- |
| 单图 → 3DGS | [Apple SHARP](https://github.com/apple/ml-sharp) | 前馈推理，一张图直接输出 `.ply`，无需逐图优化 |
| 加载 / 变换 / 渲染 | [gaussian-splat-lite](https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite) + Three.js | 加载 PLY，WebGL2 实时渲染 3DGS |
| 手部输入（路线 A） | [MediaPipe HandLandmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker) + [MANO](https://mano.is.tue.mpg.de/) | 浏览器内 21 点手部关键点 → MANO 蒙皮手 |

## 快速开始

```bash
# 1. 一次性准备（克隆 SHARP、建 Python 环境、装前端依赖）
scripts/setup.sh

# 2. 一张照片 → 3DGS（默认 DEVICE=mps，Apple Silicon 可用）
scripts/build_splat.sh assets/koala.jpg scene

# 3. 启动前端
cd web && npm run dev
# 打开 http://localhost:5173/?model=car.ply
# 手部同步：点“手部同步”，或直接打开 http://localhost:5173/?hand=1
```

`build_splat.sh` 会把结果清理后放到 `web/public/models/scene.ply`，前端默认加载它。
也可以直接把任意 `.ply` 拖进页面，或用按钮载入。

主画面只渲染模型：滚轮缩放，`自旋` 展示模型。摄像头可选，开启后只出现在右上角的小窗里；
点“手部同步”后主画面会切换成实时 MANO 手：最多两只、左右镜像、跟着手在画面里的位置摆；
没有检测到手时不显示任何手模型。

MANO 派生资产默认不提交（受 MANO 研究许可限制）。本机已生成到
`web/public/models/mano_right.json` / `mano_left.json`；新环境需要先从
[MANO 官网](https://mano.is.tue.mpg.de/) 下载 pkl，然后：

```bash
.venv/bin/python -I tools/export_mano.py MANO_RIGHT.pkl web/public/models/mano_right.json
.venv/bin/python -I tools/export_mano.py MANO_LEFT.pkl  web/public/models/mano_left.json
```

## 在 M3 Pro 上的实测

| 项目 | 结果 |
| --- | --- |
| SHARP 首次运行 | 约 3 分 45 秒（含 2.4 GB 权重下载 + 模型加载） |
| SHARP 再次运行 | 约 24 秒（其中推理约 9 秒） |
| 输出 | 1,179,648 个高斯，63 MB `.ply` |
| 清理后 | 1,044,733 个高斯（裁掉约 11%，见下文） |
| 浏览器渲染 | Chrome + Metal，**60 fps**（1280×800，1.04M splats） |

SHARP 的**预测**支持 CPU / CUDA / MPS（本项目只用到预测，MPS 正常）；
它自带的视频渲染需要 CUDA，这里不需要。

注意：论文里的“不到 1 秒”是标准 CUDA GPU 上的前馈推理时间；M3 Pro 的 MPS 上实测约 9 秒。
所以这个 demo 的形态是“**生成一次，之后实时展示**”，而不是每帧重先生成。

## 实现里值得注意的几点

### 1. SHARP 的坐标系
输出是 OpenCV 约定：x 向右、y 向下、z 向前，主体中心大约在 `(0, 0, +z)`，单位是米。
在 Three.js 里套一个 `quaternion.set(1, 0, 0, 0)`（绕 X 轴 180°）即可变成 Y 轴向上、朝 -Z 的视图。

### 2. 飞点和画面白边
单图重建会在主体周围散落少量飞点，还会在照片边缘产生一圈发白的高斯，放大看像相框。
`tools/clean_ply.py` 做两件事：

- 按坐标 0.5%~99.5% 分位数裁掉离群点；
- 用 PLY 自带的内参把高斯投回图像，丢掉贴着画面边框的一圈。

### 3. 取景不要缩放模型
直接把模型缩放到固定尺寸会破坏单图重建的透视关系（背景被拉近、主体被压扁）。
这里的做法是：**模型保持 SHARP 的度量尺度和原始位置**，用点云的张角估计原照片的视场角，
再用视场角把它“取景”到画面中央（`FIT_FRACTION = 0.55`）。

### 4. 自旋 + 变焦
模型保持居中，`自旋` 只改变模型自身姿态；滚轮通过相机 FOV（变焦镜头）缩放。
这样透视始终和输入照片一致，也避开了近距离缩放的透视失真。

### 5. 摄像头：小窗预览 + 可选的手部输入
平时摄像头画面固定在右上角，只做预览；点“手部同步”后才把画面喂给 MediaPipe，
主画面切换成实时手部模型（0–2 只）。再点一次关闭，回到 3DGS 模型。
窄屏时小窗自动挪到右下角，避免和左上角的状态面板重叠。

## 路线 A：实时手部同步（MANO 手）

点 `手部同步` 或打开 `?hand=1`，会把 MediaPipe 的 21 个关键点映射到最多两只 MANO 蒙皮手：

1. **推理**：`HandLandmarker` 在 VIDEO 模式下每帧跑一次（`numHands: 2`），优先 GPU delegate，失败退回 CPU；
2. **骨骼**：MANO 的 16 根骨骼来自 `web/public/models/mano_right.json` / `mano_left.json`，由 `tools/export_mano.py` 从 MANO pkl 导出（顶点、三角面、骨骼权重都在一个 67 KB JSON 里）；
3. **镜像**：实际右手用右手资产、实际左手用左手资产，然后对整只手做水平镜像（`scale.x = -1`）；屏幕位置也用镜像后的坐标，所以主画面里的手和右上角预览的方向一致；
4. **两只手**：结果按镜像后的屏幕 x 排序分配到两个手位，各自在自己的位置渲染；两只手同时出现时会自动缩小；
5. **无手**：连续 300 ms 没检测到手就隐藏所有手模型；
6. **重定向**：用 `worldLandmarks` 的 3D 方向算每根骨骼的局部四元数，手腕的完整朝向用世界坐标系下的手部基向量求根骨骼旋转；
7. **平滑**：骨骼四元数做 slerp。

如果 MANO JSON 加载失败，会退回 `web/src/hand.js` 里的胶囊体关节手（只支持单只、居中）。当前 MANO 手仍然是
**通用手模型**，不是 3DGS 手，也不是你本人的外观；下一步把手部资产换成带骨骼权重的 3DGS 手时，
这套推理和重定向可以复用。页面 HUD 里的“追踪中 · X ms”是单帧推理耗时。

MANO 模型和由它导出的 JSON 仅限研究用途，商用前需确认 Max Planck 的许可条款。

## 文件结构

```
3dgs/
├── assets/                 # 示例输入图
├── ml-sharp/               # Apple SHARP（setup.sh 克隆）
├── output/koala2/          # SHARP 原始输出
├── scripts/
│   ├── setup.sh            # 环境准备
│   └── build_splat.sh      # 图片 → 清理 → 前端可用 PLY
├── tools/
│   ├── clean_ply.py        # 离群点 + 边缘裁剪
│   ├── make_test_ply.py    # 生成合成球体，验证前端链路
│   ├── export_mano.py      # MANO pkl → 前端 SkinnedMesh JSON
│   └── pw/                 # Playwright 冒烟测试脚本
└── web/
    ├── src/main.js         # 渲染 + 摄像头 + 手部模式切换
    ├── src/mano.js         # MANO JSON → SkinnedMesh + 21 点重定向
    ├── src/hand.js         # 胶囊体占位手（MANO 加载失败时兜底）
    ├── public/models/      # scene.ply、car.ply、mano_*.json
    └── index.html
```

调试用的 URL 参数：

- `?model=test.ply` 加载其他模型；
- `?hand=1` 直接进入手部同步模式；
- `?raw=1` 保持 SHARP 的原始位置与尺度，用 `?fov=44` 配原照片视场角，可用于和输入照片对比；
- `?fov=…` 覆盖初始视场角。

## 限制

- 单图 3DGS 只在原视角附近可信，转到侧面会明显劣化；演示时别把模型转太多。
- 手部同步目前是通用 MANO 蒙皮手，不是 3DGS 手，也不是你本人的外观；左右手标签来自 MediaPipe，掌心/手背判断是近似值。
- 两只手靠得很近时模型会重叠；这是按真实手在画面里的位置摆放的结果。
- 单摄像头只能看到手的一面，换成 3DGS 手后手背细节会缺失；要完整外观需要多角度采集和离线训练。
- MANO 模型和导出的 JSON 仅限研究用途，商用前需确认许可条款。
- SHARP 权重和代码使用 `apple-amlr` 许可，商用前需确认许可条款。
- 用 `web/dist` 部署时，`public/models/*.ply` 体积较大（每个约 60 MB），建议按需加载或转成压缩格式（SPZ/SOG）。

## 参考

- SHARP: [GitHub](https://github.com/apple/ml-sharp) · [Hugging Face](https://huggingface.co/apple/Sharp)
- gaussian-splat-lite: [GitHub](https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite) · [npm](https://www.npmjs.com/package/gaussian-splat-lite)
- MediaPipe HandLandmarker: [文档](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker)
- MANO: [官网](https://mano.is.tue.mpg.de/)（模型需要注册下载，研究用途许可）
