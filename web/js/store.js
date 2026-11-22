// store.js - 저장소 API (C 소유). 순수 ES Module, 번들러 없음.
//
//  - 기본 메뉴(web/menus.json, 빌드 산출물)와 브라우저에 저장된 "내 메뉴"를 병합해 돌려준다.
//  - 내 메뉴는 IndexedDB(기본) 또는 localStorage(폴백), 둘 다 안 되면 메모리에만 보관한다.
//  - 기본 데이터는 읽기 전용이다. 내 메뉴는 별도 저장소에 있고, id 에 `-my-` 네임스페이스를 붙여
//    (예: kr-my-lq3k9x2a) 이후 기본 데이터가 갱신/추가돼도 충돌하거나 덮이지 않는다.
//  - 이 파일은 메뉴 스키마 검증 로직(validateMenu 등)의 단일 소스이기도 하다.
//    scripts/validate.mjs, scripts/merge.mjs, scripts/issue-to-menu.mjs 가 Node 에서 import 한다.
//    (그래서 최상위에서 브라우저 전역(window/document/indexedDB)을 건드리지 않는다.)
//
// 벡터 규약: 내 메뉴의 vec 은 "호출측이 채워서" 전달한다(addUser/updateUser).
//   - 저장 시 vec 형태는 검증만 느슨하게 한다(숫자 배열, 또는 숫자/숫자배열을 값으로 갖는 단순 객체).
//   - 텍스트 필드(name/cuisine/ingredients/tags/desc)를 바꾸는 updateUser 에 vec 이 없으면 낡은 vec 을
//     버린다. getAll() 결과에서 vec 이 없는 source:"user" 항목은 다시 임베딩해야 한다.
//   - exportJson 은 vec 을 내보내지 않고, importJson 은 vec 을 받지 않는다(모델 변경 시 오염 방지).
//     importJson 결과의 needsEmbedding 에 재임베딩이 필요한 id 목록이 담긴다.

// ---------------------------------------------------------------------------
// 스키마 상수
// ---------------------------------------------------------------------------
export const CUISINES = Object.freeze([
  'korean', 'northkorean', 'western', 'chinese', 'japanese', 'vietnamese', 'mexican',
  'thai', 'indian', 'fusion', 'snack', 'cafe', 'other',
]);

/** id 접두어(cuisine 약자). E 크롤러(scripts/crawl/lib.mjs)와 동일. */
export const CUISINE_ABBR = Object.freeze({
  korean: 'kr', northkorean: 'nk', western: 'we', chinese: 'cn', japanese: 'jp', vietnamese: 'vn', mexican: 'mx',
  thai: 'th', indian: 'in', fusion: 'fu', snack: 'sn', cafe: 'cf', other: 'ot',
});

export const SOURCES = Object.freeze(['curated', 'wikidata', 'wikipedia', 'recipe-db', 'franchise', 'user']);

/** 병합 시 소스 우선순위(앞쪽이 우선). */
export const SOURCE_PRIORITY = Object.freeze(['curated', 'franchise', 'recipe-db', 'wikipedia', 'wikidata', 'user']);

export const LIMITS = Object.freeze({
  id: 64,
  name: 30,
  ingredients: 20, ingredient: 20,
  tags: 15, tag: 16,
  descMin: 10, desc: 300,
  brand: 24,
  attribution: 200,
  vecLength: 4096,
});

// cuisineInferred/cuisineConfidence: 임베딩 kNN으로 종류를 추정한 항목 표시(scripts/infer-cuisine.mjs). UI에서 "추정" 배지로 쓴다.
const BASE_FIELDS = ['id', 'name', 'cuisine', 'ingredients', 'tags', 'desc', 'source', 'brand', 'attribution', 'cuisineInferred', 'cuisineConfidence'];
const VEC_FIELDS = ['vec', 'scale'];

