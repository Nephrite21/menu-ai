// scripts/bench/bench-models.mjs — 임베딩 모델 비교 벤치 (소유: D)
//
//   node --use-system-ca scripts/bench/bench-models.mjs [--only <substr>] [--menus scripts/bench/menus.sample.json]
//
// 한국어 상황 쿼리 20개(queries.json, 정답 메뉴 id 라벨) × 소규모 메뉴 세트(menus.sample.json, 59개)로
// 후보 모델의 품질(Recall@5, nDCG@10, MRR, P@1)·크기·속도를 측정한다.
// 모델마다 별도 자식 프로세스에서 돌려 메모리(RSS)를 분리 측정. 결과: scripts/bench/results/bench.json
// 모델 파일은 .cache/hf 에 받는다(스크립트와 분리). 속도는 Node + onnxruntime-node(CPU, 멀티스레드) 기준이라
// 브라우저 WASM 단일 스레드보다 빠르다 — 브라우저 배수는 verify.mjs 결과로 보정해서 docs 에 적는다.
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CACHE = path.join(ROOT, '.cache/hf');
const OUTDIR = path.join(ROOT, 'scripts/bench/results');

export const MODELS = [
  { key: 'e5-small-q8', id: 'Xenova/multilingual-e5-small', dtype: 'q8', qp: 'query: ', pp: 'passage: ', pooling: 'mean', dim: 384, note: '현재 SPEC 모델' },
  { key: 'e5-small-fp32', id: 'Xenova/multilingual-e5-small', dtype: 'fp32', qp: 'query: ', pp: 'passage: ', pooling: 'mean', dim: 384, note: 'q8 품질 손실 확인용 기준' },
  { key: 'e5-base-q8', id: 'Xenova/multilingual-e5-base', dtype: 'q8', qp: 'query: ', pp: 'passage: ', pooling: 'mean', dim: 768 },
  { key: 'minilm-l12-q8', id: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', dtype: 'q8', qp: '', pp: '', pooling: 'mean', dim: 384 },
  { key: 'ko-sroberta-int8', id: 'jhgan/ko-sroberta-multitask', dtype: 'fp32', model_file_name: 'model_qint8_avx512_vnni', qp: '', pp: '', pooling: 'mean', dim: 768, note: '저장소 제공 int8 ONNX' },
  { key: 'embgemma-300m-q4', id: 'onnx-community/embeddinggemma-300m-ONNX', dtype: 'q4', qp: 'task: search result | query: ', pp: 'title: none | text: ', pooling: 'sentence_embedding', dim: 768 },
  { key: 'bge-m3-q8', id: 'Xenova/bge-m3', dtype: 'q8', qp: '', pp: '', pooling: 'cls', dim: 1024 },
];

const args = process.argv.slice(2);
const getOpt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const MENUS = path.resolve(ROOT, getOpt('--menus', 'scripts/bench/menus.sample.json'));

// 브라우저가 실제로 받게 될 파일만 합산(같은 저장소의 다른 dtype 파일 제외)
async function downloadSize(cfg) {
  const suffix = { q8: '_quantized', fp32: '', fp16: '_fp16', q4: '_q4', q4f16: '_q4f16' }[cfg.dtype];
  const onnx = `onnx/${cfg.model_file_name ?? 'model'}${suffix}.onnx`;
  let s = 0;
  for (const f of ['config.json', 'tokenizer.json', 'tokenizer_config.json', onnx, `${onnx}_data`]) {
    s += await stat(path.join(CACHE, cfg.id, f)).then((x) => x.size, () => 0);
  }
  return s;
}

// ---------- child: 모델 1개 측정 ----------
async function runOne(key) {
  const cfg = MODELS.find((m) => m.key === key);
  const E = await import(pathToFileURL(path.join(ROOT, 'web/js/embed.js')).href);
  const T = await import('@huggingface/transformers');
  T.env.cacheDir = CACHE;
  T.env.allowLocalModels = false;
  const queries = JSON.parse(await readFile(path.join(ROOT, 'scripts/bench/queries.json'), 'utf8'));
  const menus = JSON.parse(await readFile(MENUS, 'utf8'));
  const passages = menus.map((m) => E.menuToPassage(m));

  const tl = performance.now();
  let encode;
  if (cfg.pooling === 'sentence_embedding') {
    const tok = await T.AutoTokenizer.from_pretrained(cfg.id);
    const model = await T.AutoModel.from_pretrained(cfg.id, { dtype: cfg.dtype, device: 'cpu' });
    encode = async (text) => {
      const inputs = tok([text], { padding: true, truncation: true });
      const { sentence_embedding } = await model(inputs);
      const v = Float32Array.from(sentence_embedding.data);
      const n = Math.hypot(...v);
      return v.map((x) => x / n);
    };
  } else {
    const opts = { dtype: cfg.dtype, device: 'cpu' };
    if (cfg.model_file_name) opts.model_file_name = cfg.model_file_name;
    const ext = await T.pipeline('feature-extraction', cfg.id, opts);
    encode = async (text) => Float32Array.from((await ext(text, { pooling: cfg.pooling, normalize: true })).data);
  }
  await encode('warmup');
  const loadMs = performance.now() - tl;
  const rss = process.memoryUsage().rss;

  const tp = performance.now();
  const P = [];
  for (const p of passages) P.push(await encode(cfg.pp + E.normalizeText(p)));
  const passMs = (performance.now() - tp) / passages.length;

  const qms = [];
  const metrics = { r5: 0, ndcg10: 0, mrr: 0, p1: 0 };
  const perQuery = [];
  for (const { q, rel } of queries) {
    const t = performance.now();
    const qv = await encode(cfg.qp + E.normalizeText(q));
    qms.push(performance.now() - t);
    const ranked = P.map((v, i) => ({ id: menus[i].id, s: E.dot(qv, v) })).sort((a, b) => b.s - a.s);
    const R = new Set(rel);
    const hits = ranked.map((x) => (R.has(x.id) ? 1 : 0));
    const r5 = hits.slice(0, 5).reduce((a, b) => a + b, 0) / Math.min(5, R.size);
    let dcg = 0, idcg = 0;
    for (let i = 0; i < 10; i++) { dcg += hits[i] / Math.log2(i + 2); if (i < R.size) idcg += 1 / Math.log2(i + 2); }
    const first = hits.indexOf(1);
    metrics.r5 += r5; metrics.ndcg10 += dcg / idcg; metrics.mrr += first >= 0 ? 1 / (first + 1) : 0; metrics.p1 += hits[0];
    perQuery.push({ q, r5: +r5.toFixed(3), top3: ranked.slice(0, 3).map((x) => x.id) });
  }
  for (const k in metrics) metrics[k] /= queries.length;
  qms.sort((a, b) => a - b);
  return {
    ...cfg, loadMs, rssMB: rss / 2 ** 20, passMs, queryMsMedian: qms[qms.length >> 1],
    diskBytes: await downloadSize(cfg), metrics, perQuery,
  };
}

if (args[0] === '--one') {
  const r = await runOne(args[1]);
  await writeFile(args[2], JSON.stringify(r));
  process.exit(0);
}

// ---------- parent ----------
await mkdir(OUTDIR, { recursive: true });
const only = getOpt('--only', null);
const prev = await readFile(path.join(OUTDIR, 'bench.json'), 'utf8').then(JSON.parse).catch(() => ({ results: [] }));
const results = new Map(prev.results.map((r) => [r.key, r]));
for (const m of MODELS) {
  if (only && !m.key.includes(only)) continue;
  console.log(`\n▶ ${m.key} (${m.id}, ${m.dtype})`);
  const tmp = path.join(ROOT, `.cache/bench-${m.key}.json`);
  try {
    execFileSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), '--one', m.key, tmp, '--menus', MENUS], { stdio: 'inherit' });
    const r = JSON.parse(await readFile(tmp, 'utf8'));
    results.set(m.key, r);
    console.log(`  R@5 ${r.metrics.r5.toFixed(3)} nDCG@10 ${r.metrics.ndcg10.toFixed(3)} MRR ${r.metrics.mrr.toFixed(3)} P@1 ${r.metrics.p1.toFixed(2)} | ${(r.diskBytes / 2 ** 20).toFixed(0)}MB | load ${(r.loadMs / 1000).toFixed(1)}s | q ${r.queryMsMedian.toFixed(1)}ms | RSS ${r.rssMB.toFixed(0)}MB`);
  } catch (e) {
    console.warn(`  실패: ${String(e).slice(0, 300)}`);
    results.set(m.key, { ...m, error: String(e).slice(0, 300) });
  }
}
const ordered = MODELS.map((m) => results.get(m.key)).filter(Boolean);
await writeFile(path.join(OUTDIR, 'bench.json'), JSON.stringify({ date: new Date().toISOString(), menus: path.relative(ROOT, MENUS), results: ordered }, null, 2));

console.log('\n| 모델 | dtype | 차원 | 다운로드 | 로드(캐시) | 쿼리 1건 | RSS | R@5 | nDCG@10 | MRR | P@1 |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of ordered) {
  if (r.error) { console.log(`| ${r.key} | ${r.dtype} | ${r.dim} | 실패 | | | | | | | |`); continue; }
  console.log(`| ${r.key} | ${r.dtype} | ${r.dim} | ${(r.diskBytes / 2 ** 20).toFixed(0)}MB | ${(r.loadMs / 1000).toFixed(1)}s | ${r.queryMsMedian.toFixed(1)}ms | ${r.rssMB.toFixed(0)}MB | ${r.metrics.r5.toFixed(3)} | ${r.metrics.ndcg10.toFixed(3)} | ${r.metrics.mrr.toFixed(3)} | ${r.metrics.p1.toFixed(2)} |`);
}
