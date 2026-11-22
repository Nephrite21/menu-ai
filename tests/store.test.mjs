// web/js/store.js 테스트(C 소유): 스키마 검증, 내 메뉴 CRUD, 병합, 내보내기/가져오기, 폴백 백엔드.
// Node 에는 indexedDB 가 없으므로 localStorage 폴백/메모리 폴백 경로를 검증한다.
// (IndexedDB 경로는 fake-indexeddb 로 별도 검증: 보고서 참고)
// 실행: node --test tests/store.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMenu } from '../web/js/store.js';

let seq = 0;
function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _map: m,
  };
}
function setGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
/** 새 모듈 인스턴스 + 선택한 저장 환경(indexedDB 없음) */
async function freshStore({ localStorage } = {}) {
  setGlobal('indexedDB', undefined);
  setGlobal('localStorage', localStorage);
  return import(`../web/js/store.js?case=${++seq}`);
}

const BASE_V1 = [
  { id: 'kr-kimchi-jjigae', name: '김치찌개', cuisine: 'korean', ingredients: ['김치'], tags: ['국물', '매운'], desc: '얼큰한 찌개', source: 'curated', vec: [1, 2, 3] },
];
const jsonFetch = (data, ok = true) => async () => ({ ok, status: ok ? 200 : 500, json: async () => data });

const GOOD = { id: 'kr-test-dish', name: '테스트 요리', cuisine: 'korean', ingredients: ['김치', '두부'], tags: ['국물', '얼큰한'], desc: '테스트를 위한 요리입니다. 얼큰하고 뜨끈해요.', source: 'curated' };

test('validateMenu: 정상 메뉴 통과 + 필드 정규화', () => {
  const r = validateMenu({ ...GOOD, name: '  테스트   요리 ' });
  assert.ok(r.ok, r.errors.join('; '));
  assert.equal(r.menu.name, '테스트 요리');
});

test('validateMenu: 엄격 모드 실패 사례', () => {
  const bad = (patch, re) => {
    const r = validateMenu({ ...GOOD, ...patch });
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.match(r.errors.join(' | '), re);
  };
  bad({ cuisine: 'martian' }, /cuisine/);
  bad({ id: 'KR-Test' }, /id/);
  bad({ id: 'jp-test-dish' }, /접두어/);
  bad({ id: 'kr-' }, /id/);
  bad({ source: 'hacker' }, /source/);
  bad({ ingredients: [] }, /ingredients/);
  bad({ tags: ['하나'] }, /tags/);
  bad({ tags: ['국물', '국물'] }, /중복/);
  bad({ desc: '짧음' }, /desc/);
  bad({ name: 'x'.repeat(31) }, /name/);
  bad({ name: '시발 맛집' }, /부적절/);
  bad({ desc: '자세한 내용은 https://example.com 참고하세요 정말로요' }, /URL/);
  bad({ desc: '<b>굵게</b> 표시되는 설명입니다 정말로요' }, /허용되지 않는/);
  bad({ vec: [1, 2, 3] }, /허용되지 않은 필드/);
  bad({ extra: 1 }, /허용되지 않은 필드/);
  bad({ source: 'franchise' }, /brand/);
  bad({ source: 'wikipedia' }, /attribution/);
});

test('validateMenu: 느슨한 모드는 빈 배열/미정의 필드 허용', () => {
  const r = validateMenu({ id: 'kr-x1', name: '아무거나', cuisine: 'korean', source: 'wikidata', attribution: 'Wikidata CC0', _wd: { a: 1 } }, { strict: false, fillDefaults: true });
  assert.ok(r.ok, r.errors.join('; '));
  assert.deepEqual(r.menu.ingredients, []);
  assert.equal(r.menu.desc, '');
  assert.equal('_wd' in r.menu, false);
});

