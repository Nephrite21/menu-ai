// node --test tests/   (또는 node --test tests/recommend.test.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  recommend,
  rerollPick,
  parseQuery,
  parseQueryDetailed,
  cosineSimilarity,
  createRng,
  createLexicon,
  setDictionaries,
  loadDictionaries,
  analyzeMenu,
  DEFAULT_WEIGHT_SCALE,
} from '../web/js/recommend.js';
import * as parseModule from '../web/js/parse.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
const ingredientsJson = readJson('data/dict/ingredients.json');
const groupsJson = readJson('data/dict/groups.json');

// 실제 사전을 기본 사전으로 주입 (loadDictionaries 경로도 함께 검증)
await loadDictionaries(async (name) => (name === 'ingredients' ? ingredientsJson : groupsJson));

// ---- 임의 벡터 픽스처 ---------------------------------------------------------
// 3차원 단위 벡터: 질문(1,0,0)과의 코사인이 곧 x 성분
const unit = (x, y) => {
  const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
  return [x, y, z];
};
const M = (id, name, cuisine, ingredients, tags, vec) => ({ id, name, cuisine, ingredients, tags, desc: '', source: 'curated', vec });
const Q = [1, 0, 0];

const menus = [
  M('kr-kimchi', '김치찌개', 'korean', ['김치', '돼지고기', '두부'], ['국물', '매운'], unit(0.9, 0.1)),
  M('kr-samgye', '삼계탕', 'korean', ['닭고기', '인삼', '찹쌀'], ['국물', '보양'], unit(0.8, 0.2)),
  M('kr-bulgogi', '불고기', 'korean', ['소고기', '양파', '간장'], ['달콤', '밥반찬'], unit(0.7, 0.3)),
  M('jp-sushi', '연어초밥', 'japanese', ['연어', '쌀', '김'], ['깔끔'], unit(0.6, 0.1)),
  M('it-carbonara', '까르보나라', 'western', ['파스타', '베이컨', '생크림', '달걀'], ['크림'], unit(0.5, 0.5)),
  M('ch-jjamppong', '짬뽕', 'chinese', ['면', '오징어', '새우', '고추기름'], ['국물', '매운'], unit(0.4, 0.2)),
];
const ids = (res) => res.map((r) => r.menu.id);
const get = (res, id) => res.find((r) => r.menu.id === id);

// ---- 코사인 -------------------------------------------------------------------
test('cosineSimilarity: 기본 성질과 방어 처리', () => {
  assert.ok(Math.abs(cosineSimilarity([1, 0], [1, 0]) - 1) < 1e-12);
  assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-12);
  assert.ok(Math.abs(cosineSimilarity([1, 0], [-1, 0]) + 1) < 1e-12);
  // 정규화되지 않은 벡터도 노름으로 보정
  assert.ok(Math.abs(cosineSimilarity([3, 0], [10, 0]) - 1) < 1e-12);
  // int8 + 임의 scale 은 코사인에 영향 없음
  const a = new Float32Array([0.3, -0.4, 0.5]);
  const q = new Int8Array([30, -40, 50]);
  assert.ok(Math.abs(cosineSimilarity(a, q) - 1) < 1e-6);
  // 영벡터/길이 불일치/빈 입력 → null
  assert.equal(cosineSimilarity([0, 0], [1, 0]), null);
  assert.equal(cosineSimilarity([1, 0], [1, 0, 0]), null);
  assert.equal(cosineSimilarity(null, [1]), null);
  assert.equal(cosineSimilarity([], []), null);
});