const ID_RE = /^[a-z]{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const USER_ID_RE = /^[a-z]{2}-my-[a-z0-9]+(?:-[a-z0-9]+)*$/;

// 제어문자, 보이지 않는 문자, 양방향 제어 문자
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/;
// 마크업/템플릿/셸 보간 위험 문자
const DANGEROUS_RE = /[<>`\\$]|\{\{|\}\}/;
const URL_RE = /(?:https?:\/\/|ftp:\/\/|www\.|javascript:|data:text|\b[a-z0-9-]+\.(?:com|net|org|io|kr|co|me|xyz|info|biz)\b)/i;

// 간단한 금칙어(욕설/성적/도박/스팸). 한글은 공백·기호를 제거한 뒤 부분 일치, 영문은 단어 경계.
// "씹다/씹히는" 같은 식감 표현, "알 포르노(al forno)" 같은 외래어 표기는 오탐이라 일부러 뺐다.
const BANNED_KO = [
  '시발', '씨발', '씨팔', '병신', '지랄', '좆', '존나', '개새끼', '썅', '미친놈', '미친년', '느금',
  'ㅅㅂ', 'ㅂㅅ', 'ㅈㄹ', '섹스', '야동', '카지노', '토토사이트', '바카라', '도박사이트',
  '대출문의', '카톡문의', '텔레그램',
];
const BANNED_EN_RE = /\b(?:fuck(?:ing|er|ed)?|shit(?:s|ty)?|bitch(?:es)?|asshole|porn(?:o|hub)?|casino|nigg(?:a|er)s?|cunt|slut|whore)\b/i;

// ---------------------------------------------------------------------------
// 문자열 유틸
// ---------------------------------------------------------------------------
const cpLen = (s) => Array.from(s).length;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** 공백 정리(NFC, 연속 공백 → 1칸, trim). 줄바꿈/탭도 공백으로 취급. */
export function cleanText(s) {
  return String(s ?? '').normalize('NFC').replace(/[\t\r\n 　]+/g, ' ').replace(/ {2,}/g, ' ').trim();
}

/** 중복 판정용 키: 소문자, 공백/기호 제거, NFKC. brand 가 있으면 함께 구분한다. */
export function nameKey(name, brand = '') {
  const norm = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  const b = norm(brand);
  return b ? `${b}|${norm(name)}` : norm(name);
}

/** 금칙어/URL/위험 문자 검사. 문제 없으면 null, 있으면 사유 문자열. */
export function checkText(value, { allowUrl = false } = {}) {
  const s = String(value ?? '');
  if (CONTROL_RE.test(s)) return '제어문자 또는 보이지 않는 문자가 있습니다';
  if (DANGEROUS_RE.test(s)) return '허용되지 않는 문자(< > ` \\ $ {{ 등)가 있습니다';
  if (!allowUrl && URL_RE.test(s)) return 'URL/도메인은 넣을 수 없습니다';
  const squeezed = s.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  for (const w of BANNED_KO) if (squeezed.includes(w)) return '부적절한 표현이 포함되어 있습니다';
  if (BANNED_EN_RE.test(s.normalize('NFKC'))) return '부적절한 표현이 포함되어 있습니다';
  return null;
}

function isVecShape(v) {
  const okNums = (a) => Array.isArray(a) && a.length > 0 && a.length <= LIMITS.vecLength && a.every((x) => Number.isFinite(x));
  if (okNums(v)) return true;
  if (!isPlainObject(v)) return false;
  const keys = Object.keys(v);
  if (keys.length === 0 || keys.length > 8) return false;
  return keys.every((k) => Number.isFinite(v[k]) || okNums(v[k]));
}

function toPlainVec(v) {
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) return Array.from(v);
  if (isPlainObject(v)) {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = ArrayBuffer.isView(x) ? Array.from(x) : x;
    return o;
  }
  return v;
}

// ---------------------------------------------------------------------------
// 스키마 검증
// ---------------------------------------------------------------------------
/**
 * 메뉴 한 건 검증 + 정규화.
 * @param {object} menu
 * @param {object} [opts]
 * @param {boolean} [opts.strict=true]  true: 큐레이션 기준(재료 1+, 태그 2+, desc 10자+, 중복·미정의 필드 불가).
 *                                       false: 크롤러/사용자 기준(배열 비어도 됨, desc 비어도 됨, 미정의 필드는 무시).
 * @param {boolean} [opts.allowVec=false] vec/scale 허용(web/menus.json, 사용자 메뉴).
 * @param {boolean} [opts.fillDefaults=false] 누락된 ingredients/tags/desc 를 빈 값으로 채움(strict=false 에서만 의미).
 * @param {boolean} [opts.checkIdPrefix=true] id 접두어가 cuisine 약자와 일치하는지.
 * @param {boolean} [opts.requireId=true] id 필수 여부(false 면 id 없어도 통과, 있으면 검사).
 * @returns {{ ok: boolean, errors: string[], menu: object|null }} 정규화된 메뉴(ok 일 때만 non-null)
 */
export function validateMenu(menu, opts = {}) {
  const { strict = true, allowVec = false, fillDefaults = false, checkIdPrefix = true, requireId = true } = opts;
  const errors = [];
  const err = (m) => errors.push(m);

  if (!isPlainObject(menu)) return { ok: false, errors: ['메뉴는 객체여야 합니다'], menu: null };

  const allowed = new Set(allowVec ? [...BASE_FIELDS, ...VEC_FIELDS] : BASE_FIELDS);
  if (strict) {
    for (const k of Object.keys(menu)) if (!allowed.has(k)) err(`허용되지 않은 필드: ${k}`);
  }

  // --- 문자열 필드
  const str = (key, { required = false, max, min = 0, label = key } = {}) => {
    const raw = menu[key];
    if (raw === undefined || raw === null) { if (required) err(`${label}: 필수`); return undefined; }
    if (typeof raw !== 'string') { err(`${label}: 문자열이어야 합니다`); return undefined; }
    const v = cleanText(raw);
    const n = cpLen(v);
    if (n < min || (required && n === 0)) err(`${label}: 너무 짧습니다(최소 ${Math.max(min, 1)}자)`);
    if (n > max) err(`${label}: 너무 깁니다(최대 ${max}자)`);
    return v;
  };

  const name = str('name', { required: true, max: LIMITS.name });
  if (name && !/[\p{L}\p{N}]/u.test(name)) err('name: 글자나 숫자가 있어야 합니다');

  const cuisine = menu.cuisine;
  if (!CUISINES.includes(cuisine)) err(`cuisine: 허용값이 아닙니다(${CUISINES.join(', ')})`);

  const source = menu.source;
  if (!SOURCES.includes(source)) err(`source: 허용값이 아닙니다(${SOURCES.join(', ')})`);

  let id = menu.id;
  if (id === undefined || id === null) {
    if (requireId) err('id: 필수');
  } else if (typeof id !== 'string' || id.length > LIMITS.id || !ID_RE.test(id)) {
    err('id: 형식 오류(소문자/숫자/하이픈, "<2글자 약자>-<slug>", 최대 64자)');
  } else if (checkIdPrefix && CUISINES.includes(cuisine) && !id.startsWith(`${CUISINE_ABBR[cuisine]}-`)) {
    err(`id: cuisine "${cuisine}" 의 접두어는 "${CUISINE_ABBR[cuisine]}-" 여야 합니다`);
  }

  const brand = str('brand', { max: LIMITS.brand });
  if (source === 'franchise' && !brand) err('brand: franchise 소스는 brand 가 필요합니다');
  if (brand === '' && strict) err('brand: 비어 있으면 필드를 빼세요');

  const attribution = str('attribution', { max: LIMITS.attribution });
  if ((source === 'wikipedia' || source === 'wikidata') && !attribution) err('attribution: Wikipedia/Wikidata 유래 항목은 필수');

  let cuisineInferred;
  if (menu.cuisineInferred !== undefined && menu.cuisineInferred !== null) {
    if (typeof menu.cuisineInferred !== 'boolean') err('cuisineInferred: true/false 여야 합니다');
    else cuisineInferred = menu.cuisineInferred;
  }
  let cuisineConfidence;
  if (menu.cuisineConfidence !== undefined && menu.cuisineConfidence !== null) {
    if (typeof menu.cuisineConfidence !== 'number' || !(menu.cuisineConfidence >= 0 && menu.cuisineConfidence <= 1)) err('cuisineConfidence: 0~1 숫자여야 합니다');
    else cuisineConfidence = Math.round(menu.cuisineConfidence * 1000) / 1000;
  }

  // --- 배열 필드
  const arr = (key, { max, itemMax, minItems, label }) => {
    let raw = menu[key];
    if (raw === undefined || raw === null) {
      if (fillDefaults && !strict) return [];
      err(`${label}: 필수(배열)`);
      return [];
    }
    if (!Array.isArray(raw)) { err(`${label}: 배열이어야 합니다`); return []; }
    if (raw.length > max * 4) { err(`${label}: 항목이 너무 많습니다(최대 ${max}개)`); return []; }
    const out = [];
    const seen = new Set();
    raw.forEach((x, i) => {
      if (typeof x !== 'string') { err(`${label}[${i}]: 문자열이어야 합니다`); return; }
      const v = cleanText(x);
      if (!v) { if (strict) err(`${label}[${i}]: 비어 있습니다`); return; }
      if (cpLen(v) > itemMax) { if (strict) err(`${label}[${i}]: 너무 깁니다(최대 ${itemMax}자)`); return; }
      if (seen.has(v)) { if (strict) err(`${label}[${i}]: 중복("${v}")`); return; }
      seen.add(v);
      out.push(v);
    });
    if (out.length > max) {
      if (strict) err(`${label}: 항목이 너무 많습니다(최대 ${max}개)`);
      else out.length = max;
    }
    if (out.length < minItems) err(`${label}: 최소 ${minItems}개 필요`);
    return out;
  };
  const ingredients = arr('ingredients', { max: LIMITS.ingredients, itemMax: LIMITS.ingredient, minItems: strict ? 1 : 0, label: 'ingredients' });
  const tags = arr('tags', { max: LIMITS.tags, itemMax: LIMITS.tag, minItems: strict ? 2 : 0, label: 'tags' });

  // desc: strict 는 필수(최소 길이), lenient 는 비어 있어도 됨
  let desc = menu.desc;
  if (desc === undefined || desc === null) {
    if (strict || !fillDefaults) err('desc: 필수');
    desc = '';
  } else if (typeof desc !== 'string') {
    err('desc: 문자열이어야 합니다');
    desc = '';
  } else {
    desc = cleanText(desc);
    const n = cpLen(desc);
    if (strict && n < LIMITS.descMin) err(`desc: 너무 짧습니다(최소 ${LIMITS.descMin}자)`);
    if (n > LIMITS.desc) {
      if (strict) err(`desc: 너무 깁니다(최대 ${LIMITS.desc}자)`);
      else desc = Array.from(desc).slice(0, LIMITS.desc - 1).join('') + '…';
    }
  }

  // --- 금칙어/위험 문자
  const textChecks = [['name', name], ['desc', desc], ['brand', brand]];
  ingredients.forEach((v, i) => textChecks.push([`ingredients[${i}]`, v]));
  tags.forEach((v, i) => textChecks.push([`tags[${i}]`, v]));
  for (const [label, v] of textChecks) {
    if (!v) continue;
    const bad = checkText(v);
    if (bad) err(`${label}: ${bad}`);
  }
  if (attribution) {
    const bad = checkText(attribution, { allowUrl: true });
    if (bad) err(`attribution: ${bad}`);
  }

  // --- 벡터
  const out = {};
  if (menu.vec !== undefined && menu.vec !== null) {
    if (!allowVec) {
      if (strict) { /* 위의 미정의 필드 오류로 이미 보고됨 */ }
    } else {
      const vec = toPlainVec(menu.vec);
      if (!isVecShape(vec)) err('vec: 숫자 배열(또는 숫자 배열을 담은 단순 객체)이어야 합니다');
      else out.vec = vec;
      if (menu.scale !== undefined && menu.scale !== null) {
        if (!Number.isFinite(menu.scale)) err('scale: 숫자여야 합니다');
        else out.scale = menu.scale;
      }
    }
  }

  if (errors.length) return { ok: false, errors, menu: null };

  const clean = { id, name, cuisine, ingredients, tags, desc, source };
  if (id === undefined) delete clean.id;
  if (brand) clean.brand = brand;
  if (attribution) clean.attribution = attribution;
  if (cuisineInferred) { clean.cuisineInferred = true; if (cuisineConfidence !== undefined) clean.cuisineConfidence = cuisineConfidence; }
  Object.assign(clean, out);
  return { ok: true, errors: [], menu: clean };
}

/**
 * 메뉴 배열 검증 + 전체 id/이름 중복 검사.
 * @returns {{ ok: boolean, results: Array<{index:number, id?:string, errors:string[]}>, menus: object[], globalErrors: string[] }}
 */
export function validateMenus(list, opts = {}) {
  const results = [];
  const menus = [];
  const globalErrors = [];
  if (!Array.isArray(list)) return { ok: false, results, menus, globalErrors: ['최상위 값은 배열이어야 합니다'] };
  const ids = new Map();
  const names = new Map();
  list.forEach((m, index) => {
    const r = validateMenu(m, opts);
    const errors = [...r.errors];
    if (r.ok) {
      const clean = r.menu;
      if (clean.id !== undefined) {
        if (ids.has(clean.id)) errors.push(`id 중복: "${clean.id}" (index ${ids.get(clean.id)} 와 동일)`);
        else ids.set(clean.id, index);
      }
      const k = nameKey(clean.name, clean.brand);
      if (opts.uniqueNames !== false) {
        if (names.has(k)) errors.push(`이름 중복: "${clean.name}"${clean.brand ? ` (${clean.brand})` : ''} (index ${names.get(k)} 와 동일)`);
        else names.set(k, index);
      }
      if (!errors.length) menus.push(clean);
    }
    if (errors.length) results.push({ index, id: m && typeof m === 'object' ? m.id : undefined, errors });
  });
  return { ok: results.length === 0 && globalErrors.length === 0, results, menus, globalErrors };
}

// ---------------------------------------------------------------------------
// 내 메뉴 저장 백엔드: IndexedDB -> localStorage -> 메모리
// ---------------------------------------------------------------------------
const DB_NAME = 'menusuggestion';
const DB_VERSION = 1;
const STORE = 'userMenus';
const LS_KEY = 'menusuggestion.userMenus.v1';
const OPEN_TIMEOUT_MS = 4000;

function openIdb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined' || !indexedDB) { reject(new Error('indexedDB 없음')); return; }
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { reject(e); return; }
    const timer = setTimeout(() => reject(new Error('indexedDB 열기 시간 초과')), OPEN_TIMEOUT_MS);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => { clearTimeout(timer); resolve(req.result); };
    req.onerror = () => { clearTimeout(timer); reject(req.error || new Error('indexedDB 오류')); };
    req.onblocked = () => { clearTimeout(timer); reject(new Error('indexedDB 차단됨')); };
  });
}

