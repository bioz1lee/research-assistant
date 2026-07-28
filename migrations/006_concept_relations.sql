-- 006_concept_relations.sql
-- 개념 간 관계 (지식 그래프의 엣지)
-- source: paper(같은 논문 공출현) | llm(의미 관계)
-- relation_type: co-occur | related | method-of | part-of | contrast | parent | applies-to ...

CREATE TABLE IF NOT EXISTS concept_relations (
    from_id        TEXT NOT NULL,
    to_id          TEXT NOT NULL,
    relation_type  TEXT DEFAULT 'related',
    source         TEXT DEFAULT 'paper',
    weight         INTEGER DEFAULT 1,
    created_at     TEXT NOT NULL,
    PRIMARY KEY (from_id, to_id, source)
);
CREATE INDEX IF NOT EXISTS idx_concept_rel_from ON concept_relations(from_id);
CREATE INDEX IF NOT EXISTS idx_concept_rel_to ON concept_relations(to_id);
