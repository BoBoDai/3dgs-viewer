#!/usr/bin/env bash
# 一次性环境准备：SHARP 推理环境 + Web 前端依赖 + 本地模型资源
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> 1/4 获取 SHARP"
if [ ! -d ml-sharp ]; then
  git clone --depth 1 https://github.com/apple/ml-sharp.git ml-sharp
fi

echo "==> 2/4 创建 Python 环境（已存在则跳过安装）"
if [ ! -x .venv/bin/python ]; then
  uv venv .venv --python 3.13
fi
(cd ml-sharp && uv pip install --python "$ROOT/.venv/bin/python" -r requirements.txt)

echo "==> 3/4 安装前端依赖"
(cd web && npm install)

echo "==> 4/4 准备 MediaPipe 运行时与手部模型"
mkdir -p web/public/wasm web/public/models
cp web/node_modules/@mediapipe/tasks-vision/wasm/* web/public/wasm/
if [ ! -f web/public/models/hand_landmarker.task ]; then
  curl -L -o web/public/models/hand_landmarker.task \
    https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task
fi

if [ ! -f web/public/models/mano_right.json ]; then
  echo "提示：未找到 MANO JSON，手部同步会退回胶囊体占位手。"
  echo "      从 MANO 官网下载 pkl 后运行 tools/export_mano.py 生成（见 README）。"
fi

echo
echo "完成。下一步："
echo "  scripts/build_splat.sh 你的照片.jpg   # 单图 → 3DGS"
echo "  cd web && npm run dev                 # 打开 http://localhost:5173"
