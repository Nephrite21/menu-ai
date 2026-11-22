/* 통합: UI 이벤트(menu:*) ↔ store / embed / recommend.  ES module, 번들러 없음.
   계약은 SPEC.md 의 'UI 이벤트' 절. 검색·리롤은 detail.signal(AbortSignal)을 지켜야 한다. */
import * as store from '../js/store.js';
import { initEmbedder, embed, embedMenu, menuVector } from '../js/embed.js';
import { recommend, rerollPick, parseQuery, loadDictionaries } from '../js/recommend.js';
import { SERVICES, cachedLocation, clearLocationCache, permissionState, getPosition, accuracyText, openMapNow } from '../js/maps.js';

const UI = window.MenuUI;
const CFG = Object.assign({ repo: '', weightScale: 0.1, topN: 40, pick: 3 }, window.MENU_CONFIG || {});
const here = (p) => new URL(p, import.meta.url).href;
const CUISINE_LABEL = { korean: '한식 (korean)', northkorean: '북한 (northkorean)', western: '양식 (western)', chinese: '중식 (chinese)', japanese: '일식 (japanese)',
  vietnamese: '베트남 (vietnamese)', mexican: '멕시코 (mexican)', thai: '태국 (thai)', indian: '인도 (indian)',
  fusion: '퓨전 (fusion)', snack: '분식 (snack)', cafe: '카페·디저트 (cafe)', other: '기타 (other)' };

/* ---------- 취소 가능한 대기 ---------- */
const abortErr = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
function abortable(p, signal) {
  return new Promise((res, rej) => {
    if (signal && signal.aborted) return rej(abortErr());
    if (signal) signal.addEventListener('abort', () => rej(abortErr()), { once: true });
    Promise.resolve(p).then(res, rej);
  });
}
const msgOf = (e) => String((e && e.message) || e).split('\n')[0].slice(0, 120);

/* ---------- 데이터 ---------- */
let menus = [];
let banned = store.getBanned();           // 숨긴 메뉴 id(이 브라우저에만 저장)
const active = () => menus.filter((m) => !banned.has(m.id));
UI.isBanned = (id) => banned.has(id);
async function reload() {
  menus = await store.getAll({ baseUrl: here('../menus.json') });
  banned = store.getBanned();
  UI.setHiddenCount(banned.size);
  UI.setMenus(menus);
  const st = await store.getStatus();
  if (st.baseError) UI.toast('기본 메뉴 데이터를 불러오지 못했어요: ' + st.baseError, 5000);
}
const loaded = (async () => {
  try {
    await loadDictionaries((name) => fetch(here(`../dict/${name}.json`)).then((r) => {
      if (!r.ok) throw new Error(`사전 ${name} 로드 실패 (HTTP ${r.status})`);
      return r.json();
    }));
  } catch (e) { console.warn('[app] 사전을 불러오지 못해 재료 동의어/분류 가중치가 제한됩니다:', e); }
  await reload();
})();

/* ---------- 임베딩 모델 (처음 한 번 내려받음, 이후 브라우저 캐시) ---------- */
let embedderP = null;
if (window.MenuSphere) window.MenuSphere.timeoutMs = 60000; // 모델을 처음 받는 동안은 넉넉히
function ensureEmbedder() {
  if (!embedderP) {
    UI.setProgress(0, '검색 모델 준비 중…');
    embedderP = initEmbedder({
      onProgress: (p) => UI.setProgress(p, p < 0.02 ? '검색 모델 준비 중…' : p < 1 ? `검색 모델 준비 중 ${Math.round(p * 100)}%` : '검색 모델 준비 완료'),
    }).then((info) => {
      setTimeout(() => UI.setProgress(null), 700);
      if (window.MenuSphere) window.MenuSphere.timeoutMs = 15000; // 이후부터는 15초 안에 못 찾으면 포기
      return info;
    }).catch((e) => { embedderP = null; UI.setProgress(null); throw e; });
  }
  return embedderP;
}
// 사이트에 들어오면 곧바로 모델 준비를 시작한다(메뉴·사전을 먼저 받은 뒤).
// 홈 화면(body.loading)에서는 준비되는 동안 구가 계속 돌고 검색창은 숨어 있다가,
// 준비가 끝나면 구가 감속해서 멈춘 뒤 검색창이 나타난다. 첫 검색에서 기다릴 일이 없다.
// 실패해도(오프라인 등) 구를 멈추고 검색창을 보여 주며, 검색할 때 다시 시도한다.
const loadingSphere = document.body.classList.contains('loading') && window.MenuSphere ? window.MenuSphere.load() : null;
loaded.then(() => ensureEmbedder()).then(() => true, (e) => {
  console.warn('[app] 검색 모델을 미리 준비하지 못했어요(검색할 때 다시 시도합니다):', e);
  UI.toast('검색 모델을 미리 불러오지 못했어요. 검색할 때 다시 시도할게요.', 4000);
  return false;
}).then(async () => {
  if (loadingSphere) { window.MenuSphere.settle(); await loadingSphere; }
  document.body.classList.remove('loading');
});

