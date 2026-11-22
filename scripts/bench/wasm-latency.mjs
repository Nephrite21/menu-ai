// scripts/bench/wasm-latency.mjs — 후보 모델의 "브라우저 WASM 단일 스레드" 쿼리 지연 추정 (소유: D)
//
//   node --use-system-ca scripts/bench/wasm-latency.mjs
//
// verify.mjs 에서 Node onnxruntime-web WASM == Edge WASM (코사인 1.000000, 지연도 거의 같음) 을 확인했으므로,
// 브라우저를 띄우지 않고 Node 에서 onnxruntime-web(WASM, numThreads=1)으로 쿼리 20개의 지연을 잰다.
// 모델 파일은 bench-models.mjs 가 .cache/hf 에 받아 둔 것을 쓴다(없으면 건너뜀).
import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CACHE = path.join(ROOT, '.cache/hf');
const ort = await import('onnxruntime-web');
ort.env.wasm.wasmPaths = pathToFileURL(path.join(ROOT, 'node_modules/onnxruntime-web/dist')).href + '/';
ort.env.wasm.numThreads = 1;
const T = await import('@huggingface/transformers');
T.env.cacheDir = CACHE;

const CANDIDATES = [
  { key: 'e5-small-q8', id: 'Xenova/multilingual-e5-small', file: 'onnx/model_quantized.onnx', qp: 'query: ', out: 'mean' },
  { key: 'ko-sroberta-int8', id: 'jhgan/ko-sroberta-multitask', file: 'onnx/model_qint8_avx512_vnni.onnx', qp: '', out: 'mean' },
  { key: 'embgemma-300m-q4', id: 'onnx-community/embeddinggemma-300m-ONNX', file: 'onnx/model_q4.onnx', data: 'onnx/model_q4.onnx_data', qp: 'task: search result | query: ', out: 'sentence_embedding' },
  { key: 'bge-m3-q8', id: 'Xenova/bge-m3', file: 'onnx/model_quantized.onnx', qp: '', out: 'cls' },
];
const queries = JSON.parse(await readFile(path.join(ROOT, 'scripts/bench/queries.json'), 'utf8')).map((x) => x.q);
const results = [];
for (const c of CANDIDATES) {
  const f = path.join(CACHE, c.id, c.file);
  if (!(await stat(f).catch(() => null))) { console.log(`${c.key}: 모델 파일 없음, 건너뜀`); continue; }
  const tok = await T.AutoTokenizer.from_pretrained(c.id);
  const opts = { executionProviders: ['wasm'] };
  if (c.data) opts.externalData = [{ path: path.basename(c.data), data: new Uint8Array(await readFile(path.join(CACHE, c.id, c.data))) }];
  const t0 = performance.now();
  const s = await ort.InferenceSession.create(new Uint8Array(await readFile(f)), opts);
  const loadMs = performance.now() - t0;
  const run = async (text) => {
    const enc = tok(text, { padding: true, truncation: true });
    const feeds = {};
    for (const n of s.inputNames) {
      feeds[n] = enc[n] ? new ort.Tensor('int64', enc[n].data, enc[n].dims) : new ort.Tensor('int64', new BigInt64Array(enc.input_ids.data.length), enc.input_ids.dims);
    }
    return s.run(feeds);
  };
  await run(c.qp + 'warmup');
  const ms = [];
  for (const q of queries) { const t = performance.now(); await run(c.qp + q); ms.push(performance.now() - t); }
  ms.sort((a, b) => a - b);
  const r = { key: c.key, sessionLoadMs: loadMs, queryMsMedian: ms[ms.length >> 1], queryMsP90: ms[Math.floor(ms.length * 0.9)] };
  results.push(r);
  console.log(`${c.key.padEnd(18)} 세션 생성 ${(loadMs / 1000).toFixed(1)}s, 쿼리 중앙값 ${r.queryMsMedian.toFixed(1)}ms, p90 ${r.queryMsP90.toFixed(1)}ms`);
  await s.release?.();
}
await writeFile(path.join(ROOT, 'scripts/bench/results/wasm-latency.json'), JSON.stringify({ date: new Date().toISOString(), ortWeb: ort.env.versions?.web, threads: 1, results }, null, 2));
