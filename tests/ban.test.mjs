// 숨긴(밴) 메뉴 저장 API 테스트. Node 에는 localStorage 가 없으므로 가짜 저장소로 검증한다.
import test from 'node:test';
import assert from 'node:assert/strict';

let seq = 0;
const fakeStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const setGlobal = (n, v) => Object.defineProperty(globalThis, n, { value: v, configurable: true, writable: true });
async function fresh(storage) { setGlobal('indexedDB', undefined); setGlobal('localStorage', storage); return import(`../web/js/store.js?ban=${++seq}`); }

test('ban/unban/isBanned/getBanned', async () => {
  const s = await fresh(fakeStorage());
  assert.equal(s.ban('kr-kimchi-jjigae'), 1);
  assert.equal(s.ban('kr-kimchi-jjigae'), 1);          // 중복은 한 번만
  assert.ok(s.isBanned('kr-kimchi-jjigae'));
  assert.deepEqual([...s.getBanned()], ['kr-kimchi-jjigae']);
  assert.equal(s.unban('kr-kimchi-jjigae'), 0);
  assert.ok(!s.isBanned('kr-kimchi-jjigae'));
});

test('잘못된 id 는 거절', async () => {
  const s = await fresh(fakeStorage());
  for (const bad of ['', 'x', 'KR-Upper', '<script>', 'kr-' + 'a'.repeat(80), null, 5]) assert.throws(() => s.ban(bad), /id/);
});

test('저장소에 남아 다시 로드해도 유지', async () => {
  const st = fakeStorage();
  const a = await fresh(st); a.ban('kr-a-b'); a.ban('we-pizza');
  const b = await fresh(st);
  assert.deepEqual([...b.getBanned()].sort(), ['kr-a-b', 'we-pizza']);
  b.clearBanned();
  assert.equal((await fresh(st)).getBanned().size, 0);
});

test('저장소가 없어도(예외) 메모리로 동작', async () => {
  const s = await fresh(undefined);
  s.ban('kr-a-b'); assert.ok(s.isBanned('kr-a-b'));
});

test('내보내기에 banned 포함, 가져오기는 합집합/대체, banned 만 있는 파일도 허용', async () => {
  const s = await fresh(fakeStorage());
  s.ban('kr-a-b');
  assert.deepEqual(JSON.parse(await s.exportJson()).banned, ['kr-a-b']);
  const r = await s.importJson({ banned: ['we-pizza', 'BAD ID', 'kr-a-b'] });
  assert.equal(r.bannedAdded, 1);                                   // 중복·불량 id 는 제외
  assert.deepEqual([...s.getBanned()].sort(), ['kr-a-b', 'we-pizza']);
  await s.importJson({ banned: ['jp-sushi'] }, { mode: 'replace' });
  assert.deepEqual([...s.getBanned()], ['jp-sushi']);
});
