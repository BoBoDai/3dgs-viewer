#!/usr/bin/env bash
# 一次性环境准备：Web 前端依赖 + MediaPipe 运行时 + 本地模型资源
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> 1/2 安装前端依赖"
(cd web && npm install)

echo "==> 2/2 准备 MediaPipe 运行时与手部模型"
mkdir -p web/public/wasm web/public/models
cp web/node_modules/@mediapipe/tasks-vision/wasm/* web/public/wasm/
if [ ! -f web/public/models/hand_landmarker.task ]; then
  curl -L -o web/public/models/hand_landmarker.task \
    https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task
fi

if [ ! -f web/public/models/soma_hand_right.json ]; then
  echo "提示：未找到 SOMA 手资产，手部同步会退回胶囊体占位手。"
  echo "      可用 tools/export_soma_hand.py 重新导出（见 README）。"
fi

echo
echo "完成。下一步："
echo "  cd web && npm run dev              # 打开 http://localhost:5173"