test('recommend: 유사도 순 정렬, 점수=sim+bonus, 필드 계약', () => {
  const res = recommend({ queryVec: Q, menus, topN: 10 });
  assert.equal(res.length, menus.length);
  assert.deepEqual(ids(res), ['kr-kimchi', 'kr-samgye', 'kr-bulgogi', 'jp-sushi', 'it-carbonara', 'ch-jjamppong']);
  for (const r of res) {
    assert.deepEqual(Object.keys(r).sort(), ['bonus', 'menu', 'reasons', 'score', 'sim']);
    assert.equal(r.bonus, 0);
    assert.ok(Math.abs(r.score - (r.sim + r.bonus)) < 1e-12);
    assert.ok(Array.isArray(r.reasons) && r.reasons.length >= 1);
  }
  assert.ok(Math.abs(get(res, 'kr-kimchi').sim - 0.9) < 1e-9);
});

test('recommend: 벡터가 {q,scale}(int8) 이어도 동일 순위', () => {
  const quant = menus.map((m) => {
    const max = Math.max(...m.vec.map(Math.abs));
    const q = m.vec.map((x) => Math.round((x / max) * 127));
    return { ...m, vec: { q, scale: 1 / Math.hypot(...q) } };
  });
  assert.deepEqual(ids(recommend({ queryVec: Q, menus: quant })), ids(recommend({ queryVec: Q, menus })));
});

test('recommend: topN, 빈 입력, 벡터 없는 메뉴는 크래시 없이 처리', () => {
  assert.equal(recommend({ queryVec: Q, menus, topN: 2 }).length, 2);
  assert.equal(recommend({ queryVec: Q, menus: [] }).length, 0);
  assert.equal(recommend({}).length, 0);
  const noVec = [{ id: 'x', name: 'x', cuisine: 'korean', ingredients: [], tags: [] }];
  const res = recommend({ queryVec: Q, menus: noVec });
  assert.equal(res[0].sim, 0);
  assert.match(res[0].reasons[0], /벡터 정보가 없어/);
  // queryVec 없이도 가중치만으로 동작
  const r2 = recommend({ menus, weights: { 소고기: 1 } });
  assert.equal(r2[0].menu.id, 'kr-bulgogi');
});

// ---- 음식 종류 필터 ------------------------------------------------------------
test('recommend: cuisines 필터', () => {
  const only = recommend({ queryVec: Q, menus, cuisines: ['japanese', 'chinese'] });
  assert.deepEqual(ids(only), ['jp-sushi', 'ch-jjamppong']);
  assert.equal(recommend({ queryVec: Q, menus, cuisines: [] }).length, menus.length); // 빈 배열 = 전체
  assert.equal(recommend({ queryVec: Q, menus, cuisines: ['mexican'] }).length, 0);
});

// ---- 가중치 점수 ---------------------------------------------------------------
test('recommend: 재료 가중치 = weight × 보유 여부 (표준명/동의어 모두)', () => {
  const base = recommend({ queryVec: Q, menus });
  const neg = recommend({ queryVec: Q, menus, weights: { 닭고기: -1 } });
  const samgye = get(neg, 'kr-samgye');
  assert.ok(Math.abs(samgye.bonus - -1 * DEFAULT_WEIGHT_SCALE) < 1e-12);
  assert.ok(Math.abs(samgye.score - (get(base, 'kr-samgye').sim - 1)) < 1e-12);
  assert.equal(neg.at(-1).menu.id, 'kr-samgye'); // -1 이 sim 격차보다 커서 최하위
  // 동의어 키(치킨, 닭)도 같은 효과
  for (const key of ['치킨', '닭', '닭고기는']) {
    assert.ok(Math.abs(get(recommend({ queryVec: Q, menus, weights: { [key]: -1 } }), 'kr-samgye').bonus + 1) < 1e-12, key);
  }
  // 강한 선호 +2, 보유하지 않은 메뉴는 0
  const pos = recommend({ queryVec: Q, menus, weights: { 소고기: 2 } });
  assert.equal(pos[0].menu.id, 'kr-bulgogi');
  assert.ok(Math.abs(pos[0].bonus - 2) < 1e-12);
  assert.equal(get(pos, 'kr-kimchi').bonus, 0);
});