/* ---------- 검색 / 다시 추천 ---------- */
let last = null; // { all: 순위 전체(숨김 제외 전), shown: id[], current: 지금 화면의 결과 }
const newSeed = () => Math.random().toString(36).slice(2);

const pickK = () => (UI.pickCount ? UI.pickCount() : CFG.pick);
const rankedNow = () => last.all.filter((r) => !banned.has(r.menu.id));
function showPicks() {
  const k = pickK();
  const pool = Math.max(12, last.shown.length + k * 2, k * 2);
  const picks = rerollPick(rankedNow(), { seed: newSeed(), k, temperature: 0.03, pool, history: last.shown });
  last.shown.push(...picks.map((p) => p.menu.id));
  last.current = picks;
  UI.renderResults(picks);
}
function fail(e, signal) {
  if ((signal && signal.aborted) || (e && e.name === 'AbortError')) return; // 사용자가 새 검색을 했거나 타임아웃으로 이미 취소됨
  console.error('[app] 검색 실패', e);
  if (window.MenuSphere) window.MenuSphere.fail('error'); else UI.toast('찾는 중에 문제가 생겼어요.', 4000);
}

document.addEventListener('menu:search', async (ev) => {
  const d = ev.detail || {}, signal = d.signal;
  try {
    await abortable(loaded, signal);
    const parsed = parseQuery(d.text || '');
    const weights = { ...parsed.weights, ...(d.weights || {}) };      // 칩으로 고른 값이 입력창 접두어보다 우선
    const exclude = new Set([...parsed.exclude, ...(d.exclude || [])]);
    for (const x of exclude) delete weights[x];
    let queryVec = null;
    if (parsed.text) {                                                  // 글이 없으면(칩만 고른 경우) 모델 없이 가중치·필터만으로 추천
      await abortable(ensureEmbedder(), signal);
      queryVec = await abortable(embed(parsed.text, { kind: 'query' }), signal);
    }
    if (signal && signal.aborted) return;
    const ranked = recommend({ queryVec, menus: active(), cuisines: d.cuisines, weights, exclude, topN: CFG.topN, seed: newSeed(), weightScale: CFG.weightScale });
    last = { all: ranked, shown: [], current: [] };
    showPicks();
  } catch (e) { fail(e, signal); }
});

document.addEventListener('menu:count', () => {   // 3/5/10 변경: 이미 계산해 둔 후보에서 바로 다시 고른다
  if (last) showPicks();
});

document.addEventListener('menu:reroll', (ev) => {
  const signal = ev.detail && ev.detail.signal;
  try {
    if (!last) { UI.renderResults([]); return; }
    showPicks();
  } catch (e) { fail(e, signal); }
});

/* ---------- 내 메뉴 ---------- */
let backfilling = false;
async function backfill() { // 벡터가 없는 내 메뉴(오프라인에서 추가, 가져오기, 수정)를 임베딩해서 채운다
  if (backfilling) return;
  backfilling = true;
  try {
    const todo = (await store.listUser()).filter((m) => !m.vec);
    if (!todo.length) return;
    await ensureEmbedder();
    for (const m of todo) await store.updateUser(m.id, { vec: await embedMenu(m) });
    await reload();
  } catch (e) { console.warn('[app] 내 메뉴 벡터 채우기 실패(다음에 다시 시도):', e); }
  finally { backfilling = false; }
}
loaded.then(backfill);

