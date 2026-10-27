# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 这个仓库是什么

浏览器端的 3D Gaussian Splatting 查看器。`web/index.html` 加载 `web/src/main.js`，用 Three.js +
[gaussian-splat-lite](https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite) 解码并实时渲染 3DGS 模型；
可选开启摄像头，画面只在右上角小窗预览，点“手部同步”后通过 MediaPipe → MANO 驱动最多两只镜像蒙皮手。

仓库**不包含模型生成链路**。早期的 Apple SHARP 单图 → 3DGS 流程已经删除（`ml-sharp/`、`output/`、
`.venv/`、`build_splat.sh`、`clean_ply.py`），模型需要自行准备后放进 `web/public/models/`。

## 前置条件

- **Node.js + npm**：Vite 7 需要 Node 20.19+ 或 22.12+（当前开发机是 v24）。`web/` 是 ESM。
- **WebGL2 浏览器**：3DGS 渲染依赖 WebGL2。
- **摄像头**：`getUserMedia` 只在 `localhost` 或 HTTPS 下可用。`npm run dev` 虽然带 `--host`，
  但通过局域网 IP 打开页面时摄像头会被浏览器拒绝。
- **运行应用不需要 Python**。只有这些工具需要：
  - `tools/export_mano.py`：Python 3 + numpy（MANO pkl → JSON）；
  - `tools/make_test_ply.py`：numpy + plyfile；
  - `tools/pw/track.js`：需要 ffmpeg 预先生成的 `/tmp/hand.y4m`。
