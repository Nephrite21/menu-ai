#!/usr/bin/env bash
# scripts/bench/prefetch.sh — 벤치 후보 모델 파일을 .cache/hf 에 미리 받기(선택). Transformers.js 캐시와 같은 배치.
# 사용: bash scripts/bench/prefetch.sh   (안 돌려도 bench-models.mjs 가 필요할 때 받는다)
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEST="$ROOT/.cache/hf"
UA='MenuSuggestionBot/0.1 (hobby project)'
get() { # repo file
  local out="$DEST/$1/$2"
  if [ -s "$out" ]; then echo "  있음 $1/$2"; return; fi
  mkdir -p "$(dirname "$out")"
  echo "  받기 $1/$2"
  curl -sSfL -A "$UA" -o "$out.part" "https://huggingface.co/$1/resolve/main/$2" && mv "$out.part" "$out"
}
common() { for f in config.json tokenizer.json tokenizer_config.json; do get "$1" "$f"; done; }
common Xenova/multilingual-e5-small;  get Xenova/multilingual-e5-small onnx/model.onnx
common Xenova/multilingual-e5-base;   get Xenova/multilingual-e5-base onnx/model_quantized.onnx
common Xenova/paraphrase-multilingual-MiniLM-L12-v2; get Xenova/paraphrase-multilingual-MiniLM-L12-v2 onnx/model_quantized.onnx
common jhgan/ko-sroberta-multitask;   get jhgan/ko-sroberta-multitask onnx/model_qint8_avx512_vnni.onnx
common onnx-community/embeddinggemma-300m-ONNX; get onnx-community/embeddinggemma-300m-ONNX onnx/model_q4.onnx; get onnx-community/embeddinggemma-300m-ONNX onnx/model_q4.onnx_data
common Xenova/bge-m3;                 get Xenova/bge-m3 onnx/model_quantized.onnx
echo done
