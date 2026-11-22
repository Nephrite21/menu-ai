# 기술 노트: 임베딩, 정합성, 모델 선택, GitHub Pages

작성: D(기술 고문) · 2026-11-22 · 측정 환경: Windows 11, Ryzen 7 3700X(16스레드), RTX 2070 SUPER, Node 26.13.1, Microsoft Edge 158(헤드리스)

## 0. 결론 요약

| 항목 | 결론 |
|---|---|
| 모델 | `Xenova/multilingual-e5-small` q8 유지(SPEC 그대로). HF 커밋 `761b726`으로 고정 |
| 라이브러리 | `@huggingface/transformers@4.3.2`(2026-10-27 출시). npm과 CDN 모두 같은 버전 |
| 빌드 백엔드 | 기본값은 **onnxruntime-web WASM(Node)**. 브라우저 WASM과 벡터가 같다(코사인 1.000000) |
| 브라우저 장치 | 지시에 따라 WebGPU를 먼저 쓰고 안 되면 WASM으로 폴백하게 구현했다. 다만 실측으로는 **WASM이 10배 빠르고 정합성도 더 좋다** → WASM 기본을 제안(요청사항) |
| 벡터 형식 | int8 대칭 양자화. `vec: { q: int8[384], scale }`이고 `scale = 1/‖q‖`라서 dequantize 결과가 단위벡터다. 순위 손실은 무시할 수준(top-5 겹침 0.99) |
| 용량 | 메뉴 1,065개 기준 `web/menus.json`은 1.72MB, gzip 608KB(메뉴당 gzip 585B) |
| 모델 호스팅 | HF CDN에서 받는다(커밋 고정). 저장소에 넣지 않는다(118MB 파일이 GitHub의 100MiB 차단선을 넘음) |
| COOP/COEP | Pages에서는 설정할 수 없다 → WASM이 단일 스레드로 돈다. e5-small은 단일 스레드로도 쿼리 1건이 26ms라 문제없다 |
| 모델 대안 | EmbeddingGemma-300m q4는 품질이 확실히 더 좋다(R@5 0.67 대 0.45). 다만 WASM 쿼리가 413ms이고 Gemma 라이선스가 걸린다 → 채택은 결정 사항(요청사항) |
| cuisine 재분류 | 대상 144건 중 47건을 재분류했다(LOO 정밀도 0.91). 설명 없는 17건은 정밀도 기준(0.95)을 만족하는 임계값이 없어 하나도 바꾸지 않았다 |

---

## 1. `web/js/embed.js` 설계

- **로딩**: 최상위에 정적 import를 두지 않았다. `initEmbedder()`를 부르는 시점에만 Transformers.js를 동적으로 import한다.
  - 브라우저: `https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/dist/transformers.min.js`(단일 번들). onnxruntime-web의 wasm 파일은 Transformers.js가 jsDelivr(`onnxruntime-web@1.31.0-dev.20260914-8d85527a0`, 26.8MB)에서 받는다. 이 버전도 4.3.2에 고정되어 있다.
  - Node: npm 패키지 `@huggingface/transformers`. 그래서 `menuToPassage`, `quantize` 같은 순수 함수는 Node 빌드 스크립트가 같은 파일에서 그대로 import한다.
- **장치**: `device: 'auto'`면 `BROWSER_DEVICE_ORDER = ['webgpu', 'wasm']` 순서로 시도한다. 어댑터가 없거나 워밍업 추론에 실패하면 다음 후보로 넘어간다. `?device=wasm`처럼 고정할 수도 있다. Node에서 `'wasm'`을 주면 onnxruntime-web WASM으로, `'cpu'`를 주면 onnxruntime-node로 돈다.
- **진행률**: Transformers.js 4.x의 `progress_total` 이벤트(전체 바이트)를 0~0.95 구간에, 세션 생성과 워밍업 완료를 1로 매핑했다.
- **캐시**: 브라우저는 Cache API(`transformers-cache`)를 쓰므로 재방문 때 모델을 다시 받지 않는다. ORT wasm도 `useWasmCache`로 캐시된다. Node는 `.cache/hf/<repo>/<revision>/…`에 받는다. 다운로드 폴더는 스크립트와 분리되어 있다.
- **e5 처리**: 접두어 `query: ` / `passage: `를 붙이고, NFC 정규화와 공백 정리, mean pooling, L2 정규화까지 모두 내부에서 처리한다.
- **`menuToPassage`**: SPEC 템플릿 그대로다. 단, 빈 항목은 건너뛰어 `. .`이 생기지 않게 하고, 각 조각 끝의 마침표 중복을 없앤다. cuisine 한국어 라벨은 `CUISINE_KO`(아래 표)에 있다.

