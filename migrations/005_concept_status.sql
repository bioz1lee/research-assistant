-- 005_concept_status.sql
-- 논문 → 개념 추출 작업 상태 추적
-- 값: none / pending / running / done / failed

ALTER TABLE papers ADD COLUMN concept_status TEXT DEFAULT 'none';
ALTER TABLE papers ADD COLUMN concept_error TEXT;
