#!/usr/bin/env node
// wikipedia.mjs — 설명이 비었거나 짧은 wikidata 항목을 한국어 위키백과 REST 요약 API로 보강.
//
// 사용법:
//   node scripts/crawl/wikipedia.mjs               # data/raw/wikidata.json 읽어 data/raw/wikipedia.json 생성
//   node scripts/crawl/wikipedia.mjs --min-len 20  # 이 길이 미만 설명만 보강(기본 20자)
//   node scripts/crawl/wikipedia.mjs --limit 50    # 처음 N개만(테스트)
//   node scripts/crawl/wikipedia.mjs --fresh       # 캐시 무시
//   이후 `node scripts/crawl/enrich.mjs` 가 wikidata.json + wikipedia.json 을 합쳐 재료/태그 초안까지 생성한다.
//
// 요청 규칙: GET https://ko.wikipedia.org/api/rest_v1/page/summary/{title}
//   - UA 'MenuSuggestionBot/0.1 (hobby project)', 요청 간 >=1.2초(직렬), 실패 시 지수 백오프 3회, 응답은 data/raw/.cache/ 캐시(이어받기).
//   - 공식 문서화된 REST API 사용(Wikimedia API 에티켓 준수). ko.wikipedia.org/robots.txt 는 일반 크롤러에게 /api/ 를 막고 있으나,
//     이 엔드포인트는 UA 정책 하의 프로그램 접근용 공식 API이며 저속(<1 req/s)으로만 호출한다.
// 라이선스: 위키백과 본문은 CC BY-SA 4.0. 요약 1~2문장을 그대로 인용하며 문서 URL을 attribution에 남긴다.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetchJson, readJson, writeJson, RAW_DIR } from './lib.mjs';

const API = 'https://ko.wikipedia.org/api/rest_v1/page/summary/';
export const WP_ATTRIBUTION = 'Wikipedia CC BY-SA 4.0';

/** 괄호(로마자·한자·발음 표기 등) 제거 + 공백 정리 */
function stripParens(t) {
  let prev;
  do { prev = t; t = t.replace(/\([^()]*\)|（[^（）]*）|\[[^\]]*\]/g, ''); } while (t !== prev);
  return t.replace(/\s+([,.])/g, '$1').replace(/\s{2,}/g, ' ').trim();
}

/** 한국어 문장 단위로 최대 2문장, 최대 maxLen자로 자르기 */
export function summarize(extract, maxLen = 160) {
  const clean = stripParens(extract.replace(/\s+/g, ' '));
  const sents = clean.split(/(?<=[.!?。])\s+/).filter(Boolean);
  let out = '';
  for (const s of sents.slice(0, 2)) {
    if (out && (out + ' ' + s).length > maxLen) break;
    out = out ? out + ' ' + s : s;
  }
  if (!out) out = clean;
  return out.length > maxLen ? out.slice(0, maxLen - 1).replace(/[\s,]+\S*$/, '') + '…' : out;
}

export async function main(argv = process.argv.slice(2)) {
  const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const minLen = Number(arg('--min-len') ?? 20);
  const limit = arg('--limit') ? Number(arg('--limit')) : Infinity;
  const fresh = argv.includes('--fresh');

  const items = await readJson(join(RAW_DIR, 'wikidata.json'));
  const targets = items.filter((it) => it._wd?.wpTitle && (it.desc?.length ?? 0) < minLen).slice(0, limit);
  console.log(`[wikipedia] targets=${targets.length} / ${items.length} (desc<${minLen}, ko article exists)`);

  const outPath = join(RAW_DIR, 'wikipedia.json');
  const result = {};
  let ok = 0, miss = 0, i = 0;
  for (const it of targets) {
    i++;
    const title = it._wd.wpTitle;
    try {
      const data = await fetchJson(API + encodeURIComponent(title.replace(/ /g, '_')), {
        headers: { Accept: 'application/json' }, allow404: true, noCache: fresh,
      });
      if (!data || data.type === 'disambiguation' || !data.extract) { miss++; continue; }
      const desc = summarize(data.extract);
      if (desc.length < 10) { miss++; continue; }
      const pageUrl = data.content_urls?.desktop?.page ?? `https://ko.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
      result[it._wd.qid] = {
        qid: it._wd.qid, title: data.title ?? title, desc, url: pageUrl,
        attribution: `${WP_ATTRIBUTION} (${decodeURI(pageUrl)})`,
      };
      ok++;
    } catch (e) {
      miss++; console.warn(`  ! ${title}: ${e.message}`);
    }
    if (i % 25 === 0) { console.log(`  ${i}/${targets.length} ok=${ok} miss=${miss}`); await writeJson(outPath, result); }
  }
  await writeJson(outPath, result);
  console.log(`[wikipedia] done ok=${ok} miss=${miss} -> data/raw/wikipedia.json`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