test('recommend: 메뉴 쪽 동의어도 정규화(메뉴가 "치킨"이라고 적어도 닭고기 가중치 적용)', () => {
  const m = [M('x1', '양념치킨', 'korean', ['치킨'], [], [1, 0, 0]), M('x2', '샐러드', 'western', ['양상추'], [], [1, 0, 0])];
  const res = recommend({ queryVec: Q, menus: m, weights: { 닭고기: -1 } });
  assert.equal(get(res, 'x1').bonus, -1);
  assert.equal(get(res, 'x2').bonus, 0);
});

test('recommend: 태그 가중치와 분류(육류/해산물/국물) 가중치', () => {
  const tagRes = recommend({ queryVec: Q, menus, weights: { 보양: 1 } });
  assert.equal(get(tagRes, 'kr-samgye').bonus, 1);

  const meat = recommend({ queryVec: Q, menus, weights: { 육류: -1 } });
  assert.equal(get(meat, 'kr-kimchi').bonus, -1); // 돼지고기
  assert.equal(get(meat, 'kr-samgye').bonus, -1); // 닭고기
  assert.equal(get(meat, 'kr-bulgogi').bonus, -1); // 소고기
  assert.equal(get(meat, 'it-carbonara').bonus, -1); // 베이컨(가공육)
  assert.equal(get(meat, 'jp-sushi').bonus, 0);
  assert.equal(get(meat, 'ch-jjamppong').bonus, 0);

  const sea = recommend({ queryVec: Q, menus, weights: { 해산물: 1 } });
  assert.equal(get(sea, 'jp-sushi').bonus, 1); // 연어(생선)
  assert.equal(get(sea, 'ch-jjamppong').bonus, 1); // 오징어/새우는 한 번만 셈
  assert.equal(get(sea, 'kr-kimchi').bonus, 0);

  // 분류 별칭: '고기' → 육류, '국물' 분류는 태그 기반
  assert.equal(get(recommend({ queryVec: Q, menus, weights: { 고기: -1 } }), 'kr-bulgogi').bonus, -1);
  const soup = recommend({ queryVec: Q, menus, weights: { 국물: 1 } });
  assert.equal(get(soup, 'kr-kimchi').bonus, 1);
  assert.equal(get(soup, 'jp-sushi').bonus, 0);

  // 면류: 메뉴 재료가 그냥 '면'이어도 분류 별칭으로 매칭
  assert.equal(get(recommend({ queryVec: Q, menus, weights: { 면류: 1 } }), 'ch-jjamppong').bonus, 1);
  assert.equal(get(recommend({ queryVec: Q, menus, weights: { 면: 1 } }), 'it-carbonara').bonus, 1); // 파스타
});

test('recommend: 여러 가중치는 합산되고 동일 키는 한 번만 센다', () => {
  // 닭고기 -1 + 육류 -1 + 가금류 -1 → 삼계탕 -3, 그러나 클램프는 키별 ±2
  const res = recommend({ queryVec: Q, menus, weights: { 닭고기: -1, 육류: -1, 가금류: -1 } });
  assert.equal(get(res, 'kr-samgye').bonus, -3);
  // 동의어 키 두 개(치킨, 닭)는 같은 표준키로 합쳐져 한 번만 반영(마지막 값 우선)
  const res2 = recommend({ queryVec: Q, menus, weights: { 치킨: -1, 닭: -2 } });
  assert.equal(get(res2, 'kr-samgye').bonus, -2);
  // 범위 밖 값 클램프(+5 → +2), 0/NaN 무시
  const res3 = recommend({ queryVec: Q, menus, weights: { 소고기: 5, 두부: 0, 연어: NaN } });
  assert.equal(get(res3, 'kr-bulgogi').bonus, 2);
  assert.equal(get(res3, 'kr-kimchi').bonus, 0);
  assert.equal(get(res3, 'jp-sushi').bonus, 0);
});

