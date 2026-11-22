#!/usr/bin/env node
// enrich.mjs — wikidata.json + wikipedia.json 을 합쳐 설명/재료/태그 초안을 만든 최종 원시 후보 data/raw/menus.raw.json 생성.
//
// 사용법:
//   node scripts/crawl/enrich.mjs               # 전체 병합
//   node scripts/crawl/enrich.mjs --drop-empty  # 설명이 끝내 비어 있는 항목 제외
//   node scripts/crawl/enrich.mjs --keep-nonfood # 소스/양념/음료 등 비메뉴 필터 해제
//
// 규칙:
//   - 위키백과 요약이 있으면 desc 를 그것으로 교체하고 source:'wikipedia', attribution 에 위키백과(CC BY-SA 4.0)+Wikidata(CC0) 병기.
//   - 없으면 wikidata 설명 유지(source:'wikidata').
//   - ingredients/tags 는 name+desc 에서 키워드 추출(사전: data/dict/ingredients.json 이 있으면 그것, 없으면 내장 소규모 사전).
//     확신이 없으면 비워 둔다(한 글자 별칭은 오탐 방지를 위해 제외). 위키데이터 구성 재료(P527/P186)로 얻은 재료는 유지.
//   - _wd 보조 필드는 그대로 둔다(merge 단계에서 제거 가능).
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJson, writeJson, RAW_DIR, CUISINE_ABBR, extractIngredients, extractTags, loadIngredientDict } from './lib.mjs';

// 원산지 정보가 없어 'other' 로 남은 항목을 설명 첫 문장("~는 일본의 ...")으로 보정. 확신 높은 패턴만 사용.
const DESC_COUNTRIES = {
  northkorean: '북한',
  korean: '한국|조선|대한민국',
  japanese: '일본|오키나와',
  chinese: '중국|대만|타이완|홍콩|마카오|광둥|쓰촨|상하이',
  vietnamese: '베트남', mexican: '멕시코', thai: '태국', indian: '인도|파키스탄|방글라데시|네팔',
  western: '미국|영국|프랑스|이탈리아|스페인|독일|오스트리아|스위스|네덜란드|벨기에|포르투갈|그리스|러시아|폴란드|아일랜드|스웨덴|덴마크|노르웨이|핀란드|헝가리|체코|캐나다|호주|아르헨티나|스코틀랜드',
};
const DESC_RES = Object.entries(DESC_COUNTRIES).map(([c, names]) => [c, new RegExp(`(${names})(인)?(의|식|에서|\s*전통|\s*요리|\s*음식|\s*디저트|\s*과자)`)]);
export function cuisineFromDesc(desc) {
  const first = (desc ?? '').split(/(?<=[.!?。])s+/)[0] ?? '';
  let best = null;
  for (const [c, re] of DESC_RES) {
    const m = re.exec(first);
    if (m && (best === null || m.index < best.idx)) best = { c, idx: m.index };
  }
  return best?.c ?? null;
}

// 소스·양념·음료 등 "메뉴가 아닌" 항목을 설명 첫 문장으로 걸러냄(기본 적용, --keep-nonfood 로 해제)
const NONFOOD_FIRST = /(소스|드레싱|양념|조미료|향신료|음료|주류|칵테일|커피|술|s차|식물|과일|채소)(이다|이며|의 일종이다|의 한 종류이다|의 하나이다)/;
export function looksNonFood(desc) {
  const first = (desc ?? '').split(/(?<=[.!?。])s+/)[0] ?? '';
  return NONFOOD_FIRST.test(first);
}

export async function main(argv = process.argv.slice(2)) {
  const dropEmpty = argv.includes('--drop-empty');
  const keepNonFood = argv.includes('--keep-nonfood');
  const dropped = [];
  const items = await readJson(join(RAW_DIR, 'wikidata.json'));
  const wp = await readJson(join(RAW_DIR, 'wikipedia.json'), {});
  const dict = await loadIngredientDict();
  const canon = new Set(Object.keys(dict.map));

  const out = [];
  const usedIds = new Set();
  let fromWp = 0;
  for (const it of items) {
    const w = wp[it._wd.qid];
    const next = { ...it };
    if (w) {
      next.desc = w.desc;
      next.source = 'wikipedia';
      next.attribution = `${w.attribution}; Wikidata CC0 https://www.wikidata.org/wiki/${it._wd.qid}`;
      fromWp++;
    }
    if (next.cuisine === 'other') {
      const c = cuisineFromDesc(next.desc);
      if (c) {
        next.cuisine = c;
        next._wd = { ...next._wd, cuisineBy: 'desc' };
        next.id = next.id.replace(/^[a-z]{2}-/, `${CUISINE_ABBR[c]}-`); // id 접두어를 cuisine 약자와 일치시킴
      }
    }
    if (usedIds.has(next.id)) next.id += `-${it._wd.qid.toLowerCase()}`;
    usedIds.add(next.id);
    if (!keepNonFood && looksNonFood(next.desc)) { dropped.push(`${next.name}: ${next.desc.slice(0, 40)}`); continue; }
    // 포도주/와인 때문에 '포도' 재료가 오탐되는 것 방지
    const text = `${next.name} ${next.desc}`.replace(/포도주|와인/g, '');
    // 기존(위키데이터 구성 재료로 확보된) 재료는 사전 표준명인 것만 유지 + 텍스트 추출분
    next.ingredients = Array.from(new Set([
      ...it.ingredients.filter((x) => canon.has(x)),
      ...extractIngredients(text, dict),
    ])).slice(0, 6);
    next.tags = extractTags(text, next.name);
    if (dropEmpty && !next.desc) continue;
    out.push(next);
  }
  await writeJson(join(RAW_DIR, 'menus.raw.json'), out);
  if (dropped.length) console.log(`[enrich] non-food filtered ${dropped.length}: ${dropped.slice(0, 15).join(' / ')}`);
  console.log(`[enrich] total=${out.length} fromWikipedia=${fromWp} emptyDesc=${out.filter((i) => !i.desc).length} ` +
    `withIngredients=${out.filter((i) => i.ingredients.length).length} withTags=${out.filter((i) => i.tags.length).length} dict=${dict.source}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
