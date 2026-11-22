#!/usr/bin/env node
// wikidata.mjs — Wikidata SPARQL로 "요리(dish)" 항목을 수집해 data/raw/wikidata.json 으로 저장.
//
// 사용법:
//   node scripts/crawl/wikidata.mjs               # 전체 수집(캐시가 있으면 이어받기)
//   node scripts/crawl/wikidata.mjs --limit 300   # 상위 N개 후보만(테스트용)
//   node scripts/crawl/wikidata.mjs --fresh       # 캐시 무시하고 재요청
//   node scripts/crawl/wikidata.mjs --report      # 네트워크 없이 기존 wikidata.json 통계만 출력
//
// 동작:
//   - 1단계: ?d wdt:P31/wdt:P279* wd:Q746549(dish) + 한국어 라벨 보유 QID를 ID_PAGE개씩(LIMIT/OFFSET, ORDER BY ?d).
//   - 2단계: QID를 DETAIL_BATCH개씩 VALUES로 묶어 상세(영문라벨/설명/원산지/구성재료/ko위키 문서) 조회.
//   - 모든 응답은 data/raw/.cache/ 에 저장 → 중단 후 재실행 시 이어받기(타임아웃 회피를 위해 쿼리를 둘로 분리).
//   - 원산지(P495)→국가→cuisine 매핑, 없으면 국가의 P17, 요리 계통(P2012) 영문 라벨 정규식 순으로 폴백.
//   - 음료/비식품 등은 EXCLUDE_QIDS(drink 등, 하위 클래스 포함 MINUS) + 직접 인스턴스 영문 라벨(BAD_INSTANCE_LABEL) + 한글 라벨 정규식(BAD_LABEL)으로 제외. 제외 건수는 콘솔에 출력.
//   - 한국어 라벨이 없거나 한글이 전혀 없는 항목은 제외.
//   - 출력은 SPEC 메뉴 스키마(source:'wikidata', attribution 포함). 보조 정보는 _wd 필드(빌드 시 무시/삭제 가능).
//
// 요청 규칙: UA 'MenuSuggestionBot/0.1 (hobby project)', 요청 간 >=1.2초, 실패 시 지수 백오프 3회.
// robots.txt 참고: query.wikidata.org/robots.txt 는 일반 크롤러에게 /sparql 을 막지만, 이 엔드포인트는 UA 정책 하의 프로그램 접근용 공식 공개 API다.
//   (Wikimedia 정책상 식별 가능한 UA + 저속/직렬 호출). 병렬 호출 금지, 쿼리 60초 타임아웃 내에서 처리되도록 분할.
// 라이선스: Wikidata 데이터는 CC0. 표기는 관례적으로 attribution 에 남긴다.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetchJson, writeJson, readJson, RAW_DIR, HANGUL, slugify, CUISINE_ABBR, extractIngredients, extractTags, loadIngredientDict } from './lib.mjs';

const ENDPOINT = 'https://query.wikidata.org/sparql';
const ID_PAGE = 500;      // 후보 QID 페이지 크기
const DETAIL_BATCH = 80;  // 상세 조회 VALUES 묶음 크기
const DISH = 'Q746549';
// 음료·비식품 등 제외할 상위 클래스(하위 클래스 포함해서 MINUS)
const EXCLUDE_QIDS = [
  'Q40050',   // drink
  'Q154410',  // alcoholic beverage
];