test('메모리 폴백: addUser/updateUser/removeUser + getAll 병합', async () => {
  const s = await freshStore();
  assert.equal(await s.getBackendName(), 'memory');
  const added = await s.addUser({ name: '내 비빔국수', cuisine: 'korean', ingredients: ['면', '고추장'], desc: '집에서 만든 비빔국수', vec: [1, 2, 3], scale: 0.5 });
  assert.match(added.id, /^kr-my-[a-z0-9]+$/);
  assert.equal(added.source, 'user');

  let all = await s.getAll({ fetchImpl: jsonFetch(BASE_V1) });
  assert.equal(all.length, 2);
  assert.equal(all.find((m) => m.id === added.id).source, 'user');
  assert.ok(all.find((m) => m.id === added.id).vec);

  // 태그만 바꿔도 내용 변경 -> 낡은 vec 제거
  const upd = await s.updateUser(added.id, { tags: ['비빔', '매콤한'] });
  assert.equal(upd.vec, undefined);
  assert.deepEqual(upd.tags, ['비빔', '매콤한']);
  // vec 만 갱신하면 내용은 유지
  const upd2 = await s.updateUser(added.id, { vec: [9, 9, 9], scale: 0.1 });
  assert.deepEqual(upd2.vec, [9, 9, 9]);
  assert.deepEqual(upd2.tags, ['비빔', '매콤한']);
  // id/source 변경 시도는 무시
  const upd3 = await s.updateUser(added.id, { id: 'kr-hack', source: 'curated', desc: '바꾼 설명입니다' });
  assert.equal(upd3.id, added.id);
  assert.equal(upd3.source, 'user');

  await assert.rejects(() => s.updateUser('kr-my-nope', { desc: 'x' }), /찾을 수 없음/);
  assert.equal(await s.removeUser(added.id), true);
  assert.equal(await s.removeUser(added.id), false);
  all = await s.getAll({ fetchImpl: jsonFetch(BASE_V1) });
  assert.equal(all.length, 1);
});

test('addUser: 검증 실패와 id 네임스페이스 강제', async () => {
  const s = await freshStore();
  await assert.rejects(() => s.addUser({ name: '', cuisine: 'korean' }), /검증 실패/);
  await assert.rejects(() => s.addUser({ name: '<img src=x onerror=alert(1)>', cuisine: 'korean', ingredients: [], desc: '' }), /검증 실패/);
  await assert.rejects(() => s.addUser({ name: '괜찮은 이름', cuisine: 'nope' }), /검증 실패/);
  // 기본 데이터 id 를 사칭해도 새 id 로 저장
  const m = await s.addUser({ id: 'kr-kimchi-jjigae', name: '사칭 김치찌개', cuisine: 'korean', ingredients: ['김치'], desc: '' });
  assert.notEqual(m.id, 'kr-kimchi-jjigae');
  assert.match(m.id, /^kr-my-/);
});

test('기본 데이터가 갱신돼도 내 메뉴는 그대로', async () => {
  const s = await freshStore();
  const mine = await s.addUser({ name: '내 메뉴', cuisine: 'japanese', ingredients: ['쌀'], desc: '' });
  const v1 = await s.getAll({ baseUrl: 'https://base/v1', fetchImpl: jsonFetch(BASE_V1) });
  const BASE_V2 = [...BASE_V1, { id: 'kr-new', name: '새 메뉴', cuisine: 'korean', ingredients: ['김치'], tags: ['a', 'b'], desc: '새로 추가', source: 'curated' }];
  const v2 = await s.getAll({ baseUrl: 'https://base/v2', fetchImpl: jsonFetch({ menus: BASE_V2 }) });
  assert.equal(v1.length, 2);
  assert.equal(v2.length, 3);
  assert.ok(v1.some((m) => m.id === mine.id) && v2.some((m) => m.id === mine.id));
});

test('기본 데이터 로드 실패 시에도 내 메뉴는 반환 + 상태에 오류 기록', async () => {
  const s = await freshStore();
  const mine = await s.addUser({ name: '오프라인 메뉴', cuisine: 'other', ingredients: ['쌀'], desc: '' });
  const all = await s.getAll({ baseUrl: 'https://base/fail', fetchImpl: jsonFetch(null, false) });
  assert.deepEqual(all.map((m) => m.id), [mine.id]);
  const st = await s.getStatus();
  assert.match(st.baseError, /HTTP 500/);
});

