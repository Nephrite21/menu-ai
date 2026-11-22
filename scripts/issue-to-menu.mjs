#!/usr/bin/env node
// issue-to-menu.mjs - GitHub 이슈 폼 본문 -> data/menus/user-suggestions.json 항목 (C 소유)
//
// 이슈 본문은 "신뢰할 수 없는 입력"이다. 이 스크립트는 다음 원칙으로 동작한다.
//   - 본문은 셸을 거치지 않는다: 워크플로는 이 스크립트를 인자 없이 실행하고, 스크립트가 GITHUB_EVENT_PATH 의
//     이벤트 JSON 을 직접 JSON.parse 해서 issue.body / issue.number 를 읽는다(${{ }} 보간 없음).
//   - 폼 섹션("### 라벨")에서 허용된 필드만 뽑아 새 객체를 만들고, web/js/store.js 의 validateMenu(strict)와
//     data/menus 전체 검증(id·이름 중복 포함)을 통과한 경우에만 파일에 반영한다.
//   - 파일은 data/menus/user-suggestions.json 하나만 수정한다. 결과 메시지/PR 본문은 .issue-result/ 에 파일로 쓰며,
//     사용자 입력이 들어가는 부분은 백틱을 제거한 인라인 코드나 JSON 코드 블록에만 넣는다(멘션/링크/HTML 무력화).
//   - GITHUB_OUTPUT 에는 고정 형식 토큰(status, menu_id, branch)만 쓴다.
//
// 환경변수(모두 러너/테스트가 설정, 사용자 입력 아님):
//   GITHUB_EVENT_PATH   이벤트 페이로드 JSON 경로(워크플로에서 러너가 자동 설정)
//   GITHUB_OUTPUT       워크플로 출력 파일(선택)
//   ISSUE_BODY, ISSUE_NUMBER   테스트용: 이벤트 파일 대신 직접 지정(둘 다 있어야 함)
//   ISSUE_MENUS_DIR, ISSUE_RESULT_DIR   테스트용 경로 재정의(기본: data/menus, .issue-result)
//
// 종료 코드: 0 = ok / rejected / skip (status 로 구분), 1 = 예기치 않은 오류(워크플로 실패 → 관리자가 확인)
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CUISINES, CUISINE_ABBR, cleanText, nameKey, validateMenu } from '../web/js/store.js';
import { MENUS_DIR, ROOT, validateMenusDir } from './validate.mjs';

export const SUGGESTIONS_FILE = 'user-suggestions.json';
const MAX_BODY = 20000;
const MAX_FIELD = 2000;
const MAX_SUGGESTIONS = 2000;

// 이슈 폼 라벨(.github/ISSUE_TEMPLATE/menu-suggestion.yml 의 label 과 동일해야 함)
export const LABELS = {
  name: '메뉴 이름',
  cuisine: '분류',
  ingredients: '재료',
  tags: '태그',
  desc: '설명',
  brand: '브랜드',
  agree: '확인',
};

const CUISINE_KO = {
  '한식': 'korean', '양식': 'western', '중식': 'chinese', '일식': 'japanese', '베트남': 'vietnamese',
  '멕시코': 'mexican', '태국': 'thai', '인도': 'indian', '퓨전': 'fusion', '분식': 'snack',
  '카페': 'cafe', '디저트': 'cafe', '기타': 'other',
};

// ---------------------------------------------------------------------------
// 파싱
// ---------------------------------------------------------------------------
/** "### 라벨" 섹션 파싱. 같은 라벨이 반복되면 첫 번째만 사용. */
export function parseSections(body) {
  const sections = new Map();
  let label = null;
  let buf = [];
  const flush = () => {
    if (label !== null && !sections.has(label)) sections.set(label, buf.join('\n').trim());
  };
  for (const line of body.split(/\r?\n/)) {
    const m = /^###[ \t]+(.+?)[ \t]*$/.exec(line);
    if (m) { flush(); label = m[1].trim(); buf = []; } else if (label !== null) buf.push(line);
  }
  flush();
  return sections;
}

