-- 007: 북마크를 메시지 단위로 재설계
-- 기존 bookmarks(session_id PK, created_at) → id/title/content 추가, 세션당 여러 개 허용
ALTER TABLE bookmarks RENAME TO bookmarks_old;

CREATE TABLE bookmarks (
    id          TEXT PRIMARY KEY,
    session_id  TEXT REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
    title       TEXT,
    content     TEXT,
    created_at  TEXT NOT NULL
);

-- 기존 세션 단위 북마크는 세션 제목으로 best-effort 이관 (본문 없음)
INSERT INTO bookmarks (id, session_id, title, content, created_at)
SELECT lower(hex(randomblob(16))),
       o.session_id,
       COALESCE(s.title, '북마크'),
       '',
       o.created_at
FROM bookmarks_old o
LEFT JOIN chat_sessions s ON s.session_id = o.session_id;

DROP TABLE bookmarks_old;

CREATE INDEX IF NOT EXISTS idx_bookmarks_session ON bookmarks(session_id);
CREATE INDEX IF NOT EXISTS idx_bookmarks_created ON bookmarks(created_at);
