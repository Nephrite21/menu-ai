#!/usr/bin/env node
// scripts/embed.mjs — 메뉴 벡터 빌드 (소유: D. 기술고문)
//
// 입력: data/merged.json  (없으면 data/menus/*.json 을 직접 합침)  또는 --input <file>
// 출력: web/menus.json      메뉴 배열. 각 항목 = 원본 필드 + vec: { q: int8[384], scale }
//       web/menus.meta.json 모델/규칙/개수/용량 메타(브라우저에서 모델 일치 확인용)
// 캐시: .cache/embeddings/<model>.<dtype>.json
//       key = sha256(모델·리비전·dtype·Transformers.js 버전·백엔드·실제 모델 입력 문자열)
//       → 재빌드 시 텍스트가 바뀐 메뉴만 다시 계산. scripts/infer-cuisine.mjs 도 같은 캐시를 쓴다(embedCached).
//
// 브라우저(web/js/embed.js)와 "같은 모듈·같은 함수"를 쓴다: menuToPassage, toModelInput, initEmbedder, embed.
//
// 사용:
//   node --use-system-ca scripts/embed.mjs [--input f.json] [--out web/menus.json] [--device wasm|cpu] [--no-cache] [--prune]
//   (--use-system-ca: TLS 검사 프록시/백신이 있는 Windows 환경에서 HF 다운로드 실패 시 필요. 없으면 생략 가능)
//   --device wasm(기본): onnxruntime-web WASM — 브라우저 WASM 경로와 같은 커널, 벡터 동일(코사인 1.000000 실측).
//   --device cpu       : onnxruntime-node — 약 5배 빠르지만 브라우저 대비 코사인 최소 ≈0.997 (q8 정수 커널 차이).