function idbRun(db, mode, fn) {
  return new Promise((resolve, reject) => {
    let t;
    try { t = db.transaction(STORE, mode); } catch (e) { reject(e); return; }
    let req;
    try { req = fn(t.objectStore(STORE)); } catch (e) { try { t.abort(); } catch { /* 무시 */ } reject(e); return; }
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error || (req && req.error) || new Error('트랜잭션 오류'));
    t.onabort = () => reject(t.error || new Error('트랜잭션 중단'));
  });
}

async function createIdbBackend() {
  const db = await openIdb();
  // 다른 탭이 버전을 올리거나 연결이 닫히면 다음 호출에서 다시 연다.
  db.onversionchange = () => { db.close(); backendPromise = null; };
  db.onclose = () => { backendPromise = null; };
  const backend = {
    name: 'indexeddb',
    all: () => idbRun(db, 'readonly', (s) => s.getAll()),
    get: (id) => idbRun(db, 'readonly', (s) => s.get(id)),
    putMany: (menus, { replace = false } = {}) => idbRun(db, 'readwrite', (s) => {
      if (replace) s.clear();
      let last;
      for (const m of menus) last = s.put(m);
      return last;
    }),
    remove: (id) => idbRun(db, 'readwrite', (s) => s.delete(id)),
  };
  await backend.all(); // 실제로 읽힐 수 있는지 확인(사파리 프라이빗 모드 등)
  return backend;
}

