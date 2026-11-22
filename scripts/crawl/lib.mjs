// 크롤러 공용 유틸 (E 소유). 외부 의존성 없음(Node 내장 fetch).
// - UA 고정, 요청 간 최소 간격, 지수 백오프 재시도(최대 3회), 디스크 캐시(data/raw/.cache/)
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const UA = 'MenuSuggestionBot/0.1 (hobby project)';
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RAW_DIR = join(ROOT, 'data', 'raw');
export const CACHE_DIR = join(RAW_DIR, '.cache');
export const MIN_INTERVAL_MS = 1200; // 요청 간 1초 이상(여유 포함)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastRequestAt = 0;

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

export async function readJson(path, fallback = undefined) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (e) { if (fallback !== undefined) return fallback; throw e; }
}

export async function writeJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/**
 * 캐시 + 스로틀 + 재시도가 적용된 JSON 요청.
 * @param {string} url
 * @param {{method?:string, headers?:object, body?:string, cacheKey?:string, noCache?:boolean, allow404?:boolean}} opts
 * 404는 allow404=true면 null 반환(캐시도 함).
 */
export async function fetchJson(url, opts = {}) {
  const { method = 'GET', headers = {}, body, cacheKey, noCache = false, allow404 = false, logUrl = url } = opts; // logUrl: 캐시/에러에 남길 URL(비밀키 마스킹용)
  const key = createHash('sha1').update(cacheKey ?? `${method} ${url} ${body ?? ''}`).digest('hex');
  const cachePath = join(CACHE_DIR, key + '.json');
  if (!noCache && await exists(cachePath)) return (await readJson(cachePath)).data;

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    try {
      const res = await fetch(url, {
        method, body,
        headers: { 'User-Agent': UA, 'Api-User-Agent': UA, ...headers },
        signal: AbortSignal.timeout(80_000),
      });
      if (res.status === 404 && allow404) {
        await writeJson(cachePath, { url: logUrl, data: null });
        return null;
      }
      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get('retry-after'));
        lastErr = new Error(`HTTP ${res.status} ${logUrl.slice(0, 120)}`);
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 60) * 1000 : 2000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} ${logUrl.slice(0, 120)}`), { fatal: true });
      const data = await res.json();
      if (!noCache) await writeJson(cachePath, { url: logUrl, data });
      return data;
    } catch (e) {
      if (e.fatal) throw e;
      lastErr = e;
      await sleep(2000 * 2 ** attempt); // 2s, 4s, 8s
    }
  }
  throw lastErr;
}

export const HANGUL = /[가-힣]/;

/** 영문/ASCII 라벨 → 소문자 하이픈 슬러그 */
export function slugify(s) {
  return String(s ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 48).replace(/-+$/g, '');
}

export const CUISINE_ABBR = {
  korean: 'kr', western: 'we', chinese: 'cn', japanese: 'jp', vietnamese: 'vn', mexican: 'mx',
  thai: 'th', indian: 'in', fusion: 'fu', snack: 'sn', cafe: 'cf', other: 'ot',
};

// ---- 재료/태그 사전 ------------------------------------------------------
// data/dict/ingredients.json 이 있으면 읽어서 사용한다(B 소유, 형식 미확정이라 관대하게 파싱).
// 허용 형식: { "닭고기": ["닭", "치킨"] } | { "ingredients": {...} } | [ { name, aliases:[] } ] | ["닭고기", ...]
const BUILTIN_INGREDIENTS = {
  '소고기': ['소고기', '쇠고기', '우육', '비프', '불고기', '갈비', '육회'],
  '돼지고기': ['돼지고기', '돼지', '삼겹', '베이컨', '햄', '소시지', '순대'],
  '닭고기': ['닭고기', '닭', '치킨', '닭고기'],
  '양고기': ['양고기', '양갈비', '램'],
  '오리고기': ['오리고기', '오리'],
  '해산물': ['해산물', '조개', '굴', '전복', '오징어', '낙지', '문어', '새우', '게', '홍합', '바지락'],
  '생선': ['생선', '고등어', '연어', '참치', '명태', '대구', '장어', '광어', '멸치', '청어', '어묵'],
  '계란': ['계란', '달걀', '알'],
  '두부': ['두부'],
  '김치': ['김치'],
  '쌀': ['쌀', '밥', '볶음밥', '쌀밥', '찹쌀', '쌀가루'],
  '밀가루': ['밀가루', '밀', '반죽'],
  '면': ['국수', '면', '라면', '우동', '파스타', '냉면', '스파게티', '쌀국수', '소바'],
  '빵': ['빵', '식빵', '바게트', '샌드위치', '토스트'],
  '치즈': ['치즈'],
  '감자': ['감자'],
  '고구마': ['고구마'],
  '콩': ['콩', '대두', '두유', '된장', '낫토'],
  '버섯': ['버섯', '표고', '송이'],
  '양파': ['양파'],
  '마늘': ['마늘'],
  '고추': ['고추', '고춧가루', '고추장', '칠리'],
  '토마토': ['토마토'],
  '김': ['김', '김밥', '미역', '다시마'],
  '채소': ['채소', '야채', '양배추', '배추', '무', '당근', '상추', '시금치', '오이'],
  '과일': ['과일', '사과', '바나나', '딸기', '귤', '망고'],
  '옥수수': ['옥수수', '또띠아'],
  '카레': ['카레', '커리'],
  '초콜릿': ['초콜릿', '코코아'],
  '견과류': ['땅콩', '아몬드', '호두', '견과'],
};

// 태그 키워드(설명/라벨 텍스트에 등장하면 태그 후보) — 확신 있는 것만
const TAG_KEYWORDS = {
  '국물': ['국물', '탕', '찌개', '국', '스튜', '수프', '스프', '육수'],
  '매운': ['매운', '매콤', '얼큰', '고추', '칠리', '맵'],
  '튀김': ['튀김', '튀긴', '프라이'],
  '구이': ['구이', '구운', '직화', '그릴', '바비큐', '석쇠'],
  '볶음': ['볶음', '볶은', '볶아'],
  '찜': ['찜', '찐', '증기'],
  '면요리': ['국수', '면', '라면', '우동', '파스타', '냉면'],
  '밥요리': ['덮밥', '볶음밥', '비빔밥', '주먹밥', '밥'],
  '빵': ['빵', '샌드위치', '토스트', '버거', '피자'],
  '디저트': ['디저트', '후식', '케이크', '푸딩', '아이스크림', '과자', '떡', '쿠키', '파이'],
  '간식': ['간식', '길거리'],
  '반찬': ['반찬', '무침', '나물', '절임', '장아찌'],
  '채식': ['채식', '비건', '채소 요리'],
  '해장': ['해장'],
  '든든한': ['푸짐', '든든'],
  '차가운': ['냉', '차가운', '시원한'],
  '달콤한': ['달콤', '단맛', '설탕', '꿀'],
  '고기': ['고기', '육류', '스테이크'],
  '해산물': ['해산물', '생선', '조개', '새우', '게', '오징어'],
};

function toAliasMap(raw) {
  const out = {};
  const add = (name, aliases = []) => {
    if (typeof name !== 'string' || !name || name.startsWith('_')) return; // '_comment' 등 메타 키 무시
    out[name] = Array.from(new Set([name, ...aliases.filter((a) => typeof a === 'string' && a)]));
  };
  if (Array.isArray(raw)) {
    for (const it of raw) {
      if (typeof it === 'string') add(it);
      else if (it && typeof it === 'object') add(it.name ?? it.canonical, it.aliases ?? it.synonyms ?? []);
    }
  } else if (raw && typeof raw === 'object') {
    const obj = raw.ingredients ?? raw.canonical ?? raw;
    if (Array.isArray(obj)) return toAliasMap(obj);
    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v)) add(k, v);
      else if (v && typeof v === 'object') add(k, v.aliases ?? v.synonyms ?? []);
      else if (typeof v === 'string') add(v, [k]); // { 별칭: 표준명 }
    }
  }
  return out;
}

export async function loadIngredientDict() {
  const p = join(ROOT, 'data', 'dict', 'ingredients.json');
  try {
    const map = toAliasMap(await readJson(p));
    if (Object.keys(map).length) return { map, source: 'data/dict/ingredients.json' };
  } catch { /* 없거나 파싱 불가 → 내장 사전 */ }
  return { map: BUILTIN_INGREDIENTS, source: 'builtin' };
}

/**
 * 텍스트에서 재료 후보 추출. 한 글자 별칭(김, 게, 무, 알, 밀 등)은 오탐이 많아
 * 사전의 "표준명 자체"가 정확히 포함될 때만 인정한다.
 */
// 사전 별칭이 일반 단어/국가명과 겹쳐 오탐이 나는 것들(예: 터키=칠면조 vs 튀르키예)
const AMBIGUOUS_ALIAS = new Set(['터키', '포크', '램', '곱']);
const norm = (s) => s.normalize('NFC').toLowerCase().replace(/[s-]/g, '');
const SAFE_SINGLE = new Set(['닭', '빵', '쌀', '콩']); // 한 글자여도 오탐이 적은 별칭
export function extractIngredients(text, dict) {
  const found = [];
  const t = norm(text);
  for (const [canon, aliases] of Object.entries(dict.map)) {
    const hit = aliases.some((a) => {
      if (AMBIGUOUS_ALIAS.has(a)) return false;
      if (a.length < 2 && !SAFE_SINGLE.has(a)) return false;
      return t.includes(norm(a));
    });
    if (hit) found.push(canon);
  }
  return found.slice(0, 6);
}

export function extractTags(text, name = '') {
  const found = [];
  for (const [tag, kws] of Object.entries(TAG_KEYWORDS)) {
    if (kws.some((k) => k.length >= 2 && text.includes(k))) found.push(tag);
  }
  // 이름 접미사 규칙(한 글자 키워드는 이름 끝에서만 인정)
  if (/(탕|국|찌개|전골|스튜|수프|스프)$/.test(name) && !found.includes('국물')) found.unshift('국물');
  if (/(면|국수|라면|우동|파스타)$/.test(name) && !found.includes('면요리')) found.push('면요리');
  if (/(밥|덮밥|리조또)$/.test(name) && !found.includes('밥요리')) found.push('밥요리');
  if (/(튀김|까스|가스|프라이)$/.test(name) && !found.includes('튀김')) found.push('튀김');
  if (/(구이|스테이크|바비큐)$/.test(name) && !found.includes('구이')) found.push('구이');
  if (/(볶음)$/.test(name) && !found.includes('볶음')) found.push('볶음');
  if (/(찜)$/.test(name) && !found.includes('찜')) found.push('찜');
  return found.slice(0, 5);
}