- **MANO 资产**：pkl 需在 [MANO 官网](https://mano.is.tue.mpg.de/) 注册下载，模型与导出的 JSON
  仅限研究用途，不能提交到仓库。

## 命令

```bash
# 一次性准备：web 依赖 + MediaPipe wasm + hand_landmarker.task
scripts/setup.sh

# 开发 / 构建
cd web
npm run dev        # vite --host，默认 http://localhost:5173
npm run build      # 输出 web/dist（gitignored）
npm run preview

# 无头冒烟测试（先启动 dev server）
cd tools/pw
npm install
npx playwright install chromium
NO_PROXY=localhost,127.0.0.1,::1 node test.js "http://localhost:5173/?model=scene.ply" /tmp/out.png
NO_PROXY=localhost,127.0.0.1,::1 node track.js /tmp/hand.y4m "http://localhost:5173/?hand=1&model=car.ply"

# 工具（用任意装了 numpy 的 Python；-I 避免从当前目录导入同名模块）
python3 -I tools/export_mano.py MANO_RIGHT.pkl web/public/models/mano_right.json
python3 -I tools/export_mano.py MANO_LEFT.pkl  web/public/models/mano_left.json
python3 -I tools/make_test_ply.py web/public/models/test.ply
```

- `scripts/setup.sh` 会 `npm install`、把 `node_modules/@mediapipe/tasks-vision/wasm/*` **复制**到
  `web/public/wasm/`，并在缺失时下载 `hand_landmarker.task`。升级 `@mediapipe/tasks-vision` 后必须
  重新运行，否则 wasm 与 JS 版本不匹配。
- 它**不**下载 3DGS 模型，也**不**生成 MANO JSON；缺 MANO JSON 时手部同步会退回胶囊体占位手。
- `test.js` 等待 `window.__demo.state.numSplats > 0` 后截图；`track.js` 用假摄像头播放 y4m，
  等待 `window.__hand.tracker().landmarker` 和 `window.__hand.rig.lastSeen > 0`。
- 无头环境走 SwiftShader 软渲染，截图里的 5–7 fps **不代表真机性能**；它只用来验证“能加载、能渲染”。
- 本机若设置了 `http_proxy`，访问 localhost 也会走代理：脚本要带 `NO_PROXY`，浏览器要带
  `--no-proxy-server`（现有脚本已处理）。

## 架构

### 页面入口

- `web/index.html` → `/src/main.js`。`main.js` 依赖 index.html 里的固定 DOM id
  （`#model-status`、`#btn-hand`、`#file-input` 等），改页面前先对照 `els` 表。
- `web/src/viewer.js` + `ply-detect.js` 是一个**独立原型**，没有被任何页面引用：它支持
  3DGS PLY、带 face 的网格 PLY、无 face 的点云 PLY。`viewer.js` 需要一套 index.html 没有的 DOM
  （`#stats`、`#btn-open`、`#url-input` 等）。不要假设它会运行；接入时需要新增页面/CSS，并在
  生产构建里配置 Vite 多页入口。

### 模型加载与取景（main.js）

- 场景层级：`pivot`（整模型位置）→ `orient`（up 轴翻转）→ `holder`（自旋），
  `GaussianSplatRenderer` 直接挂在 `scene` 上。
- 渲染器刻意 `antialias: false`（splats 不需要 MSAA），`preBlurAmount: 0`、`blurAmount: 0.3`，
  避免高斯轮廓外出现发白光晕。
- 加载：`new SplatMesh({ file | url })` → `await mesh.initialized`。支持 `.ply` 以及
  `.spz` / `.sog` / `.rad`。错误信息里出现 compressed / packed_position / min_scale_x / chunk
  通常意味着编码格式不受支持。
- 取景：`robustFit()` 通过 `mesh.splats.forEachCenter((index, x, y, z) => …)` 最多采样约 20 万个中心，
  用 2%~98% 分位数求主体中心和包围球，把模型平移到中心，再由包围球 + 视场角算出相机距离。
  **模型本身不缩放**，保持重建的原始尺度。
- 相机：滚轮改的是 `state.zoom`（0.5–3）并推拉相机，不改 FOV；`updateGenericCamera()` 每帧按
  包围球设置 `near/far`。缩放模型尺度从毫米到公里都成立。
- up 轴：默认按 OpenCV/COLMAP（+Y 向下）绕 X 轴翻转 180°；`?up=1` 跳过翻转，
  工具栏 `翻转` 可手动切换。
- URL 参数只有三个：`?model=`（`web/public/models/` 下的文件名或完整 URL）、`?hand=1`、`?up=1`。
  `?raw` / `?fov` 已随 SHARP 一起删除。
- 调试钩子：`window.__demo`（scene/camera/state/loadSplat）和 `window.__hand`（rigs/tracker/enable/disable）。

### 手部模式（main.js + mano.js + hand.js）

- `enableHandMode()`：隐藏 `pivot`、开启摄像头、并行加载 4 个 rig（2 个手位 × 左右手资产）、
  初始化 `HandTracker`。MANO 资产失败时退回 `hand.js` 的胶囊体手。
- `mano.js` 把 `/models/mano_{right,left}.json` 构建成 16 骨骼 `SkinnedMesh`，用 MediaPipe 的
  `worldLandmarks` 求每根骨骼的局部四元数，再做 slerp 平滑；整只手用 `scale.x = -1` 镜像，
  屏幕位置也使用镜像后的坐标，和右上角预览方向一致。
- 手部相机固定在原点，手的位置固定在 `HAND_Z = -0.56`。**手部模式必须显式设置
  `camera.near = 0.01; camera.far = 20;`**，不能沿用模型尺度的 `near/far`——例如 car.ply 的
  `near ≈ 1.57`，会把手整只裁掉。这是移除 SHARP 取景后真实出现过的回归，改相机代码时务必用
  `track.js` 验证。
- 连续 300 ms 没检测到手就隐藏所有手模型；MediaPipe 只在视频帧更新时推理，GPU delegate 失败会退回 CPU。

### 资源与忽略规则

- `web/public/models/*.ply`、`web/public/models/mano_*.json`、`web/public/wasm/`、
  `web/public/models/hand_landmarker.task` 都被 gitignore：要么太大，要么受 MANO 许可限制。
- `web/public` 由 Vite 映射到站点根路径，因此代码里硬编码的是 `/wasm` 和 `/models/...`。
- `assets/*.jpg` 只是历史示例输入，仓库里已经没有生成脚本。
- `web/dist`、`node_modules`、`.idea`、`.DS_Store` 都不提交。

## 约定

- 源码注释、README、界面文案都用中文；提交信息用英文（见下文的 Conventional Commits 规则）。改代码时沿用周围注释的密度和语气。
- 改了 URL 参数、支持格式、命令或资源路径时，同步更新 `README.md` 和本文件。
- 改取景/相机后必须同时验证模型模式和手部模式；`track.js` 是手部模式的回归测试。
- 不要把 SHARP 专属假设（相机在原点、`?raw`、`?fov`、按张角取景）重新塞回 `main.js`；
  现在的取景对模型来源不做假设，唯一的约定是默认的 up 翻转。
- `viewer.js` 仍是原型。如果正式采用它，先决定它和 `main.js` 的入口关系，再删掉重复的加载逻辑，
  不要长期维护两个会悄悄分叉的渲染器。
- 大文件不提交，不要用 `git add -f` 绕过 `.gitignore`。

## Git conventions

### What goes into a commit

- **Source, docs and config only.** Never commit `node_modules/`, `web/dist/`,
  `web/public/models/*.ply`, `web/public/models/mano_*.json`, `web/public/wasm/`,
  `hand_landmarker.task`, `.idea/`, or OS files.
- **MANO assets are license-restricted** (Max Planck research license); they never enter the repository.
- **No `git add -f`** to bypass `.gitignore` for generated output.
- Keep related changes together; keep pure refactors separate from behavior changes.

### Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/), in English, imperative mood:

```
<type>(<scope>): <subject>
```

- **type** (required): `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`,
  `chore`, `revert`.
  - `feat` — user-visible capability or behavior
  - `fix` — bug fix
  - `build` / `deps` — dependency or toolchain bumps
  - `docs` — `README.md`, `CLAUDE.md`, comments-only changes
  - `perf` — performance-only changes
  - `test` — test-only changes
  - `chore` — housekeeping that fits no other type (`.gitignore`, file moves)
- **scope** (optional): the area, e.g. `web`, `viewer`, `hand`, `mano`, `ply`, `deps`. Omit it for
  repo-wide changes.
- **subject**: lowercase after the colon, imperative, ≤ 72 characters including the prefix, no trailing period.
- **One line only**: no body and no footer. If the reason is not obvious, fold a short clause into the subject.
- **Breaking change**: add `!` before the colon
  (`feat(web)!: drop SHARP and use generic PLY auto-framing`).
- No tool/agent attribution.

Examples:

```
feat: scaffold single-image 3DGS viewer with mirrored MANO hands
fix(mano): keep the hand inside the camera near plane
docs: document the generic PLY viewer prototype
```

### When to commit and push

- Commit only when the user asks; do not commit as a side effect of another task.
- Push only when the user asks. No remote is configured.
- `main` is the default branch; develop on it directly.
- Before committing, run `cd web && npm run build`. For camera/framing or hand changes, also run
  `node tools/pw/track.js` with the dev server up.
