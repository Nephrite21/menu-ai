/* 통합: UI 이벤트(menu:*) ↔ store / embed / recommend.  ES module, 번들러 없음.
   계약은 SPEC.md 의 'UI 이벤트' 절. 검색·리롤은 detail.signal(AbortSignal)을 지켜야 한다. */
import * as store from '../js/store.js';
import { initEmbedder, embed, embedMenu, menuVector } from '../js/embed.js';
import { recommend, rerollPick, parseQuery, loadDictionaries } from '../js/recommend.js';
import { openMapSearch, SERVICES } from '../js/maps.js';

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
async function reload() {
  menus = await store.getAll({ baseUrl: here('../menus.json') });
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
let last = null; // { ranked, shown: id[] }
const newSeed = () => Math.random().toString(36).slice(2);

const pickK = () => (UI.pickCount ? UI.pickCount() : CFG.pick);
function showPicks() {
  const k = pickK();
  const pool = Math.max(12, last.shown.length + k * 2, k * 2);
  const picks = rerollPick(last.ranked, { seed: newSeed(), k, temperature: 0.03, pool, history: last.shown });
  last.shown.push(...picks.map((p) => p.menu.id));
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
    const ranked = recommend({ queryVec, menus, cuisines: d.cuisines, weights, exclude, topN: CFG.topN, seed: newSeed(), weightScale: CFG.weightScale });
    last = { ranked, shown: [] };
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
    UI.toast(`가져왔어요: 추가 ${r.added}, 갱신 ${r.updated}, 건너뜀 ${r.skipped}` + (r.errors && r.errors.length ? ` · 오류 ${r.errors.length}건` : ''), 5000);
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
    return recommend({ queryVec: v, menus, topN: 7, weightScale: CFG.weightScale })
      .filter((r) => r.menu.id !== m.id).slice(0, 5).map((r) => ({ menu: r.menu, score: r.score }));
  } catch (e) { console.warn('[app] 비슷한 메뉴 계산 실패', e); return []; }
};

/* ---------- 내 주변에서 찾기: 카카오맵/네이버지도/구글지도 (위치 요청 → 지도 검색 주소를 새 창으로 연다) ---------- */
const WHY = { denied: '위치 권한을 허용하지 않아서', unavailable: '위치를 알 수 없어서', timeout: '위치 확인이 너무 오래 걸려서', unsupported: '이 브라우저에서는 위치를 쓸 수 없어서' };
UI.openMap = async (service, query, radiusM) => {
  try {
    const r = await openMapSearch(service, { query, radiusM });
    const name = (SERVICES[service] || {}).label || '지도';
    if (r.blocked) UI.toast('팝업이 차단됐어요. 이 사이트의 팝업을 허용하고 다시 눌러 주세요.', 5000);
    else if (!r.located) UI.toast(`${WHY[r.reason] || '위치 없이'} ${name}을(를) 위치 없이 열었어요. 지도에서 내 위치 버튼을 눌러 주세요.`, 6000);
  } catch (e) { UI.toast('지도를 열지 못했어요: ' + msgOf(e), 5000); }
};