function lsAvailable() {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return false;
    const k = `${LS_KEY}.probe`;
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return true;
  } catch { return false; }
}

function createLocalStorageBackend() {
  const read = () => {
    try {
      const v = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
      return Array.isArray(v) ? v.filter((m) => isPlainObject(m) && typeof m.id === 'string') : [];
    } catch { return []; }
  };
  const write = (list) => { localStorage.setItem(LS_KEY, JSON.stringify(list)); };
  return {
    name: 'localstorage',
    all: async () => read(),
    get: async (id) => read().find((m) => m.id === id),
    putMany: async (menus, { replace = false } = {}) => {
      const map = new Map((replace ? [] : read()).map((m) => [m.id, m]));
      for (const m of menus) map.set(m.id, m);
      write([...map.values()]);
    },
    remove: async (id) => { write(read().filter((m) => m.id !== id)); },
  };
}

function createMemoryBackend() {
  const map = new Map();
  return {
    name: 'memory',
    all: async () => [...map.values()].map((m) => structuredCloneSafe(m)),
    get: async (id) => (map.has(id) ? structuredCloneSafe(map.get(id)) : undefined),
    putMany: async (menus, { replace = false } = {}) => {
      if (replace) map.clear();
      for (const m of menus) map.set(m.id, structuredCloneSafe(m));
    },
    remove: async (id) => { map.delete(id); },
  };
}

