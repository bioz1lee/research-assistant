# Research Assistant 개선 계획

> 2026-06-11 코드 리뷰 기반. 다음 세션에서 이 파일을 읽고 Phase 순서대로 진행할 것.
> 각 항목은 독립적으로 완료 가능. 완료 시 체크박스 표시 + 날짜 기록.

## Phase 0 — 보안 + 신뢰성 ✅ 완료 (2026-06-11)

> 추가로 완료된 정리 작업 (2026-06-11):
> - 죽은 코드 제거: db.py 레거시 JSON 마이그레이션(~140줄, DB에 migration_done=true 확인 후), close_conn, get_scheduler, telegram webhook 엔드포인트, paper_search.enrich_citations, kkirikkiri 마커 파일
> - db.py 마이그레이션 러너 일반화: migrations/*.sql 순차 적용 + meta 테이블로 추적
> - bioRxiv 크롤 커버리지 수정: 3페이지(300건) 하드캡 → total까지 페이징(상한 2000건), 잘림 시 로그
> - 프론트 enrichPaper: 가짜 "완료" 토스트 → 실제 완료까지 폴링(pollEnrichment)
> - ⚠️ 남은 사용자 액션: .env에 새 TELEGRAM_BOT_TOKEN 붙여넣기 (현재 비어 있음 → token_set=false)

### 0-1. Telegram 토큰을 환경변수로 이전
- [x] 완료 — server.py가 .env 자동 로드, telegram_service.get_token()이 env 우선, settings API에서 토큰 송수신 차단, config.json에서 토큰 제거
- `backend/services/telegram_service.py`: 토큰 읽기를 `os.environ.get("TELEGRAM_BOT_TOKEN")` 우선, config.json fallback으로 변경
- `backend/api/settings.py`: GET 응답에서 token 필드 자체를 제거하고 `token_set: bool`만 반환. PUT에서 token 저장 로직 제거
- `config.json`에서 token 값 삭제 (`enabled`, `chat_id`는 유지)
- `start.command`에 `export TELEGRAM_BOT_TOKEN=...` 추가 안내 또는 `.env` 파일 + 로드 로직 (`.env`는 .gitignore 대상)
- **⚠️ 사용자 액션 필요: @BotFather에서 기존 토큰 revoke 후 재발급. 코드 작업 전에 사용자에게 새 토큰 받을 것**

### 0-2. 백그라운드 작업 상태 추적 (enrichment_status)
- [x] 완료 — migrations/002 적용, wiki_service에 상태 기록, wiki.js에 뱃지+폴링+재시도 UI
- `migrations/002_enrichment_status.sql` 생성:
  ```sql
  ALTER TABLE papers ADD COLUMN enrichment_status TEXT DEFAULT 'none';
  -- 값: none / pending / running / done / failed
  ALTER TABLE papers ADD COLUMN enrichment_error TEXT;
  ```
- `backend/db.py`의 마이그레이션 러너가 002를 적용하는지 확인 (meta 테이블로 버전 추적 중)
- `backend/services/wiki_service.py` 비동기 enrichment 함수(~line 384-446):
  - 시작 시 `running`, 성공 시 `done`, 예외/파싱실패 시 `failed` + `enrichment_error`에 메시지 기록
- `backend/api/wiki.py`: `POST /api/wiki/papers/<id>/enrich` 재시도 엔드포인트 추가 (이미 있으면 status 리셋만)
- 프론트 `static/js/wiki.js`: 논문 카드/상세 패널에 상태 뱃지 (`running` 스피너, `failed` 빨간 뱃지 + 재시도 버튼)

### 0-3. 파일 로깅 도입
- [x] 완료 — backend/logging_setup.py, data/logs/app.log (5MB×3 로테이션), 주요 print/silent-except를 logger로 교체
- `backend/logging_setup.py` 신규: `logging.handlers.RotatingFileHandler` → `data/logs/app.log` (5MB × 3개)
- `server.py` 시작 시 호출. 각 service의 `print(...)` → `logger.info/warning/error`로 일괄 치환
- 특히 digest 파이프라인, telegram polling, enrichment 스레드의 예외는 반드시 `logger.exception()`

### 0-4. LLM 출력 파싱 견고화
- [x] 완료 — backend/services/llm_parse.py (raw_decode 기반), wiki/digest/concept 서비스에 적용
- `backend/services/llm_parse.py` 신규: 공용 함수 `extract_json(raw: str) -> dict | None`
  - 1차: ```json 블록 정규식 → 2차: 첫 `{`부터 `json.JSONDecoder().raw_decode()` → 3차: 실패 시 None + 로그
- 적용 위치: `wiki_service.py:427-437`, `digest_service.py:152`, `concept_service.py:244`
- 실패 시 enrichment_status='failed'로 연결 (0-2와 연동)

### 0-5. 자잘한 보안 정리
- [x] 완료 — knowledge 삭제 시 경로 구분자 거부, /api/local 화이트리스트(uploads/, data/, vault) + realpath 검증 (403 실측 확인)

## Phase 1 — 연구 가치 기능 ✅ 완료 (2026-06-11)

> 실측 검증: 검색 API 3종(논문 2 / 대화 8건) + 프리뷰 브라우저 모달 렌더링 + 피드백 신호/재노출 함수 단위테스트 통과. 마이그레이션 003/004 적용 확인 (papers_fts·chat_fts 백필 완료).

### 1-1. Digest 피드백 루프
- [x] 완료 — migrations/003, telegram_service.record_feedback (saved/skipped/later 기록), digest_service.get_feedback_signal로 Claude 선별 프롬프트에 취향 주입, _pop_later_papers로 "나중에" 논문 1회 재노출(🔁 라벨)
- `migrations/003_digest_feedback.sql`: 테이블 `digest_feedback(id, paper_doi, paper_title, action TEXT /* saved|later|skipped */, keywords, created_at)`
- 콜백 핸들러에서 action 기록. "Add to Wiki"도 `saved`로 기록
- `digest_service.py`의 Claude 선별 프롬프트(~line 110-126)에 최근 30개 피드백 주입:
  "최근 저장한 논문 제목: [...] / 스킵한 논문 제목: [...] — 이 취향을 반영해 선별하라"
- "later" 논문은 다음 digest 말미에 "다시 보기" 섹션으로 1회 재노출

### 1-2. 전역 검색 (Cmd+K) — FTS5
- [x] 완료 — migrations/004 (papers_fts/concepts_fts/chat_fts + 동기화 트리거), backend/api/search.py, static/js/search.js + 모달 마크업 + CSS. Cmd+K로 열림, prefix 매칭, 세션당 1건 dedupe, 클릭/Enter로 해당 항목 이동
- `migrations/004_fts.sql`: `papers_fts` (title, abstract, summary, llm_analysis, tags), `concepts_fts` (title, summary, content), `chat_fts` (content) — contentless 또는 external content 방식 + 트리거로 동기화
- `backend/api/search.py` 신규 blueprint: `GET /api/search?q=` → 타입별 그룹 결과 (papers/concepts/chats)
- 프론트: `static/js/search.js` 신규 — Cmd+K 모달, 디바운스 입력, 타입별 섹션, Enter로 해당 탭+항목 열기
- `utils.js:183-222`의 단축키 핸들러에서 Cmd+K 연결, `index.html`에 모달 마크업 추가

### 1-3. Concept 매칭 임베딩 전환 → LLM 판정으로 구현
- [x] 완료 (옵션 A) — concept_service._match_concepts_llm: 후보 제목 전체를 기존 개념 목록과 함께 LLM 1회 판정, Jaccard는 fallback으로 유지. 개념 300개 넘으면 임베딩(옵션 B) 검토
- 옵션 A (권장, 의존성 없음): Claude CLI로 후보 매칭 판정 — 신규 개념 제목 + 기존 개념 제목 전체 목록을 주고 "같은 개념이 있으면 id 반환" (개념 수백 개까지 충분)
- 옵션 B: `sentence-transformers` 로컬 임베딩 + 코사인 유사도, `concepts` 테이블에 embedding BLOB 컬럼
- 우선 A로 구현하고, 개념 300개 넘으면 B 검토. Jaccard는 1차 프리필터로 유지
- 파싱 실패/판정 모호 시 기존 동작(신규 생성)으로 fallback

### 1-4. 메타데이터 어휘 통제
- [x] 완료 — wiki_service.get_existing_vocab/normalize_vocab: enrichment 프롬프트에 기존 어휘 주입 + 저장 직전 case-insensitive 통일 + organism 학명 canonical map (Mus musculus→mouse 등). add_paper/enrich 양쪽 적용

### 1-6. 개념 지식 그래프 + 본문 중심 학습 UI (2026-06-11 추가)
- [x] 완료 — 카드 그리드가 개념 공부에 부적합(관계·위계 안 보임)하다는 피드백 반영. 본문 중심 + 지도 토글.
  - migrations/006: concept_relations 테이블 (from/to/type/source/weight)
  - concept_service: rebuild_paper_relations(논문 공출현, 즉시) + rebuild_llm_relations(전체 개념 LLM 1회 의미 관계) + get_related + get_graph. 추출 완료 시 논문 관계 자동 갱신
  - concepts.py: GET /graph, POST /relations/rebuild
  - 개념 상세 패널: "관련 개념" 칩(방법/구성요소/적용/대조/함께등장) → 클릭하면 그 개념으로 이동 (위키식 탐색)
  - 그래프 뷰: 목록/지도 토글, force-directed SVG(노드 크기=논문수, 실선=의미 관계 점선=논문 공출현), 노드 클릭→상세, "관계 다시 분석" 버튼
  - 현재 데이터: 의미 관계 10 + 논문 관계 20. 검증: PADIT-seq→Lower-affinity[method-of] 등 의미 정확, 개념간 네비게이션 동작
- 향후: 개념 300개 넘으면 그래프 클러스터링/필터, 관계 수동 편집

### 1-5. 개념 추출 가시화 + 소급 추출 (2026-06-11 추가)
- [x] 완료 — Concepts 탭이 비어 보이는 혼란 해결. 원인은 기존 논문이 추출 기능 도입 전 저장됨.
  - migrations/005: papers.concept_status/concept_error 컬럼
  - concept_service: 상태 추적(pending/running/done/failed) + 성공 시 생성 개수 로깅
  - concepts.py: POST /api/wiki/concepts/backfill (분석은 있는데 미추출인 논문 일괄)
  - wiki_service._enrich_paper: enrichment로 분석이 새로 생기면 개념 추출 자동 연결 (텔레그램 저장 논문 누락 방지)
  - wiki.js: 논문 상세에 "◈ 개념 추출" 버튼 + 상태 라인 + 폴링, Concepts 빈 상태에 소급 추출 버튼
  - 기존 논문 2편 백필 완료 → 개념 10개 생성됨
- `wiki_service.py` enrichment 프롬프트에 기존 DB의 distinct 값 목록 주입:
  "organism은 다음 기존 값 중 일치하는 것이 있으면 그대로 사용: [...]"
- 저장 직전 정규화 함수: 소문자 비교로 기존 값과 case-insensitive 일치 시 기존 표기로 통일
- organism은 canonical map 하드코딩 시작: {"mouse": "Mus musculus", "human": "Homo sapiens", "rat": "Rattus norvegicus", ...}

## Phase 2 — 소스 확장

### 2-1. medRxiv 추가
- [ ] `paper_search.py`의 bioRxiv 함수 일반화: `api.biorxiv.org/details/{server}/...`에서 server 파라미터화 (biorxiv|medrxiv)
- `config.json` sources에 "medrxiv" 추가 가능하게, digest 파이프라인에서 합류

### 2-2. bioRxiv 카테고리 필터
- [ ] bioRxiv API 응답의 category 필드 활용 — config에 `biorxiv_categories: ["bioinformatics", "genomics", "neuroscience", "cell biology"]` 추가, 키워드 매칭 전 카테고리 프리필터

### 2-3. Semantic Scholar 인용 알림 (탐색적)
- [ ] Wiki 저장 논문(DOI 기준)의 신규 인용 논문을 주간 체크 → digest에 "내 라이브러리를 인용한 논문" 섹션
- API: `api.semanticscholar.org/graph/v1/paper/DOI:{doi}/citations` (무료, rate limit 주의)
- scheduler에 주 1회 잡 추가

## Phase 3 — 보류 (필요해질 때까지 하지 않음)

- 논문 목록 페이지네이션 (500개 하드캡 도달 시)
- chat.js/wiki.js 파일 분할 리팩터링
- 모듈 간 이벤트 버스
- 모바일 최적화
- UBERON/Cell Ontology 연동

## 작업 규칙

- 각 항목 완료 후 `python3 server.py` 기동 + `/healthz` 확인 + 해당 기능 수동 확인
- DB 변경 전 `data/app.db` 백업 (`cp data/app.db data/app.db.bak-YYYYMMDD`)
- 마이그레이션은 항상 새 번호 파일로 (기존 001 수정 금지)
- 기존 기능 깨뜨리지 않기 — 특히 digest 스케줄러와 telegram polling은 스레드 기동 순서 민감
