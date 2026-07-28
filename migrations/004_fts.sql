-- 004_fts.sql
-- 전역 검색용 FTS5 인덱스 (papers / concepts / chat_messages)
-- external content 방식: 원본 테이블 rowid에 연결, 트리거로 동기화

-- ── papers ──────────────────────────────────────────────
CREATE VIRTUAL TABLE IF NOT EXISTS papers_fts USING fts5(
    title, abstract, summary, llm_analysis, tags, notes,
    content='papers', content_rowid='rowid'
);

INSERT INTO papers_fts(rowid, title, abstract, summary, llm_analysis, tags, notes)
    SELECT rowid, title, abstract, summary, llm_analysis, tags, notes FROM papers;

CREATE TRIGGER IF NOT EXISTS papers_fts_ai AFTER INSERT ON papers BEGIN
    INSERT INTO papers_fts(rowid, title, abstract, summary, llm_analysis, tags, notes)
    VALUES (new.rowid, new.title, new.abstract, new.summary, new.llm_analysis, new.tags, new.notes);
END;
CREATE TRIGGER IF NOT EXISTS papers_fts_ad AFTER DELETE ON papers BEGIN
    INSERT INTO papers_fts(papers_fts, rowid, title, abstract, summary, llm_analysis, tags, notes)
    VALUES ('delete', old.rowid, old.title, old.abstract, old.summary, old.llm_analysis, old.tags, old.notes);
END;
CREATE TRIGGER IF NOT EXISTS papers_fts_au AFTER UPDATE ON papers BEGIN
    INSERT INTO papers_fts(papers_fts, rowid, title, abstract, summary, llm_analysis, tags, notes)
    VALUES ('delete', old.rowid, old.title, old.abstract, old.summary, old.llm_analysis, old.tags, old.notes);
    INSERT INTO papers_fts(rowid, title, abstract, summary, llm_analysis, tags, notes)
    VALUES (new.rowid, new.title, new.abstract, new.summary, new.llm_analysis, new.tags, new.notes);
END;

-- ── concepts ────────────────────────────────────────────
CREATE VIRTUAL TABLE IF NOT EXISTS concepts_fts USING fts5(
    title, summary, content, tags,
    content='concepts', content_rowid='rowid'
);

INSERT INTO concepts_fts(rowid, title, summary, content, tags)
    SELECT rowid, title, summary, content, tags FROM concepts;

CREATE TRIGGER IF NOT EXISTS concepts_fts_ai AFTER INSERT ON concepts BEGIN
    INSERT INTO concepts_fts(rowid, title, summary, content, tags)
    VALUES (new.rowid, new.title, new.summary, new.content, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS concepts_fts_ad AFTER DELETE ON concepts BEGIN
    INSERT INTO concepts_fts(concepts_fts, rowid, title, summary, content, tags)
    VALUES ('delete', old.rowid, old.title, old.summary, old.content, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS concepts_fts_au AFTER UPDATE ON concepts BEGIN
    INSERT INTO concepts_fts(concepts_fts, rowid, title, summary, content, tags)
    VALUES ('delete', old.rowid, old.title, old.summary, old.content, old.tags);
    INSERT INTO concepts_fts(rowid, title, summary, content, tags)
    VALUES (new.rowid, new.title, new.summary, new.content, new.tags);
END;

-- ── chat_messages ───────────────────────────────────────
CREATE VIRTUAL TABLE IF NOT EXISTS chat_fts USING fts5(
    content,
    content='chat_messages', content_rowid='rowid'
);

INSERT INTO chat_fts(rowid, content)
    SELECT rowid, content FROM chat_messages;

CREATE TRIGGER IF NOT EXISTS chat_fts_ai AFTER INSERT ON chat_messages BEGIN
    INSERT INTO chat_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS chat_fts_ad AFTER DELETE ON chat_messages BEGIN
    INSERT INTO chat_fts(chat_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS chat_fts_au AFTER UPDATE ON chat_messages BEGIN
    INSERT INTO chat_fts(chat_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    INSERT INTO chat_fts(rowid, content) VALUES (new.rowid, new.content);
END;