| cuisine | korean | western | chinese | japanese | vietnamese | mexican | thai | indian | fusion | snack | cafe | other |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| passage 라벨 | 한식 | 양식 | 중식 | 일식 | 베트남 음식 | 멕시코 음식 | 태국 음식 | 인도 음식 | 퓨전 음식 | 분식·간식 | 카페·디저트 | 기타 |

- 추가 export(계약은 깨지 않음): `quantize`, `menuVector(menu)`(`{q,scale}`, 배열, Float32Array 모두 처리), `dot`, `embedBatch`, `embedMenu`(사용자 메뉴용 `{q,scale}` 생성), `getEmbedderInfo`, 상수(`MODEL_ID`, `MODEL_REVISION`, `MODEL_DTYPE`, `DIM`, `CUISINE_KO`, `BROWSER_DEVICE_ORDER`).

### 발견 1: q8 모델은 문장을 묶어 배치로 돌리면 벡터가 달라진다
`model_quantized.onnx`는 동적 양자화(DynamicQuantizeLinear)를 쓴다. 이 연산은 활성값의 min/max를 **텐서 전체**에서 잡는다. 그래서 여러 문장을 패딩해 한 번에 넣으면 같은 문장이라도 결과가 바뀐다(실측 코사인 0.9966). 브라우저는 쿼리를 1건씩 임베딩하므로 **빌드도 1건씩** 처리한다(`embedBatch` 기본 batchSize=1).

### 발견 2: onnxruntime-node(CPU)와 WASM은 q8 정수 커널의 수치가 다르다
같은 모델 파일을 써도 Node 네이티브 CPU와 브라우저 WASM의 코사인이 최소 0.9966까지 떨어진다. 순위로 보면 브라우저 쿼리에 CPU로 빌드한 메뉴 벡터를 쓰면 top-5 겹침이 **0.85**까지 내려간다. 그래서 `scripts/embed.mjs`의 기본 백엔드를 onnxruntime-web WASM(Node, 단일 스레드)으로 바꿨다. 그 결과 Edge WASM과 코사인 **1.000000**이 되었다(아래 3절).

Transformers.js 4.3.2의 Node 빌드는 주입된 onnxruntime-web을 pipeline에 연결할 공식 경로가 없다(`Unsupported device`가 난다). 그래서 Node WASM 경로만 같은 pipeline 토크나이저와 같은 모델 파일을 쓰고, mean pooling과 정규화는 `embed.js` 안에서 재현했다(`createNodeWasmExtractor`). 이 재현이 정확하다는 것은 3절의 Edge 비교로 확인했다.

---

## 2. `scripts/embed.mjs` — 메뉴 벡터 빌드

```
node --use-system-ca scripts/embed.mjs [--input f.json] [--out web/menus.json] [--device wasm|cpu] [--no-cache] [--prune]
```
- 입력 우선순위: `--input` → `data/merged.json` → `data/menus/*.json`
- 출력: `web/menus.json`(메뉴 1개가 1줄인 배열, 원본 필드에 `vec:{q,scale}` 추가)과 `web/menus.meta.json`(모델, 리비전, dtype, 빌드 백엔드, 개수, 용량, 양자화 코사인)
- 캐시: `.cache/embeddings/Xenova_multilingual-e5-small.q8.json`. 키는 `sha256(모델|리비전|dtype|tjs버전|백엔드|실제 모델 입력)`이다. 1,065건을 처음 계산하면 77s(WASM, 건당 73ms) 걸리고, 다시 빌드하면 1.1s다. `--prune`은 쓰지 않는 키를 지운다.
- `--use-system-ca`: 이 PC처럼 TLS 검사 프록시나 백신이 있는 Windows에서는 Node fetch가 `SELF_SIGNED_CERT_IN_CHAIN`으로 실패한다. 이 옵션을 주면 Windows 인증서 저장소를 쓴다. 검증을 끄는 우회(`NODE_TLS_REJECT_UNAUTHORIZED=0`)는 쓰지 않았다.

**용량(1,065개, `data/merged.json`)**

| 형식 | raw | gzip | 메뉴당 gzip |
|---|---|---|---|
| 벡터 없음(참고) | 323KB | 63KB | 61B |
| **채택: int8 JSON 배열 `{q:[…],scale}`** | **1,722KB** | **608KB** | **585B** |
| int8 base64(대안) | 897KB | 503KB | 484B |
| float32 JSON(참고) | 4,081KB | 1,372KB | 1,319B |

