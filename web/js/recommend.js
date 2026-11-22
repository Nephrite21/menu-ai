// web/js/recommend.js — 추천 엔진 (순수 함수, DOM/네트워크 없음, 브라우저·Node 공용 ES Module)
//
//   recommend({ queryVec, menus, cuisines, weights, exclude, topN, seed, history, ... })
//     → [{ menu, score, sim, bonus, reasons }]   (score 내림차순)
//   parseQuery(text) / rerollPick(ranked, opts)
//
// 점수 = 코사인 유사도(sim) + bonus
//   bonus = weightScale × Σ(weight × 보유 여부)  - 최근 추천 감점
//   "보유 여부"는 가중치 키(재료/태그/분류/메뉴명) 단위로 0/1 이다. 같은 키는 한 번만 센다.
//   키 판정: 표준 재료명, 표준 태그명, 분류명(groups.json: 소속 재료·태그·cuisine), 메뉴명(사전에 없는 용어는 부분 일치).
//   메뉴의 재료/태그와 가중치 키는 모두 사전으로 표준명 정규화 후 비교한다(치킨 == 닭고기).
//   weights 값은 -2..+2 로 클램프한다. exclude 에 걸리는 메뉴는 결과에서 완전히 제외한다.

import { getLexicon, parseQuery, parseQueryDetailed, resolveTerm, normKey, createLexicon, setDictionaries, loadDictionaries } from './parse.js';

export { parseQuery, parseQueryDetailed, resolveTerm, createLexicon, setDictionaries, loadDictionaries, getLexicon };

/** weight 1 단위가 점수에 주는 크기. 계약(점수 = 유사도 + Σ weight×보유)대로 기본 1. 부드럽게 하려면 recommend({ weightScale: 0.1 }) */
export const DEFAULT_WEIGHT_SCALE = 1;
/** 직전 추천 메뉴에 주는 기본 감점(유사도 단위). 최근일수록 크게, 오래될수록 HISTORY_DECAY^age 로 감소 */
export const DEFAULT_HISTORY_PENALTY = 0.05;
const HISTORY_DECAY = 0.8;

// ---- 유틸 -------------------------------------------------------------------
const isVecLike = (v) => Array.isArray(v) || (ArrayBuffer.isView(v) && !(v instanceof DataView));

/** 메뉴의 벡터 꺼내기. { q, scale } (web/menus.json), number[]/Float32Array/Int8Array, base64(int8) 모두 허용.
 *  코사인은 스케일에 불변이므로 scale 은 쓰지 않는다. */
function rawVecOf(menu) {
  let v = menu && (menu.vec ?? menu.embedding);
  if (v && typeof v === 'object' && !isVecLike(v)) v = v.q ?? v.data ?? v.values ?? v.v;
  if (typeof v === 'string') {
    try {
      const bin = atob(v);
      const out = new Int8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = (bin.charCodeAt(i) << 24) >> 24;
      return out;
    } catch {
      return null;
    }
  }
  return isVecLike(v) ? v : null;
}

const normCache = new WeakMap(); // vec(배열/타입드배열) → L2 노름
function normOf(v) {
  let n = normCache.get(v);
  if (n === undefined) {
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[i] * v[i];
    n = Math.sqrt(s);
    normCache.set(v, n);
  }
  return n;
}

/** 코사인 유사도. 정규화 가정이지만 노름으로 나눠 방어. 길이 불일치/영벡터/NaN → null */
export function cosineSimilarity(a, b) {
  if (!isVecLike(a) || !isVecLike(b) || a.length !== b.length || a.length === 0) return null;
  const na = normOf(a);
  const nb = normOf(b);
  if (!(na > 0) || !(nb > 0)) return null;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  const s = dot / (na * nb);
  return Number.isFinite(s) ? Math.max(-1, Math.min(1, s)) : null;
}

