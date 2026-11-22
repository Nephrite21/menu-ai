// scripts/bench/verify.mjs — 임베딩 정합성 + 양자화 순위 손실 검증 (소유: D)
//
//   node --use-system-ca scripts/bench/verify.mjs [--no-browser] [--menus web/menus.json]
//
// 같은 문장 집합(벤치 쿼리 20개 × kind:'query' + web/menus.json 전체 메뉴 × kind:'passage')을
//   A) Node 빌드 경로   : embed.js → Transformers.js(node) → onnxruntime-node CPU      (= scripts/embed.mjs)
//   B) Node WASM 커널   : onnxruntime-web WASM 단일 스레드, 같은 모델 파일·토크나이저·pooling
//   C) 실제 브라우저    : Microsoft Edge 헤드리스(playwright-core) 가 web/js/embed.js 를 그대로 로드
//                         (CDN Transformers.js 4.3.2 + Cache API) — device 'wasm', 'webgpu' 각각
// 로 임베딩해서 A 대비 코사인을 비교한다. 이어서 web/menus.json 의 int8 벡터 vs float 벡터로
// 쿼리 20개의 검색 순위 손실을 측정한다. 결과는 scripts/bench/results/verify.json 에 저장.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUTDIR = path.join(ROOT, 'scripts/bench/results');
const TMP = path.join(ROOT, '.cache/verify');
const args = process.argv.slice(2);
const MENUS = path.resolve(ROOT, args.includes('--menus') ? args[args.indexOf('--menus') + 1] : 'web/menus.json');
const NO_BROWSER = args.includes('--no-browser');

const E = await import(pathToFileURL(path.join(ROOT, 'web/js/embed.js')).href);
const queries = JSON.parse(await readFile(path.join(ROOT, 'scripts/bench/queries.json'), 'utf8')).map((x) => x.q);
const menus = JSON.parse(await readFile(MENUS, 'utf8'));
const items = [
  ...queries.map((text) => ({ text, kind: 'query' })),
  ...menus.map((m) => ({ text: E.menuToPassage(m), kind: 'passage' })),
];
await mkdir(TMP, { recursive: true });
await mkdir(OUTDIR, { recursive: true });
const inFile = path.join(TMP, 'items.json');
await writeFile(inFile, JSON.stringify(items));

// ---------- A, B: Node ----------
function runNode(mode) {
  const out = path.join(TMP, `${mode}.json`);
  execFileSync(process.execPath, [...process.execArgv, path.join(ROOT, 'scripts/bench/dump-node.mjs'), mode, inFile, out], {
    stdio: 'inherit',
  });
  return readFile(out, 'utf8').then(JSON.parse);
}
const results = { cpu: await runNode('cpu'), 'node-wasm': await runNode('wasm') };

// ---------- C: Edge headless ----------
function findBrowser() {
  const c = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ];
  return c.find((p) => existsSync(p));
}

function startStaticServer(dir) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css' };
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const p = path.join(dir, u);
    if (!p.startsWith(dir) || !existsSync(p)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' });
    createReadStream(p).pipe(res);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

if (!NO_BROWSER) {
  const exe = findBrowser();
  if (!exe) console.warn('브라우저 없음 — C 단계 생략');
  else {
    const { chromium } = await import('playwright-core');
    const srv = await startStaticServer(path.join(ROOT, 'web'));
    const base = `http://127.0.0.1:${srv.address().port}`;
    // 영구 프로필: Cache API('transformers-cache')가 유지되어 두 번째 실행부터 모델 재다운로드 없음
    const ctx = await chromium.launchPersistentContext(path.join(ROOT, '.cache/edge-profile'), {
      executablePath: exe,
      headless: true,
      args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--ignore-gpu-blocklist'],
    });
    for (const device of ['wasm', 'webgpu']) {
      const page = await ctx.newPage();
      page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`  [edge:${device}] ${m.text().slice(0, 200)}`); });
      await page.goto(`${base}/menus.meta.json`); // 스크립트 없는 같은 출처 문서
      try {
        const r = await page.evaluate(async ({ items, device }) => {
          const E = await import('/js/embed.js');
          const t0 = performance.now();
          const info = await E.initEmbedder({ device });
          const loadMs = performance.now() - t0;
          const vectors = [];
          const ms = [];
          for (const { text, kind } of items) {
            const t = performance.now();
            vectors.push(Array.from(await E.embed(text, { kind })));
            ms.push(performance.now() - t);
          }
          return {
            info: { ...info, crossOriginIsolated: self.crossOriginIsolated, hwc: navigator.hardwareConcurrency, ua: navigator.userAgent },
            loadMs, vectors, ms,
          };
        }, { items, device });
        results[`edge-${device}`] = { mode: `edge-${device}`, ...r };
        console.log(`[edge-${device}] ${items.length}건 완료, 로드 ${(r.loadMs / 1000).toFixed(1)}s, 평균 ${(r.ms.reduce((a, b) => a + b, 0) / r.ms.length).toFixed(1)}ms ${JSON.stringify(r.info)}`);
      } catch (e) {
        console.warn(`[edge-${device}] 실패: ${String(e).slice(0, 300)}`);
        results[`edge-${device}`] = { mode: `edge-${device}`, error: String(e).slice(0, 500) };
      }
      await page.close();
    }
    await ctx.close();
    srv.close();
  }
}