test('recommend: weightScale 로 가중치 크기 조절', () => {
  const res = recommend({ queryVec: Q, menus, weights: { 소고기: 2 }, weightScale: 0.05 });
  assert.ok(Math.abs(get(res, 'kr-bulgogi').bonus - 0.1) < 1e-12);
  assert.equal(res[0].menu.id, 'kr-kimchi'); // 소프트 가중치에서는 유사도 격차가 이김
});

test('recommend: 사전에 없는 용어는 메뉴명 부분 일치', () => {
  const res = recommend({ queryVec: Q, menus, weights: { 까르보: 1 } });
  assert.equal(get(res, 'it-carbonara').bonus, 1);
  assert.equal(get(res, 'kr-kimchi').bonus, 0);
});

// ---- exclude ------------------------------------------------------------------
test('recommend: exclude 는 하드 제외(재료/동의어/분류/태그/메뉴명, Set·배열 모두)', () => {
  // 유사도 1위(김치찌개)라도 제외되면 결과에 없다
  let res = recommend({ queryVec: Q, menus, exclude: new Set(['돼지고기']) });
  assert.ok(!ids(res).includes('kr-kimchi'));
  assert.equal(res.length, menus.length - 1);
  // 동의어
  res = recommend({ queryVec: Q, menus, exclude: ['치킨'] });
  assert.ok(!ids(res).includes('kr-samgye'));
  // 분류
  res = recommend({ queryVec: Q, menus, exclude: ['해산물'] });
  assert.deepEqual(ids(res), ['kr-kimchi', 'kr-samgye', 'kr-bulgogi', 'it-carbonara']);
  // 태그 계열(매운 → 매운맛 분류, 고추기름/고추장 등 포함)
  res = recommend({ queryVec: Q, menus, exclude: ['매운'] });
  assert.ok(!ids(res).includes('kr-kimchi') && !ids(res).includes('ch-jjamppong'));
  // 메뉴명
  res = recommend({ queryVec: Q, menus, exclude: ['불고기'] });
  assert.ok(!ids(res).includes('kr-bulgogi'));
  // exclude 가 weights 의 +선호보다 우선
  res = recommend({ queryVec: Q, menus, weights: { 소고기: 2 }, exclude: ['소고기'] });
  assert.ok(!ids(res).includes('kr-bulgogi'));
  // cuisines 와 함께
  res = recommend({ queryVec: Q, menus, cuisines: ['korean'], exclude: ['닭고기'] });
  assert.deepEqual(ids(res), ['kr-kimchi', 'kr-bulgogi']);
});

test('recommend: 분류 별칭 한식/중식은 cuisine 기반', () => {
  const res = recommend({ queryVec: Q, menus, weights: { 중식: 1 } });
  assert.equal(get(res, 'ch-jjamppong').bonus, 1);
  assert.equal(get(res, 'kr-kimchi').bonus, 0);
});

// ---- reasons ------------------------------------------------------------------
test('recommend: reasons 는 한국어 문장으로 가점/감점 이유를 설명', () => {
  const res = recommend({ queryVec: Q, menus, weights: { 닭고기: -1, 소고기: 2, 육류: -1, 국물: 1 } });
  const samgye = get(res, 'kr-samgye').reasons;
  assert.match(samgye[0], /의미 유사도 0\.\d\d/);
  assert.ok(samgye.some((s) => s.includes("'닭고기'가 들어 있어 감점 (-1.00)")), samgye.join('|'));
  assert.ok(samgye.some((s) => s.includes("분류 '육류'(닭고기)에 해당해 감점")), samgye.join('|'));
  assert.ok(samgye.some((s) => s.includes("'국물'") && s.includes('가점')), samgye.join('|'));
  const bulgogi = get(res, 'kr-bulgogi').reasons;
  assert.ok(bulgogi.some((s) => s.includes("강한 선호 재료 '소고기'가 들어 있어 가점 (+2.00)")), bulgogi.join('|'));
  // 받침 없는 재료 → '가'
  const r = recommend({ queryVec: Q, menus, weights: { 연어: 1 } });
  assert.ok(get(r, 'jp-sushi').reasons.some((s) => s.includes("'연어'가")));
});

