#!/usr/bin/env node
// scripts/infer-cuisine.mjs — 임베딩 kNN 으로 cuisine:'other' 메뉴 재분류 (소유: D. 기술고문)
//
//   node --use-system-ca scripts/infer-cuisine.mjs [--device cpu|wasm] [--report scripts/bench/results/infer-cuisine.json]
//
// 입력  : data/raw/menus.raw.json (크롤러 산출물, 덮어쓰지 않음), data/menus/*.json (큐레이션·프랜차이즈)
// 출력  : data/raw/menus.inferred.json — menus.raw.json 과 같은 메뉴 스키마 배열(전체 항목).
//         재분류된 항목: cuisine 교체, id 접두어 교정, cuisineInferred:true, cuisineConfidence(0~1),
//         _infer:{ from, share, margin, maxSim, neighbors[] }  (재분류 안 된 대상도 _infer 로 최선 추정을 남김 → 검수용)
//         scripts/bench/results/infer-cuisine.json — LOO 평가·임계값·분포·검수 샘플
//
// 정답(라벨 확실) 집합 G
//   1) data/menus/*.json 전부(큐레이션 + franchise) — 12개 cuisine 모두 라벨로 사용
//   2) 위키 항목 중 _wd.cuisineBy ∈ {P495, P495>P17, P2012} 이고 cuisine != other (원산지/요리계통 근거)
//   3) 위키 항목 중 cuisine == other 이지만 _wd.origins(원산지 P495)가 있는 것 — 원산지가 "지원 cuisine 밖"
//      (인도네시아·튀르키예·나이지리아 등)이라는 근거가 있는 'other'. 재분류 대상이 아니라 'other' 정답 예시로 쓴다.
//   (_wd.cuisineBy == 'desc' 는 설명 키워드 휴리스틱 라벨이라 G 에서 제외, 대상에서도 제외 — 그대로 둠)
// 재분류 대상 T: cuisine == other && 원산지 정보 없음(_wd.origins 비어 있음)
//
// 순환 방지: 분류용 문장 = menuToPassage 에서 cuisine 문구만 뺀 것(이름. 재료. 태그. 설명).
//            최종 서비스 벡터는 merge → scripts/embed.mjs 가 원래 passage(새 cuisine 포함)로 다시 계산(해시 캐시로 변경분만).
// 방식    : 코사인 상위 k 이웃, 가중치 exp((sim - sim_1)/τ) 의 가중 다수결. 'other' 도 득표하지만 결과로 'other' 가
//           이기면 "변경 없음". 신뢰도 = (득표율 share, 1·2위 격차 margin, 예측 클래스 최고 유사도 maxSim) 이
//           모두 임계값 이상일 때만 재분류. k·τ·임계값은 G 의 leave-one-out(동명 항목도 함께 가림)으로 정한다.
//           설명이 빈 대상은 G 에서 설명을 지운 문장으로 따로 LOO 를 돌려 더 엄격한 정밀도 목표로 임계값을 정한다.
import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { ROOT, readJson, atomicWrite, embedCached, loadEmbCache } from './embed.mjs';

const E = await import(pathToFileURL(path.join(ROOT, 'web/js/embed.js')).href);
const { CUISINE_ABBR, CUISINES } = await import(pathToFileURL(path.join(ROOT, 'web/js/store.js')).href);

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const DEVICE = opt('--device', 'cpu'); // 분류용 벡터는 배포되지 않으므로 빠른 CPU 기본
const RAW = path.join(ROOT, 'data/raw/menus.raw.json');
const OUT = path.join(ROOT, 'data/raw/menus.inferred.json');
const REPORT = path.resolve(ROOT, opt('--report', 'scripts/bench/results/infer-cuisine.json'));
const PREC_TARGET = 0.9; // 설명 있는 대상
const PREC_TARGET_NODESC = 0.95; // 설명 없는 대상(이름·재료·태그만) — 더 엄격
const GOLD_BY = new Set(['P495', 'P495>P17', 'P2012']);