base64로 바꿔도 gzip 기준으로는 17%만 줄어든다. 반면 B(recommend.js)와 C(store.js)가 이미 `{q,scale}` 배열을 읽으므로 SPEC 표현("int8 배열 + scale")을 유지했다. 메뉴가 1만 개를 넘으면 base64 전환을 검토한다(요청사항).

---

## 3. 정합성 검증 (`scripts/bench/verify.mjs`)

같은 문장 1,085개(상황 쿼리 20개 + `menus.json` 메뉴 1,065개)를 네 가지 경로로 임베딩해서 비교했다.
- **node-cpu**: onnxruntime-node
- **node-wasm**: 빌드 경로
- **edge-wasm**: 헤드리스 Edge가 `web/js/embed.js`를 그대로 로드(CDN 번들 + Cache API)
- **edge-webgpu**: 실제 RTX 2070(turing) 어댑터

결과 파일은 `scripts/bench/results/verify.json`이다.

| 비교 | query 코사인 min / mean | passage 코사인 min / mean |
|---|---|---|
| **node-wasm 대 edge-wasm** | **1.000000 / 1.000000** | **0.999999 / 1.000000** |
| node-wasm 대 edge-webgpu | 0.996756 / 0.999382 | 0.996075 / 0.999055 |
| node-cpu 대 edge-wasm | 0.996756 / 0.999640 | 0.996620 / 0.999114 |

| 저장된 int8(`menus.json`) 대 각 경로 float | min | mean |
|---|---|---|
| edge-wasm | 0.999964 | 0.999982 |
| edge-webgpu | 0.996083 | 0.999037 |

**순위 손실**: 기준은 node-wasm float(쿼리 20 × 메뉴 1,065)이다.

| 조합 | top-1 일치 | top-5 겹침 | top-10 겹침 | top-10 평균 순위 이동 | 최대 점수차 |
|---|---|---|---|---|---|
| int8 양자화만 | 0.95 | 0.99 | 0.99 | 0.13 | 0.0008 |
| **edge-wasm 쿼리 × int8 메뉴(실서비스)** | **0.95** | **0.99** | **0.99** | **0.13** | **0.0008** |
| edge-webgpu 쿼리 × int8 메뉴 | 0.90 | 0.96 | 0.96 | 0.43 | 0.0081 |
| (참고) cpu 빌드 int8 × edge-wasm 쿼리 | 0.90 | 0.85 | 0.89 | 1.34 | 0.0102 |

- top-1이 어긋난 1건은 점수차 0.0008 이내에서 생긴 동점에 가까운 뒤바뀜이다. B의 가중치(±1~2)에 비하면 무의미한 크기다.
- **속도**(쿼리 평균, 2회 측정): edge-wasm 23~27ms, edge-webgpu **223~264ms**, node-cpu 6.5~6.9ms. 커밋 고정 후 다시 돌린 결과도 정합성 수치는 위 표와 같다. 첫 로드는 Cache API에 모델이 있을 때 2.7~3.2s, 처음 받을 때 약 16~30s(회선 약 2MB/s)였다. q8 모델의 정수 연산(MatMulInteger, DynamicQuantizeLinear)은 WebGPU EP에서 CPU로 폴백되기 때문에 WebGPU가 오히려 느리다.
- 한계: Edge(Chromium) 한 종만 확인했다. Safari와 Firefox의 WASM SIMD 결과가 비트 단위로 같다는 보장은 없다. 같은 ORT wasm 바이너리이므로 Edge와의 차이는 작을 것으로 보지만, WebGPU 수준(코사인 0.996 이상)의 오차는 감안해야 한다.

---

## 4. 모델 벤치 (`scripts/bench/`)

- 데이터: 한국어 상황 쿼리 20개(`queries.json`, 쿼리마다 정답 메뉴 id 3~11개를 붙임)와 메뉴 59개(`menus.sample.json`)
- 메뉴 설명에는 상황 문구를 일부러 거의 넣지 않았다. 의미를 이해하는지 보려는 것이다.
- 지표: Recall@5, nDCG@10, MRR, P@1
- 크기: 실제로 받는 파일(onnx + tokenizer + config)
- 속도: Node CPU(멀티스레드)와 **WASM 단일 스레드**(`wasm-latency.mjs`, Pages 조건과 같음). 3절에서 node-wasm과 edge-wasm의 지연이 거의 같았으므로(79.1ms 대 79.6ms) WASM 단일 스레드 수치를 브라우저 추정치로 쓴다.

