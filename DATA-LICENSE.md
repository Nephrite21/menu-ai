# 데이터 라이선스

이 저장소의 **코드**는 [MIT 라이선스](LICENSE)입니다. 아래 **데이터**는 별도로 다음 조건을 따릅니다.

## 대상

- `data/menus/` — 직접 정리한 메뉴(큐레이션·프랜차이즈 대표 메뉴)
- `data/raw/` — 위키백과·위키데이터에서 수집한 원시 데이터와 가공 결과
- `data/merged.json`, `web/menus.json` 등 위 데이터에서 빌드한 파일 (벡터 포함)

## 조건: CC BY-SA 4.0

데이터에는 **위키백과 본문(CC BY-SA 4.0)에서 가져온 설명**이 포함되어 있어서, 이를 담은 데이터 전체를
[Creative Commons 저작자표시-동일조건변경허락 4.0](https://creativecommons.org/licenses/by-sa/4.0/deed.ko)으로 배포합니다.

- 위키백과/위키데이터에서 온 항목은 각 메뉴의 `attribution` 필드에 문서 주소가 들어 있습니다. 재사용할 때 이 표기를 유지해 주세요.
- 위키데이터의 구조화 정보(원산지, 라벨 등)는 [CC0](https://creativecommons.org/publicdomain/zero/1.0/deed.ko)입니다.
- 직접 정리한 메뉴 데이터(`source: "curated"`, `"franchise"`)도 같은 조건(CC BY-SA 4.0)으로 공개합니다.
- 사용자가 이슈로 제안해 병합된 메뉴(`source: "curated"`, 출처에 이슈 번호 표기)는 제안 시 공개 데이터셋 포함에 동의한 것으로 봅니다.

## 상표·이름

프랜차이즈 메뉴에 쓰인 브랜드·메뉴 이름은 각 권리자의 상표이며, 이 프로젝트는 해당 회사와 무관합니다.
가격·열량 등 사실 정보는 담지 않았고, 이름과 일반적인 특징만 정리했습니다.

## 그 밖의 구성요소

| 구성요소 | 라이선스 |
|---|---|
| 아이콘 [Lucide](https://lucide.dev) | ISC (`web/ui/icons-LICENSE.txt`) |
| 검색 모델 [multilingual-e5-small](https://huggingface.co/Xenova/multilingual-e5-small) | MIT |
| [Transformers.js](https://github.com/huggingface/transformers.js) | Apache-2.0 |