document.addEventListener('menu:add', async (ev) => {
  try {
    await store.addUser({ ...ev.detail, source: 'user' });
    await reload();
    UI.toast('저장했어요');
    backfill();                       // 모델이 준비되는 대로 검색에 반영(저장은 기다리지 않음)
  } catch (e) { UI.toast('저장하지 못했어요: ' + msgOf(e), 5000); }
});
document.addEventListener('menu:update', async (ev) => {
  const { id, ...patch } = ev.detail || {};
  try {
    await store.updateUser(id, patch);
    await reload();
    UI.toast('수정했어요');
    backfill();
  } catch (e) { UI.toast('수정하지 못했어요: ' + msgOf(e), 5000); }
});
document.addEventListener('menu:edit', (ev) => {
  const m = menus.find((x) => x.id === (ev.detail && ev.detail.id) && x.source === 'user');
  if (m) UI.openAddModal(m);
});
document.addEventListener('menu:remove', async (ev) => {
  const m = menus.find((x) => x.id === (ev.detail && ev.detail.id) && x.source === 'user');
  if (!m || !confirm(`"${m.name}" 메뉴를 삭제할까요?`)) return;
  try { await store.removeUser(m.id); await reload(); UI.toast('삭제했어요'); }
  catch (e) { UI.toast('삭제하지 못했어요: ' + msgOf(e), 5000); }
});
document.addEventListener('menu:export', async () => {
  try { await store.downloadExport(); UI.toast('내 메뉴를 파일로 내보냈어요'); }
  catch (e) { UI.toast('내보내지 못했어요: ' + msgOf(e), 5000); }
});
document.addEventListener('menu:import', async (ev) => {
  const file = ev.detail && ev.detail.file;
  if (!file) return;
  try {
    const r = await store.importJson(file, { mode: 'merge' });
    await reload();
    banned = store.getBanned(); UI.setHiddenCount(banned.size); UI.setMenus(menus);
    UI.toast(`가져왔어요: 추가 ${r.added}, 갱신 ${r.updated}, 건너뜀 ${r.skipped}` + (r.bannedAdded ? ` · 숨김 ${r.bannedAdded}개` : '') + (r.errors && r.errors.length ? ` · 오류 ${r.errors.length}건` : ''), 5000);
    backfill();
  } catch (e) { UI.toast('가져오지 못했어요: ' + msgOf(e), 5000); }
  const inp = document.getElementById('import'); if (inp) inp.value = '';
});

/* ---------- 공용 목록에 제안: 미리 채운 GitHub 이슈 작성 화면을 연다 (이슈 → 검증 → 자동 PR) ---------- */
document.addEventListener('menu:suggest-public', (ev) => {
  const m = (ev.detail && ev.detail.menu) || {};
  if (!CFG.repo) { UI.toast('공용 제안은 사이트에 GitHub 저장소가 연결되면 쓸 수 있어요. (내 메뉴로는 저장됐어요)', 5000); return; }
  if ((m.tags || []).length < 2 || (m.desc || '').length < 10) {
    UI.toast('공용 제안에는 태그 2개 이상, 설명 10자 이상이 필요해요. (내 메뉴로는 저장됐어요)', 5000); return;
  }
  const q = new URLSearchParams({ template: 'menu-suggestion.yml', title: '[메뉴 제안] ' + m.name, name: m.name,
    cuisine: CUISINE_LABEL[m.cuisine] || '', ingredients: m.ingredients.join(', '), tags: m.tags.join(', '), desc: m.desc });
  window.open(`https://github.com/${CFG.repo}/issues/new?${q}`, '_blank', 'noopener');
  UI.toast('GitHub 이슈 작성 화면을 열었어요. 확인란을 체크하고 제출해 주세요.', 6000);
});

/* ---------- 상세 창의 '비슷한 메뉴' (메뉴 벡터끼리 비교, 모델 불필요) ---------- */
UI.similarProvider = (m) => {
  try {
    const v = menuVector(m);
    if (!v) return [];
    return recommend({ queryVec: v, menus: active(), topN: 7, weightScale: CFG.weightScale })
      .filter((r) => r.menu.id !== m.id).slice(0, 5).map((r) => ({ menu: r.menu, score: r.score }));
  } catch (e) { console.warn('[app] 비슷한 메뉴 계산 실패', e); return []; }
};

/* ---------- 내 주변에서 찾기: 카카오맵/네이버지도/구글지도 ----------
   위치 권한 안내는 요청한 창에 뜬다. 지도 창을 먼저 열면 안내가 뒤에 가려 보이지 않으므로,
   위치는 이 창(상세 창)에서 먼저 확인하고 상태를 화면에 보여 준 뒤 지도 창을 연다. */
const WHY = { denied: '위치 권한을 허용하지 않아서', unavailable: '위치를 알 수 없어서', timeout: '위치 확인이 너무 오래 걸려서', unsupported: '이 브라우저에서는 위치를 쓸 수 없어서' };
let skipLocation = false; // 위치를 쓸 수 없다고 확인된 뒤에는 다음 클릭부터 기다리지 않고 위치 없이 연다