| 모델 | dtype | 차원 | 다운로드 | 쿼리(WASM 1스레드) | 쿼리(CPU) | RSS | R@5 | nDCG@10 | MRR | P@1 | 라이선스 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **multilingual-e5-small** | q8 | 384 | 129MB | **18.6ms** | 6.4ms | 443MB | 0.446 | 0.540 | 0.855 | 0.80 | MIT |
| multilingual-e5-small | fp32 | 384 | 465MB | – | 7.7ms | 789MB | 0.470 | 0.539 | 0.820 | 0.75 | MIT |
| multilingual-e5-base | q8 | 768 | 282MB | – | 11.3ms | 596MB | 0.277 | 0.318 | 0.540 | 0.35 | MIT |
| paraphrase-multilingual-MiniLM-L12-v2 | q8 | 384 | 129MB | – | 5.6ms | 442MB | 0.201 | 0.261 | 0.466 | 0.30 | Apache-2.0 |
| jhgan/ko-sroberta-multitask | int8(저장소 제공) | 768 | 107MB | 50.8ms | 9.1ms | 230MB | 0.542 | 0.602 | 0.861 | 0.80 | **명시 없음** |
| **EmbeddingGemma-300m** | q4 | 768 | 209MB | 413.2ms | 28.3ms | 497MB | **0.666** | **0.750** | **0.922** | **0.90** | Gemma 약관 |
| bge-m3 | q8 | 1024 | 560MB | 219.5ms | 25.8ms | 891MB | 0.468 | 0.583 | 0.889 | 0.85 | MIT |

해석:
- **q8과 fp32 차이**: e5-small에서 q8과 fp32는 차이가 없다(R@5 0.446 대 0.470, MRR은 q8이 오히려 높음). 다운로드는 3.6배 차이 나므로 q8이 맞다.
- **EmbeddingGemma**: 쿼리별 R@5로 비교하면 e5-small보다 14승 5무 1패다(부호검정 p≈0.001). n=20이지만 우위는 통계적으로 의미가 있다. 대가는 다운로드 1.6배, WASM 쿼리 22배(413ms), 빌드 시간 증가(1,065건 WASM 약 10분, 이후 캐시), Gemma Terms of Use 준수 의무다.
- **ko-sroberta**: 가장 작고 e5-small보다 낫다(9승 3패, 유의하지 않음). 하지만 HF 저장소에 **라이선스가 명시되어 있지 않아** 배포용으로 권하지 않는다.
- **e5-base q8**: 이상하게 낮다. Xenova 양자화본이 망가졌을 가능성이 있으나 fp32(1.1GB)는 검증하지 않았다. **bge-m3**는 560MB라 정적 사이트 첫 로드에 부적합하다.
- 실데이터(`data/menus`)의 태그에는 "비 오는 날", "해장" 같은 상황 문구가 이미 들어 있어, 모델 간 격차가 이 벤치보다 작을 수 있다. 데모에서 "술 마신 다음 날 해장"을 넣으면 1위는 북엇국이었지만, 2~5위에 해물파전, 감자전, 마타파, 모둠회가 섞였다. 이는 B의 태그 가중치로 보완하는 영역이다.

**권고**: 지금은 e5-small q8을 유지한다. 품질 개선이 필요하면 1순위는 EmbeddingGemma-300m q4로 전환하는 것이다(라이선스와 지연 수용 여부는 오케스트레이터가 결정). 이때는 `MODEL_ID`, `DIM`, 접두어(`task: search result | query: ` / `title: none | text: `), 출력(`sentence_embedding`)을 바꿔야 하고 `menus.json`을 재빌드해야 한다.

---

## 5. GitHub Pages 제약 점검

