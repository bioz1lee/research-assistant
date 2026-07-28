# Research Assistant

논문 읽기·정리·추적을 한 곳에서 하는 로컬 웹 앱. 브라우저에서 돌지만 서버·DB·파일이 전부
내 맥 안에만 있고, 외부로 나가는 건 Claude API·논문 검색(PubMed/bioRxiv)·(설정 시) 텔레그램뿐입니다.

| 탭 | 하는 일 |
|---|---|
| **Chat** | Claude와 대화. 프로젝트 컨텍스트·파일 첨부·안전모드(계획만 세우고 파일 변경 안 함) 지원 |
| **Wiki** | 논문 저장소. 요약·figure·노트·개념 그래프. Obsidian vault로 내보내기 |
| **Proj** | 프로젝트별로 논문·대화 묶어서 관리 |
| **Study** | PDF를 넣으면 구조 분석 → Wiki에 저장 |
| **Digest** | 키워드 기반으로 매일 새 논문을 모아 Claude가 추려주고, 원하면 텔레그램으로 발송 |

---

## 준비물

1. **Python 3.10+**
2. **Claude Code CLI** — 이 앱은 Claude API를 직접 호출하지 않고 `claude` CLI를 실행합니다.
   [설치 안내](https://claude.com/product/claude-code)를 따라 설치하고, 터미널에서 `claude` 가
   실행되는지(로그인까지) 먼저 확인하세요.
   ```bash
   claude --version
   ```
   CLI가 PATH에 없으면 `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin` 순으로도 찾습니다.
3. (선택) **텔레그램 봇** — Digest 알림을 받고 싶을 때만.

## 설치

```bash
git clone <이-저장소-주소>
cd research-assistant
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
```

## 실행

```bash
python3 server.py
```

`http://127.0.0.1:8321` 로 접속하면 됩니다. 포트를 바꾸려면 `PORT=9000 python3 server.py`.

맥에서는 `./start.command` 를 더블클릭해도 됩니다.

> ⚠️ `static/index.html` 파일을 파인더에서 직접 열면 안 됩니다. CSS/JS를 `/static/...`
> 절대경로로 불러오기 때문에 `file://` 로 열면 스타일이 전부 깨집니다. 반드시 서버를 띄우고
> `http://127.0.0.1:8321` 로 접속하세요.

## 첫 설정

서버를 처음 켜면 `config.example.json` 을 복사해 `config.json` 이 자동으로 만들어집니다.
나머지는 앱 안 **Set(Settings)** 탭에서 채우면 됩니다.

| 항목 | 설명 |
|---|---|
| `vault_path` | Obsidian vault 안 Wiki 폴더의 **절대경로**. 비워두면 Wiki 내보내기만 안 되고 나머지는 정상 동작합니다. |
| `digest.keywords` | Daily Digest가 추적할 검색어. 본인 분야에 맞게 바꾸세요. |
| `digest.schedule` | 매일 실행 시각 (`HH:MM`, `timezone` 기준) |
| `llm.model` | 기본 모델. 기본값 `claude-opus-5` |

텔레그램을 쓸 경우에만:

```bash
cp .env.example .env
# .env 를 열어 TELEGRAM_BOT_TOKEN 을 채운다 (@BotFather 에서 발급)
```

봇 토큰은 **`.env` 에만** 둡니다 (git에 올라가지 않음). `chat_id` 는 Settings 탭에서 설정합니다.

## 모델 선택

Chat 화면 우측 상단에서 대화마다 모델을 고를 수 있습니다.

| 모델 | 컨텍스트 | 쓰임새 |
|---|---|---|
| **Opus 5** (기본) | 1M | 기본값. 논문 분석·코딩 등 대부분의 작업 |
| Fable 5 | 1M | 가장 어려운 추론. Opus보다 비쌈 |
| Sonnet 5 | 1M | 빠르고 저렴. 일상적인 작업 |
| Haiku 4.5 | 200K | 가장 빠름/저렴. 단순 작업 |

Digest 선별, 논문 enrichment, 개념 추출 같은 백그라운드 작업은 `config.json` 의
`llm.model`(기본 `claude-opus-5`)을 씁니다. 비용을 아끼려면 이 값을 `claude-sonnet-5` 로
낮춰도 됩니다.

---

## 데이터가 저장되는 곳

전부 로컬이고, git에는 아무것도 올라가지 않습니다.

```
data/app.db      SQLite — 대화·논문·개념·프로젝트
data/logs/       서버 로그
uploads/         업로드한 PDF 원본
config.json      개인 설정
.env             비밀 값
```

백업하려면 `data/` 와 `uploads/` 를 복사하면 됩니다.

## 구조

```
server.py               Flask 엔트리포인트 (DB 마이그레이션 → 스케줄러 → 텔레그램 순으로 부팅)
backend/
  api/                  HTTP 엔드포인트 (Blueprint)
  services/             실제 로직 — claude_runner, wiki, concept, digest, telegram, paper_search
  db.py                 SQLite 연결 + config 읽기/쓰기
  scheduler.py          APScheduler (Daily Digest)
migrations/*.sql        순차 적용되는 스키마 마이그레이션
static/                 프론트엔드 (프레임워크 없는 순수 JS)
launcher/               macOS .app 번들 빌드 스크립트
```

## 문제가 생기면

| 증상 | 확인할 것 |
|---|---|
| 화면 스타일이 다 깨짐 | `file://` 로 열었을 가능성. `http://127.0.0.1:8321` 로 접속 |
| 채팅 응답이 없음 | 터미널에서 `claude --version` 이 되는지, 로그인돼 있는지 |
| Wiki 저장 실패 | Settings에서 `vault_path` 가 실제 존재하는 절대경로인지 |
| Digest가 안 옴 | `.env` 의 `TELEGRAM_BOT_TOKEN`, Settings의 `chat_id`, `digest.enabled` |
| 포트 충돌 | `PORT=9000 python3 server.py` |

로그는 `data/logs/` 에 쌓입니다.