// ---- history / seed -----------------------------------------------------------
test('recommend: history 는 최근 추천을 약하게 감점(최근일수록 크게)', () => {
  const res = recommend({ queryVec: Q, menus, history: ['kr-samgye', 'kr-kimchi'] });
  const kimchi = get(res, 'kr-kimchi');
  const samgye = get(res, 'kr-samgye');
  assert.ok(kimchi.bonus < 0 && samgye.bonus < 0);
  assert.ok(kimchi.bonus < samgye.bonus); // kimchi 가 더 최근
  assert.ok(kimchi.reasons.some((s) => s.includes('최근에 추천했던')));
  assert.equal(get(res, 'kr-bulgogi').bonus, 0);
});

test('recommend: seed 는 완전 동점 메뉴의 순서를 재현 가능하게 결정', () => {
  const tied = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((x) => M(`t-${x}`, x, 'other', [], [], [1, 0, 0]));
  const r1 = ids(recommend({ queryVec: Q, menus: tied, seed: 42 }));
  const r2 = ids(recommend({ queryVec: Q, menus: tied, seed: 42 }));
  const r3 = ids(recommend({ queryVec: Q, menus: tied, seed: 'other-seed' }));
  assert.deepEqual(r1, r2);
  assert.notDeepEqual(r1, r3);
  assert.deepEqual(ids(recommend({ queryVec: Q, menus: tied })), tied.map((m) => m.id)); // seed 없으면 id 순
});

// ---- 파서 ---------------------------------------------------------------------
test('parseQuery: 계약 예시', () => {
  const p = parseQuery('비 오는 날 -닭고기 +소고기');
  assert.equal(p.text, '비 오는 날');
  assert.deepEqual(p.weights, { 닭고기: -1, 소고기: 1 });
  assert.ok(p.exclude instanceof Set);
  assert.equal(p.exclude.size, 0);
});

test('parseQuery: 접두어 + ++ - -- ! ✕', () => {
  const p = parseQuery('++소고기 --오이 !새우 ✕땅콩 +두부 -가지 매콤한 거');
  assert.deepEqual(p.weights, { 소고기: 2, 오이: -2, 두부: 1, 가지: -1 });
  assert.deepEqual([...p.exclude].sort(), ['땅콩', '새우']);
  assert.equal(p.text, '매콤한 거');
  const p2 = parseQuery('+++소고기 ---오이'); // 3개 이상은 ±2 로 클램프
  assert.deepEqual(p2.weights, { 소고기: 2, 오이: -2 });
  assert.deepEqual([...parseQuery('✖새우 ✗굴 ×게').exclude].sort(), ['게', '굴', '새우']);
});

test('parseQuery: 동의어를 표준명으로 정규화', () => {
  for (const syn of ['닭', '치킨', '닭고기', '계육', 'chicken', 'Chicken']) {
    assert.deepEqual(parseQuery(`-${syn}`).weights, { 닭고기: -1 }, syn);
  }
  assert.deepEqual([...parseQuery('!쇠고기').exclude], ['소고기']);
  assert.deepEqual(parseQuery('+계란 -새우튀김').weights, { 달걀: 1, 새우튀김: -1 }); // 사전에 없으면 원형 유지
  assert.deepEqual(parseQuery('-고기').weights, { 육류: -1 }); // 분류 별칭
  assert.deepEqual(parseQuery('-매콤한').weights, { 매운맛: -1 });
});

