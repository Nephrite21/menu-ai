#!/usr/bin/env node
// validate.mjs - data/menus/*.json 스키마 검증 (C 소유)
//
// 사용법:
//   node scripts/validate.mjs                 # data/menus/*.json 을 엄격 기준으로 검증
//   node scripts/validate.mjs a.json b.json   # 지정한 파일만 검증
//   node scripts/validate.mjs --raw           # data/raw/*.json(크롤러 산출물)도 느슨한 기준으로 점검(경고만, 실패 아님)
//   node scripts/validate.mjs --quiet         # 요약만 출력
//
// 검증 항목: cuisine/source 허용값, id 형식·접두어·전체 유일, 필수 필드, 이름(+brand) 중복,
//           길이 제한, 금칙어/URL/위험 문자, vec 금지(빌드 산출물에만 존재), franchise 의 brand,
//           wikipedia/wikidata 의 attribution.
// 검증 로직 자체는 web/js/store.js 의 validateMenu 를 공유한다(브라우저·CI 가 같은 규칙을 쓰도록).
//
// 종료 코드: 0 통과, 1 검증 실패, 2 사용법/IO 오류
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve, relative, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateMenu, nameKey, CUISINES } from '../web/js/store.js';

export const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const MENUS_DIR = join(ROOT, 'data', 'menus');
export const RAW_DIR = join(ROOT, 'data', 'raw');

/** 디렉터리의 *.json 파일 경로(정렬, 숨김 파일 제외). 디렉터리가 없으면 []. */
export async function listJson(dir) {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.endsWith('.json') && !e.name.startsWith('.'))
      .map((e) => join(dir, e.name))
      .sort();
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

/** JSON 파일 읽기. 실패하면 { error } */
export async function readJsonFile(path) {
  try {
    const text = await readFile(path, 'utf8');
    return { data: JSON.parse(text.replace(/^﻿/, '')) };
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * 여러 파일의 메뉴를 한꺼번에 검증한다(파일 간 id/이름 중복 포함).
 * @param {Array<{file: string, data: any}>} fileSets
 * @param {object} [opts] validateMenu 옵션(기본 strict, vec 금지)
 * @returns {{ errors: string[], menus: object[], perFile: Array<{file:string,count:number}> }}
 */
export function validateFileSets(fileSets, opts = {}) {
  const errors = [];
  const menus = [];
  const perFile = [];
  const ids = new Map();
  const names = new Map();
  for (const { file, data } of fileSets) {
    const label = file;
    if (!Array.isArray(data)) {
      errors.push(`${label}: 최상위 값은 메뉴 배열이어야 합니다`);
      perFile.push({ file, count: 0 });
      continue;
    }
    let count = 0;
    data.forEach((m, index) => {
      const where = `${label}[${index}]${m && typeof m === 'object' && typeof m.id === 'string' ? ` (${m.id})` : ''}`;
      const r = validateMenu(m, { strict: true, allowVec: false, ...opts });
      if (!r.ok) {
        for (const e of r.errors) errors.push(`${where}: ${e}`);
        return;
      }
      const c = r.menu;
      let dup = false;
      if (ids.has(c.id)) { errors.push(`${where}: id 중복 "${c.id}" (먼저 나온 곳: ${ids.get(c.id)})`); dup = true; } else ids.set(c.id, where);
      const k = nameKey(c.name, c.brand);
      if (names.has(k)) { errors.push(`${where}: 이름 중복 "${c.name}"${c.brand ? ` [${c.brand}]` : ''} (먼저 나온 곳: ${names.get(k)})`); dup = true; } else names.set(k, where);
      if (!dup) { menus.push(c); count++; }
    });
    perFile.push({ file, count });
  }
  return { errors, menus, perFile };
}

/** data/menus/*.json 전체 로드 + 검증. issue-to-menu.mjs 등에서 재사용. */
export async function validateMenusDir(dir = MENUS_DIR, opts = {}) {
  const files = await listJson(dir);
  const sets = [];
  const errors = [];
  for (const f of files) {
    const r = await readJsonFile(f);
    if (r.error) { errors.push(`${relative(ROOT, f)}: JSON 파싱 실패 - ${r.error}`); continue; }
    sets.push({ file: relative(ROOT, f).replaceAll('\\', '/'), data: r.data });
  }
  const res = validateFileSets(sets, opts);
  return { ...res, errors: [...errors, ...res.errors], files };
}

function tally(menus, key) {
  const t = new Map();
  for (const m of menus) t.set(m[key], (t.get(m[key]) || 0) + 1);
  return t;
}

async function main(argv) {
  const args = argv.filter((a) => !a.startsWith('--'));
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const quiet = flags.has('--quiet');
  if (flags.has('--help') || flags.has('-h')) {
    console.log('usage: node scripts/validate.mjs [files...] [--raw] [--quiet]');
    return 0;
  }

  let result;
  if (args.length) {
    const sets = [];
    const ioErrors = [];
    for (const a of args) {
      const p = resolve(process.cwd(), a);
      const r = await readJsonFile(p);
      if (r.error) ioErrors.push(`${a}: ${r.error}`); else sets.push({ file: a, data: r.data });
    }
    const res = validateFileSets(sets);
    result = { ...res, errors: [...ioErrors, ...res.errors] };
  } else {
    result = await validateMenusDir();
    if (!result.files.length) result.errors.push(`${relative(ROOT, MENUS_DIR)}: 검증할 *.json 이 없습니다`);
  }

  if (!quiet) for (const { file, count } of result.perFile) console.log(`  ${file}: ${count}개`);
  const { menus, errors } = result;

  if (errors.length) {
    console.error(`\n검증 실패: 오류 ${errors.length}건`);
    for (const e of errors.slice(0, 200)) console.error(`  - ${e}`);
    if (errors.length > 200) console.error(`  ... 외 ${errors.length - 200}건`);
    return 1;
  }

  console.log(`\n검증 통과: 메뉴 ${menus.length}개 (파일 ${result.perFile.length}개)`);
  if (!quiet) {
    const byCuisine = tally(menus, 'cuisine');
    console.log('  cuisine: ' + CUISINES.map((c) => `${c} ${byCuisine.get(c) || 0}`).join(', '));
    const bySource = tally(menus, 'source');
    console.log('  source: ' + [...bySource].map(([k, v]) => `${k} ${v}`).join(', '));
    const brands = new Set(menus.filter((m) => m.brand).map((m) => m.brand));
    console.log(`  brands: ${brands.size}개 (${[...brands].join(', ')})`);
  }

  if (flags.has('--raw')) {
    const rawFiles = await listJson(RAW_DIR);
    let bad = 0;
    for (const f of rawFiles) {
      const r = await readJsonFile(f);
      if (r.error || !Array.isArray(r.data)) { console.warn(`  [raw] ${basename(f)}: 읽을 수 없음 (${r.error || '배열 아님'})`); continue; }
      let ok = 0;
      for (const m of r.data) {
        const v = validateMenu(m, { strict: false, allowVec: false, fillDefaults: true, checkIdPrefix: false });
        if (v.ok) ok++; else bad++;
      }
      console.log(`  [raw] ${basename(f)}: ${ok}/${r.data.length}개가 느슨한 기준 통과`);
    }
    if (bad) console.warn(`  [raw] 기준 미달 ${bad}건은 merge 시 제외됩니다(경고만, 실패 아님)`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(e); process.exitCode = 2; });
}