| 제약 | 근거 | 영향과 대응 |
|---|---|---|
| 커스텀 HTTP 헤더 불가(COOP/COEP) | GitHub 커뮤니티 토론 #13309: 지원 계획은 있으나 ETA 없음. `<meta http-equiv>`로는 설정 불가 | `crossOriginIsolated=false`이므로 SharedArrayBuffer가 없고 ORT WASM이 **단일 스레드**로 돈다. 실측(Edge, 격리 없음) e5-small 쿼리는 26.5ms로 충분하다. coi-serviceworker로 우회할 수 있지만 첫 방문 새로고침, 교차 출처 리소스 제약, 디버깅 부담 때문에 **도입하지 않음**을 권장한다. EmbeddingGemma로 바꾼다면 그때 다시 검토한다 |
| 파일 크기: 50MiB 경고, **100MiB 차단** | GitHub 문서 "About large files on GitHub" | `model_quantized.onnx`(118MB)는 저장소에 넣을 수 없다. Git LFS를 쓰면 Pages 배포 경로(Actions 체크아웃 `lfs: true`)와 LFS 대역폭 할당량까지 함께 관리해야 한다 |
| 사이트 1GB, 저장소 권장 1GB, 대역폭 **월 100GB(soft)**, 빌드 10회/시간(soft, Actions 배포는 제외), 배포 10분 타임아웃 | GitHub 문서 "GitHub Pages limits" | 모델을 자체 호스팅하면 신규 방문 1회에 약 135MB가 나간다. 그러면 월 약 740회 첫 방문이면 soft limit에 닿는다. `menus.json`(gzip 0.6MB)은 영향이 거의 없다 |
| HF CDN 응답 | `curl -I` 확인: `Access-Control-Allow-Origin`을 요청 Origin으로 반사, 302 후 `cdn.hf.co`, `X-Repo-Commit` 제공 | **모델은 HF CDN에서 받는다.** 커밋 SHA 고정(`MODEL_REVISION`)으로 저장소가 갱신돼도 벡터가 바뀌지 않는다. Cache API로 재방문 때 다시 받지 않는다 |
| jsDelivr | `curl -I` 확인: `access-control-allow-origin: *`, `cross-origin-resource-policy: cross-origin`, `Cache-Control: immutable 1년`. ORT wasm 26.8MB 정상 제공 | Transformers.js 번들과 ORT wasm은 jsDelivr를 쓴다(버전 고정). 나중에 COEP를 켜더라도 CORP 헤더가 있어 호환된다 |
| HTTPS | Pages는 HTTPS로 제공 | Cache API와 WebGPU에 필요한 보안 컨텍스트가 충족된다. 로컬은 `http://localhost`나 `127.0.0.1`도 보안 컨텍스트로 취급된다 |

**결정**: 모델과 런타임은 외부 CDN(HF, jsDelivr)에서 받는다. 저장소에는 `menus.json`과 `menus.meta.json`만 둔다. 외부 CDN 장애가 걱정되면 Actions 배포 단계에서 모델을 받아 아티팩트에 넣고 `env.remoteHost`를 자기 사이트로 바꾸면 된다. 이 경우 대역폭 한도를 감안해야 한다.

---

## 6. cuisine 재분류 (`scripts/infer-cuisine.mjs`)

```
node --use-system-ca scripts/infer-cuisine.mjs        # → data/raw/menus.inferred.json, scripts/bench/results/infer-cuisine.json
```

### 6.1 집합 정의와 판단 근거
- `menus.raw.json`의 `other` 385건 가운데 **241건은 `_wd.origins`(P495 원산지)가 있다.** 인도네시아 109, 튀르키예 18, 나이지리아 11, 이집트 7, 말레이시아 6 등 지원 cuisine 밖의 원산지라는 근거가 있는 것이다. 이들은 "원산지 불명"이 아니다. 그래서 **재분류 대상에서 빼고 `other` 정답 예시로 쓴다.**
- **재분류 대상**은 `other`이면서 원산지 정보가 없는 **144건**이다(설명 없음 17건).
- **정답 집합(1,237)**:
  - 큐레이션과 franchise 546건(12개 라벨 전부)
  - 위키 원산지·요리계통 근거(`cuisineBy` ∈ P495, P495>P17, P2012이고 cuisine≠other) 450건
  - 위키 원산지-other 241건
  - P2012는 "요리 계통" 속성이라 원산지와 같은 수준의 근거로 보고 포함했다. `cuisineBy:'desc'`(45건)는 설명 키워드 휴리스틱이라 정답과 대상 양쪽에서 빼고 그대로 둔다.
- **'other' 처리**: `other`도 투표에 참여하되, 결과 후보에서는 뺀다. 즉 other 이웃이 많으면 득표율과 격차가 떨어져 자연히 "변경 없음"이 된다. 투표에서 아예 빼면 아프리카, 중동, 중남미 요리가 가장 가까운 지원 cuisine으로 억지 분류된다.
- **순환 방지**: 분류용 문장은 `menuToPassage({...m, cuisine:''})`로 만든 `이름. 재료. 태그. 설명`이다. 서비스 벡터는 이후 merge → `embed.mjs`가 새 cuisine이 들어간 원래 passage로 다시 계산한다(해시 캐시라 바뀐 것만 계산). 분류용 벡터는 배포하지 않으므로 빠른 CPU 백엔드를 쓴다(2,582건 36s, 다시 돌리면 캐시 적중).

