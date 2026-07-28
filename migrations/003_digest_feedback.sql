-- 003_digest_feedback.sql
-- Digest 피드백 루프: 텔레그램 저장/나중에/건너뛰기 액션 기록
-- action: saved | later | skipped
-- reshown: later 논문이 다음 digest에 재노출됐는지 (1회만 재노출)

CREATE TABLE IF NOT EXISTS digest_feedback (
    id          TEXT PRIMARY KEY,
    digest_id   TEXT,
    paper_doi   TEXT,
    paper_title TEXT NOT NULL,
    paper_json  TEXT,
    action      TEXT NOT NULL,
    keywords    TEXT,
    reshown     INTEGER DEFAULT 0,
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_digest_feedback_action ON digest_feedback(action);
CREATE INDEX IF NOT EXISTS idx_digest_feedback_created ON digest_feedback(created_at);
