// web/js/parse.js
// 사전(Lexicon) 생성/조회 + 검색어 파서. 순수 함수 모듈(DOM·네트워크 없음), 브라우저/Node 양쪽 ES Module.
//
// 사용 흐름
//   1) 앱 시작 시 한 번: await loadDictionaries(name => fetch(`.../${name}.json`).then(r => r.json()))
//      (또는 이미 읽은 JSON을 setDictionaries({ ingredients, groups }) 로 주입)
//   2) parseQuery("비 오는 날 -닭고기 +소고기") → { text, weights, exclude }
//   3) recommend.js 의 recommend() 가 같은 사전으로 메뉴 재료/태그/분류를 정규화한다.
// 사전을 주입하지 않으면 빈 사전(정규화 없음, 한국어 조사 처리는 동작)으로 동작한다.
//
// 한계(문서화)
//  - 접두어는 "공백/쉼표 뒤 단어의 맨 앞"에서만 인식한다: "-닭고기" O, "닭고기 -" X, "- 닭고기"(띄어쓰기) X.
//  - 접두어 용어 1개 = 공백 없는 한 단어. "-닭 가슴살"은 "닭"만 비선호로 잡고 "가슴살"은 본문에 남는다.
//  - 조사는 "사전에 있는 단어 + 조사" 형태일 때만 정확히 벗긴다(닭고기는/소고기만/치킨이랑 등).
//    사전에 없는 단어는 은/는/을/를/만/도 (어간 2자 이상)만 보수적으로 벗기고, 그 외는 원형 유지.
//  - "소고기만"의 '만'은 "~만 원한다"는 의미 해석 없이 단순 조사로만 제거된다(+1 가중 그대로).
//  - 동의어는 표기가 완전히 같을 때만 매칭한다(띄어쓰기/하이픈/대소문자는 무시). 형태소 분석은 하지 않는다.
//  - 용어가 여러 표준명에 걸치는 동음이의(예: '배' 과일/신체)는 사전의 첫 정의를 따른다.

const NFC = (s) => String(s ?? '').normalize('NFC');

/** 비교용 키: NFC + 소문자 + 공백/하이픈/밑줄/점/쉼표 제거 */
export function normKey(s) {
  return NFC(s).trim().toLowerCase().replace(/[\s\-_.,·]+/g, '');
}

/** "@@@@" 같은 객체/배열 방어: 문자열 배열만 뽑는다 */
const strArr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : []);

/**
 * 사전 생성.
 * @param ingredientsJson  { 표준명: [동의어...] } 또는 { ingredients: {...} } ('_' 키는 무시)
 * @param groupsJson       { groups: { 분류명: { aliases, ingredients, tags, includes, cuisines } }, tags: { 표준태그: [동의어] } }
 */
