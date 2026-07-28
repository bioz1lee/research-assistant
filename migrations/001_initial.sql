-- 001_initial.sql
-- Local Research Assistant — Initial SQLite Schema
-- (DESIGN.md 섹션 3.1)
--
-- WAL 모드 PRAGMA 는 db.py 에서 connection 단위로 설정한다.

-- 메타 테이블 (마이그레이션 상태 추적)
CREATE TABLE IF NOT EXISTS meta (
    key     TEXT PRIMARY KEY,
    value   TEXT NOT NULL
);

-- 프로젝트 (chat_sessions 의 FK 대상이므로 먼저 생성)
CREATE TABLE IF NOT EXISTS projects (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    description     TEXT,
    system_prompt   TEXT,
    knowledge_files TEXT,
    wiki_tags       TEXT,
    is_active       INTEGER DEFAULT 0,
    color           TEXT DEFAULT '#9b77d9',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

-- 채팅 세션
CREATE TABLE IF NOT EXISTS chat_sessions (
    session_id  TEXT PRIMARY KEY,
    title       TEXT NOT NULL DEFAULT '새 대화',
    project_id  TEXT REFERENCES projects(id) ON DELETE SET NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

-- 채팅 메시지
CREATE TABLE IF NOT EXISTS chat_messages (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
    role        TEXT NOT NULL,
    content     TEXT NOT NULL,
    pdf_url     TEXT,
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id);

-- 논문 (Paper Wiki)
CREATE TABLE IF NOT EXISTS papers (
    id              TEXT PRIMARY KEY,
    title           TEXT NOT NULL,
    authors         TEXT,
    doi             TEXT UNIQUE,
    pmid            TEXT,
    biorxiv_id      TEXT,
    is_preprint     INTEGER DEFAULT 0,
    journal         TEXT,
    year            INTEGER,
    volume_issue    TEXT,
    abstract        TEXT,
    summary         TEXT,
    llm_analysis    TEXT,
    tags            TEXT,
    structured_tags TEXT,
    related_ids     TEXT,
    relation_types  TEXT,
    geo_accession   TEXT,
    github_url      TEXT,
    analysis_lang   TEXT,
    key_tools       TEXT,
    cell_types      TEXT,
    organism        TEXT,
    tissue          TEXT,
    sample_n        TEXT,
    read_status     TEXT DEFAULT 'to-read',
    relevance       TEXT DEFAULT 'reference',
    personal_note   TEXT,
    research_note   TEXT,
    figures         TEXT,
    vault_path      TEXT,
    pdf_path        TEXT,
    source          TEXT DEFAULT 'manual',
    notes           TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_papers_doi ON papers(doi);
CREATE INDEX IF NOT EXISTS idx_papers_year ON papers(year);
CREATE INDEX IF NOT EXISTS idx_papers_read_status ON papers(read_status);

-- Digest 엔트리
CREATE TABLE IF NOT EXISTS digest_entries (
    id              TEXT PRIMARY KEY,
    date            TEXT NOT NULL,
    keywords        TEXT,
    source          TEXT DEFAULT 'both',
    status          TEXT DEFAULT 'pending',
    papers          TEXT NOT NULL,
    highlight       TEXT,
    telegram_msg_id TEXT,
    created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_digest_date ON digest_entries(date);

-- 북마크 (기존 bookmarks.json 마이그레이션 대상)
CREATE TABLE IF NOT EXISTS bookmarks (
    session_id  TEXT PRIMARY KEY REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL
);

-- 개념 문서 (LLM-Wiki 패턴 — 논문에서 추출된 개념 단위 누적 문서)
CREATE TABLE IF NOT EXISTS concepts (
    id                  TEXT PRIMARY KEY,
    title               TEXT NOT NULL,
    summary             TEXT,           -- 한 줄 요약
    content             TEXT,           -- 누적 마크다운 본문
    tags                TEXT,           -- JSON array
    source_paper_ids    TEXT DEFAULT '[]',  -- JSON array of paper IDs
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_concepts_title ON concepts(title);
