#!/usr/bin/env bash
# 单张图片 → 3DGS：调用 SHARP 前馈推理，并把结果放到前端能加载的位置
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${1:?用法: scripts/build_splat.sh <图片路径> [输出名]}"
NAME="${2:-scene}"
DEVICE="${DEVICE:-mps}"

mkdir -p "$ROOT/output/$NAME"
echo "==> SHARP 推理（device=$DEVICE）"
"$ROOT/.venv/bin/sharp" predict -i "$IMAGE" -o "$ROOT/output/$NAME" --device "$DEVICE"

STEM="$(basename "$IMAGE")"
STEM="${STEM%.*}"
PLY="$ROOT/output/$NAME/$STEM.ply"

if [ ! -f "$PLY" ]; then
  echo "未找到输出 $PLY" >&2
  exit 1
fi

echo "==> 清理离群高斯"
"$ROOT/.venv/bin/python" "$ROOT/tools/clean_ply.py" "$PLY" "$ROOT/web/public/models/$NAME.ply"

echo "==> 完成"
ls -lh "$ROOT/web/public/models/$NAME.ply"
echo "前端默认加载 web/public/models/$NAME.ply（可用 ?model=文件名 切换）"