// ---- 원산지 국가 → cuisine ------------------------------------------------
const COUNTRY_CUISINE = {};
const put = (cuisine, ...qids) => qids.forEach((q) => (COUNTRY_CUISINE[q] = cuisine));
put('korean', 'Q884', 'Q423', 'Q18097', 'Q28233');          // 한국, 북한, 한반도(Korea), 대한제국
put('japanese', 'Q17', 'Q1752937');                          // 일본
put('chinese', 'Q148', 'Q865', 'Q8646', 'Q14773', 'Q29520', 'Q13426199'); // 중국, 대만, 홍콩, 마카오, 중국(구분 다양)
put('vietnamese', 'Q881');
put('mexican', 'Q96');
put('thai', 'Q869');
put('indian', 'Q668', 'Q843', 'Q902', 'Q837', 'Q854');       // 인도, 파키스탄, 방글라데시, 네팔, 스리랑카(남아시아)
put('western',                                                // 서양권(미국/영국/프랑스/이탈리아/스페인/독일 외 유럽·북미·오세아니아 주요국)
  'Q30', 'Q145', 'Q142', 'Q38', 'Q29', 'Q183', 'Q40', 'Q39', 'Q55', 'Q31', 'Q45', 'Q41', 'Q159',
  'Q36', 'Q27', 'Q34', 'Q35', 'Q20', 'Q33', 'Q28', 'Q213', 'Q408', 'Q16', 'Q414', 'Q211', 'Q37', 'Q191',
  'Q233', 'Q214', 'Q403', 'Q224', 'Q215', 'Q218', 'Q219', 'Q189', 'Q347', 'Q26', 'Q21', 'Q22', 'Q25', 'Q664');

// P2012(요리 계통) 영문 라벨 정규식 폴백
const CUISINE_LABEL_RULES = [
  [/korean/i, 'korean'], [/japanese/i, 'japanese'], [/chinese|cantonese|sichuan|hong kong|taiwanese|shanghai|hunan/i, 'chinese'],
  [/vietnam/i, 'vietnamese'], [/mexic|tex-mex/i, 'mexican'], [/thai/i, 'thai'], [/indian|pakistani|bangladesh|nepal|sri lank/i, 'indian'],
  [/american|british|english|french|italian|spanish|german|austrian|swiss|dutch|belgian|portuguese|greek|russian|polish|irish|scandinavian|swedish|danish|norwegian|finnish|hungarian|czech|european|australian|canadian|argentin|scottish|welsh/i, 'western'],
];

// ---- 제외 규칙(음료·비식품·기타 이상 항목) --------------------------------
const BAD_LABEL = /(맥주|와인|소주|막걸리|위스키|칵테일|s차$|커피|음료|주스|스무디|소다|콜라|우유$|사케|리큐어|브랜디|보드카|증류|양조|\(음료\)|\(disambiguation\)|동음이의|분류:|목록|식당|레스토랑|체인|회사|기업|브랜드|지역 요리|요리법$|^요리$|조리법|식문화|문화$|식단|축제|도시$|^[A-Za-z0-9 ._-]+$)/;
// P31(직접 인스턴스) 영문 라벨이 아래와 '정확히' 일치하면 비요리로 간주
const BAD_INSTANCE_LABEL = /^(beverage|drink|alcoholic beverage|liquor|wine|beer|tea|coffee|restaurant|company|brand|food brand|trademark|restaurant chain|disambiguation page|list|cuisine|culinary art|cooking technique|ingredient|food ingredient|spice|herb|plant|fruit|vegetable|animal|species|taxon|chemical compound|food additive|diet|food group|sauce|condiment|seasoning|spread|dip|powder|granular material|instant stock|cough drop|chewing gum|military operation|event|historical event|battle|massacre|article)$/i;

// ---- SPARQL ---------------------------------------------------------------
// 1단계: 후보 QID 목록(가벼운 쿼리, LIMIT/OFFSET 페이지네이션)
function buildIdQuery(offset, limit) {
  const minus = EXCLUDE_QIDS.map((q) => `MINUS { ?d wdt:P31/wdt:P279* wd:${q} . }`).join(' ');
  return `SELECT DISTINCT ?d WHERE {
    ?d wdt:P31/wdt:P279* wd:${DISH} .
    ?d rdfs:label ?l . FILTER(LANG(?l) = "ko")
    ${minus}
  } ORDER BY ?d LIMIT ${limit} OFFSET ${offset}`;
}