// ---------- 데이터 ----------
const raw = await readJson(RAW);
const curated = [];
for (const f of (await readdir(path.join(ROOT, 'data/menus'))).filter((f) => f.endsWith('.json')).sort()) {
  const arr = await readJson(path.join(ROOT, 'data/menus', f));
  if (Array.isArray(arr)) curated.push(...arr.map((m) => ({ ...m, _file: f })));
}
const nameKey = (s) => String(s ?? '').normalize('NFC').replace(/\s*\(.*?\)\s*/g, '').replace(/\s+/g, '').toLowerCase();
const hasDesc = (m) => !!(m.desc && m.desc.trim());
const isWiki = (m) => m.source === 'wikipedia' || m.source === 'wikidata';

const gold = [];
for (const m of curated) gold.push({ m, label: m.cuisine, kind: 'curated' });
for (const m of raw) {
  const by = m._wd?.cuisineBy;
  if (m.cuisine !== 'other' && GOLD_BY.has(by)) gold.push({ m, label: m.cuisine, kind: 'wiki-origin' });
  else if (m.cuisine === 'other' && m._wd?.origins?.length) gold.push({ m, label: 'other', kind: 'wiki-origin-other' });
}
const targets = raw.map((m, idx) => ({ m, idx })).filter(({ m }) => m.cuisine === 'other' && !m._wd?.origins?.length);
console.log(`정답 집합 ${gold.length} (큐레이션 ${curated.length}, 위키 원산지 ${gold.filter((g) => g.kind === 'wiki-origin').length}, 위키 원산지-other ${gold.filter((g) => g.kind === 'wiki-origin-other').length})`);
console.log(`재분류 대상 ${targets.length} (설명 없음 ${targets.filter((t) => !hasDesc(t.m)).length}) / 원산지 있는 other ${raw.filter((m) => m.cuisine === 'other' && m._wd?.origins?.length).length}는 유지`);

// ---------- 임베딩 (cuisine 문구 제외 문장) ----------
const clsText = (m, { noDesc = false } = {}) => E.menuToPassage({ ...m, cuisine: '', desc: noDesc ? '' : m.desc });
const cache = await loadEmbCache();
const G = (await embedCached(gold.map((g) => clsText(g.m)), { device: DEVICE, cache, label: '정답(전체문장)' })).vectors;
const Gnd = (await embedCached(gold.map((g) => clsText(g.m, { noDesc: true })), { device: DEVICE, cache, label: '정답(설명 제거)' })).vectors;
const Tv = (await embedCached(targets.map((t) => clsText(t.m)), { device: DEVICE, cache, label: '대상' })).vectors;
const goldKeys = gold.map((g) => nameKey(g.m.name));

// ---------- kNN ----------
function knn(qv, { k, tau, excludeKey = null }) {
  const sims = [];
  for (let j = 0; j < G.length; j++) {
    if (excludeKey !== null && goldKeys[j] === excludeKey) continue; // LOO: 자기 자신 + 동명 항목 가림
    sims.push({ j, s: E.dot(qv, G[j]) });
  }
  sims.sort((a, b) => b.s - a.s);
  const top = sims.slice(0, k);
  const s1 = top[0].s;
  const votes = {};
  let total = 0;
  const maxSimBy = {};
  for (const { j, s } of top) {
    const w = Math.exp((s - s1) / tau);
    const l = gold[j].label;
    votes[l] = (votes[l] || 0) + w;
    total += w;
    maxSimBy[l] = Math.max(maxSimBy[l] ?? -1, s);
  }
  const ranked = Object.entries(votes).sort((a, b) => b[1] - a[1]);
  const best = ranked.find(([l]) => l !== 'other'); // 결과 후보에서 other 제외
  const top1 = ranked[0][0];
  const pred = best ? best[0] : 'other';
  const share = best ? best[1] / total : 0;
  const second = Math.max(0, ...ranked.filter(([l]) => l !== pred).map(([, v]) => v / total));
  return {
    top1, pred, share, margin: share - second, maxSim: best ? maxSimBy[pred] : 0,
    neighbors: top.slice(0, 5).map(({ j, s }) => ({ name: gold[j].m.name, cuisine: gold[j].label, sim: +s.toFixed(4) })),
  };
}

