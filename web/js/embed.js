// web/js/embed.js — 로컬 임베딩 모듈 (소유: D. 기술고문)
//
// SPEC '임베딩 API' 계약:
//   initEmbedder({ onProgress })       모델 로드, 진행률 콜백(0~1)
//   embed(text, { kind })              kind: 'query'|'passage' → Float32Array(384), L2 정규화
//   dequantize(int8Array, scale)       → Float32Array
//   menuToPassage(menu)                빌드(scripts/embed.mjs)·브라우저 공통 passage 문장
//
// 이 파일은 브라우저와 Node 양쪽에서 import 된다.
//   - 최상위에 Transformers.js 정적 import가 없다. (Node가 https: import 를 못 하므로)
//   - 브라우저: initEmbedder() 시점에 CDN(버전 고정)에서 동적 import.
//   - Node:     initEmbedder() 시점에 npm 패키지 '@huggingface/transformers' 를 동적 import.
//   - menuToPassage / dequantize / quantize 등 순수 함수는 모델 없이 바로 쓸 수 있다.

// ---------------------------------------------------------------------------
// 고정 설정 — 빌드 벡터와 브라우저 벡터의 정합성은 아래 값이 양쪽에서 같아야 보장된다.
// 바꾸면 반드시 `node scripts/embed.mjs` 로 web/menus.json 을 재빌드할 것.
// ---------------------------------------------------------------------------
export const TRANSFORMERS_VERSION = '4.3.2'; // npm 2026-10-27 출시. package.json 과 동일하게 고정.
export const TRANSFORMERS_CDN =
  `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VERSION}/dist/transformers.min.js`;
export const MODEL_ID = 'Xenova/multilingual-e5-small';
// HF 저장소 커밋 고정(2025-07-22 커밋). 'main' 이면 저장소가 갱신될 때 빌드 벡터와 브라우저 벡터가 조용히 어긋날 수 있다.
export const MODEL_REVISION = '761b726dd34fb83930e26aab4e9ac3899aa1fa78';
// q8 = onnx/model_quantized.onnx (118MB). fp32(470MB)/fp16(235MB)는 정적 사이트 첫 로드에 과함.
// WebGPU 에서도 같은 q8 파일을 써서 빌드(Node CPU) 벡터와 같은 가중치를 보장한다.
export const MODEL_DTYPE = 'q8';
export const DIM = 384;
export const USER_AGENT = 'MenuSuggestionBot/0.1 (hobby project)';
export const PASSAGE_RULE_VERSION = 1; // menuToPassage 규칙이 바뀌면 올린다(빌드 캐시 키에 포함).

/** cuisine 코드 → passage 문장에 들어갈 한국어 라벨 (SPEC 'cuisineKo') */
export const CUISINE_KO = Object.freeze({
  korean: '한식',
  western: '양식',
  chinese: '중식',
  japanese: '일식',
  vietnamese: '베트남 음식',
  mexican: '멕시코 음식',
  thai: '태국 음식',
  indian: '인도 음식',
  fusion: '퓨전 음식',
  snack: '분식·간식',
  cafe: '카페·디저트',
  other: '기타',
});

// ---------------------------------------------------------------------------
// 순수 함수 (모델 불필요)
// ---------------------------------------------------------------------------