test('parseQuery: 한국어 조사 처리', () => {
  assert.deepEqual(parseQuery('닭고기는 말고 -닭고기는 빼고').weights, { 닭고기: -1 });
  assert.equal(parseQuery('저녁 -닭고기는 빼고 추천').text, '저녁 추천');
  assert.deepEqual(parseQuery('+소고기만').weights, { 소고기: 1 });
  assert.deepEqual(parseQuery('!새우를').exclude, new Set(['새우']));
  assert.deepEqual(parseQuery('-치킨이랑').weights, { 닭고기: -1 });
  assert.deepEqual(parseQuery('-돼지고기에서는').weights, { 돼지고기: -1 });
  assert.deepEqual(parseQuery('-오이는').weights, { 오이: -1 }); // '오이' 자체가 사전어 → 정확 일치 우선
  assert.deepEqual(parseQuery('-오이를').weights, { 오이: -1 });
  // 사전에 없는 단어는 보수적으로(은/는/을/를/만/도) 벗김
  assert.deepEqual(parseQuery('-불고기를').weights, { 불고기: -1 });
  assert.deepEqual(parseQuery('-마라샹궈가').weights, { 마라샹궈가: -1 }); // '가'는 미등록어에서 벗기지 않음(한계)
});

test('parseQuery: 구두점/쉼표/슬래시/엣지 케이스', () => {
  assert.deepEqual(parseQuery('-닭고기, -돼지고기, +두부').weights, { 닭고기: -1, 돼지고기: -1, 두부: 1 });
  assert.equal(parseQuery('-닭고기, -돼지고기, 뜨끈한 국물').text, '뜨끈한 국물');
  assert.deepEqual(parseQuery('-닭고기/오리고기').weights, { 닭고기: -1, 오리고기: -1 });
  assert.deepEqual(parseQuery('("-닭고기").').weights, { 닭고기: -1 }); // 따옴표/괄호 바로 뒤의 접두어도 인식
  // 접두어가 단어 중간/단독이면 본문으로 취급
  assert.equal(parseQuery('비-오는 날').text, '비-오는 날');
  assert.equal(parseQuery('맛있는 거!').text, '맛있는 거!');
  assert.equal(parseQuery('- ').text, '-');
  assert.deepEqual(parseQuery('').weights, {});
  assert.equal(parseQuery(undefined).text, '');
  // 마지막 지정이 이김, exclude 는 weight 를 지움
  assert.deepEqual(parseQuery('+소고기 -쇠고기').weights, { 소고기: -1 });
  const p = parseQuery('+소고기 !소고기');
  assert.deepEqual(p.weights, {});
  assert.deepEqual([...p.exclude], ['소고기']);
  const d = parseQueryDetailed('-닭고기 !불고기');
  assert.deepEqual(d.terms.map((t) => [t.name, t.known, t.op]), [['닭고기', true, 'weight'], ['불고기', false, 'exclude']]);
});

test('parseQuery 결과를 recommend 에 그대로 연결', () => {
  const p = parseQuery('국물 요리 -치킨 +소고기 !새우');
  const res = recommend({ queryVec: Q, menus, weights: p.weights, exclude: p.exclude });
  assert.ok(!ids(res).includes('ch-jjamppong'));
  assert.equal(get(res, 'kr-samgye').bonus, -1);
  assert.equal(get(res, 'kr-bulgogi').bonus, 1);
});

test('parse.js 에서도 parseQuery export (recommend.js 와 동일 함수)', () => {
  assert.equal(parseModule.parseQuery, parseQuery);
});

// ---- 사전 ---------------------------------------------------------------------
test('사전: 규모, 충돌 없음, 참조 무결성', () => {
  const lex = createLexicon(ingredientsJson, groupsJson);
  assert.ok(lex.stats.ingredients >= 150, `재료 ${lex.stats.ingredients}개`);
  assert.ok(lex.stats.groups >= 20, `분류 ${lex.stats.groups}개`);
  assert.deepEqual(lex.conflicts, [], JSON.stringify(lex.conflicts.slice(0, 5)));

  // groups.json 의 includes 는 실제 분류여야 하고, ingredients 는 재료 사전의 표준명이어야 한다
  const stdNames = new Set(Object.keys(ingredientsJson).filter((k) => !k.startsWith('_')));
  const bad = [];
  for (const [g, def] of Object.entries(groupsJson.groups)) {
    for (const inc of def.includes || []) if (!lex.hasGroup(inc)) bad.push(`${g}.includes:${inc}`);
    for (const i of def.ingredients || []) if (!stdNames.has(i) && !['피칸', '피스타치오', '헤이즐넛', '마카다미아'].includes(i)) bad.push(`${g}.ingredients:${i}`);
  }
  assert.deepEqual(bad, []);
});