// ---------- 비교 ----------
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const stats = (arr) => ({ min: Math.min(...arr), mean: arr.reduce((a, b) => a + b, 0) / arr.length });
const nQ = queries.length;
const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
// 쌍별 코사인: [기준, 비교] — 같은 문장끼리
const PAIRS = [
  ['cpu', 'node-wasm'], ['cpu', 'edge-wasm'], ['cpu', 'edge-webgpu'],
  ['node-wasm', 'edge-wasm'], ['node-wasm', 'edge-webgpu'], ['edge-wasm', 'edge-webgpu'],
];
const consistency = {};
for (const [a, b] of PAIRS) {
  const A = results[a]?.vectors, B = results[b]?.vectors;
  if (!A || !B) continue;
  const cos = B.map((v, i) => dot(v, A[i]));
  consistency[`${a} vs ${b}`] = { query: stats(cos.slice(0, nQ)), passage: stats(cos.slice(nQ)) };
}
const timing = {};
for (const [k, r] of Object.entries(results)) if (r.ms) timing[k] = { info: r.info, avgMs: avg(r.ms), queryAvgMs: avg(r.ms.slice(0, nQ)), loadMs: r.loadMs };

// 저장된 int8 벡터(web/menus.json) vs 각 경로 float 재계산 — 빌드 산출물이 실제 브라우저 벡터와 맞는지
const stored = menus.map((m) => E.menuVector(m));
const storedVs = {};
for (const k of ['cpu', 'node-wasm', 'edge-wasm', 'edge-webgpu']) {
  const R = results[k]?.vectors;
  if (R) storedVs[k] = stats(stored.map((v, i) => (v ? dot(v, R[nQ + i]) : NaN)));
}
const ref = results['node-wasm'].vectors;