// 2단계: QID 묶음(VALUES)별 상세 정보
function buildDetailQuery(qids) {
  return `
SELECT ?d
  (SAMPLE(?lk) AS ?ko) (SAMPLE(?le) AS ?en) (SAMPLE(?dk) AS ?descKo)
  (GROUP_CONCAT(DISTINCT STRAFTER(STR(?o), "entity/"); separator="|") AS ?origins)
  (GROUP_CONCAT(DISTINCT STRAFTER(STR(?o17), "entity/"); separator="|") AS ?origins17)
  (GROUP_CONCAT(DISTINCT ?cuisLabel; separator="|") AS ?cuisines)
  (GROUP_CONCAT(DISTINCT STRAFTER(STR(?inst), "entity/"); separator="|") AS ?instQ)
  (GROUP_CONCAT(DISTINCT ?instLabel; separator="|") AS ?instEn)
  (GROUP_CONCAT(DISTINCT ?ingLabel; separator="|") AS ?ings)
  (SAMPLE(?art) AS ?article)
WHERE {
  VALUES ?d { ${qids.map((q) => 'wd:' + q).join(' ')} }
  ?d rdfs:label ?lk . FILTER(LANG(?lk) = "ko")
  OPTIONAL { ?d rdfs:label ?le . FILTER(LANG(?le) = "en") }
  OPTIONAL { ?d schema:description ?dk . FILTER(LANG(?dk) = "ko") }
  OPTIONAL { ?d wdt:P495 ?o . OPTIONAL { ?o wdt:P17 ?o17 } }
  OPTIONAL { ?d wdt:P2012 ?cu . ?cu rdfs:label ?cuisLabel . FILTER(LANG(?cuisLabel) = "en") }
  OPTIONAL { ?d wdt:P31 ?inst . OPTIONAL { ?inst rdfs:label ?instLabel . FILTER(LANG(?instLabel) = "en") } }
  OPTIONAL { ?d (wdt:P527|wdt:P186) ?ing . ?ing rdfs:label ?ingLabel . FILTER(LANG(?ingLabel) = "ko") }
  OPTIONAL { ?art schema:about ?d ; schema:isPartOf <https://ko.wikipedia.org/> . }
}
GROUP BY ?d`;
}

async function sparql(query, fresh) {
  const json = await fetchJson(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/sparql-results+json' },
    body: new URLSearchParams({ query }).toString(), noCache: fresh,
  });
  return json.results.bindings;
}

const v = (b, k) => (b[k]?.value ?? '').trim();
const split = (s) => (s ? s.split('|').filter(Boolean) : []);

function classify(b) {
  const origins = split(v(b, 'origins'));
  const o17 = split(v(b, 'origins17'));
  for (const q of origins) if (COUNTRY_CUISINE[q]) return { cuisine: COUNTRY_CUISINE[q], how: 'P495' };
  for (const q of o17) if (COUNTRY_CUISINE[q]) return { cuisine: COUNTRY_CUISINE[q], how: 'P495>P17' };
  for (const lab of split(v(b, 'cuisines'))) {
    for (const [re, c] of CUISINE_LABEL_RULES) if (re.test(lab)) return { cuisine: c, how: 'P2012' };
  }
  return { cuisine: 'other', how: 'none' };
}

function rejectReason(b, ko) {
  if (!ko || !HANGUL.test(ko)) return 'no-hangul-label';
  if (/^Q\d+$/.test(ko)) return 'label-is-qid';
  if (BAD_LABEL.test(ko)) return 'bad-label';
  const bad = split(v(b, 'instEn')).find((l) => BAD_INSTANCE_LABEL.test(l));
  if (bad) return 'bad-instance:' + bad;
  return null;
}