// LOO: 각 정답 항목을 가리고 예측. useNoDesc → 쿼리 문장에서 설명을 지운 벡터 사용
function loo(params, { useNoDesc = false, subset = () => true } = {}) {
  const rows = [];
  gold.forEach((g, i) => {
    if (!subset(g)) return;
    const r = knn(useNoDesc ? Gnd[i] : G[i], { ...params, excludeKey: goldKeys[i] });
    rows.push({ i, label: g.label, ...r });
  });
  return rows;
}
const top1Acc = (rows) => rows.filter((r) => r.top1 === r.label).length / rows.length;

// 임계값 적용 결과: accept 된 것만 '재분류', label==other 인데 accept 되면 오분류
function applyThr(rows, t) {
  let acc = 0, ok = 0;
  for (const r of rows) {
    if (r.pred === 'other' || r.share < t.share || r.margin < t.margin || r.maxSim < t.maxSim) continue;
    acc++;
    if (r.pred === r.label) ok++;
  }
  const positives = rows.filter((r) => r.label !== 'other').length;
  return { accepted: acc, correct: ok, precision: acc ? ok / acc : 1, coverage: ok / positives, acceptRate: acc / rows.length };
}

function searchThr(rows, target) {
  const shares = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95];
  const margins = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
  const sims = [0.8, 0.82, 0.84, 0.85, 0.86, 0.87, 0.88, 0.89, 0.9, 0.92];
  let best = null;
  for (const share of shares) for (const margin of margins) for (const maxSim of sims) {
    const t = { share, margin, maxSim };
    const r = applyThr(rows, t);
    if (r.accepted < 20 || r.precision < target) continue; // 표본 20건 미만인 임계값은 정밀도 추정이 불안정 → 제외
    if (!best || r.coverage > best.r.coverage || (r.coverage === best.r.coverage && r.precision > best.r.precision)) best = { t, r };
  }
  return best;
}

// ---------- 하이퍼파라미터(k, τ): 위키 정답(대상과 문체·분포가 비슷) LOO top-1 정확도 ----------
const wikiOnly = (g) => g.kind !== 'curated';
const grid = [];
for (const k of [5, 10, 20, 30]) for (const tau of [0.01, 0.02, 0.05, 1]) {
  grid.push({ k, tau, accWiki: top1Acc(loo({ k, tau }, { subset: wikiOnly })), accAll: top1Acc(loo({ k, tau })) });
}
grid.sort((a, b) => b.accWiki - a.accWiki || b.accAll - a.accAll);
const P = { k: grid[0].k, tau: grid[0].tau };
console.log('\n(k, τ) 탐색 — LOO top-1 정확도(위키 / 전체):');
for (const g of grid.slice(0, 6)) console.log(`  k=${g.k} τ=${g.tau}  ${g.accWiki.toFixed(3)} / ${g.accAll.toFixed(3)}`);

// ---------- 임계값: 위키 정답 LOO 로 정밀도 목표 충족 + 커버리지 최대 ----------
const rowsWiki = loo(P, { subset: wikiOnly });
const rowsWikiND = loo(P, { subset: wikiOnly, useNoDesc: true });
const rowsAll = loo(P);
const thr = searchThr(rowsWiki, PREC_TARGET);
const thrND = searchThr(rowsWikiND, PREC_TARGET_NODESC);