// ---------- 양자화 순위 손실 ----------
function rank(qv, mvecs) {
  return mvecs.map((v, i) => ({ i, s: dot(qv, v) })).sort((a, b) => b.s - a.s);
}
function overlap(a, b, k) {
  const A = new Set(a.slice(0, k).map((x) => x.i));
  return b.slice(0, k).filter((x) => A.has(x.i)).length / k;
}
function rankLoss(queryVecs, floatM, otherM, otherQ = queryVecs) {
  const acc = { top1: 0, top5: 0, top10: 0, maxScoreDiff: 0, meanAbsRankShiftTop10: 0 };
  for (let q = 0; q < queryVecs.length; q++) {
    const a = rank(queryVecs[q], floatM);
    const b = rank(otherQ[q], otherM);
    acc.top1 += a[0].i === b[0].i ? 1 : 0;
    acc.top5 += overlap(a, b, 5);
    acc.top10 += overlap(a, b, 10);
    const posB = new Map(b.map((x, r) => [x.i, r]));
    let shift = 0;
    for (let r = 0; r < 10; r++) shift += Math.abs(posB.get(a[r].i) - r);
    acc.meanAbsRankShiftTop10 += shift / 10;
    const sb = new Map(b.map((x) => [x.i, x.s]));
    for (const x of a) acc.maxScoreDiff = Math.max(acc.maxScoreDiff, Math.abs(x.s - sb.get(x.i)));
  }
  const n = queryVecs.length;
  return {
    top1Agree: acc.top1 / n, top5Overlap: acc.top5 / n, top10Overlap: acc.top10 / n,
    meanAbsRankShiftTop10: acc.meanAbsRankShiftTop10 / n, maxScoreDiff: acc.maxScoreDiff,
  };
}
// 기준 = 빌드 경로(node-wasm) float 쿼리 × float 메뉴
const qRef = ref.slice(0, nQ);
const mFloat = ref.slice(nQ);
const mInt8 = mFloat.map((v) => { const { q, scale } = E.quantize(Float32Array.from(v)); return E.dequantize(q, scale); });
const quantLoss = { 'int8 메뉴 (양자화만)': rankLoss(qRef, mFloat, mInt8) };
// 실제 서비스 조합: 브라우저 쿼리 벡터 × 빌드 int8 메뉴 벡터(web/menus.json)
for (const k of ['edge-wasm', 'edge-webgpu']) {
  if (results[k]?.vectors) quantLoss[`${k} 쿼리 × int8 메뉴`] = rankLoss(qRef, mFloat, stored, results[k].vectors.slice(0, nQ));
}
// 참고: 빌드를 onnxruntime-node(cpu)로 했다면
quantLoss['(참고) cpu빌드 int8 × edge-wasm 쿼리'] = results['edge-wasm']?.vectors
  ? rankLoss(qRef, mFloat, results.cpu.vectors.slice(nQ).map((v) => { const { q, scale } = E.quantize(Float32Array.from(v)); return E.dequantize(q, scale); }), results['edge-wasm'].vectors.slice(0, nQ))
  : undefined;
if (!quantLoss['(참고) cpu빌드 int8 × edge-wasm 쿼리']) delete quantLoss['(참고) cpu빌드 int8 × edge-wasm 쿼리'];

const meta = JSON.parse(await readFile(MENUS.replace(/\.json$/, '.meta.json'), 'utf8').catch(() => '{}'));
const report = { date: new Date().toISOString(), menus: path.relative(ROOT, MENUS), menusBuildBackend: meta.buildBackend, nQueries: nQ, nMenus: menus.length, timing, consistency, storedInt8Vs: storedVs, rankLoss: quantLoss };
await writeFile(path.join(OUTDIR, 'verify.json'), JSON.stringify(report, null, 2));

const f = (x, d = 6) => (x == null || Number.isNaN(x) ? '-' : x.toFixed(d));
console.log('\n== 속도 ==');
for (const [k, t] of Object.entries(timing)) console.log(k.padEnd(12), `건당 ${f(t.avgMs, 1)}ms (쿼리 ${f(t.queryAvgMs, 1)}ms)`, t.loadMs ? `로드 ${f(t.loadMs / 1000, 1)}s` : '', t.info?.device ?? '');
console.log('\n== 정합성: 같은 문장 코사인 ==');
console.log('비교'.padEnd(26), 'query min / mean'.padEnd(22), 'passage min / mean');
for (const [k, c] of Object.entries(consistency)) console.log(k.padEnd(26), `${f(c.query.min)} / ${f(c.query.mean)}`.padEnd(22), `${f(c.passage.min)} / ${f(c.passage.mean)}`);
console.log(`\n== web/menus.json int8 (빌드: ${meta.buildBackend ?? '?'}) vs 각 경로 float ==`);
for (const [k, s] of Object.entries(storedVs)) console.log(k.padEnd(12), `min ${f(s.min)} mean ${f(s.mean)}`);
console.log('\n== 순위 손실 (기준: node-wasm float, 쿼리 %d개 × 메뉴 %d개) ==', nQ, menus.length);
for (const [k, v] of Object.entries(quantLoss)) console.log(k.padEnd(28), JSON.stringify(Object.fromEntries(Object.entries(v).map(([a, b]) => [a, +b.toFixed(4)]))));
console.log(`\n결과 저장: ${path.relative(ROOT, path.join(OUTDIR, 'verify.json'))}`);