export async function main(argv = process.argv.slice(2)) {
  const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const outPath = join(RAW_DIR, 'wikidata.json');
  if (argv.includes('--report')) return report(await readJson(outPath));
  const fresh = argv.includes('--fresh');
  const maxItems = arg('--limit') ? Number(arg('--limit')) : Infinity;

  const dict = await loadIngredientDict();
  // 1단계: QID 목록
  const qids = [];
  for (let offset = 0; qids.length < maxItems; offset += ID_PAGE) {
    const limit = Math.min(ID_PAGE, maxItems - qids.length);
    process.stderr.write(`[wikidata] ids offset=${offset} limit=${limit} ... `);
    const bs = await sparql(buildIdQuery(offset, limit), fresh);
    process.stderr.write(`${bs.length}
`);
    qids.push(...bs.map((b) => v(b, 'd').replace(/^.*entity\//, '')));
    if (bs.length < limit) break;
  }
  // 2단계: 상세
  const rows = [];
  for (let i = 0; i < qids.length; i += DETAIL_BATCH) {
    const chunk = qids.slice(i, i + DETAIL_BATCH);
    process.stderr.write(`[wikidata] detail ${i}/${qids.length} ... `);
    const bs = await sparql(buildDetailQuery(chunk), fresh);
    process.stderr.write(`${bs.length}
`);
    rows.push(...bs);
  }

  const rejected = {};
  const items = [];
  const usedIds = new Set();
  const seen = new Set();
  for (const b of rows.sort((a, c) => v(a, 'd').localeCompare(v(c, 'd')))) {
    const qid = v(b, 'd').replace(/^.*entity\//, '');
    if (seen.has(qid)) continue;
    seen.add(qid);
    const ko = v(b, 'ko');
    const why = rejectReason(b, ko);
    if (why) { const k = why.split(':')[0]; (rejected[k] ??= []).push(`${qid} ${ko}`); continue; }

    const { cuisine, how } = classify(b);
    const en = v(b, 'en');
    const base = `${CUISINE_ABBR[cuisine]}-${slugify(en) || qid.toLowerCase()}`;
    let id = base;
    if (usedIds.has(id)) id = `${base}-${qid.toLowerCase()}`;
    usedIds.add(id);

    const desc = v(b, 'descKo');
    const text = `${ko} ${desc}`;
    const ingFromWd = split(v(b, 'ings'));
    // 위키데이터 구성 재료(P527/P186) 라벨은 사전에 있는 표준 재료로만 인정
    const canonSet = new Set(Object.keys(dict.map));
    const ingredients = Array.from(new Set([
      ...ingFromWd.filter((x) => canonSet.has(x)),
      ...extractIngredients(text, dict),
    ])).slice(0, 6);
    const article = v(b, 'article');
    const wpTitle = article ? decodeURIComponent(article.replace(/^https:\/\/ko\.wikipedia\.org\/wiki\//, '')).replace(/_/g, ' ') : null;

    items.push({
      id, name: ko, cuisine,
      ingredients,
      tags: extractTags(text, ko),
      desc,
      source: 'wikidata',
      attribution: `Wikidata (CC0) https://www.wikidata.org/wiki/${qid}`,
      _wd: { qid, en: en || null, cuisineBy: how, origins: split(v(b, 'origins')), wpTitle, instances: split(v(b, 'instQ')) },
    });
  }

  await writeJson(outPath, items);
  console.log(`rows=${rows.length} kept=${items.length} rejected=${Object.values(rejected).reduce((a, x) => a + x.length, 0)}`);
  for (const [k, arr] of Object.entries(rejected)) console.log(`  rejected[${k}] ${arr.length}: ${arr.slice(0, 8).join(' / ')}`);
  console.log(`ingredient dict: ${dict.source}`);
  report(items);
}

function report(items) {
  const dist = {}; const how = {};
  for (const it of items) { dist[it.cuisine] = (dist[it.cuisine] ?? 0) + 1; how[it._wd.cuisineBy] = (how[it._wd.cuisineBy] ?? 0) + 1; }
  console.log('count:', items.length);
  console.log('cuisine:', JSON.stringify(dist));
  console.log('cuisineBy:', JSON.stringify(how));
  console.log('with desc:', items.filter((i) => i.desc).length, ' short desc(<15):', items.filter((i) => i.desc.length < 15).length,
    ' with ingredients:', items.filter((i) => i.ingredients.length).length, ' with wiki article:', items.filter((i) => i._wd.wpTitle).length);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