const NO_RESPONSE = /^_?No response_?$/i;
const fieldValue = (sections, label) => {
  const raw = sections.get(label);
  if (raw === undefined) return undefined;
  const v = raw.trim();
  return NO_RESPONSE.test(v) ? '' : v.slice(0, MAX_FIELD);
};

function splitList(text) {
  return String(text ?? '').split(/[,，、\n]+/).map((s) => cleanText(s.replace(/^[-*•]\s*/, ''))).filter(Boolean);
}

function parseCuisine(text) {
  const t = cleanText(text ?? '');
  const code = /\(([a-z]+)\)\s*$/.exec(t);
  if (code && CUISINES.includes(code[1])) return code[1];
  if (CUISINES.includes(t.toLowerCase())) return t.toLowerCase();
  for (const [ko, c] of Object.entries(CUISINE_KO)) if (t.startsWith(ko)) return c;
  return null;
}

/** 이슈 본문 -> 후보 메뉴(검증 전). 폼 형식이 아니면 null. */
export function buildDraft(body, number) {
  const sections = parseSections(body);
  if (!sections.has(LABELS.name) || !sections.has(LABELS.cuisine)) return null; // 우리 폼이 아님
  const errors = [];

  const name = cleanText(fieldValue(sections, LABELS.name) ?? '');
  const cuisine = parseCuisine(fieldValue(sections, LABELS.cuisine));
  if (!cuisine) errors.push('분류: 목록에서 선택한 값이 아닙니다');
  const ingredients = splitList(fieldValue(sections, LABELS.ingredients));
  const tags = splitList(fieldValue(sections, LABELS.tags));
  const desc = cleanText(fieldValue(sections, LABELS.desc) ?? '');
  const brand = cleanText(fieldValue(sections, LABELS.brand) ?? '');

  const agreeText = sections.get(LABELS.agree) ?? '';
  if (!/^\s*[-*]\s*\[[xX]\]/m.test(agreeText)) errors.push('확인: 안내 사항에 동의(체크)해야 제안할 수 있습니다');

  const display = brand && !name.startsWith(brand) ? `${brand} ${name}` : name;
  const draft = {
    id: undefined,
    name: display,
    cuisine: cuisine ?? 'other',
    ingredients,
    tags,
    desc,
    source: brand ? 'franchise' : 'curated',
    attribution: `사용자 제안(GitHub 이슈 #${number})`,
  };
  if (brand) draft.brand = brand;
  draft.id = makeId(draft);
  return { draft, errors };
}

export function makeId(menu) {
  const h = createHash('sha1').update(`${menu.cuisine}|${nameKey(menu.name, menu.brand)}`).digest('hex').slice(0, 8);
  return `${CUISINE_ABBR[menu.cuisine] ?? 'ot'}-sg-${h}`;
}

// ---------------------------------------------------------------------------
// 출력 포맷(data/menus 의 다른 파일과 같은 스타일)
// ---------------------------------------------------------------------------
export function formatMenusJson(list) {
  if (!list.length) return '[]\n';
  const arr = (a) => `[${a.map((x) => JSON.stringify(x)).join(', ')}]`;
  const body = list.map((m) => {
    const lines = [
      `    "id": ${JSON.stringify(m.id)}`, `    "name": ${JSON.stringify(m.name)}`, `    "cuisine": ${JSON.stringify(m.cuisine)}`,
      `    "ingredients": ${arr(m.ingredients)}`, `    "tags": ${arr(m.tags)}`, `    "desc": ${JSON.stringify(m.desc)}`,
      `    "source": ${JSON.stringify(m.source)}`,
    ];
    if (m.brand) lines.push(`    "brand": ${JSON.stringify(m.brand)}`);
    if (m.attribution) lines.push(`    "attribution": ${JSON.stringify(m.attribution)}`);
    return `  {\n${lines.join(',\n')}\n  }`;
  }).join(',\n');
  return `[\n${body}\n]\n`;
}