### 6.2 방식과 LOO로 정한 값
- 상위 k개 이웃에 가중치 `exp((sim − sim₁)/τ)`를 주는 가중 다수결이다.
- LOO는 자기 자신과 **동명 항목**(공백·괄호 무시)을 함께 가린다. 같은 요리가 큐레이션과 위키에 둘 다 있어 생기는 누수를 막기 위해서다.
- **(k, τ)**: 위키 정답 691건 LOO의 top-1 정확도로 골랐다. 위키 정답은 대상과 문체와 분포가 비슷하다. 결과는 **k=20, τ=0.02**이고 정확도 0.744다(전체 정답 기준 0.772). 비교: k=10/τ=0.05는 0.741, k=5는 0.69~0.71.
- **임계값**: (득표율, 1·2위 격차, 예측 클래스 최고 유사도) 격자에서 **LOO 정밀도 0.90 이상**을 만족하면서 커버리지가 가장 큰 값을 골랐다. 수락 표본이 20건 미만인 조합은 제외했다.
  - 설명 있음: **share ≥ 0.5, margin ≥ 0.3, maxSim ≥ 0.80** → 위키 LOO에서 수락 219, 정답 199로 **정밀도 0.909**, 커버리지 0.442. 전체 정답 LOO로는 정밀도 0.909, 커버리지 0.551.
  - 설명 없음(정밀도 0.95 목표): 정답의 설명을 지우고 LOO를 돌리면 top-1 정확도가 0.420까지 떨어진다. 이 경우 **0.95를 만족하는 임계값이 없다.** 일반 임계값을 그대로 쓰면 정밀도 0.76이다. 그래서 **설명 없는 17건은 재분류하지 않았다.**
- `cuisineConfidence`는 예측 cuisine의 가중 득표율(0~1)이다. LOO에서는 0.5 이상 구간 전체의 정밀도가 0.91이었다.

**위키 정답 LOO 혼동행렬**(임계값 없이 top-1, 행은 정답, 열은 예측):

| 정답＼예측 | korean | western | chinese | japanese | vietnamese | mexican | thai | indian | snack | cafe | other |
|---|---|---|---|---|---|---|---|---|---|---|---|
| korean | 58 | 4 | 3 | 1 | 0 | 0 | 0 | 0 | 2 | 1 | 4 |
| western | 6 | 183 | 0 | 2 | 0 | 2 | 0 | 0 | 0 | 6 | 34 |
| chinese | 6 | 7 | 23 | 4 | 0 | 0 | 0 | 0 | 0 | 0 | 9 |
| japanese | 1 | 6 | 0 | 32 | 0 | 0 | 0 | 0 | 0 | 1 | 2 |
| vietnamese | 0 | 1 | 1 | 0 | 11 | 0 | 0 | 0 | 0 | 0 | 0 |
| mexican | 0 | 0 | 0 | 0 | 0 | 8 | 0 | 0 | 0 | 0 | 4 |
| thai | 0 | 0 | 0 | 0 | 0 | 0 | 9 | 0 | 0 | 0 | 1 |
| indian | 3 | 1 | 0 | 0 | 0 | 0 | 1 | 1 | 0 | 1 | 11 |
| other | 3 | 42 | 3 | 1 | 0 | 1 | 0 | 0 | 0 | 2 | 189 |

**종류별 정밀도/재현율**: top-1은 임계값 없음, 오른쪽 두 열은 임계값 적용 후(abstain은 미예측으로 계산).

| cuisine | n | P(top-1) | R(top-1) | 임계값 후 예측 수 | P(임계값) | R(임계값) |
|---|---|---|---|---|---|---|
| korean | 73 | 0.75 | 0.79 | 39 | 0.92 | 0.49 |
| western | 233 | 0.75 | 0.79 | 132 | 0.90 | 0.51 |
| chinese | 49 | 0.77 | 0.47 | 12 | 0.92 | 0.22 |
| japanese | 42 | 0.80 | 0.76 | 18 | 0.94 | 0.40 |
| vietnamese | 13 | 1.00 | 0.85 | 3 | 1.00 | 0.23 |
| mexican | 12 | 0.73 | 0.67 | 5 | 1.00 | 0.42 |
| thai | 10 | 0.90 | 0.90 | 8 | 1.00 | 0.80 |
| indian | 18 | 1.00 | 0.06 | 0 | – | 0.00 |
| other | 241 | 0.74 | 0.78 | (변경 안 함) | – | – |

주요 오류 방향은 western과 other 사이다. 유럽 요리 34건이 other로, other 42건이 western으로 갔다. 이는 "서양권" 정의(크롤러 국가 매핑)가 임베딩으로는 잘 구분되지 않는 지리 경계이기 때문이다. indian은 남아시아 요리가 중동·중앙아시아 other와 섞여 재현율이 0.06이다(임계값 후 예측 0건이라 오분류도 없음).