/** 위치만 확인한다(지도 창은 열지 않음). onStatus(text, kind: wait|ok|warn) 로 진행을 알린다. */
async function checkLocation(onStatus = () => {}) {
  const hit = cachedLocation();
  if (hit) { onStatus(accuracyText(hit), 'ok'); return hit; }
  if ((await permissionState()) === 'denied') {
    skipLocation = true; onStatus('위치 권한이 거절돼 있어요. 주소창의 자물쇠(사이트 설정)에서 허용하면 내 주변을 찾을 수 있어요. 지금은 위치 없이 검색해요.', 'warn'); return null;
  }
  onStatus('위치 확인 중… 주소창 근처에 뜨는 위치 권한 요청에서 “허용”을 눌러 주세요.', 'wait');
  try {
    const loc = await getPosition();
    skipLocation = false; onStatus(accuracyText(loc), 'ok'); return loc;
  } catch (e) {
    skipLocation = true;
    onStatus(`${WHY[e.code] || '위치를 쓸 수 없어서'} 위치 없이 검색해요. 지도에서 내 위치 버튼을 눌러 주세요.`, 'warn'); return null;
  }
}
UI.checkLocation = (onStatus) => checkLocation(onStatus);
UI.resetLocation = () => { clearLocationCache(); skipLocation = false; };

UI.openMap = async (service, query, radiusM, { onStatus = () => {} } = {}) => {
  try {
    const name = (SERVICES[service] || {}).label || '지도';
    let loc = cachedLocation();
    const waited = !loc && !skipLocation;               // 위치를 새로 확인하느라 시간이 걸렸는가(= 클릭 직후가 아님)
    if (waited) loc = await checkLocation(onStatus);
    const r = openMapNow(service, { query, radiusM, loc });
    if (r.blocked) {
      onStatus(loc ? '위치를 확인했어요. 브라우저가 팝업을 막아서, 지도 버튼을 한 번 더 누르면 바로 열려요.' : '팝업이 차단됐어요. 이 사이트의 팝업을 허용하고 다시 눌러 주세요.', 'warn');
      UI.toast(`${name} 창을 열지 못했어요. 한 번 더 눌러 주세요.`, 5000);
    } else if (!loc) {
      UI.toast(`${name}을(를) 위치 없이 열었어요. 지도에서 내 위치 버튼을 눌러 주세요.`, 5000);
    }
  } catch (e) { UI.toast('지도를 열지 못했어요: ' + msgOf(e), 5000); }
};

/* ---------- 숨기기(밴): 먹고 싶지 않은 메뉴는 추천·다시 추천·비슷한 메뉴에서 빠진다 ---------- */
function syncBanned() {
  banned = store.getBanned();
  UI.setHiddenCount(banned.size);
  if (menus.length) UI.setMenus(menus);          // 전체 메뉴 목록의 '숨김' 표시 갱신
}
function replaceOne(id) {                         // 화면에서 숨긴 카드만 다음 후보로 바꾼다(스크롤 이동 없음)
  if (!last || !last.current) return;
  const idx = last.current.findIndex((x) => x.menu.id === id);
  if (idx < 0) return;
  last.current.splice(idx, 1);
  const rest = rankedNow().filter((r) => !last.current.some((c) => c.menu.id === r.menu.id));
  const more = rerollPick(rest, { seed: newSeed(), k: 1, temperature: 0.03, pool: 12, history: last.shown });
  last.current.push(...more);
  last.shown.push(...more.map((p) => p.menu.id));
  UI.renderResults(last.current, { noScroll: true });
}
document.addEventListener('menu:ban', (ev) => {
  const { id, name } = ev.detail || {};
  try { store.ban(id); } catch (e) { UI.toast('숨기지 못했어요: ' + msgOf(e), 4000); return; }
  syncBanned();
  replaceOne(id);
  UI.toast(`"${name || '메뉴'}" 메뉴를 숨겼어요. 더 이상 추천하지 않아요.`, 7000,
    { label: '되돌리기', onClick: () => { store.unban(id); syncBanned(); } });
});
document.addEventListener('menu:unban', (ev) => {
  store.unban(ev.detail && ev.detail.id); syncBanned(); UI.toast('숨김을 해제했어요');
});
document.addEventListener('menu:unban-all', () => {
  if (!banned.size || !confirm(`숨긴 메뉴 ${banned.size}개를 모두 해제할까요?`)) return;
  store.clearBanned(); syncBanned(); UI.toast('숨긴 메뉴를 모두 해제했어요');
});
