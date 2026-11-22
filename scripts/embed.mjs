#!/usr/bin/env node
// scripts/embed.mjs — 메뉴 벡터 빌드 (소유: D. 기술고문)
//
// 입력: data/merged.json  (없으면 data/menus/*.json 을 직접 합침)  또는 --input <file>
// 출력: web/menus.json      메뉴 배열. 각 항목 = 원본 필드 + vec: { q: int8[384], scale }
//       web/menus.meta.json 모델/규칙/개수/용량 메타(브라우저에서 모델 일치 확인용)
// 캐시: .cache/embeddings/<model>.<dtype>.json   key = sha256(모델·dtype·버전·실제 입력 문자열)
//       → 재빌드 시 텍스트가 바뀐 메뉴만 다시 계산.
//
// 브라우저(web/js/embed.js)와 "같은 모듈·같은 함수"를 쓴다: menuToPassage, toModelInput, initEmbedder, embed.
//
// 사용:
//   node --use-system-ca scripts/embed.mjs [--input f.json] [--out web/menus.json] [--device wasm|cpu] [--no-cache] [--prune]
//   (--use-system-ca: TLS 검사 프록시/백신이 있는 Windows 환경에서 HF 다운로드 실패 시 필요. 없으면 생략 가능)

import { readFile, writeFile, mkdir, readdir, rename, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E = await import(pathToFileURL(path.join(ROOT, 'web/js/embed.js')).href);

// ---------- args ----------
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const OUT = path.resolve(ROOT, opt('--out', 'web/menus.json'));
const META_OUT = OUT.replace(/\.json$/i, '.meta.json');
const INPUT = opt('--input', null);
const USE_CACHE = !flag('--no-cache');
const PRUNE = flag('--prune');
// wasm(기본): onnxruntime-web WASM — 브라우저 WASM 경로와 같은 커널이라 벡터가 사실상 동일(코사인 ≈1.0000).
// cpu       : onnxruntime-node — 약 6배 빠르지만 브라우저 대비 코사인 최소 ≈0.997 (q8 정수 커널 차이).
const DEVICE = opt('--device', 'wasm');
if (!['wasm', 'cpu'].includes(DEVICE)) throw new Error('--device 는 wasm|cpu');
const MODEL_CACHE_DIR = path.resolve(ROOT, opt('--model-cache', '.cache/hf'));
const EMB_CACHE_DIR = path.resolve(ROOT, '.cache/embeddings');
const EMB_CACHE_FILE = path.join(
  EMB_CACHE_DIR,
  `${E.MODEL_ID.replace(/[^\w.-]+/g, '_')}.${E.MODEL_DTYPE}.json`,
);

// ---------- input ----------
async function readJson(p) {
  return JSON.parse(await readFile(p, 'utf8'));
}

async function loadMenus() {
  if (INPUT) return { from: INPUT, menus: await readJson(path.resolve(ROOT, INPUT)) };
  const merged = path.join(ROOT, 'data/merged.json');
  if (existsSync(merged)) {
    const j = await readJson(merged);
    return { from: 'data/merged.json', menus: Array.isArray(j) ? j : j.menus };
  }
  const dir = path.join(ROOT, 'data/menus');
  const files = existsSync(dir) ? (await readdir(dir)).filter((f) => f.endsWith('.json')).sort() : [];
  if (!files.length) throw new Error('입력 없음: data/merged.json 도 data/menus/*.json 도 없습니다. --input 을 지정하세요.');
  const seen = new Map();
  for (const f of files) {
    const arr = await readJson(path.join(dir, f));
    for (const m of arr) {
      if (seen.has(m.id)) console.warn(`  ! 중복 id ${m.id} (${f}) — 뒤 항목으로 덮어씀`);
      seen.set(m.id, m);
    }
  }
  return { from: `data/menus/*.json (${files.length}개 파일)`, menus: [...seen.values()] };
}

// ---------- embedding cache ----------
const f32ToB64 = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
const b64ToF32 = (s) => {
  const b = Buffer.from(s, 'base64');
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
const cacheKey = (modelInput) =>
  createHash('sha256')
    .update(`${E.MODEL_ID}|${E.MODEL_REVISION}|${E.MODEL_DTYPE}|tjs${E.TRANSFORMERS_VERSION}|${DEVICE}|${modelInput}`)
    .digest('hex')
    .slice(0, 32);

async function loadCache() {
  if (!USE_CACHE || !existsSync(EMB_CACHE_FILE)) return {};
  try {
    return await readJson(EMB_CACHE_FILE);
  } catch {
    console.warn('  ! 임베딩 캐시 손상 — 무시하고 새로 만듦');
    return {};
  }
}

async function atomicWrite(p, data) {
  await mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  await writeFile(tmp, data);
  await rename(tmp, p);
}

// ---------- main ----------
const t0 = performance.now();
const { from, menus } = await loadMenus();
console.log(`입력: ${from} → ${menus.length}개 메뉴`);

const cache = await loadCache();
const jobs = menus.map((m) => {
  const passage = E.menuToPassage(m);
  const modelInput = E.toModelInput(passage, 'passage');
  return { m, passage, key: cacheKey(modelInput) };
});
const todo = jobs.filter((j) => !cache[j.key]);
console.log(`캐시 적중 ${jobs.length - todo.length} / 신규 계산 ${todo.length}`);

if (todo.length) {
  const tl = performance.now();
  let lastPct = -1;
  const info = await E.initEmbedder({
    cacheDir: MODEL_CACHE_DIR,
    device: DEVICE,
    onProgress: (p) => {
      const pct = Math.floor(p * 10) * 10;
      if (pct !== lastPct) { lastPct = pct; process.stdout.write(`\r  모델 로드 ${pct}%`); }
    },
  });
  console.log(`\r  모델 로드 완료 ${JSON.stringify(info)} (${((performance.now() - tl) / 1000).toFixed(1)}s)`);
  const te = performance.now();
  // 단건 처리(batchSize=1): 브라우저 embed() 와 비트 단위로 같은 입력 텐서 → 같은 벡터. (embed.js 주석 참고)
  for (let i = 0; i < todo.length; i++) {
    const v = await E.embed(todo[i].passage, { kind: 'passage' });
    cache[todo[i].key] = f32ToB64(v);
    if ((i + 1) % 25 === 0 || i + 1 === todo.length) process.stdout.write(`\r  임베딩 ${i + 1}/${todo.length}`);
  }
  const dt = performance.now() - te;
  console.log(`\n  임베딩 ${todo.length}건 ${(dt / 1000).toFixed(1)}s (건당 ${(dt / todo.length).toFixed(1)}ms)`);
}

if (USE_CACHE) {
  let toSave = cache;
  if (PRUNE) {
    toSave = {};
    for (const j of jobs) toSave[j.key] = cache[j.key];
  }
  await atomicWrite(EMB_CACHE_FILE, JSON.stringify(toSave));
}

// ---------- quantize + write ----------
let worstCos = 1;
let sumCos = 0;
const out = jobs.map(({ m, key }) => {
  const v = b64ToF32(cache[key]);
  const { q, scale } = E.quantize(v);
  const cos = E.dot(v, E.dequantize(q, scale));
  worstCos = Math.min(worstCos, cos);
  sumCos += cos;
  const { vec: _old, ...rest } = m; // 입력에 vec 가 있어도 새로 계산한 값으로 교체
  return { ...rest, vec: { q: Array.from(q), scale: Number(scale.toPrecision(9)) } };
});

const body = '[\n' + out.map((o) => JSON.stringify(o)).join(',\n') + '\n]\n';
await atomicWrite(OUT, body);

// 용량 비교(참고): 벡터 없는 본문, float32 JSON 배열, base64 int8
const noVec = '[\n' + out.map(({ vec, ...r }) => JSON.stringify(r)).join(',\n') + '\n]\n';
const asFloat = '[\n' + jobs.map(({ m, key }) => JSON.stringify({ ...m, vec: Array.from(b64ToF32(cache[key]), (x) => +x.toFixed(6)) })).join(',\n') + '\n]\n';
const asB64 = '[\n' + out.map((o) => JSON.stringify({ ...o, vec: { b64: Buffer.from(Int8Array.from(o.vec.q).buffer).toString('base64'), scale: o.vec.scale } })).join(',\n') + '\n]\n';
const sz = (s) => ({ raw: Buffer.byteLength(s), gzip: gzipSync(s, { level: 9 }).length });
const kb = (n) => `${(n / 1024).toFixed(1)}KB`;
const sizes = { output: sz(body), withoutVec: sz(noVec), float32Json: sz(asFloat), int8Base64: sz(asB64) };

const meta = {
  model: E.MODEL_ID,
  revision: E.MODEL_REVISION,
  dtype: E.MODEL_DTYPE,
  dim: E.DIM,
  buildBackend: DEVICE === 'wasm' ? 'onnxruntime-web wasm (node, 1 thread)' : 'onnxruntime-node cpu',
  transformers: E.TRANSFORMERS_VERSION,
  passageRuleVersion: E.PASSAGE_RULE_VERSION,
  quantization: 'int8 symmetric per-vector; q=round(x/(max|x|/127)); scale=1/||q|| (dequantize 결과 단위벡터)',
  count: out.length,
  input: from,
  builtAt: new Date().toISOString(),
  bytes: { raw: sizes.output.raw, gzip: sizes.output.gzip },
  quantCos: { min: +worstCos.toFixed(6), mean: +(sumCos / out.length).toFixed(6) },
};
await atomicWrite(META_OUT, JSON.stringify(meta, null, 2) + '\n');

console.log(`출력: ${path.relative(ROOT, OUT)} (${out.length}개)  ${path.relative(ROOT, META_OUT)}`);
console.log('용량(raw / gzip):');
for (const [k, v] of Object.entries(sizes)) console.log(`  ${k.padEnd(12)} ${kb(v.raw).padStart(10)} / ${kb(v.gzip).padStart(9)}   (메뉴당 ${(v.raw / out.length).toFixed(0)}B / ${(v.gzip / out.length).toFixed(0)}B)`);
console.log(`양자화 코사인(원본 vs int8): 최소 ${worstCos.toFixed(6)}, 평균 ${(sumCos / out.length).toFixed(6)}`);
console.log(`총 ${((performance.now() - t0) / 1000).toFixed(1)}s`);