import { readFile, writeFile, mkdir, readdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E = await import(pathToFileURL(path.join(ROOT, 'web/js/embed.js')).href);
export const MODEL_CACHE_DIR = path.join(ROOT, '.cache/hf');
export const EMB_CACHE_FILE = path.join(ROOT, '.cache/embeddings', `${E.MODEL_ID.replace(/[^\w.-]+/g, '_')}.${E.MODEL_DTYPE}.json`);

// ---------- 공용 유틸 ----------
export async function readJson(p) {
  return JSON.parse(await readFile(p, 'utf8'));
}

export async function atomicWrite(p, data) {
  await mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  await writeFile(tmp, data);
  await rename(tmp, p);
}

export const f32ToB64 = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
export const b64ToF32 = (s) => {
  const b = Buffer.from(s, 'base64');
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
export const cacheKey = (modelInput, device) =>
  createHash('sha256')
    .update(`${E.MODEL_ID}|${E.MODEL_REVISION}|${E.MODEL_DTYPE}|tjs${E.TRANSFORMERS_VERSION}|${device}|${modelInput}`)
    .digest('hex')
    .slice(0, 32);

export async function loadEmbCache() {
  if (!existsSync(EMB_CACHE_FILE)) return {};
  try {
    return await readJson(EMB_CACHE_FILE);
  } catch {
    console.warn('  ! 임베딩 캐시 손상 — 무시하고 새로 만듦');
    return {};
  }
}

/**
 * 텍스트 배열을 해시 캐시를 거쳐 임베딩한다. → Float32Array[] (입력 순서)
 * @param {string[]} texts  접두어 없는 원문(kind 에 맞는 e5 접두어는 embed.js 가 붙임)
 * @param {{kind?:'query'|'passage', device?:'wasm'|'cpu', cache?:object|null, save?:boolean, label?:string}} [o]
 *        cache: 미리 읽은 캐시 객체(여러 번 호출 시 공유), null 이면 캐시 미사용. save: 끝나고 캐시 파일 저장.
 */
export async function embedCached(texts, { kind = 'passage', device = 'wasm', cache, save = true, label = '임베딩' } = {}) {
  const useCache = cache !== null;
  const c = useCache ? (cache ?? (await loadEmbCache())) : {};
  const keys = texts.map((t) => cacheKey(E.toModelInput(t, kind), device));
  const todo = [];
  keys.forEach((k, i) => { if (!c[k]) todo.push(i); });
  console.log(`  ${label}: 캐시 적중 ${texts.length - todo.length} / 신규 계산 ${todo.length}`);
  if (todo.length) {
    const tl = performance.now();
    let lastPct = -1;
    const info = await E.initEmbedder({
      cacheDir: MODEL_CACHE_DIR,
      device,
      onProgress: (p) => {
        const pct = Math.floor(p * 10) * 10;
        if (pct !== lastPct && process.stdout.isTTY) { lastPct = pct; process.stdout.write(`\r  모델 로드 ${pct}%`); }
      },
    });
    if (E.getEmbedderInfo()?.device !== device) throw new Error(`이미 다른 device(${E.getEmbedderInfo()?.device})로 로드됨`);
    console.log(`  모델 ${JSON.stringify(info)} (${((performance.now() - tl) / 1000).toFixed(1)}s)`);
    const te = performance.now();
    // 단건 처리(batchSize=1): 브라우저 embed() 와 같은 입력 텐서 → 같은 벡터. (embed.js embedBatch 주석 참고)
    for (let n = 0; n < todo.length; n++) {
      const i = todo[n];
      c[keys[i]] = f32ToB64(await E.embed(texts[i], { kind }));
      if (process.stdout.isTTY && ((n + 1) % 25 === 0 || n + 1 === todo.length)) process.stdout.write(`\r  ${label} ${n + 1}/${todo.length}`);
    }
    const dt = performance.now() - te;
    console.log(`${process.stdout.isTTY ? '\n' : ''}  ${label} ${todo.length}건 ${(dt / 1000).toFixed(1)}s (건당 ${(dt / todo.length).toFixed(1)}ms)`);
    if (useCache && save) await atomicWrite(EMB_CACHE_FILE, JSON.stringify(c));
  }
  return { vectors: keys.map((k) => b64ToF32(c[k])), keys, cache: c };
}

// ---------- 입력 ----------
async function loadMenus(input) {
  if (input) return { from: input, menus: await readJson(path.resolve(ROOT, input)) };
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

// ---------- main ----------
async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => args.includes(name);
  const opt = (name, def) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : def;
  };
  const OUT = path.resolve(ROOT, opt('--out', 'web/menus.json'));
  const META_OUT = OUT.replace(/\.json$/i, '.meta.json');
  const DEVICE = opt('--device', 'wasm');
  if (!['wasm', 'cpu'].includes(DEVICE)) throw new Error('--device 는 wasm|cpu');

  const t0 = performance.now();
  const { from, menus } = await loadMenus(opt('--input', null));
  console.log(`입력: ${from} → ${menus.length}개 메뉴`);
  const passages = menus.map((m) => E.menuToPassage(m));
  const cache = flag('--no-cache') ? null : await loadEmbCache();
  const { vectors, keys } = await embedCached(passages, { kind: 'passage', device: DEVICE, cache, save: false, label: '임베딩' });
  if (cache) {
    let toSave = cache;
    if (flag('--prune')) { toSave = {}; for (const k of keys) toSave[k] = cache[k]; }
    await atomicWrite(EMB_CACHE_FILE, JSON.stringify(toSave));
  }

  // ---------- quantize + write ----------
  let worstCos = 1;
  let sumCos = 0;
  const out = menus.map((m, i) => {
    const v = vectors[i];
    const { q, scale } = E.quantize(v);
    const cos = E.dot(v, E.dequantize(q, scale));
    worstCos = Math.min(worstCos, cos);
    sumCos += cos;
    const { vec: _old, scale: _oldScale, ...rest } = m; // 입력에 vec 가 있어도 새로 계산한 값으로 교체
    return { ...rest, vec: { q: Array.from(q), scale: Number(scale.toPrecision(9)) } };
  });
  const body = '[\n' + out.map((o) => JSON.stringify(o)).join(',\n') + '\n]\n';
  await atomicWrite(OUT, body);

  // 용량 비교(참고): 벡터 없는 본문, float32 JSON 배열, base64 int8
  const noVec = '[\n' + out.map(({ vec, ...r }) => JSON.stringify(r)).join(',\n') + '\n]\n';
  const asFloat = '[\n' + menus.map((m, i) => JSON.stringify({ ...m, vec: Array.from(vectors[i], (x) => +x.toFixed(6)) })).join(',\n') + '\n]\n';
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
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