// 사용자 입력이 섞인 문장은 인라인 코드로만 노출(백틱 제거, 길이 제한, 줄바꿈 제거)
const code = (s, max = 100) => `\`${String(s).replace(/[`\r\n]+/g, ' ').replace(/@/g, '＠').trim().slice(0, max)}\``;

function rejectedComment(reasons) {
  return [
    '메뉴 제안을 보내 주셔서 감사합니다. 아래 이유로 자동 반영하지 못했어요.',
    '',
    ...reasons.slice(0, 15).map((r) => `- ${code(r)}`),
    '',
    '이슈 내용을 수정해서 새 이슈로 다시 제안해 주세요. 형식 규칙: 이름 30자 이하, 재료 1개 이상(쉼표로 구분), 태그 2개 이상, 설명 10자 이상, URL/특수문자(<, >, 백틱 등) 금지.',
  ].join('\n');
}

function acceptedComment(menu, prHint) {
  return [
    '메뉴 제안이 검증을 통과했어요. 검토용 Pull Request를 만들었습니다.',
    '',
    `- 이름: ${code(menu.name)}`,
    `- 분류: ${code(menu.cuisine)}`,
    '',
    prHint,
  ].join('\n');
}

function prBody(menu, number) {
  return [
    `Closes #${number}`,
    '',
    '이슈 폼 제안을 자동 검증(`scripts/validate.mjs` 규칙)한 뒤 `data/menus/user-suggestions.json`에 추가했습니다.',
    '병합 전에 내용이 적절한지(사실 확인, 중복, 부적절한 표현) 검토해 주세요.',
    '',
    '```json',
    JSON.stringify(menu, null, 2),
    '```',
    '',
    '이 PR은 자동 생성되었습니다.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 핵심 처리
// ---------------------------------------------------------------------------
/**
 * @returns {Promise<{status: 'ok'|'rejected'|'skip', menu?: object, reasons?: string[], comment?: string, prTitle?: string, prBody?: string}>}
 */
export async function processIssue({ body, number, menusDir = MENUS_DIR }) {
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error('issue.number 가 올바르지 않습니다');
  if (typeof body !== 'string' || !body.trim()) return { status: 'skip' };
  if (body.length > MAX_BODY) return { status: 'rejected', reasons: [`본문이 너무 깁니다(최대 ${MAX_BODY}자)`], comment: rejectedComment([`본문이 너무 깁니다(최대 ${MAX_BODY}자)`]) };

  const parsed = buildDraft(body.normalize('NFC'), number);
  if (!parsed) return { status: 'skip' }; // 메뉴 제안 폼이 아닌 이슈
  const { draft, errors } = parsed;

  const v = validateMenu(draft, { strict: true });
  const reasons = [...errors, ...v.errors];
  if (reasons.length) return { status: 'rejected', reasons, comment: rejectedComment(reasons) };
  const menu = v.menu;

  // 기존 데이터와 합쳐서 전체 검증(id/이름 중복). 기존 데이터가 이미 깨져 있으면 사용자 잘못이 아니므로 오류 처리.
  const before = await validateMenusDir(menusDir);
  if (before.errors.length) throw new Error(`기존 data/menus 검증 실패(${before.errors.length}건): ${before.errors[0]}`);
  const key = nameKey(menu.name, menu.brand);
  if (before.menus.some((m) => nameKey(m.name, m.brand) === key)) {
    const r = ['이미 등록되어 있는 메뉴 이름입니다'];
    return { status: 'rejected', reasons: r, comment: rejectedComment(r) };
  }
  if (before.menus.some((m) => m.id === menu.id)) {
    const r = ['같은 id 의 메뉴가 이미 있습니다'];
    return { status: 'rejected', reasons: r, comment: rejectedComment(r) };
  }

  const file = join(menusDir, SUGGESTIONS_FILE);
  const original = existsSync(file) ? readFileSync(file, 'utf8') : '[]\n';
  let list;
  try { list = JSON.parse(original); } catch { throw new Error(`${SUGGESTIONS_FILE} 가 올바른 JSON 이 아닙니다`); }
  if (!Array.isArray(list)) throw new Error(`${SUGGESTIONS_FILE} 의 최상위 값이 배열이 아닙니다`);
  if (list.length >= MAX_SUGGESTIONS) throw new Error(`${SUGGESTIONS_FILE} 항목이 ${MAX_SUGGESTIONS}개를 넘었습니다(관리자 정리 필요)`);
  list.push(menu);
  writeFileSync(file, formatMenusJson(list), 'utf8');

  // 쓴 뒤 다시 전체 검증. 실패하면 원복.
  const after = await validateMenusDir(menusDir);
  if (after.errors.length) {
    writeFileSync(file, original, 'utf8');
    throw new Error(`반영 후 검증 실패, 원복함: ${after.errors[0]}`);
  }

  return {
    status: 'ok',
    menu,
    // 제목에서는 #(이슈 교차 참조)와 @(멘션) 도 제거한다.
    prTitle: `feat(data): 메뉴 제안 추가 - ${menu.name.replace(/[#@]/g, '')} (#${number})`.replace(/[\r\n`]+/g, ' '),
    prBody: prBody(menu, number),
    comment: acceptedComment(menu, '검토 후 병합되면 이 이슈는 자동으로 닫힙니다.'),
  };
}

function setOutputs(obj) {
  const f = process.env.GITHUB_OUTPUT;
  if (!f) return;
  // 값은 고정 형식 토큰(영문/숫자/하이픈/슬래시)만 허용
  const lines = Object.entries(obj).map(([k, v]) => {
    if (!/^[a-z_]+$/.test(k) || !/^[A-Za-z0-9._\/-]*$/.test(String(v))) throw new Error(`unsafe output ${k}`);
    return `${k}=${v}`;
  });
  appendFileSync(f, `${lines.join('\n')}\n`);
}

async function main() {
  let body; let number;
  if (process.env.ISSUE_BODY !== undefined && process.env.ISSUE_NUMBER !== undefined) {
    body = process.env.ISSUE_BODY; number = Number(process.env.ISSUE_NUMBER);
  } else {
    const evPath = process.env.GITHUB_EVENT_PATH;
    if (!evPath) throw new Error('GITHUB_EVENT_PATH 가 없습니다');
    const event = JSON.parse(readFileSync(evPath, 'utf8'));
    const issue = event && typeof event === 'object' ? event.issue : null;
    if (!issue || typeof issue !== 'object') throw new Error('이벤트에 issue 가 없습니다');
    body = typeof issue.body === 'string' ? issue.body : '';
    number = issue.number;
  }

  const menusDir = process.env.ISSUE_MENUS_DIR ? resolve(process.env.ISSUE_MENUS_DIR) : MENUS_DIR;
  const resultDir = process.env.ISSUE_RESULT_DIR ? resolve(process.env.ISSUE_RESULT_DIR) : join(ROOT, '.issue-result');
  mkdirSync(resultDir, { recursive: true });

  const res = await processIssue({ body, number, menusDir });
  if (res.comment) writeFileSync(join(resultDir, 'comment.md'), `${res.comment}\n`, 'utf8');
  if (res.status === 'ok') {
    writeFileSync(join(resultDir, 'pr-title.txt'), `${res.prTitle}\n`, 'utf8');
    writeFileSync(join(resultDir, 'pr-body.md'), `${res.prBody}\n`, 'utf8');
    setOutputs({ status: 'ok', menu_id: res.menu.id, branch: `menu-suggestion/issue-${number}` });
    console.log(`ok: ${res.menu.id} -> ${SUGGESTIONS_FILE}`);
  } else {
    setOutputs({ status: res.status });
    console.log(`${res.status}${res.reasons ? `: ${res.reasons.length}건 사유` : ''}`);
    if (res.reasons) for (const r of res.reasons) console.log(`  - ${String(r).slice(0, 160)}`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((c) => { process.exitCode = c; }, (e) => { console.error(`error: ${e.message}`); process.exitCode = 1; });
}

