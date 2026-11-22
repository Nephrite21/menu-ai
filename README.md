# MenuAI — 상황에 맞는 메뉴 추천

"비 오는 날 뜨끈한 국물", "든든한 소고기 요리 +소고기 !닭고기"처럼 **상황을 문장으로 입력하면** 어울리는 메뉴를 추천해 주는 정적 웹 앱입니다.
**AI API를 호출하지 않습니다.** 임베딩 모델(`multilingual-e5-small`)이 브라우저 안에서(WASM) 직접 돌고, 모델은 처음 한 번만 내려받아 브라우저에 캐시됩니다.

## 기능

- 상황 문장 → 의미 유사도로 메뉴 추천 (한식·북한·양식·중식·일식·베트남·멕시코·태국·인도·퓨전·분식·카페)
- 재료 가중치: `+소고기`(선호) `++`(강한 선호) `-닭고기`(비선호) `!닭고기`(제외), 상세 설정의 칩으로도 지정
- 일상 메뉴, 주요 프랜차이즈 대표 메뉴, 퓨전 메뉴, 위키 기반 세계 요리 (약 1,300개)
- 3/5/10개씩 추천, 다시 추천, 메뉴 상세 창(재료·태그·비슷한 메뉴·출처)
- 상세 창에서 카카오맵/네이버지도/구글지도로 **내 주변 검색** 열기 (API 키 불필요, 위치는 저장·전송하지 않음)
- "이게 없다고?": 내 브라우저에 메뉴 추가(내보내기/가져오기 지원), 공용 목록에는 GitHub 이슈로 제안 → 자동 검증 → PR

## 구조

```
크롤링(Wikidata/Wikipedia) ─ 큐레이션 ─▶ 병합·검증 ─▶ 임베딩(빌드 시 1회) ─▶ web/menus.json ─▶ 정적 사이트
```

- `web/` — 사이트(순수 HTML/CSS/ES Modules, 번들러 없음)
- `data/menus/` — 직접 정리한 메뉴 · `data/raw/` — 크롤링 결과 · `data/dict/` — 재료/분류 사전
- `scripts/` — 크롤러, 검증, 병합, 임베딩, 종류 재분류
- `docs/tech-notes.md` — 모델 벤치마크, 정합성 검증, 지도 링크 검증 기록
- `SPEC.md` — 모듈 간 계약(스키마, API, UI 이벤트)

## 개발

Node.js 20 이상이 필요합니다.

```bash
npm ci
npm test                 # 단위 테스트
npm run build            # 검증 → 병합 → 임베딩 → 사전 복사 (web/menus.json 생성)
python -m http.server -d web 8000   # http://localhost:8000
```

- `web/menus.json`, `web/dict/`는 빌드 산출물이라 저장소에는 없습니다. GitHub Actions가 배포 때 만듭니다.
- 사내망/백신이 TLS를 가로채는 PC에서는 `node --use-system-ca scripts/embed.mjs`처럼 실행하세요.
- 위치 기능은 HTTPS 또는 `localhost`에서만 동작합니다.

## 배포 (GitHub Pages)

`main`에 push하면 `.github/workflows/deploy.yml`이 검증 → 병합 → 임베딩 → Pages 배포를 합니다.
저장소 설정에서 **Settings → Pages → Source = GitHub Actions**, **Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests"** 를 켜야 합니다.

## 메뉴 제안

없는 메뉴가 있으면 사이트의 "이게 없다고?" → "공용 목록에도 제안"을 누르거나 [이슈 폼](../../issues/new?template=menu-suggestion.yml)으로 제안해 주세요.
이슈는 자동으로 검증되고, 통과하면 검토용 PR이 만들어집니다.

## 라이선스

- 코드: [MIT](LICENSE)
- 데이터(위키백과 유래 설명 포함): [CC BY-SA 4.0](DATA-LICENSE.md)
- 아이콘 Lucide(ISC), 검색 모델 multilingual-e5-small(MIT), Transformers.js(Apache-2.0)