function structuredCloneSafe(v) { return JSON.parse(JSON.stringify(v)); }

let backendPromise = null;
function getBackend() {
  if (!backendPromise) {
    backendPromise = (async () => {
      try { return await createIdbBackend(); } catch (e) {
        if (typeof console !== 'undefined') console.warn('[store] IndexedDB 사용 불가, 폴백 사용:', e && e.message);
      }
      if (lsAvailable()) return createLocalStorageBackend();
      if (typeof console !== 'undefined') console.warn('[store] localStorage 도 사용 불가: 이번 세션에만 저장됩니다');
      return createMemoryBackend();
    })();
  }
  return backendPromise;
}

/** 현재 사용 중인 저장 백엔드 이름: 'indexeddb' | 'localstorage' | 'memory' */
export async function getBackendName() { return (await getBackend()).name; }

// ---------------------------------------------------------------------------
// id 생성 / 내 메뉴 정규화
// ---------------------------------------------------------------------------
function randomToken(len = 8) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let bytes;
  try {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) bytes = crypto.getRandomValues(new Uint8Array(len));
  } catch { /* 무시 */ }
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[(bytes ? bytes[i] : Math.floor(Math.random() * 256)) % alphabet.length];
  return out;
}

export function generateUserId(cuisine) {
  const abbr = CUISINE_ABBR[cuisine] || CUISINE_ABBR.other;
  return `${abbr}-my-${Date.now().toString(36)}${randomToken(4)}`;
}

