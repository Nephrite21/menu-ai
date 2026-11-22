# MenuSuggestion SPEC (모든 에이전트의 공통 계약)

상황 문장 → 로컬 임베딩(Transformers.js) → 메뉴 추천. **런타임에 외부 AI API 호출 금지.** GitHub Pages 정적 배포.

## 원칙
- 각 에이전트는 **자기 소유 파일만 수정**한다. 남의 파일이 필요하면 SPEC의 인터페이스만 가정하고, 변경이 필요하면 최종 보고에 "요청사항"으로 적는다.
- 번들러 없음. 브라우저 코드는 순수 ES Modules. 빌드 스크립트는 Node(.mjs).
- 개인정보(이름, 이메일, 경로의 사용자명 등)를 외부 요청(User-Agent 포함)에 넣지 않는다. UA는 `MenuSuggestionBot/0.1 (hobby project)` 사용.
- 모델: `Xenova/multilingual-e5-small` (D가 벤치 후 변경 제안 가능). 벡터 384차원, L2 정규화.

## 디렉터리와 소유권
```
SPEC.md                         (오케스트레이터)
web/index.html, web/list.html, web/css/*, web/mock/*      A(UI)
web/js/recommend.js, web/js/parse.js, data/dict/*, tests/recommend.*   B(추천엔진)
data/menus/*, scripts/merge.mjs, scripts/validate.mjs, web/js/store.js, .github/**   C(데이터·저장·자동화)
web/js/embed.js, scripts/embed.mjs, scripts/bench/*, docs/tech-notes.md   D(기술고문)
scripts/crawl/*, data/raw/*     E(크롤러)
```

## 메뉴 스키마 (data/menus/*.json 은 벡터 없는 배열)
```json
{
  "id": "kr-kimchi-jjigae",
  "name": "김치찌개",
  "cuisine": "korean",
  "ingredients": ["김치", "돼지고기", "두부"],
  "tags": ["국물", "매운", "밥반찬"],
  "desc": "얼큰하고 뜨끈한 국물 요리. 해장, 비 오는 날.",
  "source": "curated | wikidata | wikipedia | recipe-db | franchise | user",
  "brand": "프랜차이즈일 때만",
  "attribution": "Wikipedia CC BY-SA 등 출처 표기가 필요할 때",
  "vec": "빌드 산출물(web/menus.json)에서만 존재. int8 양자화 배열 + scale"
}
```
- `cuisine` 허용값: korean, western, chinese, japanese, vietnamese, mexican, thai, indian, fusion, snack, cafe, other
- `id`: `<cuisine 약자>-<romanized-slug>`, 소문자/숫자/하이픈, 전체에서 유일
- 재료는 한국어 표준 명칭(예: "닭고기", "소고기", "돼지고기", "해산물"). 정규화 사전은 B의 `data/dict/ingredients.json`.

## 임베딩 API (D) — web/js/embed.js
```js
export async function initEmbedder({ onProgress }) // 모델 로드, 진행률 콜백(0~1)
export async function embed(text, { kind }) // kind: 'query'|'passage'. e5 접두어 처리는 내부에서. → Float32Array(384) L2정규화
export function dequantize(int8Array, scale)  // → Float32Array
```
- 메뉴 passage 문장 생성 규칙(빌드·브라우저 공통): `${name}. ${cuisineKo}. ${ingredients.join(', ')}. ${tags.join(', ')}. ${desc}`
  이 함수는 `web/js/embed.js`의 `menuToPassage(menu)`로 export, scripts/embed.mjs도 동일 함수를 import해 사용.

## 추천 API (B) — web/js/recommend.js
```js
// weights: { "닭고기": -1, "소고기": 2, "국물": 1, ... }  값: -2(강한 비선호) ~ +2(강한 선호), 별도 exclude 집합은 하드 제외
export function recommend({ queryVec, menus, cuisines, weights, exclude, topN, seed, history })
  // → [{ menu, score, sim, bonus, reasons: string[] }]
export function parseQuery(text) // "비 오는 날 -닭고기 +소고기" → { text: "비 오는 날", weights: {닭고기:-1, 소고기:1}, exclude: Set }
  // 접두어: + → +1, ++ → +2, - → -1, -- → -2, ! 또는 ✕ → exclude
export function rerollPick(ranked, { seed, k, temperature }) // 상위권에서 가중 랜덤
```
- 점수 = 코사인 유사도 + Σ(weight × 보유 재료/태그/분류). 분류 단위 가중치(육류, 해산물 등)는 `data/dict/groups.json`으로 확장.
- 순수 함수. DOM/네트워크 접근 금지. Node 테스트 가능해야 함.

## 저장소 API (C) — web/js/store.js
```js
export async function getAll()        // 기본 menus.json + IndexedDB 사용자 메뉴 병합 (source:"user" 구분)
export async function addUser(menu)   // 스키마 검증 + 벡터는 호출측이 채워서 전달
export async function updateUser(id, patch)
export async function removeUser(id)
export function exportJson() / importJson(file)
```

## UI 이벤트 (A) — 로직과의 접점
UI는 `document`에 CustomEvent만 발행, 로직은 구독 측이 구현. 목업 모드에서는 `web/mock/menus.mock.json`로 동작.
- `menu:search` detail `{ text, cuisines: string[], weights: {}, exclude: string[] }`
- `menu:reroll`
- `menu:add` detail `{ name, cuisine, ingredients[], desc }`
- `menu:suggest-public` detail `{ menu }`  (GitHub 이슈 제안)
- 결과 렌더링은 `window.MenuUI.renderResults([{menu, score, reasons}])` 형태로 노출

## 출처·라이선스
- Wikipedia/Wikidata 유래 항목은 `attribution` 필수. 푸터에 출처 표기.
- 크롤링은 robots.txt와 약관 확인 후 허용된 곳만. 공식 API 우선. 요청 간 1초 이상 간격.

## 완료 보고 형식 (각 에이전트)
1) 만든 파일 목록 2) 실행/검증 방법과 결과 3) SPEC 대비 변경·가정 4) 타 에이전트에 대한 요청사항