### 6.3 결과
- 대상 144건 → **재분류 47건**(설명 있음 47/127, 설명 없음 0/17)
- 목적지: korean +24, western +13, cafe +5, chinese +2, japanese +2, snack +1

| menus.raw.json | korean | western | chinese | japanese | vietnamese | mexican | thai | indian | snack | cafe | other |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 재분류 전 | 84 | 251 | 52 | 47 | 13 | 13 | 14 | 21 | 0 | 0 | 385 |
| 재분류 후 | 108 | 264 | 54 | 49 | 13 | 13 | 14 | 21 | 1 | 5 | 338 |

- **독립 점검**: 설명에 나오는 국가·지역 키워드로 만든 은라벨(예측에는 쓰지 않음, 잡음 있음)로 대상 63건을 점검했다. 재분류된 16건 중 14건이 일치해 정밀도 0.875다. 은라벨이 `other`인 32건 중 잘못 옮겨진 것은 1건(판 데 하몬, 베네수엘라)이다. LOO 추정치(0.91)와 맞는 수준이다.
- **수작업 검토**: 47건을 전부 읽었다. 분명한 오류는 3건이다. 판 데 하몬(베네수엘라 → other여야 함), 스픈즈(마그레브 → other여야 함), 노란밥(강황밥 일반 → korean이라 하기 어려움). 경계 사례는 쇠꼬리(식재료), 구이(일반 용어), 블랙 라즈베리 아이스크림(cafe와 western 모두 가능)이다. 정밀도는 약 0.9~0.94로 판단한다. **사용할 만하다고 판단해 적용했다.**
- **검수용 20건**: 은라벨과 다르거나 신뢰도가 낮은 순이다. 전체 47건과 이웃 목록은 `menus.inferred.json`의 `_infer`에 있다.

| id | 이름 | 추정 | 신뢰도 | 사유 | 최근접 이웃 |
|---|---|---|---|---|---|
| we-pan-de-jamon | 판 데 하몬 | western | 0.87 | 설명은 베네수엘라(other) | 햄버거(western), 하판로흐코(western) |
| cf-black-raspberry-ice-cream | 블랙 라즈베리 아이스크림 | cafe | 0.60 | 은라벨은 western | 배스킨라빈스 엄마는 외계인(cafe), 호키 포키(western) |
| kr-oxtail | 쇠꼬리 | korean | 0.52 | 신뢰도 하위, 식재료 | 소를 넣은 고추(western), 소고기전골(korean) |
| kr-cup-bop | 컵밥 | korean | 0.52 | 신뢰도 하위(snack일 수도) | 컵밥(snack), 껌승(vietnamese) |
| kr-kkakdugi | 깍두기 | korean | 0.53 | 신뢰도 하위 | 보쌈김치(korean), 보쌈(korean) |
| kr-funchoza | 푼초자 | korean | 0.53 | 고려인 음식(중앙아시아) | 잡채(korean), 평양 온반(korean) |
| we-sfenj | 스픈즈 | western | 0.55 | 마그레브 → other여야 함 | 맥앤치즈(western), 브라우니(cafe) |
| kr-cooked-rice | 쌀밥 | korean | 0.56 | 신뢰도 하위 | 볶음밥(chinese), 콩밥(korean) |
| we-poutine | 푸틴 | western | 0.57 | 신뢰도 하위(퀘벡이라 맞음) | 치즈닭갈비(korean), 퀘사디아(mexican) |
| cf-chocolate-covered-fruit | 초콜릿을 입힌 과일 | cafe | 0.59 | 신뢰도 하위 | 투썸 스트로베리 초콜릿 케이크(cafe), 맥플러리(western) |
| cf-raw-chocolate | 생초콜릿 | cafe | 0.59 | 신뢰도 하위 | 초코라떼(cafe), 초코케이크(cafe) |
| we-klenat | 클레네트 | western | 0.60 | 신뢰도 하위(북유럽이라 맞음) | 젤튼(western), 포르카날라티코(western) |
| cn-monkey-brains | 원숭이골 | chinese | 0.60 | 신뢰도 하위(맞음) | 차오간(chinese), 원앙볶음밥(chinese) |
| kr-pork-skin | 돼지 껍데기 | korean | 0.61 | 신뢰도 하위 | 돼지갈비(korean), 돼지고기 김치찜(korean) |
| jp-hakata-ramen | 하카타 라멘 | japanese | 0.61 | 신뢰도 하위(맞음) | 이에케 라멘(japanese), 돈코츠라멘(japanese) |
| kr-ojingeo-sundae | 오징어순대 | korean | 0.62 | 신뢰도 하위 | 순댓국(korean), 파이구판(chinese) |
| jp-q11264794 | 유키우사기 | japanese | 0.62 | 신뢰도 하위(맞음) | 로바타야키(japanese), 우동(japanese) |
| we-croquette | 크로켓 | western | 0.63 | 신뢰도 하위 | 볼리뉴 드 바칼랴우(western), 피테팔트(western) |
| kr-daetong-bap | 대통밥 | korean | 0.63 | 신뢰도 하위 | 볶음밥(chinese), 굴밥(korean) |
| kr-gui | 구이 | korean | 0.63 | 일반 용어 | 너비아니(korean), 장어구이(korean) |