// 내 메뉴: 느슨한 기준(태그/설명 비어도 됨). id 는 -my- 네임스페이스라 cuisine 접두어 일치는 요구하지 않는다.
const USER_OPTS = { strict: false, allowVec: true, fillDefaults: true, checkIdPrefix: false };

function prepareUserMenu(input, { id } = {}) {
  const draft = { ...input, source: 'user' };
  if (id) draft.id = id;
  else if (typeof draft.id !== 'string' || !USER_ID_RE.test(draft.id)) {
    draft.id = generateUserId(CUISINES.includes(draft.cuisine) ? draft.cuisine : 'other');
  }
  const r = validateMenu(draft, USER_OPTS);
  if (!r.ok) {
    const e = new Error(`메뉴 검증 실패: ${r.errors.join('; ')}`);
    e.code = 'INVALID_MENU';
    e.errors = r.errors;
    throw e;
  }
  return r.menu;
}

// ---------------------------------------------------------------------------
// 기본 메뉴 로드(web/menus.json)
// ---------------------------------------------------------------------------
const DEFAULT_BASE_URL = (() => {
  try { return new URL('../menus.json', import.meta.url).href; } catch { return '../menus.json'; }
})();
const baseCache = new Map(); // url -> Promise<menu[]>
let lastBaseError = null;

async function loadBase(url, { refresh = false, fetchImpl } = {}) {
  if (!refresh && baseCache.has(url)) return baseCache.get(url);
  const p = (async () => {
    const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!f) throw new Error('fetch 를 사용할 수 없습니다');
    const res = await f(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`기본 메뉴 로드 실패: HTTP ${res.status}`);
    const data = await res.json();
    const list = Array.isArray(data) ? data : (data && Array.isArray(data.menus) ? data.menus : null);
    if (!list) throw new Error('기본 메뉴 형식 오류(배열 또는 {menus:[...]} 이어야 함)');
    return list.filter((m) => isPlainObject(m) && typeof m.id === 'string' && typeof m.name === 'string');
  })();
  baseCache.set(url, p);
  try { return await p; } catch (e) { baseCache.delete(url); throw e; }
}

// ---------------------------------------------------------------------------
// 공개 API
// ---------------------------------------------------------------------------
/**
 * 기본 menus.json 과 내 메뉴를 병합해 돌려준다(내 메뉴는 source:"user").
 * 기본 데이터를 못 읽어도(오프라인 등) 내 메뉴는 돌려주고, 원인은 getStatus().baseError 로 확인한다.
 * @param {{ baseUrl?: string, refresh?: boolean, fetchImpl?: Function }} [options]
 *   baseUrl: 기본 메뉴 URL(기본 '../menus.json' = web/menus.json). 목업 모드는 '../mock/menus.mock.json' 등을 넘긴다.
 *   refresh: true 면 기본 메뉴를 다시 받는다(기본은 첫 로드 결과를 캐시).
 */
export async function getAll(options = {}) {
  const url = options.baseUrl || DEFAULT_BASE_URL;
  let base = [];
  try {
    base = await loadBase(url, options);
    lastBaseError = null;
  } catch (e) {
    lastBaseError = e;
    if (typeof console !== 'undefined') console.warn('[store] 기본 메뉴를 불러오지 못했습니다:', e && e.message);
  }
  const user = await listUser();
  const seen = new Set(base.map((m) => m.id));
  const merged = base.slice();
  for (const m of user) {
    if (seen.has(m.id)) { // 사실상 발생하지 않음(-my- 네임스페이스). 기본 데이터가 우선.
      if (typeof console !== 'undefined') console.warn('[store] id 충돌로 내 메뉴 숨김:', m.id);
      continue;
    }
    seen.add(m.id);
    merged.push(m);
  }
  return merged;
}

/** 내 메뉴만 돌려준다. */
export async function listUser() {
  const backend = await getBackend();
  const rows = await backend.all();
  return rows
    .filter((m) => isPlainObject(m) && typeof m.id === 'string')
    .map((m) => ({ ...m, source: 'user' }));
}

/** 상태 정보(UI 안내용). */
export async function getStatus() {
  const backend = await getBackend();
  return {
    backend: backend.name,
    persistent: backend.name !== 'memory',
    baseError: lastBaseError ? String(lastBaseError.message || lastBaseError) : null,
  };
}

/**
 * 내 메뉴 추가. 스키마 검증 후 저장하고 저장된 메뉴(id 포함)를 돌려준다.
 * id 를 주지 않거나 내 메뉴 네임스페이스(`<약자>-my-...`)가 아니면 새로 만든다.
 * 벡터(vec)는 호출측이 임베딩해서 menu.vec 로 전달한다(없으면 나중에 updateUser 로 채운다).
 */