test('localStorage 폴백: 모듈을 다시 로드해도 유지', async () => {
  const ls = fakeStorage();
  const s1 = await freshStore({ localStorage: ls });
  assert.equal(await s1.getBackendName(), 'localstorage');
  const m = await s1.addUser({ name: '저장되는 메뉴', cuisine: 'thai', ingredients: ['새우'], desc: '' });
  const s2 = await freshStore({ localStorage: ls });
  const all = await s2.listUser();
  assert.deepEqual(all.map((x) => x.id), [m.id]);
});

test('localStorage 접근이 예외를 던져도 메모리 폴백', async () => {
  const s = await freshStore({ localStorage: { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() {} } });
  assert.equal(await s.getBackendName(), 'memory');
  await s.addUser({ name: '임시 메뉴', cuisine: 'other', ingredients: [], desc: '' });
  assert.equal((await s.listUser()).length, 1);
});

test('내보내기/가져오기 왕복: vec 제외, 재임베딩 필요 id 반환', async () => {
  const s = await freshStore();
  const a = await s.addUser({ name: '메뉴 A', cuisine: 'korean', ingredients: ['김치'], tags: ['매운', '국물'], desc: '설명 A', vec: [1, 2, 3] });
  const text = await s.exportJson();
  const parsed = JSON.parse(text);
  assert.equal(parsed.format, 'menusuggestion-user-menus');
  assert.equal(parsed.menus.length, 1);
  assert.equal('vec' in parsed.menus[0], false);

  const s2 = await freshStore();
  const r = await s2.importJson(text);
  assert.equal(r.added, 1);
  assert.equal(r.skipped, 0);
  assert.deepEqual(r.needsEmbedding, [a.id]);
  const again = await s2.importJson(text); // 같은 id -> 갱신
  assert.equal(again.updated, 1);
  assert.equal((await s2.listUser()).length, 1);
});

test('가져오기: 악의적/불량 항목 거절, 허용 필드만, vec 무시, 네임스페이스 강제', async () => {
  const s = await freshStore();
  const evil = {
    menus: [
      { name: '정상 메뉴', cuisine: 'korean', ingredients: ['김치'], tags: ['a', 'b'], desc: '정상', vec: [1, 2, 3], scale: 1, isAdmin: true, __proto__: { polluted: 1 } },
      { name: '<script>alert(1)</script>', cuisine: 'korean', ingredients: [], desc: '' },
      { name: '링크', cuisine: 'korean', ingredients: [], desc: 'http://evil.example 방문' },
      { name: '분류 오류', cuisine: 'mars', ingredients: [], desc: '' },
      'string-item',
      { id: 'kr-kimchi-jjigae', name: '사칭', cuisine: 'korean', ingredients: [], desc: '', source: 'curated' },
    ],
  };
  const r = await s.importJson(JSON.stringify(evil));
  assert.equal(r.total, 6);
  assert.equal(r.added, 2); // 정상 + 사칭(새 id 로)
  assert.equal(r.skipped, 4);
  const list = await s.listUser();
  assert.ok(list.every((m) => m.source === 'user' && /^[a-z]{2}-my-/.test(m.id)));
  assert.ok(list.every((m) => !('vec' in m) && !('isAdmin' in m)));
  assert.equal({}.polluted, undefined);
});

test('가져오기: 잘못된 JSON/형식/크기 제한', async () => {
  const s = await freshStore();
  await assert.rejects(() => s.importJson('not json'), /JSON/);
  await assert.rejects(() => s.importJson('{"foo":1}'), /형식 오류/);
  await assert.rejects(() => s.importJson({ menus: new Array(1001).fill({}) }), /너무 많습니다/);
  await assert.rejects(() => s.importJson({ size: 6 * 1024 * 1024, text: async () => '[]' }), /너무 큽니다/);
});

test('가져오기 replace 모드: 기존 내 메뉴를 대체', async () => {
  const s = await freshStore();
  await s.addUser({ name: '기존 메뉴', cuisine: 'korean', ingredients: [], desc: '' });
  const r = await s.importJson({ menus: [{ name: '새 메뉴', cuisine: 'korean', ingredients: ['김치'], desc: '' }] }, { mode: 'replace' });
  assert.equal(r.added, 1);
  const list = await s.listUser();
  assert.deepEqual(list.map((m) => m.name), ['새 메뉴']);
});