// 혼동행렬·종류별 P/R (임계값 없이 top-1, 위키 정답 LOO) + 임계값 적용 후 종류별 P/R
function confusion(rows, key = 'top1') {
  const labels = CUISINES.filter((c) => rows.some((r) => r.label === c || r[key] === c));
  const M = Object.fromEntries(labels.map((a) => [a, Object.fromEntries(labels.map((b) => [b, 0]))]));
  for (const r of rows) M[r.label][r[key]]++;
  const per = {};
  for (const c of labels) {
    const tp = M[c][c];
    const fp = labels.reduce((s, a) => s + (a !== c ? M[a][c] : 0), 0);
    const fn = labels.reduce((s, b) => s + (b !== c ? M[c][b] : 0), 0);
    per[c] = { n: tp + fn, precision: tp + fp ? tp / (tp + fp) : null, recall: tp + fn ? tp / (tp + fn) : null };
  }
  return { labels, matrix: M, per };
}
function perClassThr(rows, t) {
  const per = {};
  for (const c of CUISINES) {
    if (c === 'other') continue;
    const pos = rows.filter((r) => r.label === c).length;
    const accC = rows.filter((r) => r.pred === c && r.share >= t.share && r.margin >= t.margin && r.maxSim >= t.maxSim);
    const tp = accC.filter((r) => r.label === c).length;
    if (!pos && !accC.length) continue;
    per[c] = { n: pos, predicted: accC.length, precision: accC.length ? tp / accC.length : null, recall: pos ? tp / pos : null };
  }
  return per;
}

// ---------- 대상 재분류 ----------
const targetKey = new Set(targets.map((t) => nameKey(t.m.name)));
const usedIds = new Set([...raw.map((m) => m.id), ...curated.map((m) => m.id)]);
const decisions = targets.map((t, n) => {
  const r = knn(Tv[n], P);
  const nd = !hasDesc(t.m);
  const T = nd ? thrND?.t : thr?.t;
  const accept = !!T && r.pred !== 'other' && r.share >= T.share && r.margin >= T.margin && r.maxSim >= T.maxSim;
  return { ...t, r, nd, accept };
});
const out = raw.map((m) => ({ ...m }));
for (const d of decisions) {
  const m = out[d.idx];
  m._infer = {
    from: 'other', best: d.r.pred, share: +d.r.share.toFixed(3), margin: +d.r.margin.toFixed(3), maxSim: +d.r.maxSim.toFixed(4),
    noDesc: d.nd, applied: d.accept, model: `${E.MODEL_ID}@${E.MODEL_REVISION.slice(0, 7)}`, k: P.k, tau: P.tau, neighbors: d.r.neighbors,
  };
  if (!d.accept) continue;
  m.cuisine = d.r.pred;
  m.cuisineInferred = true;
  m.cuisineConfidence = +d.r.share.toFixed(3);
  usedIds.delete(m.id);
  let id = m.id.replace(/^[a-z]{2}-/, `${CUISINE_ABBR[d.r.pred]}-`);
  if (usedIds.has(id)) id = `${id}-${(m._wd?.qid ?? 'x').toLowerCase()}`;
  usedIds.add(id);
  m.id = id;
}
await atomicWrite(OUT, '[\n' + out.map((m) => JSON.stringify(m)).join(',\n') + '\n]\n');