export async function addUser(menu) {
  const clean = prepareUserMenu(menu);
  const backend = await getBackend();
  if (await backend.get(clean.id)) {
    const e = new Error(`이미 존재하는 id: ${clean.id}`);
    e.code = 'DUPLICATE_ID';
    throw e;
  }
  await backend.putMany([clean]);
  return clean;
}

const CONTENT_FIELDS = ['name', 'cuisine', 'ingredients', 'tags', 'desc'];

/**
 * 내 메뉴 수정(부분 패치). id/source 는 바꿀 수 없다.
 * 내용 필드가 바뀌었는데 patch 에 vec 이 없으면 낡은 vec 을 제거한다(재임베딩 필요).
 */
export async function updateUser(id, patch) {
  if (!isPlainObject(patch)) throw Object.assign(new Error('patch 는 객체여야 합니다'), { code: 'INVALID_MENU' });
  const backend = await getBackend();
  const cur = await backend.get(id);
  if (!cur) throw Object.assign(new Error(`내 메뉴를 찾을 수 없음: ${id}`), { code: 'NOT_FOUND' });
  const { id: _i, source: _s, ...rest } = patch;
  const next = { ...cur, ...rest };
  const contentChanged = CONTENT_FIELDS.some((k) => k in rest && JSON.stringify(rest[k]) !== JSON.stringify(cur[k]));
  if (contentChanged && !('vec' in rest)) { delete next.vec; delete next.scale; }
  const clean = prepareUserMenu(next, { id });
  await backend.putMany([clean]);
  return clean;
}

/** 내 메뉴 삭제. 있었으면 true. */
export async function removeUser(id) {
  const backend = await getBackend();
  const existed = !!(await backend.get(id));
  if (existed) await backend.remove(id);
  return existed;
}

/** 내 메뉴 전체 삭제(설정 화면의 "모두 지우기" 등). */
export async function clearUser() {
  const backend = await getBackend();
  await backend.putMany([], { replace: true });
}

// ---------------------------------------------------------------------------
// 숨긴(밴) 메뉴: "이 메뉴는 먹고 싶지 않아요". id 만 이 브라우저(localStorage, 불가하면 메모리)에 저장한다.
// 기본 메뉴·내 메뉴 모두 대상이며, 서버로 보내지 않는다. 추천/비슷한 메뉴에서는 app.js 가 걸러 낸다.
// ---------------------------------------------------------------------------
const BAN_KEY = 'menuai.banned.v1';
export const BAN_MAX = 5000;
const validBanId = (id) => typeof id === 'string' && id.length <= LIMITS.id && ID_RE.test(id);
let banSet = null;

function loadBanned() {
  if (banSet) return banSet;
  banSet = new Set();
  try {
    const v = JSON.parse(localStorage.getItem(BAN_KEY) || '[]');
    if (Array.isArray(v)) for (const id of v) if (validBanId(id) && banSet.size < BAN_MAX) banSet.add(id);
  } catch { /* 저장소를 못 읽으면 빈 목록으로 시작(이번 세션 메모리) */ }
  return banSet;
}
function saveBanned() {
  try { localStorage.setItem(BAN_KEY, JSON.stringify([...banSet])); } catch { /* 저장 불가: 이번 세션에만 유지 */ }
}

/** 숨긴 메뉴 id 집합(복사본). */
export function getBanned() { return new Set(loadBanned()); }
export function isBanned(id) { return loadBanned().has(id); }
/** 메뉴를 숨긴다. @returns {number} 숨긴 메뉴 수 */
export function ban(id) {
  if (!validBanId(id)) throw Object.assign(new Error('올바른 메뉴 id 가 아닙니다'), { code: 'INVALID_ID' });
  const set = loadBanned();
  if (!set.has(id) && set.size >= BAN_MAX) throw Object.assign(new Error(`숨길 수 있는 메뉴는 최대 ${BAN_MAX}개입니다`), { code: 'TOO_MANY' });
  set.add(id); saveBanned();
  return set.size;
}
/** 숨김을 해제한다. @returns {number} 남은 숨긴 메뉴 수 */
export function unban(id) { const set = loadBanned(); if (set.delete(id)) saveBanned(); return set.size; }
export function clearBanned() { loadBanned().clear(); saveBanned(); }
/** 테스트용: 메모리 캐시를 버리고 저장소에서 다시 읽게 한다. */
export function _resetBanCache() { banSet = null; }

export const EXPORT_FORMAT = 'menusuggestion-user-menus';
export const EXPORT_VERSION = 1;
const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
const IMPORT_MAX_ITEMS = 1000;