test('사전: 대표 동의어 정규화', () => {
  const lex = createLexicon(ingredientsJson, groupsJson);
  const cases = {
    닭: '닭고기', 치킨: '닭고기', 닭고기: '닭고기', 쇠고기: '소고기', 삼겹살: '돼지고기', 계란: '달걀',
    해물: '해산물', 씨푸드: '해산물', 파: '대파', 순두부: '두부', 우유: '우유', 모짜렐라: '치즈',
    스파게티: '파스타', 밥: '쌀', 오뎅: '어묵', 주꾸미: '쭈꾸미', 고기: '육류', 버섯: '버섯류', 조개: '조개류',
  };
  for (const [k, v] of Object.entries(cases)) assert.equal(lex.resolve(k), v, k);
  assert.equal(lex.resolve('존재하지않는재료'), null);
});

test('사전: 분류 멤버십(includes 전이)', () => {
  const lex = createLexicon(ingredientsJson, groupsJson);
  const g = lex.groupsOf('닭고기');
  for (const name of ['가금류', '육류']) assert.ok(g.has(name), name);
  assert.ok(lex.groupsOf('연어').has('해산물'));
  assert.ok(lex.groupsOf('새우').has('갑각류'));
  assert.ok(lex.groupsOf('국수').has('탄수화물')); // 면류 → 탄수화물
  assert.ok(lex.groupsOfCuisine('korean').has('한식'));
  const info = analyzeMenu(menus[1], lex);
  assert.ok(info.terms.has('육류') && info.terms.get('육류').via.has('닭고기'));
});

test('createLexicon: 임의 사전 주입 / 빈 사전에서도 동작', () => {
  const lex = createLexicon({ 가짜고기: ['페이크'] }, { groups: { 비건불가: { ingredients: ['가짜고기'] } } });
  const res = recommend({
    queryVec: Q,
    menus: [M('z', '테스트', 'other', ['페이크'], [], [1, 0, 0])],
    weights: { 비건불가: -1 },
    lexicon: lex,
  });
  assert.equal(res[0].bonus, -1);
  // 빈 사전: 정규화 없이 원형 비교
  const empty = createLexicon();
  assert.deepEqual(parseQuery('-닭고기는', empty).weights, { 닭고기: -1 });
});

// ---- rerollPick ---------------------------------------------------------------
const ranked = recommend({ queryVec: Q, menus, topN: 10 });
const counts = (picks) => picks.reduce((m, id) => ((m[id] = (m[id] || 0) + 1), m), {});

test('rerollPick: 같은 seed 면 같은 결과, 다른 seed 면 달라질 수 있음', () => {
  const a = ids(rerollPick(ranked, { seed: 123, k: 3, temperature: 0.3 }));
  const b = ids(rerollPick(ranked, { seed: 123, k: 3, temperature: 0.3 }));
  assert.deepEqual(a, b);
  const seqs = new Set();
  for (let s = 0; s < 30; s++) seqs.add(ids(rerollPick(ranked, { seed: s, k: 3, temperature: 0.3 })).join());
  assert.ok(seqs.size > 3, `seed 별 결과가 다양해야 함 (${seqs.size})`);
  // 문자열 seed 도 재현 가능
  assert.deepEqual(ids(rerollPick(ranked, { seed: 'abc' })), ids(rerollPick(ranked, { seed: 'abc' })));
});