// ---------- 독립 점검: 설명 속 국가/지역 키워드로 만든 "은(silver) 라벨" (예측에는 안 씀) ----------
// 주의: 한국어 조사와 겹치는 지명(구이"란", "가나"다 등)은 앞 글자가 한글이 아닐 때만 매칭. 그래도 잡음이 있는 점검용 라벨이다.
const SILVER = [
  ['other', /브라질|페루|칠레|콜롬비아|볼리비아|베네수엘라|에콰도르|우루과이|파라과이|쿠바|자메이카|카리브|푸에르토리코|(?<![가-힣])이란|이라크|터키|튀르키예|레바논|시리아|이스라엘|팔레스타인|요르단|아랍|중동|이집트|모로코|알제리|튀니지|리비아|아프리카|나이지리아|에티오피아|케냐|(?<![가-힣])가나|세네갈|니제르|베냉|인도네시아|(?<![가-힣])자바|(?<![가-힣])발리(?![다는고])|말레이|필리핀|싱가포르|미얀마|버마|캄보디아|라오스|몽골|중앙아시아|우즈베크|카자흐|키르기스|타지크|투르크멘|아프가니스탄|조지아|아르메니아|아제르바이잔|티베트/],
  ['korean', /한국|조선|한식|북한|경상도|전라도|충청도|강원도|제주|평안도|함경도/],
  ['japanese', /일본|홋카이도|오키나와|규슈|후쿠오카|가고시마|미야자키|도쿄|오사카|교토|나고야|에도 시대/],
  ['chinese', /중국|대만|타이완|홍콩|마카오|광둥|쓰촨|사천|저장성|산둥|베이징|상하이|윈난|후난|푸젠/],
  ['vietnamese', /베트남/], ['thai', /태국/], ['mexican', /멕시코/],
  ['indian', /인도(?!네시아|차이나|양)|파키스탄|방글라데시|네팔|스리랑카/],
  ['western', /프랑스|이탈리아|스페인|독일|영국|잉글랜드|스코틀랜드|웨일스|아일랜드|미국|캐나다|포르투갈|그리스|러시아|폴란드|오스트리아|스위스|네덜란드|벨기에|헝가리|체코|슬로바키아|스웨덴|노르웨이|덴마크|핀란드|아이슬란드|우크라이나|벨라루스|리투아니아|라트비아|에스토니아|루마니아|불가리아|세르비아|크로아티아|슬로베니아|오스트레일리아|호주|뉴질랜드|아르헨티나|유럽/],
];
function silverLabel(m) {
  const text = `${m.name} ${m.desc ?? ''}`;
  let best = null;
  for (const [c, re] of SILVER) { const x = re.exec(text); if (x && (!best || x.index < best.i)) best = { c, i: x.index }; }
  return best?.c ?? null;
}
const silver = decisions.map((d) => ({ d, s: silverLabel(d.m) })).filter((x) => x.s);
const silverEval = (() => {
  const acc = silver.filter((x) => x.d.accept);
  const ok = acc.filter((x) => x.d.r.pred === x.s).length;
  const otherSilver = silver.filter((x) => x.s === 'other');
  return {
    n: silver.length, accepted: acc.length, precision: acc.length ? ok / acc.length : null,
    recallNonOther: silver.filter((x) => x.s !== 'other').length ? ok / silver.filter((x) => x.s !== 'other').length : null,
    silverOtherWronglyMoved: otherSilver.filter((x) => x.d.accept).length, silverOther: otherSilver.length,
    bestGuessTop1: silver.filter((x) => (x.d.r.share >= 0.5 ? x.d.r.pred : 'other') === x.s).length / silver.length,
  };
})();

// ---------- 분포·리포트 ----------
const dist = (arr) => Object.fromEntries(CUISINES.map((c) => [c, arr.filter((m) => m.cuisine === c).length]).filter(([, v]) => v));
const applied = decisions.filter((d) => d.accept);
const byGroup = (nd) => {
  const ds = decisions.filter((d) => d.nd === nd);
  return { targets: ds.length, applied: ds.filter((d) => d.accept).length, to: dist(ds.filter((d) => d.accept).map((d) => ({ cuisine: d.r.pred }))) };
};
// 검수용 샘플 20: (a) 적용됐지만 은라벨과 다른 것 → (b) 적용 중 신뢰도 낮은 순
const review = [];
for (const x of silver) if (x.d.accept && x.d.r.pred !== x.s) review.push({ why: `설명 키워드는 ${x.s}`, d: x.d });
for (const d of [...applied].sort((a, b) => a.r.share - b.r.share)) {
  if (review.length >= 20) break;
  if (!review.some((r) => r.d === d)) review.push({ why: '적용 중 신뢰도 하위', d });
}
const reviewRows = review.slice(0, 20).map(({ why, d }) => ({
  id: out[d.idx].id, name: d.m.name, pred: d.r.pred, conf: +d.r.share.toFixed(2), margin: +d.r.margin.toFixed(2), maxSim: +d.r.maxSim.toFixed(3),
  noDesc: d.nd, why, desc: (d.m.desc ?? '').slice(0, 70), nn: d.r.neighbors.slice(0, 3).map((n) => `${n.name}(${n.cuisine},${n.sim.toFixed(3)})`).join(' '),
}));

