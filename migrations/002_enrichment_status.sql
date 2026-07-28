-- 002_enrichment_status.sql
-- 백그라운드 enrichment 작업 상태 추적
-- 값: none / pending / running / done / failed

ALTER TABLE papers ADD COLUMN enrichment_status TEXT DEFAULT 'none';
ALTER TABLE papers ADD COLUMN enrichment_error TEXT;