test('rerollPick: k개 중복 없음, 원소는 ranked 의 원본 객체, 항상 배열', () => {
  const picks = rerollPick(ranked, { seed: 1, k: 4, temperature: 1 });
  assert.equal(picks.length, 4);
  assert.equal(new Set(ids(picks)).size, 4);
  for (const p of picks) assert.ok(ranked.includes(p));
  assert.equal(rerollPick(ranked, { seed: 1 }).length, 1); // k 기본 1
  assert.equal(rerollPick(ranked, { seed: 1, k: 99, pool: 99 }).length, ranked.length); // 후보보다 크면 전부
  assert.deepEqual(rerollPick([], { seed: 1 }), []);
  assert.deepEqual(rerollPick(undefined, { seed: 1 }), []);
});

test('rerollPick: temperature 가 낮으면 상위 편향, 높으면 균등에 가까움 (고정 seed 시뮬레이션)', () => {
  const sample = (T) => {
    const c = {};
    for (let s = 0; s < 600; s++) {
      const id = rerollPick(ranked, { seed: `s${s}`, temperature: T })[0].menu.id;
      c[id] = (c[id] || 0) + 1;
    }
    return c;
  };
  const cold = sample(0.02);
  const hot = sample(5);
  assert.ok((cold['kr-kimchi'] || 0) > 600 * 0.6, JSON.stringify(cold));
  const hotMin = Math.min(...ranked.map((r) => hot[r.menu.id] || 0));
  assert.ok(hotMin > 600 * 0.08, `고온에서는 모든 후보가 뽑혀야 함 ${JSON.stringify(hot)}`);
  // 결정적 모드
  assert.deepEqual(ids(rerollPick(ranked, { temperature: 0, k: 2 })), ['kr-kimchi', 'kr-samgye']);
});

test('rerollPick: pool 은 후보 범위를 제한', () => {
  for (let s = 0; s < 100; s++) {
    const id = rerollPick(ranked, { seed: s, temperature: 10, pool: 2 })[0].menu.id;
    assert.ok(['kr-kimchi', 'kr-samgye'].includes(id));
  }
});

test('rerollPick: history 로 직전 추천 반복 억제', () => {
  const trials = 500;
  const rate = (history) => {
    let hit = 0;
    for (let s = 0; s < trials; s++) if (rerollPick(ranked, { seed: s, temperature: 0.1, history })[0].menu.id === 'kr-kimchi') hit++;
    return hit / trials;
  };
  const without = rate(undefined);
  const withHist = rate(['kr-kimchi']);
  assert.ok(without > 0.5, `기준 선택률 ${without}`);
  assert.ok(withHist < without * 0.4, `history 적용 시 크게 감소해야 함 ${withHist} vs ${without}`);
  // 오래된 항목일수록 억제가 약해진다
  const old = rate(['kr-kimchi', 'a', 'b', 'c', 'd', 'e']);
  assert.ok(old > withHist);
  // 결정적 모드에서는 history 항목이 뒤로 밀림
  assert.equal(rerollPick(ranked, { temperature: 0, history: ['kr-kimchi'] })[0].menu.id, 'kr-samgye');
  // 객체형 history 도 허용
  assert.equal(rerollPick(ranked, { temperature: 0, history: [{ menu: { id: 'kr-kimchi' } }] })[0].menu.id, 'kr-samgye');
});

test('rerollPick: rng 주입, createRng 재현성', () => {
  const r1 = createRng(7);
  const r2 = createRng(7);
  const seq1 = [r1(), r1(), r1()];
  assert.deepEqual(seq1, [r2(), r2(), r2()]);
  assert.ok(seq1.every((x) => x >= 0 && x < 1));
  const fixed = () => 0; // 항상 첫 후보
  assert.equal(rerollPick(ranked, { rng: fixed, temperature: 1 })[0].menu.id, ranked[0].menu.id);
});

test('rerollPick: 점수가 NaN/누락인 항목에도 안전', () => {
  const weird = [{ menu: { id: 'a' }, score: NaN }, { menu: { id: 'b' } }, { menu: { id: 'c' }, score: 1 }];
  const picks = rerollPick(weird, { seed: 3, k: 3 });
  assert.equal(picks.length, 3);
});
