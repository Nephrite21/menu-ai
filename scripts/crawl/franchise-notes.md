# 프랜차이즈 공식 사이트 robots.txt 조사 메모

- 조사일: 2026-11-22. 방법: 각 호스트의 `/robots.txt` 1회 GET(UA `MenuSuggestionBot/0.1 (hobby project)`, 호스트 간 1.2초 간격). 본문·메뉴 페이지는 **수집하지 않음**.
- 이번 범위에서 프랜차이즈 스크래핑은 **하지 않는다**. 이 표는 "나중에 한다면 어디까지 가능한가"를 보기 위한 허용 경로 확인용이다.
- **이용약관(ToS)과 저작권(메뉴 이미지/설명문)은 아직 검토하지 않았다.** robots.txt가 허용해도 약관 확인 전에는 수집 금지. 수집한다 해도 브랜드명+메뉴명 같은 사실 정보 위주로 하고 설명문·이미지는 복제하지 않는 것을 권장.
- 판정 기준: `허용` = `User-agent: *`(또는 우리 UA에 해당하는 그룹)가 루트를 허용. `부분` = 일부 경로만 금지. `금지` = `*`에 `Disallow: /`. `미확인` = robots.txt 없음/오류/차단 → RFC 9309상 404는 "제한 없음"이지만, 프로젝트 규칙(확인 못 한 곳은 크롤링 금지)에 따라 **수집 금지**로 취급.

| 브랜드 | 호스트 | robots.txt 결과 | 판정 | 비고 |
|---|---|---|---|---|
| 맥도날드 | www.mcdonalds.co.kr | `User-agent: *` / `Allow: /` | 허용 | 약관 미검토 |
| 버거킹 | www.burgerking.co.kr | `*` Allow `/`, sitemap.xml 제공 | 허용 | 약관 미검토. sitemap 활용 가능 |
| 스타벅스코리아 | www.starbucks.co.kr | `*` Allow `/`, sitemap.xml 제공 | 허용 | 약관 미검토 |
| BBQ | www.bbq.co.kr | `*` Allow `/` | 허용 | 약관 미검토 |
| 파리바게뜨 | www.paris.co.kr | `*` Disallow `/wp-admin/`만 (admin-ajax 허용) | 허용(부분) | 메뉴/제품 페이지는 제한 없음 |
| 이디야커피 | www.ediya.com | `*` Disallow `/admin/ /manager/ /member/ /inc/ /checkplus/` | 허용(부분) | sitemap 제공 |
| 도미노피자 | web.dominos.co.kr | `*` Allow `/goods/ /event/ /contents/ /company/ /bbs/ ...`, Disallow `/order/ /mypage/ /member/ /test/` | 허용(경로 한정) | 메뉴는 `/goods/` 하위로 보임. 주문·회원 경로 금지. euc-kr 인코딩 응답 |
| BHC | www.bhc.co.kr | `*` `Allow: /` + `Content-Signal: search=yes, ai-train=no, use=reference`(Cloudflare) | 허용하나 **AI 학습 금지 신호** | 임베딩/모델 학습 데이터로 쓰는 용도와 충돌 소지 → 수집 비권장 |
| 교촌치킨 | www.kyochon.com | `User-agent: Yeti`(네이버)만 `Allow: /` | 미확인(우리 UA 규칙 없음) | 사실상 검색봇 한정 정책으로 보임 → 수집 금지 취급 |
| 롯데리아(롯데이츠) | www.lotteeatz.com | 검색엔진·SNS·AI봇 그룹별 허용 목록 존재, `User-agent: *` → **`Disallow: /`** | **금지** | 우리 UA는 `*`에 해당 → 수집 불가. (www.lotteria.com 은 DNS 해석 안 됨) |
| KFC코리아 | www.kfckorea.com | `/robots.txt` 가 404 + SPA HTML 반환 | 미확인 | |
| 맘스터치 | www.momstouch.co.kr | `/robots.txt` 가 HTML 페이지 반환(실제 robots 없음) | 미확인 | |
| 서브웨이 | www.subway.co.kr | 404(JSON 에러) | 미확인 | |
| 투썸플레이스 | www.twosome.co.kr | 403(CDN 차단) | 미확인 | 자동 접근 차단 정책으로 보임 → 시도하지 말 것 |
| 피자헛 | www.pizzahut.co.kr | 404 | 미확인 | |
| 파파존스 | www.pji.co.kr | 404 | 미확인 | |
| 한솥도시락 | www.hsd.co.kr | 404 | 미확인 | |
| 본죽 | www.bonjuk.com | 접속 시간 초과(15초) | 미확인 | 도메인 재확인 필요 |

## 요약 / 권고
- robots.txt 상 우리 UA로 접근 가능한 곳: 맥도날드, 버거킹, 스타벅스, BBQ, 파리바게뜨, 이디야, 도미노(경로 한정). 그중 BHC는 AI 학습 금지 신호가 있어 제외 권장.
- 명시적 금지: 롯데리아(롯데이츠). 정책 불명/차단: 교촌, KFC, 맘스터치, 서브웨이, 투썸, 피자헛, 파파존스, 한솥, 본죽.
- 다음 단계가 필요하다면(이번 범위 밖): 허용 브랜드 몇 곳의 이용약관을 먼저 읽고, 메뉴명·카테고리 같은 사실 정보만 소량(요청 간 >=1초, 목록 페이지 위주) 수집. 대안으로 사용자 제안(GitHub 이슈, `menu:suggest-public`)이나 직접 큐레이션이 더 안전하다.
- 이 표는 시점 스냅샷이다. robots.txt는 수시로 바뀌므로 실제 수집 직전에 재확인할 것.