(노란밥 `kr-yellow-rice`는 신뢰도 0.634로 20위 바로 밖이지만, 수작업 검토에서 오류로 분류했다. 함께 검수 권장.)

---

## 7. 재현 방법

```
npm install                                          # @huggingface/transformers 4.3.2, (dev) playwright-core 1.65.0
node --use-system-ca scripts/embed.mjs               # web/menus.json
node --use-system-ca scripts/bench/verify.mjs        # 정합성 + 순위 손실 (Edge 필요, 약 10분)
node --use-system-ca scripts/bench/bench-models.mjs  # 모델 비교 (최초 약 1.4GB 다운로드)
node --use-system-ca scripts/bench/wasm-latency.mjs  # WASM 단일 스레드 지연
node --use-system-ca scripts/infer-cuisine.mjs       # cuisine 재분류
python -m http.server 8000 -d web                    # → http://localhost:8000/demo-embed.html (?device=wasm|webgpu)
```
다운로드한 모델은 `.cache/hf`, 임베딩 캐시는 `.cache/embeddings`, Edge 프로필은 `.cache/edge-profile`에 쌓인다. 모두 `.gitignore` 대상으로 하기를 권한다.


## 지도 서비스 "내 주변 찾기" 링크 검증 (2026-11-22)

API 키 없이 각 서비스의 공개 검색 주소에 검색어와 위치를 담아 새 창으로 여는 방식이다(`web/js/maps.js`).
브라우저 위치를 **부산(35.1796, 129.0756)**으로 주고 URL로는 **제주(33.4996, 126.5312)**를 지정해 열어서, 결과가 어느 지역으로 나오는지 확인했다.

| 서비스 | 형식 | 결과 | 비고 |
|---|---|---|---|
| 구글 | `/maps/search/<검색어>/@위도,경도,줌z?hl=ko` | 제주 결과 → **중심 지정 동작** | 문서화되지 않은 형식. 공식 문서는 Search 액션에 center/zoom 을 정의하지 않고, 위치는 검색어 글자(`pizza+seattle+wa`)로만 지정하라고 한다 |
| 구글 | `?api=1&query=<검색어>` (공식) | 서울 결과 → 위치 무시 | 위치가 없을 때만 사용 |
| 카카오 | `m.map.kakao.com/scheme/search?q=<검색어>&p=<위도>,<경도>` | `map.kakao.com/?q=…&urlX=…&urlY=…&currentBound=true` 로 넘어가며 제주 결과 → **동작** | 좌표 변환은 카카오가 한다. 공식 문서에서는 확인하지 못했고(서드파티 문서의 `kakaomap://search?q=&p=` 와 같은 파라미터) 실측으로만 확인. 반경 지정 불가 |
| 카카오 | `map.kakao.com/link/search/<검색어>` | `?q=` 로 리다이렉트, 위치 무시(서울) | |
| 네이버 | `map.naver.com/p/search/<검색어>?c=<x>,<y>,<줌>,0,0,0,dh` | **미확인** | 공식 문서(Ncloud)는 앱 스킴(`nmap://`)만 정의하고 `/search` 에는 위치 파라미터가 없다. 이 PC 에서의 자동 접근이 "과도한 접근 요청"으로 차단돼 더 시도하지 않았다. 웹 메르카토르 미터 좌표로 추정(기본 주소 `c=15.00,0,0,0,dh` 에서 첫 값이 줌). 틀려도 키워드 검색은 열리고 위치만 기본값이 된다 |

- 반경은 거리 필터가 아니라 처음 보여 줄 지도 범위(줌)를 맞추는 값이다(`zoomForRadius`).
- 위치는 `navigator.geolocation` 으로 클릭 때마다 1회 읽어 주소 문자열에만 쓰고 저장·전송하지 않는다. HTTPS(또는 localhost)에서만 동작한다.
- 확인 방법: `tests/maps.test.mjs`(주소 생성), E2E 에서 외부 지도 주소를 가짜 응답으로 대체해 새 창이 열리는 주소를 검증.