/** 내 메뉴를 JSON 문자열로 내보낸다(vec 제외). */
export async function exportJson() {
  const menus = (await listUser()).map(({ vec: _v, scale: _s, ...m }) => m);
  return JSON.stringify({ format: EXPORT_FORMAT, version: EXPORT_VERSION, exportedAt: new Date().toISOString(), menus, banned: [...loadBanned()] }, null, 2);
}

/** 브라우저에서 내보내기 파일 다운로드를 시작한다(document 가 없으면 문자열만 반환). */
export async function downloadExport(filename = 'my-menus.json') {
  const text = await exportJson();
  if (typeof document !== 'undefined' && typeof Blob !== 'undefined' && typeof URL !== 'undefined') {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return text;
}

/**
 * 내보낸 JSON 을 가져온다. 입력은 신뢰하지 않는다: 크기/개수 제한, 스키마 검증, 허용 필드만 복사,
 * source 는 항상 "user", vec 은 버림(재임베딩 필요).
 * @param {File|Blob|string|object} file  File/Blob, JSON 문자열, 또는 이미 파싱된 객체
 * @param {{ mode?: 'merge'|'replace' }} [opts]  merge(기본): 같은 id 는 덮어쓰고 나머지는 추가. replace: 기존 내 메뉴를 모두 지우고 대체.
 * @returns {Promise<{ total:number, added:number, updated:number, skipped:number, errors:Array<{index:number,name:string,reasons:string[]}>, needsEmbedding:string[] }>}
 */
export async function importJson(file, { mode = 'merge' } = {}) {
  let data;
  if (typeof file === 'string') {
    if (file.length > IMPORT_MAX_BYTES) throw Object.assign(new Error('파일이 너무 큽니다(최대 5MB)'), { code: 'TOO_LARGE' });
    data = parseJson(file);
  } else if (file && typeof file.text === 'function') {
    if (typeof file.size === 'number' && file.size > IMPORT_MAX_BYTES) throw Object.assign(new Error('파일이 너무 큽니다(최대 5MB)'), { code: 'TOO_LARGE' });
    data = parseJson(await file.text());
  } else if (file && typeof file === 'object') {
    data = file;
  } else {
    throw Object.assign(new Error('가져올 수 없는 입력입니다'), { code: 'INVALID_FILE' });
  }

  const hasBanned = isPlainObject(data) && Array.isArray(data.banned);
  const list = Array.isArray(data) ? data : (isPlainObject(data) && Array.isArray(data.menus) ? data.menus : (hasBanned ? [] : null));
  if (!list) throw Object.assign(new Error('형식 오류: 메뉴 배열 또는 { menus: [...] } 이어야 합니다'), { code: 'INVALID_FILE' });
  if (list.length > IMPORT_MAX_ITEMS) throw Object.assign(new Error(`항목이 너무 많습니다(최대 ${IMPORT_MAX_ITEMS}개)`), { code: 'TOO_LARGE' });

  const backend = await getBackend();
  const existing = new Set((await backend.all()).map((m) => m.id));
  const errors = [];
  const accepted = new Map();
  let added = 0; let updated = 0;

  list.forEach((raw, index) => {
    if (!isPlainObject(raw)) { errors.push({ index, name: '', reasons: ['객체가 아닙니다'] }); return; }
    const { vec: _v, scale: _s, ...rest } = raw;
    try {
      const clean = prepareUserMenu(rest);
      if (accepted.has(clean.id)) { errors.push({ index, name: clean.name, reasons: [`파일 안에서 id 중복: ${clean.id}`] }); return; }
      accepted.set(clean.id, clean);
      if (mode !== 'replace' && existing.has(clean.id)) updated++; else added++;
    } catch (e) {
      errors.push({ index, name: typeof raw.name === 'string' ? raw.name.slice(0, 30) : '', reasons: e.errors || [String(e.message)] });
    }
  });

  const menus = [...accepted.values()];
  if (menus.length || mode === 'replace') await backend.putMany(menus, { replace: mode === 'replace' });

  // 숨긴 메뉴: 올바른 id 만 받는다(최대 BAN_MAX). merge 는 합집합, replace 는 파일 내용으로 대체.
  let bannedAdded = 0;
  if (hasBanned) {
    const set = loadBanned();
    if (mode === 'replace') set.clear();
    for (const id of data.banned) {
      if (validBanId(id) && !set.has(id) && set.size < BAN_MAX) { set.add(id); bannedAdded++; }
    }
    saveBanned();
  }
  return { total: list.length, added, updated, skipped: errors.length, errors, needsEmbedding: menus.map((m) => m.id), bannedAdded };
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { throw Object.assign(new Error('JSON 형식이 올바르지 않습니다'), { code: 'INVALID_FILE' }); }
}
