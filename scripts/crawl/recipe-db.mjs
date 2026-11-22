#!/usr/bin/env node
// recipe-db.mjs — 식품안전나라(식품의약품안전처) 조리식품의 레시피 DB(COOKRCP01) 수집 "골격".
// ※ 이번 범위에서는 실행하지 않음(API 키 필요). 키 없이 실행하면 안내만 출력하고 종료(exit 0).
//
// 사용법:
//   1) https://www.foodsafetykorea.go.kr/api/ 에서 인증키 발급(무료, 회원가입) 후
//   2) PowerShell:  $env:RECIPE_API_KEY = "발급키"; node scripts/crawl/recipe-db.mjs [--limit 200]
//      bash:        RECIPE_API_KEY=발급키 node scripts/crawl/recipe-db.mjs
//   결과: data/raw/recipe-db.json (SPEC 메뉴 스키마, source:'recipe-db')
//
// 엔드포인트(공식 OpenAPI): http://openapi.foodsafetykorea.go.kr/api/{KEY}/COOKRCP01/json/{START}/{END}
//   주요 필드: RCP_NM(메뉴명) RCP_WAY2(조리방법) RCP_PAT2(요리종류) RCP_PARTS_DTLS(재료) HASH_TAG
//   (※ 필드명은 발급 후 실제 응답으로 한 번 확인할 것 — 미검증 골격)
// 요청 규칙: UA 고정, 요청 간 >=1.2초, 실패 시 지수 백오프 3회, 응답 캐시(data/raw/.cache/).
//   키는 URL 경로에 들어가므로 cacheKey/logUrl 로 캐시 파일·오류 메시지에서 마스킹한다.
// 라이선스/표기: 식품의약품안전처 공공데이터 — attribution 에 출처를 남긴다(이용약관은 키 발급 시 확인).
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetchJson, writeJson, RAW_DIR, slugify, extractIngredients, extractTags, loadIngredientDict } from './lib.mjs';

const BASE = 'http://openapi.foodsafetykorea.go.kr/api';
const PAGE = 100;
const ATTRIBUTION = '식품의약품안전처 식품안전나라 조리식품의 레시피 DB(COOKRCP01)';

// RCP_PAT2(요리종류) → tags 보조
const PAT_TAG = { '반찬': '반찬', '국&찌개': '국물', '후식': '디저트', '밥': '밥요리', '일품': '든든한' };
const WAY_TAG = { '찌기': '찜', '끓이기': '국물', '굽기': '구이', '볶기': '볶음', '튀기기': '튀김' };

export async function main(argv = process.argv.slice(2)) {
  const key = process.env.RECIPE_API_KEY;
  if (!key) {
    console.log([
      '[recipe-db] 환경변수 RECIPE_API_KEY 가 없습니다. 아무 것도 수집하지 않고 종료합니다.',
      '  - 식품안전나라 OpenAPI(https://www.foodsafetykorea.go.kr/api/)에서 인증키를 발급받으세요.',
      '  - 실행: RECIPE_API_KEY=발급키 node scripts/crawl/recipe-db.mjs --limit 200',
    ].join('\n'));
    return;
  }
  const i = argv.indexOf('--limit');
  const limit = i >= 0 ? Number(argv[i + 1]) : Infinity;
  const dict = await loadIngredientDict();

  const items = [];
  const used = new Set();
  for (let start = 1; items.length < limit; start += PAGE) {
    const end = start + PAGE - 1;
    const data = await fetchJson(`${BASE}/${key}/COOKRCP01/json/${start}/${end}`, {
      cacheKey: `COOKRCP01 ${start}-${end}`, // 키를 캐시 키에 넣지 않는다
      logUrl: `${BASE}/<KEY>/COOKRCP01/json/${start}/${end}`,
    });
    const block = data?.COOKRCP01;
    const rows = block?.row ?? [];
    if (block?.RESULT?.CODE && block.RESULT.CODE !== 'INFO-000' && !rows.length) {
      if (block.RESULT.CODE === 'INFO-200') break; // 데이터 없음 = 끝
      throw new Error(`COOKRCP01 error ${block.RESULT.CODE}: ${block.RESULT.MSG}`);
    }
    for (const r of rows) {
      const name = (r.RCP_NM ?? '').trim();
      if (!name) continue;
      const ingText = (r.RCP_PARTS_DTLS ?? '').replace(/\s+/g, ' ');
      const text = `${name} ${ingText}`;
      const tags = Array.from(new Set([
        ...extractTags(text, name), PAT_TAG[r.RCP_PAT2], WAY_TAG[r.RCP_WAY2],
        ...String(r.HASH_TAG ?? '').split(/[,#\s]+/).filter((t) => t && t.length <= 6),
      ].filter(Boolean))).slice(0, 6);
      let id = `kr-rcp-${r.RCP_SEQ ?? slugify(name) ?? items.length}`;
      if (used.has(id)) id += `-${items.length}`;
      used.add(id);
      items.push({
        id, name, cuisine: 'korean',
        ingredients: extractIngredients(ingText, dict),
        tags,
        desc: [r.RCP_PAT2, r.RCP_WAY2].filter(Boolean).join(' · ') ? `${[r.RCP_WAY2, r.RCP_PAT2].filter(Boolean).join(' ')} 요리.` : '',
        source: 'recipe-db',
        attribution: ATTRIBUTION,
      });
    }
    if (rows.length < PAGE) break;
  }
  await writeJson(join(RAW_DIR, 'recipe-db.json'), items.slice(0, limit));
  console.log(`[recipe-db] saved ${Math.min(items.length, limit)} items -> data/raw/recipe-db.json`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
