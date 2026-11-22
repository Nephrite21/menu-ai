#!/usr/bin/env node
// merge.mjs - data/menus/*.json + data/raw/*.json -> data/merged.json (C 소유)
//
// 사용법:
//   node scripts/merge.mjs                    # 기본: data/merged.json 생성
//   node scripts/merge.mjs --out path.json    # 출력 경로 지정
//   node scripts/merge.mjs --no-raw           # data/raw 를 읽지 않고 큐레이션만 병합
//   node scripts/merge.mjs --quiet
//
// 동작:
//   1) data/menus/*.json 을 엄격 기준으로 검증한다(실패하면 중단, 종료 코드 1).
//   2) data/raw/*.json(E 크롤러 산출물, 없어도 동작)을 느슨한 기준으로 읽는다.
//      허용 필드만 복사(_wd 같은 보조 필드는 버림), 기준 미달 항목은 경고와 함께 제외한다.
//   3) 정규화: 공백/NFC 정리, 태그·재료 중복 제거, 재료명 별칭 → 표준명(data/dict/ingredients.json 이 있으면 사용),
//      id 접두어를 cuisine 약자에 맞춤.
//   4) 이름(+brand) 기준 중복 제거. 소스 우선순위: curated > franchise > recipe-db > wikipedia > wikidata > user.
//      이긴 항목에 빈 필드(재료/태그)가 있으면 진 항목에서 채운다.
//   5) cuisine -> id 순으로 정렬해 data/merged.json 으로 저장(메뉴 1개 = 1줄, diff 친화적). 벡터는 없음(D 의 embed 단계에서 생성).
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, relative, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CUISINES, CUISINE_ABBR, SOURCE_PRIORITY, validateMenu, nameKey } from '../web/js/store.js';
import { ROOT, MENUS_DIR, RAW_DIR, listJson, readJsonFile, validateMenusDir } from './validate.mjs';

export const DEFAULT_OUT = join(ROOT, 'data', 'merged.json');
const DICT_PATH = join(ROOT, 'data', 'dict', 'ingredients.json');

const prio = (source) => {
  const i = SOURCE_PRIORITY.indexOf(source);
  return i === -1 ? SOURCE_PRIORITY.length : i;
};

// ---------------------------------------------------------------------------
// 재료 별칭 사전(B 소유 data/dict/ingredients.json, 형식 미확정이라 관대하게 파싱)
//   허용: { "닭고기": ["닭", "치킨"] } | { "ingredients": {...} } | { "닭고기": { aliases: [...] } }
//         | [ { name|canonical, aliases|synonyms: [] } ] | { "별칭": "표준명" }
// ---------------------------------------------------------------------------
// 비교 키: NFC + 소문자 + 공백/하이픈 제거 (B 의 ingredients.json 규칙과 동일)
export const aliasKey = (s) => String(s).normalize('NFC').toLowerCase().replace(/[s-]+/g, '');

export function buildAliasMap(raw) {
  const alias = new Map(); // aliasKey(별칭) -> 표준명
  const add = (canon, list = []) => {
    if (typeof canon !== 'string' || !canon.trim()) return;
    const c = canon.trim();
    if (!alias.has(aliasKey(c))) alias.set(aliasKey(c), c);
    for (const a of list) if (typeof a === 'string' && a.trim() && !alias.has(aliasKey(a))) alias.set(aliasKey(a), c);
  };
  const walk = (obj) => {
    if (Array.isArray(obj)) {
      for (const it of obj) {
        if (typeof it === 'string') add(it);
        else if (it && typeof it === 'object') add(it.name ?? it.canonical, it.aliases ?? it.synonyms ?? []);
      }
    } else if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        if (k.startsWith('_')) continue; // "_comment" 등 메타 키 무시
        if (Array.isArray(v)) add(k, v);
        else if (v && typeof v === 'object') add(k, v.aliases ?? v.synonyms ?? []);
        else if (typeof v === 'string') add(v, [k]);
      }
    }
  };
  const root = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw.ingredients ?? raw.canonical ?? raw) : raw;
  walk(root);
  return alias;
}

async function loadAliasMap() {
  const r = await readJsonFile(DICT_PATH);
  if (r.error) return { map: new Map(), used: false };
  const map = buildAliasMap(r.data);
  return { map, used: map.size > 0 };
}