/** 공백 정리 + 유니코드 NFC 정규화. 한글 자모 분리 입력(NFD) 대비. */
export function normalizeText(text) {
  return String(text ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

/**
 * SPEC: `${name}. ${cuisineKo}. ${ingredients.join(', ')}. ${tags.join(', ')}. ${desc}`
 * 빈 항목(재료/태그/설명 없음)은 ". ." 가 생기지 않도록 건너뛴다.
 */
export function menuToPassage(menu) {
  const m = menu || {};
  const list = (v) => (Array.isArray(v) ? v.map(normalizeText).filter(Boolean).join(', ') : normalizeText(v));
  const cuisineKo = CUISINE_KO[m.cuisine] ?? normalizeText(m.cuisine);
  const parts = [normalizeText(m.name), cuisineKo, list(m.ingredients), list(m.tags), normalizeText(m.desc)];
  return parts
    .filter(Boolean)
    .map((p) => p.replace(/[.\s]+$/u, '')) // 각 조각 끝의 마침표 중복 방지
    .join('. ');
}

/** e5 계열 접두어 적용. 모델에 실제로 들어가는 문자열(빌드 캐시 해시 키로도 사용). */
export function toModelInput(text, kind = 'query') {
  if (kind !== 'query' && kind !== 'passage') throw new Error(`kind must be 'query'|'passage' (got ${kind})`);
  return `${kind}: ${normalizeText(text)}`;
}

/** int8 배열 + scale → Float32Array. scale 은 빌드에서 q·scale 의 L2 노름이 1 이 되도록 정해 둔다. */
export function dequantize(int8Array, scale) {
  const n = int8Array.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = int8Array[i] * scale;
  return out;
}

/**
 * Float 벡터 → { q: Int8Array, scale }. 대칭 per-vector 양자화.
 * q = round(x / (max|x| / 127)), scale = 1 / ||q||  → dequantize 결과가 정확히 단위 벡터.
 */
export function quantize(vec) {
  let max = 0;
  for (let i = 0; i < vec.length; i++) max = Math.max(max, Math.abs(vec[i]));
  const q = new Int8Array(vec.length);
  if (max === 0) return { q, scale: 0 };
  const step = max / 127;
  let ss = 0;
  for (let i = 0; i < vec.length; i++) {
    const v = Math.max(-127, Math.min(127, Math.round(vec[i] / step)));
    q[i] = v;
    ss += v * v;
  }
  return { q, scale: 1 / Math.sqrt(ss) };
}

/**
 * 메뉴 객체에서 Float32Array 벡터를 꺼낸다.
 * 지원 형식: web/menus.json 의 { vec: { q: number[], scale } },
 *           사용자 메뉴의 vec: number[]/Float32Array (이미 float 인 경우).
 */
export function menuVector(menu) {
  const v = menu && menu.vec;
  if (!v) return null;
  if (v instanceof Float32Array) return v;
  if (Array.isArray(v)) return Float32Array.from(v);
  if (v.q && typeof v.scale === 'number') return dequantize(v.q, v.scale);
  return null;
}

/** 두 벡터의 내적(둘 다 L2 정규화면 코사인 유사도). */
export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// ---------------------------------------------------------------------------
// 모델 로딩 / 추론
// ---------------------------------------------------------------------------
const IS_BROWSER = typeof window !== 'undefined' || typeof self !== 'undefined' && typeof self.importScripts === 'function';

/**
 * 브라우저 device:'auto' 의 시도 순서. WebGPU 어댑터가 없으면 'webgpu' 는 건너뛴다.
 * 참고(docs/tech-notes.md): 이 모델(q8)은 WebGPU 에서 정수 연산이 CPU 로 폴백돼 WASM 보다 느리고
 * 빌드 벡터와의 오차도 약간 크다. ['wasm'] 으로 바꾸면 WASM 전용이 된다.
 */
export const BROWSER_DEVICE_ORDER = Object.freeze(['wasm']); // 실측: q8 모델은 WASM이 WebGPU보다 약 10배 빠르고 빌드 벡터와 정확히 일치(docs/tech-notes.md)

let state = null; // { extractor, device, dtype, transformers }

/**
 * Node 에서 device:'wasm' — 브라우저와 같은 onnxruntime-web WASM 커널로 실행(빌드 벡터 = 브라우저 WASM 벡터).
 * Transformers.js 4.3.2 Node 빌드는 onnxruntime-web 을 pipeline 에 연결할 공식 경로가 없어서
 * (주입 ORT 사용 시 지원 디바이스 목록이 비어 'Unsupported device'), 같은 pipeline 의 토크나이저와
 * 같은 모델 파일을 쓰고 mean pooling + L2 정규화만 여기서 재현한다. 반환값은 pipeline 과 같은 모양.
 */
async function createNodeWasmExtractor(T, options) {
  const base = await T.pipeline('feature-extraction', MODEL_ID, options); // 모델·토크나이저 다운로드/캐시
  const tok = base.tokenizer;
  await base.dispose?.();
  const ortName = 'onnxruntime-web';
  const ort = await import(ortName);
  const distUrl = new URL('./', import.meta.resolve(ortName)).href; // .../onnxruntime-web/dist/
  ort.env.wasm.wasmPaths = distUrl;
  ort.env.wasm.numThreads = 1; // GitHub Pages(교차 출처 격리 없음) 브라우저와 동일
  const fs = await import('node:fs/promises');
  const pathMod = await import('node:path');
  // Transformers.js 파일 캐시 배치: <cacheDir>/<repo>[/<revision>]/<file> (revision 이 'main' 이 아닐 때만 하위 폴더)
  const revDir = MODEL_REVISION === 'main' ? '' : MODEL_REVISION;
  const modelPath = pathMod.join(T.env.cacheDir, MODEL_ID, revDir, 'onnx', `model_${MODEL_DTYPE === 'q8' ? 'quantized' : MODEL_DTYPE}.onnx`);
  const session = await ort.InferenceSession.create(new Uint8Array(await fs.readFile(modelPath)), { executionProviders: ['wasm'] });
  const one = async (text) => {
    const enc = tok(text, { padding: true, truncation: true });
    const feeds = {};
    for (const name of session.inputNames) {
      const src = enc[name]; // XLM-R 은 token_type_ids 가 없음 → pipeline 처럼 0
      feeds[name] = src
        ? new ort.Tensor('int64', src.data, src.dims)
        : new ort.Tensor('int64', new BigInt64Array(enc.input_ids.data.length), enc.input_ids.dims);
    }
    const h = (await session.run(feeds))[session.outputNames[0]]; // [1, L, D]
    const [, L, D] = h.dims;
    const mask = enc.attention_mask.data;
    const v = new Float32Array(D);
    let cnt = 0;
    for (let i = 0; i < L; i++) {
      if (!Number(mask[i])) continue;
      cnt++;
      for (let d = 0; d < D; d++) v[d] += h.data[i * D + d];
    }
    let n = 0;
    for (let d = 0; d < D; d++) { v[d] /= cnt; n += v[d] * v[d]; }
    n = Math.max(Math.sqrt(n), 1e-12);
    for (let d = 0; d < D; d++) v[d] /= n;
    return v;
  };
  return async (texts) => {
    const arr = Array.isArray(texts) ? texts : [texts];
    const out = new Float32Array(arr.length * DIM);
    for (let i = 0; i < arr.length; i++) out.set(await one(arr[i]), i * DIM);
    return { data: out, dims: [arr.length, DIM] };
  };
}

let initPromise = null;

async function loadTransformers(injected) {
  if (injected) return injected;
  if (IS_BROWSER) return import(/* @vite-ignore */ TRANSFORMERS_CDN);
  const name = '@huggingface/transformers'; // 변수로 두어 브라우저 정적 분석기가 해석하지 않게 함
  return import(name);
}

async function hasWebGPU() {
  try {
    if (typeof navigator === 'undefined' || !navigator.gpu) return false;
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch {
    return false;
  }
}

/**
 * 모델 로드. 여러 번 호출해도 한 번만 로드한다(첫 호출의 옵션이 적용됨).
 * @param {object} [opts]
 * @param {(p:number, info?:object)=>void} [opts.onProgress] 0~1 진행률. info 는 Transformers.js 원본 이벤트.
 * @param {'auto'|'webgpu'|'wasm'|'cpu'} [opts.device='auto']
 *        auto: 브라우저면 BROWSER_DEVICE_ORDER 순서(WebGPU 어댑터 있으면 webgpu, 실패/없음이면 wasm).
 *              Node 면 cpu(onnxruntime-node).
 *        Node 에서 'wasm': onnxruntime-web WASM 커널(브라우저 WASM 과 같은 수치). scripts/embed.mjs 기본값.
 * @param {string} [opts.cacheDir] Node 전용. 모델 파일 캐시 폴더(기본: 라이브러리 기본 위치).
 * @param {object} [opts.transformers] 테스트용: 이미 import 한 Transformers.js 모듈 주입.
 * @returns {Promise<{ model:string, dtype:string, device:string }>}
 */
export function initEmbedder(opts = {}) {
  if (!initPromise) {
    initPromise = doInit(opts).catch((e) => {
      initPromise = null; // 실패 시 재시도 가능
      throw e;
    });
  }
  return initPromise;
}

async function doInit({ onProgress, device = 'auto', cacheDir, transformers } = {}) {
  const T = await loadTransformers(transformers);
  const { pipeline, env } = T;

  // 원격(HF Hub) 모델만 사용. 브라우저는 Cache API('transformers-cache')에 저장해 재방문 시 재다운로드 없음.
  env.allowRemoteModels = true;
  env.allowLocalModels = false;
  if (IS_BROWSER) env.useBrowserCache = true;
  if (!IS_BROWSER && cacheDir) env.cacheDir = cacheDir;
  if (!IS_BROWSER && typeof fetch === 'function' && !env.__menuSuggestionUA) {
    // SPEC: 외부 요청 UA 고정(브라우저는 UA 헤더를 바꿀 수 없으므로 Node 에서만).
    const baseFetch = env.fetch || fetch;
    env.fetch = (url, init = {}) => {
      const headers = new Headers(init.headers || {});
      headers.set('User-Agent', USER_AGENT);
      return baseFetch(url, { ...init, headers });
    };
    env.__menuSuggestionUA = true;
  }

  const report = (p, info) => {
    if (typeof onProgress === 'function') {
      try { onProgress(Math.max(0, Math.min(1, p)), info); } catch { /* UI 콜백 오류 무시 */ }
    }
  };
  // 다운로드 바이트 기준 0~0.95, 세션 생성 완료(ready) 시 1.
  let last = 0;
  const progress_callback = (info) => {
    if (info.status === 'progress_total' && info.total > 0) {
      last = Math.max(last, (info.loaded / info.total) * 0.95);
      report(last, info);
    } else if (info.status === 'ready') {
      report(1, info);
    }
  };
  report(0, { status: 'init' });

  let candidates;
  if (device === 'auto') {
    candidates = IS_BROWSER
      ? ((await hasWebGPU()) ? BROWSER_DEVICE_ORDER : BROWSER_DEVICE_ORDER.filter((d) => d !== 'webgpu'))
      : ['cpu'];
  } else {
    candidates = [device];
  }

  let lastErr;
  for (const dev of candidates) {
    try {
      const options = { dtype: MODEL_DTYPE, revision: MODEL_REVISION, progress_callback };
      if (dev) options.device = dev;
      const extractor = !IS_BROWSER && dev === 'wasm'
        ? await createNodeWasmExtractor(T, { ...options, device: 'cpu' })
        : await pipeline('feature-extraction', MODEL_ID, options);
      // 첫 추론으로 셰이더/커널 워밍업 + WebGPU 실제 동작 확인(어댑터는 있는데 실패하는 경우 폴백).
      await extractor('query: warmup', { pooling: 'mean', normalize: true });
      state = { extractor, device: dev ?? 'default', dtype: MODEL_DTYPE, transformers: T };
      report(1, { status: 'ready' });
      return getEmbedderInfo();
    } catch (e) {
      lastErr = e;
      if (typeof console !== 'undefined') console.warn(`[embed] device=${dev} 실패, 다음 후보로 폴백`, e);
    }
  }
  throw lastErr;
}

/** 현재 로드된 모델 정보. 로드 전이면 null. */
export function getEmbedderInfo() {
  return state ? { model: MODEL_ID, dtype: state.dtype, device: state.device, dim: DIM } : null;
}

function requireState() {
  if (!state) throw new Error('initEmbedder() 를 먼저 await 하세요.');
  return state;
}

/**
 * 문장 1개 임베딩. → Float32Array(384), L2 정규화.
 * @param {string} text
 * @param {{kind?: 'query'|'passage'}} [opts] 기본 'query'. 메뉴 문장은 menuToPassage() 결과를 kind:'passage' 로.
 */
export async function embed(text, { kind = 'query' } = {}) {
  if (!state) await initEmbedder();
  const { extractor } = requireState();
  const out = await extractor(toModelInput(text, kind), { pooling: 'mean', normalize: true });
  return Float32Array.from(out.data.subarray(0, DIM));
}

/**
 * 여러 문장 임베딩(빌드 스크립트·사용자 메뉴 다건 추가용). → Float32Array[]
 *
 * 주의: 기본 batchSize=1. q8 모델은 DynamicQuantizeLinear 가 "텐서 전체"의 min/max 로
 * 활성값을 양자화하므로, 여러 문장을 패딩해 한 텐서로 묶으면 같은 문장이라도 결과가 달라진다
 * (실측 코사인 ≈0.997). 브라우저의 embed()(단건)와 정확히 같은 벡터를 얻으려면 1건씩 돌려야 한다.
 */
export async function embedBatch(texts, { kind = 'passage', batchSize = 1 } = {}) {
  if (!state) await initEmbedder();
  const { extractor } = requireState();
  const result = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const chunk = texts.slice(i, i + batchSize).map((t) => toModelInput(t, kind));
    const out = await extractor(chunk, { pooling: 'mean', normalize: true });
    const [n, d] = out.dims;
    for (let j = 0; j < n; j++) result.push(Float32Array.from(out.data.subarray(j * d, (j + 1) * d)));
  }
  return result;
}

/** 메뉴 1개 → { q:number[], scale } (사용자 메뉴 추가 시 store.addUser 에 넘길 vec 형식) */
export async function embedMenu(menu) {
  const v = await embed(menuToPassage(menu), { kind: 'passage' });
  const { q, scale } = quantize(v);
  return { q: Array.from(q), scale };
}