export function createLexicon(ingredientsJson = {}, groupsJson = {}) {
  const ingMap = new Map(); // normKey → 표준 재료명
  const groupMap = new Map(); // normKey → 분류명
  const tagMap = new Map(); // normKey → 표준 태그명
  const conflicts = []; // 서로 다른 표준명이 같은 표기를 주장한 경우(사전 오류)
  const allKeys = new Map(); // normKey → {name, kind}  (맵 간 충돌 검사용)

  const put = (map, kind, key, name) => {
    const k = normKey(key);
    if (!k) return;
    const prev = allKeys.get(k);
    if (prev && prev.name !== name) {
      conflicts.push({ key: k, a: `${prev.kind}:${prev.name}`, b: `${kind}:${name}` });
      if (map.has(k)) return; // 같은 맵 안에서는 먼저 정의한 쪽 유지
    }
    if (!map.has(k)) map.set(k, name);
    if (!prev) allKeys.set(k, { name, kind });
  };

  const ingSrc = ingredientsJson && ingredientsJson.ingredients ? ingredientsJson.ingredients : ingredientsJson;
  for (const [std, syns] of Object.entries(ingSrc || {})) {
    if (std.startsWith('_')) continue;
    const name = NFC(std);
    put(ingMap, 'ingredient', name, name);
    for (const s of strArr(syns)) put(ingMap, 'ingredient', s, name);
  }

  const groupDefs = new Map();
  for (const [gname, def] of Object.entries((groupsJson && groupsJson.groups) || {})) {
    if (gname.startsWith('_')) continue;
    const name = NFC(gname);
    groupDefs.set(name, def || {});
    put(groupMap, 'group', name, name);
    for (const a of strArr(def && def.aliases)) put(groupMap, 'group', a, name);
  }
  for (const [tname, syns] of Object.entries((groupsJson && groupsJson.tags) || {})) {
    if (tname.startsWith('_')) continue;
    const name = NFC(tname);
    put(tagMap, 'tag', name, name);
    for (const s of strArr(syns)) put(tagMap, 'tag', s, name);
  }

  /** 표기 → 표준명(재료 > 분류 > 태그 순). 없으면 null */
  const resolve = (term) => {
    const k = normKey(term);
    if (!k) return null;
    return ingMap.get(k) ?? groupMap.get(k) ?? tagMap.get(k) ?? null;
  };
  const canon = (term) => resolve(term) ?? NFC(term).trim();

  // 분류 멤버 확장(includes 재귀, 순환 방지)
  const memberCache = new Map();
  const membersOf = (gname, stack = new Set()) => {
    if (memberCache.has(gname)) return memberCache.get(gname);
    const out = new Set();
    if (stack.has(gname)) return out;
    stack.add(gname);
    const def = groupDefs.get(gname) || {};
    for (const i of strArr(def.ingredients)) out.add(canon(i));
    for (const t of strArr(def.tags)) out.add(canon(t));
    for (const inc of strArr(def.includes)) {
      const incName = groupMap.get(normKey(inc)) ?? NFC(inc);
      out.add(incName);
      for (const m of membersOf(incName, stack)) out.add(m);
    }
    stack.delete(gname);
    memberCache.set(gname, out);
    return out;
  };

  const memberGroups = new Map(); // 표준 용어 → Set<분류명>
  const addMG = (term, g) => {
    if (!memberGroups.has(term)) memberGroups.set(term, new Set());
    memberGroups.get(term).add(g);
  };
  const cuisineGroups = new Map(); // cuisine 코드 → Set<분류명>
  for (const g of groupDefs.keys()) {
    addMG(g, g);
    for (const m of membersOf(g)) addMG(m, g);
    for (const c of strArr((groupDefs.get(g) || {}).cuisines)) {
      if (!cuisineGroups.has(c)) cuisineGroups.set(c, new Set());
      cuisineGroups.get(c).add(g);
    }
  }

  /** 표준 용어가 속한 분류명 집합(자기 자신이 분류명이면 자신 포함) */
  const groupsOf = (name) => memberGroups.get(name) ?? new Set();
  /** cuisine 코드가 속한 분류 집합(이 분류를 includes 하는 상위 분류 포함) */
  const groupsOfCuisine = (cuisine) => {
    const out = new Set();
    for (const g of cuisineGroups.get(cuisine) ?? []) {
      out.add(g);
      for (const up of groupsOf(g)) out.add(up);
    }
    return out;
  };

  return {
    resolve,
    canon,
    isKnown: (term) => resolve(term) !== null,
    groupsOf,
    groupsOfCuisine,
    membersOf: (g) => new Set(membersOf(g)),
    hasGroup: (name) => groupDefs.has(name),
    groupNames: () => [...groupDefs.keys()],
    conflicts,
    stats: { ingredients: new Set(ingMap.values()).size, groups: groupDefs.size, tags: new Set(tagMap.values()).size },
  };
}

// ---- 기본(모듈 전역) 사전 ---------------------------------------------------
let defaultLexicon = createLexicon({}, {});

export function setDictionaries({ ingredients, groups } = {}) {
  defaultLexicon = createLexicon(ingredients || {}, groups || {});
  return defaultLexicon;
}
export function getLexicon() {
  return defaultLexicon;
}
/**
 * 사전 JSON 로드. 네트워크 방식은 호출측이 주입한다(이 모듈은 fetch/fs를 직접 쓰지 않는다).
 * loader('ingredients' | 'groups') → Promise<object>
 */
export async function loadDictionaries(loader) {
  const [ingredients, groups] = await Promise.all([loader('ingredients'), loader('groups')]);
  return setDictionaries({ ingredients, groups });
}

// ---- 한국어 조사 처리 -------------------------------------------------------
const JOSA = [
  '에서는', '에서도', '으로는', '으로도', '에게는', '한테는', '이라도', '이라고', '까지는', '부터는',
  '에서', '으로', '에게', '한테', '에는', '에도', '이랑', '하고', '이나', '이든', '처럼', '보다', '마저', '조차', '까지', '부터',
  '만은', '만도', '만큼', '라도', '라고',
  '은', '는', '이', '가', '을', '를', '도', '만', '로', '와', '과', '랑', '의', '에', '나', '든',
].sort((a, b) => b.length - a.length);

