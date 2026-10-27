# 浏览器冒烟测试

Playwright 脚本，用来在无头浏览器里验证“加载 → 渲染”和“手部推理 → 关节映射”这两条链路。

```bash
cd tools/pw
npm install
npx playwright install chromium
```

先确保 `web` 已启动（`cd web && npm run dev`）。

- `node test.js "http://[::1]:5173/?model=scene.ply" /tmp/out.png`：加载模型并截图；
- `node gpu.js`：用本机 Chrome + Metal 测真实 GPU 帧率；
- `node track.js /tmp/hand.y4m "http://localhost:5173/?hand=1&model=car.ply"`：
  用假摄像头视频验证手部推理、左右镜像和关节角度。

`track.js` 需要一个包含手的 y4m 视频。可以拿一张手的照片循环生成：

```bash
ffmpeg -loop 1 -i hand.jpg \
  -vf "scale=640:480:force_original_aspect_ratio=decrease,pad=640:480:(ow-iw)/2:(oh-ih)/2:color=white" \
  -t 6 -r 30 -pix_fmt yuv420p -f yuv4mpegpipe /tmp/hand.y4m
```

注意：本机的 `http_proxy` 指向 127.0.0.1:7890 时，访问 localhost 也会走代理，
运行脚本时带上 `NO_PROXY=localhost,127.0.0.1`，浏览器参数里加 `--no-proxy-server`。