// ---------------------------------------------------------------------------
// 정규화
// ---------------------------------------------------------------------------
const slugPart = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function fixId(menu, usedIds) {
  const abbr = CUISINE_ABBR[menu.cuisine];
  let id = menu.id;
  if (!id || !/^[a-z]{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || !id.startsWith(`${abbr}-`)) {
    const rest = slugPart(String(id || '').replace(/^[a-z]{2,4}-/, ''));
    id = `${abbr}-${rest || `x${hash36(menu.name)}`}`;
  }
  id = id.slice(0, 64).replace(/-+$/g, '');
  let candidate = id; let n = 2;
  while (usedIds.has(candidate)) candidate = `${id.slice(0, 60)}-${n++}`;
  return candidate;
}

function hash36(s) {
  let h = 5381;
  for (const ch of String(s)) h = ((h << 5) + h + ch.codePointAt(0)) >>> 0;
  return h.toString(36);
}

function normalizeLists(menu, aliasMap) {
  const mapIng = (x) => aliasMap.get(aliasKey(x)) ?? x;
  const ingredients = [...new Set(menu.ingredients.map(mapIng))];
  const tags = [...new Set(menu.tags)];
  return { ...menu, ingredients, tags };
}

// ---------------------------------------------------------------------------
// 병합 코어(테스트에서도 사용)
// ---------------------------------------------------------------------------
/**
 * @param {Array<{menu: object, origin: string}>} candidates 검증을 통과한 후보(원본 순서 유지)
 * @param {Map<string,string>} aliasMap
 * @returns {{ menus: object[], duplicates: number, merged: Array<{kept:string, dropped:string, reason:string}> }}
 */
export function mergeCandidates(candidates, aliasMap = new Map()) {
  const order = candidates.map((c, i) => ({ ...c, i, p: prio(c.menu.source) }));
  order.sort((a, b) => a.p - b.p || a.i - b.i);

  const byKey = new Map();
  const usedIds = new Set();
  const out = [];
  const merged = [];
  let duplicates = 0;

  for (const { menu, origin } of order) {
    const m = normalizeLists(menu, aliasMap);
    const key = nameKey(m.name, m.brand);
    const winner = byKey.get(key);
    if (winner) {
      duplicates++;
      // 이긴 항목의 빈 필드만 보충
      if (!winner.ingredients.length && m.ingredients.length) winner.ingredients = m.ingredients;
      if (!winner.tags.length && m.tags.length) winner.tags = m.tags;
      merged.push({ kept: `${winner.source}:${winner.id}`, dropped: `${m.source}:${m.id ?? origin}`, reason: 'same name' });
      continue;
    }
    const id = fixId(m, usedIds);
    usedIds.add(id);
    const kept = { ...m, id };
    byKey.set(key, kept);
    out.push(kept);
  }

  const cuisineOrder = new Map(CUISINES.map((c, i) => [c, i]));
  out.sort((a, b) => cuisineOrder.get(a.cuisine) - cuisineOrder.get(b.cuisine) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { menus: out, duplicates, merged };
}

function toJsonLines(menus) {
  if (!menus.length) return '[]\n';
  return `[\n${menus.map((m) => JSON.stringify(m)).join(',\n')}\n]\n`;
}

// ---------------------------------------------------------------------------
// 메인
// ---------------------------------------------------------------------------
async function loadRaw(files, log) {
  const candidates = [];
  const dropReasons = new Map();
  let total = 0; let noInfo = 0;
  const perFile = [];
  for (const f of files) {
    const r = await readJsonFile(f);
    const name = basename(f);
    if (r.error) { log.warn(`[raw] ${name}: JSON 을 읽을 수 없어 건너뜀 (${r.error})`); continue; }
    const list = Array.isArray(r.data) ? r.data : (r.data && Array.isArray(r.data.menus) ? r.data.menus : null);
    if (!list) { log.warn(`[raw] ${name}: 메뉴 배열이 아니어서 건너뜀`); continue; }
    let accepted = 0;
    list.forEach((m, idx) => {
      total++;
      const v = validateMenu(m, { strict: false, allowVec: false, fillDefaults: true, checkIdPrefix: false });
      if (!v.ok) {
        const reason = v.errors[0].replace(/\[\d+\]/g, '[]').replace(/\(.*?\)/g, '').slice(0, 60);
        dropReasons.set(reason, (dropReasons.get(reason) || 0) + 1);
        return;
      }
      const c = v.menu;
      if (!c.ingredients.length && !c.tags.length && !c.desc) { noInfo++; return; }
      candidates.push({ menu: c, origin: `${name}[${idx}]` });
      accepted++;
    });
    perFile.push({ file: name, accepted, total: list.length });
  }
  return { candidates, dropReasons, total, noInfo, perFile };
}

export async function runMerge({ out = DEFAULT_OUT, useRaw = true, quiet = false } = {}) {
  const log = {
    info: (...a) => { if (!quiet) console.log(...a); },
    warn: (...a) => console.warn(...a),
  };

  // 1) 큐레이션(엄격)
  const cur = await validateMenusDir(MENUS_DIR);
  if (cur.errors.length) {
    console.error(`data/menus 검증 실패: 오류 ${cur.errors.length}건 (node scripts/validate.mjs 로 확인)`);
    for (const e of cur.errors.slice(0, 20)) console.error(`  - ${e}`);
    return { ok: false };
  }
  const candidates = cur.menus.map((menu, i) => ({ menu, origin: `menus#${i}` }));
  const curatedCount = candidates.length;

  // 2) 원시 데이터(느슨)
  let raw = { candidates: [], dropReasons: new Map(), total: 0, noInfo: 0, perFile: [] };
  if (useRaw) {
    // 크롤러 파이프라인: crawl → (menus.raw.json) → infer-cuisine → (menus.inferred.json) → merge.
    // 가장 하류의 최종 산출물 하나만 읽는다(wikidata.json/wikipedia.json 은 중간 산출물이라 중복·구버전이 섞인다).
    // 어느 것도 없으면 예전 방식대로 data/raw/*.json 전체를 읽는다.
    const all = (await listJson(RAW_DIR)).filter((f) => !basename(f).startsWith('_')); // "_" 접두 파일은 중간 산출물로 간주
    const pick = (name) => all.filter((f) => basename(f) === name);
    const files = pick('menus.inferred.json').length ? pick('menus.inferred.json')
      : pick('menus.raw.json').length ? pick('menus.raw.json') : all;
    log.info(`[raw] 입력: ${files.map((f) => basename(f)).join(', ') || '(없음)'}`);
    raw = await loadRaw(files, log);
    candidates.push(...raw.candidates);
  }

  // 3~4) 정규화 + 중복 제거
  const { map: aliasMap, used: dictUsed } = await loadAliasMap();
  const res = mergeCandidates(candidates, aliasMap);

  // 5) 저장
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, toJsonLines(res.menus), 'utf8');

  const bySource = new Map(); const byCuisine = new Map();
  for (const m of res.menus) {
    bySource.set(m.source, (bySource.get(m.source) || 0) + 1);
    byCuisine.set(m.cuisine, (byCuisine.get(m.cuisine) || 0) + 1);
  }
  const ingredientSet = new Set(res.menus.flatMap((m) => m.ingredients));

  log.info(`큐레이션 ${curatedCount}개 + 원시 ${raw.candidates.length}개(원시 파일 ${raw.perFile.length}개, 전체 ${raw.total}개 중)`);
  for (const p of raw.perFile) log.info(`  [raw] ${p.file}: ${p.accepted}/${p.total}개 통과`);
  if (raw.noInfo) log.info(`  [raw] 재료/태그/설명이 모두 비어 제외: ${raw.noInfo}개`);
  if (raw.dropReasons.size) {
    const top = [...raw.dropReasons].sort((a, b) => b[1] - a[1]).slice(0, 8);
    log.info('  [raw] 기준 미달로 제외된 주요 사유: ' + top.map(([k, v]) => `${k} x${v}`).join(' | '));
  }
  log.info(`중복 제거: ${res.duplicates}개 (이름+brand 기준, 우선순위 ${SOURCE_PRIORITY.join(' > ')})`);
  log.info(`재료 별칭 사전: ${dictUsed ? `data/dict/ingredients.json 사용 (${aliasMap.size}개 표제)` : '없음(정규화 생략)'}`);
  log.info(`병합 결과: ${res.menus.length}개 -> ${relative(ROOT, out).replaceAll('\\', '/')}`);
  log.info('  source: ' + [...bySource].map(([k, v]) => `${k} ${v}`).join(', '));
  log.info('  cuisine: ' + CUISINES.map((c) => `${c} ${byCuisine.get(c) || 0}`).join(', '));
  log.info(`  서로 다른 재료명: ${ingredientSet.size}개`);
  return { ok: true, count: res.menus.length, out };
}

async function main(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const oi = argv.indexOf('--out');
  const out = oi !== -1 && argv[oi + 1] ? resolve(process.cwd(), argv[oi + 1]) : DEFAULT_OUT;
  const r = await runMerge({ out, useRaw: !flags.has('--no-raw'), quiet: flags.has('--quiet') });
  return r.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(e); process.exitCode = 2; });
}