/** 앞뒤 따옴표/괄호/문장부호 제거 */
function cleanTerm(raw) {
  return NFC(raw)
    .trim()
    .replace(/^["'“‘(\[{<]+/, '')
    .replace(/["'”’)\]}>.!?~…。,，、;:]+$/, '')
    .trim();
}

/**
 * 한 단어 → { name, known }. 사전 정확 일치 → (조사 제거 후 일치, 최대 2단계) → 보수적 조사 제거.
 * 사전에 없으면 known=false, name은 (가능하면 조사를 벗긴) 원형.
 */
export function resolveTerm(raw, lexicon = defaultLexicon) {
  const t = cleanTerm(raw);
  if (!t) return { name: '', known: false };
  const walk = (s, depth) => {
    const n = lexicon.resolve(s);
    if (n) return n;
    if (depth >= 2) return null;
    for (const j of JOSA) {
      if (s.length > j.length && s.endsWith(j)) {
        const r = walk(s.slice(0, -j.length), depth + 1);
        if (r) return r;
      }
    }
    return null;
  };
  const hit = walk(t, 0);
  if (hit) return { name: hit, known: true };
  const m = t.match(/^(.{2,}?)([은는을를만도])$/u);
  return { name: m ? m[1] : t, known: false };
}

// ---- 검색어 파서 ------------------------------------------------------------
const PREFIX = '\\+{1,}|-{1,}|[!✕✖✗×]+';
const TERM_BREAK = '\\s,，、';
const NOISE = ['빼고', '빼줘', '빼주세요', '빼줄래', '빼', '제외', '제외하고', '제외해줘', '말고', '없이', '싫어', '싫어요', '싫음'];
const TERM_RE = new RegExp(
  `(^|[${TERM_BREAK}"'“‘([])(${PREFIX})([^${TERM_BREAK}+\\-!✕✖✗×][^${TERM_BREAK}]*)((?:\\s+(?:${NOISE.join('|')})(?=$|[${TERM_BREAK}]))*)`,
  'g',
);

const clampW = (n) => Math.max(-2, Math.min(2, n));

/**
 * 상세 파서. parseQuery는 이 결과에서 { text, weights, exclude }만 돌려준다.
 * 접두어: + → +1, ++ → +2, - → -1, -- → -2, ! 또는 ✕(✖ ✗ ×) → exclude.
 * 같은 용어(동의어 포함)가 여러 번 나오면 마지막 것이 이긴다. exclude된 용어는 weights에서 빠진다.
 * 용어는 '/'로 여러 개를 묶을 수 있다("-닭고기/오리고기").
 * @returns {{ text:string, weights:Object<string,number>, exclude:Set<string>, terms:Array }}
 */
export function parseQueryDetailed(input, lexicon = defaultLexicon) {
  const src = NFC(input);
  const weights = {};
  const exclude = new Set();
  const terms = [];

  const rest = src.replace(TERM_RE, (m, lead, prefix, term) => {
    const ch = prefix[0];
    const op = ch === '+' ? 'weight' : ch === '-' ? 'weight' : 'exclude';
    const weight = ch === '+' ? Math.min(2, prefix.length) : ch === '-' ? -Math.min(2, prefix.length) : 0;
    for (const piece of term.split('/')) {
      const { name, known } = resolveTerm(piece, lexicon);
      if (!name) continue;
      terms.push({ raw: piece, name, known, op, weight });
      if (op === 'exclude') {
        exclude.add(name);
        delete weights[name];
      } else if (!exclude.has(name)) {
        weights[name] = weight;
      }
    }
    return lead;
  });

  const text = rest
    .replace(/(\s*[,，、]\s*){2,}/g, ' ')
    .replace(/^[\s,，、]+|[\s,，、]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return { text, weights, exclude, terms };
}

/** 계약 API: "비 오는 날 -닭고기 +소고기" → { text:"비 오는 날", weights:{닭고기:-1, 소고기:1}, exclude:Set } */
export function parseQuery(text, lexicon = defaultLexicon) {
  const { text: t, weights, exclude } = parseQueryDetailed(text, lexicon);
  return { text: t, weights, exclude };
}