const report = {
  date: new Date().toISOString(), model: `${E.MODEL_ID}@${E.MODEL_REVISION}`, device: DEVICE,
  goldCounts: { total: gold.length, byKind: Object.fromEntries(['curated', 'wiki-origin', 'wiki-origin-other'].map((k) => [k, gold.filter((g) => g.kind === k).length])), byLabel: dist(gold.map((g) => ({ cuisine: g.label }))) },
  params: P, grid,
  loo: {
    wiki: { n: rowsWiki.length, top1Acc: top1Acc(rowsWiki), confusion: confusion(rowsWiki), thresholds: thr?.t, atThr: thr?.r, perClassAtThr: thr ? perClassThr(rowsWiki, thr.t) : null },
    wikiNoDesc: { n: rowsWikiND.length, top1Acc: top1Acc(rowsWikiND), thresholds: thrND?.t, atThr: thrND?.r, perClassAtThr: thrND ? perClassThr(rowsWikiND, thrND.t) : null, atNormalThr: thr ? applyThr(rowsWikiND, thr.t) : null },
    all: { n: rowsAll.length, top1Acc: top1Acc(rowsAll), atThr: thr ? applyThr(rowsAll, thr.t) : null },
  },
  targets: { total: targets.length, applied: applied.length, withDesc: byGroup(false), noDesc: byGroup(true) },
  silverCheck: silverEval,
  distribution: { rawBefore: dist(raw), rawAfter: dist(out) },
  review: reviewRows,
};
await atomicWrite(REPORT, JSON.stringify(report, null, 2) + '\n');

// ---------- 콘솔 요약 ----------
const f = (x, d = 3) => (x == null ? '-' : x.toFixed(d));
console.log(`\n선택: k=${P.k}, τ=${P.tau}`);
console.log(`LOO(위키 정답 ${rowsWiki.length}) top-1 정확도 ${f(rowsWiki.length && top1Acc(rowsWiki))}, 전체 정답 ${f(top1Acc(rowsAll))}, 설명 제거 ${f(top1Acc(rowsWikiND))}`);
console.log(`임계값(설명 있음, 정밀도≥${PREC_TARGET}): ${JSON.stringify(thr?.t)} → ${JSON.stringify(thr?.r && Object.fromEntries(Object.entries(thr.r).map(([k, v]) => [k, +v.toFixed?.(3) || v])))}`);
console.log(`임계값(설명 없음, 정밀도≥${PREC_TARGET_NODESC}): ${JSON.stringify(thrND?.t)} → ${JSON.stringify(thrND?.r && Object.fromEntries(Object.entries(thrND.r).map(([k, v]) => [k, +v.toFixed?.(3) || v])))}`);
console.log(`대상 ${targets.length} → 재분류 ${applied.length} (설명 있음 ${report.targets.withDesc.applied}/${report.targets.withDesc.targets}, 설명 없음 ${report.targets.noDesc.applied}/${report.targets.noDesc.targets})`);
console.log(`은라벨 점검: ${JSON.stringify(silverEval)}`);
console.log(`분포 전: ${JSON.stringify(report.distribution.rawBefore)}`);
console.log(`분포 후: ${JSON.stringify(report.distribution.rawAfter)}`);
console.log(`출력: ${path.relative(ROOT, OUT)}, 리포트: ${path.relative(ROOT, REPORT)}`);
