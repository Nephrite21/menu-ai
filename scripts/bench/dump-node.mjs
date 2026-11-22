// scripts/bench/dump-node.mjs — web/js/embed.js 를 Node 에서 실행해 벡터를 덤프 (verify.mjs 가 호출)
//
//   node --use-system-ca scripts/bench/dump-node.mjs <cpu|wasm> <in.json> <out.json>
//   in.json  : [{ text, kind }]
//   out.json : { mode, info, vectors: number[][], ms: number[] }
//
// cpu  : embed.js → Transformers.js pipeline → onnxruntime-node (CPU EP, 멀티스레드)
// wasm : embed.js → 같은 토크나이저·모델 파일 → onnxruntime-web WASM (단일 스레드, 브라우저와 같은 커널)
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [mode, inFile, outFile] = process.argv.slice(2);
if (!['cpu', 'wasm'].includes(mode) || !inFile || !outFile) {
  console.error('usage: dump-node.mjs <cpu|wasm> <in.json> <out.json>');
  process.exit(2);
}
const E = await import(pathToFileURL(path.join(ROOT, 'web/js/embed.js')).href);
const items = JSON.parse(await readFile(inFile, 'utf8'));
const info = await E.initEmbedder({ cacheDir: path.join(ROOT, '.cache/hf'), device: mode });
const vectors = [];
const ms = [];
for (const { text, kind } of items) {
  const t = performance.now();
  vectors.push(Array.from(await E.embed(text, { kind })));
  ms.push(performance.now() - t);
}
await writeFile(outFile, JSON.stringify({ mode, info, vectors, ms }));
console.log(`[node-${mode}] ${items.length}건 완료, 평균 ${(ms.reduce((a, b) => a + b, 0) / ms.length).toFixed(1)}ms`);