function hashString(str) {
  // xmur3 변형 → uint32
  let h = 1779033703 ^ String(str).length;
  for (let i = 0; i < String(str).length; i++) {
    h = Math.imul(h ^ String(str).charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

/** seed(숫자/문자열) → 재현 가능한 난수 함수 [0,1). seed 미지정이면 Math.random 기반 */
export function createRng(seed) {
  if (seed === undefined || seed === null) return Math.random;
  let a = typeof seed === 'number' && Number.isFinite(seed) ? seed >>> 0 : hashString(seed);
  return () => {
    // mulberry32
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 받침 판별 → 조사 선택
const hasBatchim = (w) => {
  const c = String(w).trim().slice(-1).charCodeAt(0);
  return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 !== 0;
};
const iga = (w) => (hasBatchim(w) ? '이' : '가');

const sgn = (n) => `${n >= 0 ? '+' : '-'}${Math.abs(n).toFixed(2)}`;

/** history: id 배열(오래된 → 최신), 또는 { id } / { menu:{id} } 객체 배열. → Map(id → age) (0 = 가장 최근) */
function historyAges(history) {
  const ages = new Map();
  if (!Array.isArray(history)) return ages;
  const ids = history.map((h) => (typeof h === 'string' ? h : h && (h.id ?? (h.menu && h.menu.id)))).filter(Boolean);
  for (let i = ids.length - 1, age = 0; i >= 0; i--, age++) if (!ages.has(ids[i])) ages.set(ids[i], age);
  return ages;
}

// ---- 메뉴 분석 / 가중치 정규화 -----------------------------------------------
/**
 * 메뉴 → { terms: Map(표준용어 → { kind:'ingredient'|'tag'|'group', via:Set }), nameKey }
 * 재료·태그는 표준명으로 정규화하고, 소속 분류(group)도 terms에 넣는다.
 */
export function analyzeMenu(menu, lexicon = getLexicon()) {
  const terms = new Map();
  const add = (name, kind, via) => {
    if (!name) return;
    const cur = terms.get(name);
    if (!cur) terms.set(name, { kind, via: new Set(via ? [via] : []) });
    else {
      if (cur.kind === 'group' && kind !== 'group') cur.kind = kind;
      if (via) cur.via.add(via);
    }
  };
  const addTerm = (raw, kind) => {
    const name = lexicon.canon(raw);
    if (!name) return;
    add(name, kind);
    for (const g of lexicon.groupsOf(name)) if (g !== name) add(g, 'group', name);
  };
  for (const i of menu.ingredients || []) addTerm(i, 'ingredient');
  for (const t of menu.tags || []) addTerm(t, 'tag');
  for (const g of lexicon.groupsOfCuisine(menu.cuisine)) add(g, 'group', null);
  return { terms, nameKey: normKey(menu.name || ''), id: menu.id };
}

/** weights(객체/Map) → Map(표준키 → 클램프된 값). 동의어 키는 같은 표준키로 합쳐지고 뒤의 것이 이긴다. 0/비수치는 무시 */
function normalizeWeights(weights, lexicon) {
  const out = new Map();
  if (!weights) return out;
  const entries = weights instanceof Map ? [...weights] : Object.entries(weights);
  for (const [k, v] of entries) {
    const num = Number(v);
    if (!Number.isFinite(num) || num === 0) continue;
    const { name } = resolveTerm(k, lexicon);
    if (!name) continue;
    out.set(name, Math.max(-2, Math.min(2, num)));
  }
  return out;
}

function normalizeExclude(exclude, lexicon) {
  const out = new Set();
  if (!exclude) return out;
  for (const k of exclude instanceof Set || Array.isArray(exclude) ? exclude : [exclude]) {
    const { name } = resolveTerm(k, lexicon);
    if (name) out.add(name);
  }
  return out;
}

/** 키가 메뉴에 해당하는지. { kind:'ingredient'|'tag'|'group'|'name', via } 또는 null */
function matchKey(info, key, lexicon) {
  const hit = info.terms.get(key);
  if (hit) return { kind: hit.kind, via: [...hit.via] };
  const k = normKey(key);
  if (!k) return null;
  if (k === info.nameKey || k === normKey(info.id || '')) return { kind: 'name', via: [] };
  // 사전에 없는 용어는 메뉴명 부분 일치(예: '파스타' → '까르보나라 파스타')
  if (!lexicon.isKnown(key) && k.length >= 2 && info.nameKey.includes(k)) return { kind: 'name', via: [] };
  return null;
}

function describeHit(match, key, w, bonus) {
  const strong = Math.abs(w) >= 2;
  const pos = w > 0;
  const stance = `${strong ? '강한 ' : ''}${pos ? '선호' : '비선호'}`;
  const tail = `${pos ? '가점' : '감점'} (${sgn(bonus)})`;
  switch (match.kind) {
    case 'ingredient':
      return `${stance} 재료 '${key}'${iga(key)} 들어 있어 ${tail}`;
    case 'group': {
      const via = match.via.length ? `(${match.via.slice(0, 3).join(', ')}${match.via.length > 3 ? ' 등' : ''})` : '';
      return `${stance} 분류 '${key}'${via}에 해당해 ${tail}`;
    }
    case 'tag':
      return `${stance} 특징 '${key}'에 해당해 ${tail}`;
    default:
      return `${stance} 항목 '${key}'에 해당해 ${tail}`;
  }
}

// ---- recommend --------------------------------------------------------------
/**
 * @param {object} p
 * @param {Float32Array|number[]} [p.queryVec]  질문 임베딩(없으면 sim=0, 가중치/필터만 반영)
 * @param {object[]} p.menus                     메뉴 배열(vec 포함: {q,scale} | 배열 | base64)
 * @param {string[]} [p.cuisines]                허용 cuisine(비면 전체)
 * @param {object|Map} [p.weights]               { 키: -2..+2 } (키는 동의어/분류명/태그/메뉴명 가능)
 * @param {Set|string[]} [p.exclude]             하드 제외 키(재료/태그/분류/메뉴명)
 * @param {number} [p.topN=10]                   Infinity 가능
 * @param {number|string} [p.seed]               동점 정렬을 재현 가능하게 섞는 seed(미지정이면 id 순)
 * @param {Array} [p.history]                    최근 추천 id 배열(오래된→최신). 약한 감점 적용
 * @param {number} [p.weightScale]               weight 1 단위 점수(기본 DEFAULT_WEIGHT_SCALE=1)
 * @param {number} [p.historyPenalty]            기본 DEFAULT_HISTORY_PENALTY
 * @param {object} [p.lexicon]                   기본: setDictionaries로 주입한 전역 사전
 */
export function recommend({
  queryVec,
  menus,
  cuisines,
  weights,
  exclude,
  topN = 10,
  seed,
  history,
  weightScale = DEFAULT_WEIGHT_SCALE,
  historyPenalty = DEFAULT_HISTORY_PENALTY,
  lexicon = getLexicon(),
} = {}) {
  const list = Array.isArray(menus) ? menus : [];
  const cuisineSet = Array.isArray(cuisines) && cuisines.length ? new Set(cuisines) : null;
  const w = normalizeWeights(weights, lexicon);
  const ex = normalizeExclude(exclude, lexicon);
  const ages = historyAges(history);
  const hasQuery = isVecLike(queryVec) && queryVec.length > 0 && normOf(queryVec) > 0;
  const limit = Number.isFinite(topN) ? Math.max(0, Math.floor(topN)) : topN === Infinity ? Infinity : 10;

  const rows = [];
  for (const menu of list) {
    if (!menu) continue;
    if (cuisineSet && !cuisineSet.has(menu.cuisine)) continue;
    const info = analyzeMenu(menu, lexicon);

    let excluded = false;
    for (const key of ex) {
      if (matchKey(info, key, lexicon)) {
        excluded = true;
        break;
      }
    }
    if (excluded) continue;

    const reasons = [];
    let sim = 0;
    const mv = hasQuery ? rawVecOf(menu) : null;
    const s = mv ? cosineSimilarity(queryVec, mv) : null;
    if (s !== null) {
      sim = s;
      reasons.push(`질문과의 의미 유사도 ${sim.toFixed(2)}`);
    } else if (hasQuery) {
      reasons.push('이 메뉴는 벡터 정보가 없어 유사도를 반영하지 못했어요');
    }

    let bonus = 0;
    for (const [key, weight] of w) {
      const m = matchKey(info, key, lexicon);
      if (!m) continue;
      const b = weight * weightScale;
      bonus += b;
      reasons.push(describeHit(m, key, weight, b));
    }

    const age = ages.get(menu.id);
    if (age !== undefined && historyPenalty) {
      const pen = historyPenalty * Math.pow(HISTORY_DECAY, age);
      bonus -= pen;
      reasons.push(`최근에 추천했던 메뉴라 순위를 조금 낮췄어요 (${sgn(-pen)})`);
    }

    rows.push({ menu, score: sim + bonus, sim, bonus, reasons, _tie: seed === undefined ? String(menu.id ?? '') : hashString(`${seed}|${menu.id}`) });
  }

  rows.sort((a, b) => {
    if (Math.abs(b.score - a.score) > 1e-12) return b.score - a.score;
    if (Math.abs(b.sim - a.sim) > 1e-12) return b.sim - a.sim;
    return typeof a._tie === 'number' ? a._tie - b._tie : a._tie < b._tie ? -1 : a._tie > b._tie ? 1 : 0;
  });
  return rows.slice(0, limit).map(({ menu, score, sim, bonus, reasons }) => ({ menu, score, sim, bonus, reasons }));
}

// ---- rerollPick -------------------------------------------------------------
/**
 * 상위권에서 가중 랜덤으로 k개 선택(중복 없음). 항상 배열을 반환한다(결과 렌더 형태와 동일한 원소).
 * 확률 ∝ exp((score - 최고점) / temperature) × (history 재추천 억제 배율)
 * @param {Array} ranked      recommend() 결과(점수 내림차순)
 * @param {object} [o]
 * @param {number|string} [o.seed]       같은 seed + 같은 입력 → 같은 결과
 * @param {Function} [o.rng]             직접 난수 함수 주입(seed보다 우선)
 * @param {number} [o.k=1]
 * @param {number} [o.temperature=0.05]  클수록 균등에 가까움. 0 이하면 결정적(최고점부터, history 항목은 뒤로)
 * @param {number} [o.pool=10]           상위 몇 개 중에서 뽑을지(최소 k)
 * @param {Array}  [o.history]           직전 추천 id 배열(오래된→최신). 최근일수록 확률을 크게 낮춤
 * @param {number} [o.repeatFactor=0.1]  가장 최근 추천 메뉴의 확률 배율(오래될수록 1에 수렴)
 */
export function rerollPick(ranked, { seed, rng, k = 1, temperature = 0.05, pool = 10, history, repeatFactor = 0.1 } = {}) {
  const arr = Array.isArray(ranked) ? ranked : [];
  const want = Math.max(0, Math.floor(Number.isFinite(k) ? k : 1));
  const size = Math.max(want, Math.floor(Number.isFinite(pool) ? pool : 10));
  const cand = arr.slice(0, size);
  if (!want || !cand.length) return [];
  const rand = typeof rng === 'function' ? rng : createRng(seed);
  const ages = historyAges(history);
  const rf = Math.max(0, Math.min(1, repeatFactor));
  const scoreOf = (r) => (Number.isFinite(r && r.score) ? r.score : 0);
  const factorOf = (r) => {
    const id = r && r.menu && r.menu.id;
    const age = ages.get(id);
    return age === undefined ? 1 : 1 - (1 - rf) * Math.pow(HISTORY_DECAY, age);
  };

  const pickedOut = [];
  const pool2 = cand.map((r, i) => ({ r, i }));
  const T = Number(temperature);

  if (!(T > 0)) {
    // 결정적: 최근 추천은 뒤로, 그 안에서 점수순
    pool2.sort((a, b) => {
      const fa = factorOf(a.r) < 1 ? 1 : 0;
      const fb = factorOf(b.r) < 1 ? 1 : 0;
      return fa - fb || scoreOf(b.r) - scoreOf(a.r) || a.i - b.i;
    });
    return pool2.slice(0, want).map((x) => x.r);
  }

  const max = Math.max(...cand.map(scoreOf));
  while (pickedOut.length < want && pool2.length) {
    const ws = pool2.map(({ r }) => Math.exp((scoreOf(r) - max) / T) * factorOf(r));
    const total = ws.reduce((a, b) => a + b, 0);
    let idx;
    if (!(total > 0)) idx = Math.floor(rand() * pool2.length);
    else {
      let x = rand() * total;
      idx = 0;
      for (; idx < ws.length - 1; idx++) {
        x -= ws[idx];
        if (x < 0) break;
      }
    }
    pickedOut.push(pool2[idx].r);
    pool2.splice(idx, 1);
  }
  return pickedOut;
}
