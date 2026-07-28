"""Paper Wiki service — Obsidian .md generation, DOI fetch, LLM enrichment."""

from __future__ import annotations

import datetime
import json
import logging
import os
import re
import threading
import uuid
from typing import Any

from .. import db
from . import claude_runner, llm_parse, paper_search

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Vault helpers
# ---------------------------------------------------------------------------

def _vault_dir() -> str | None:
    cfg = db.load_config()
    vault = (cfg.get("vault_path") or "").strip()
    if not vault:
        return None
    sub = cfg.get("vault_papers_subdir") or "papers"
    path = os.path.join(os.path.expanduser(vault), sub)
    try:
        os.makedirs(path, exist_ok=True)
    except OSError:
        return None
    return path


def _slugify(text: str, max_len: int = 50) -> str:
    text = text.lower().strip()
    text = re.sub(r"[^a-z0-9가-힣\s-]", "", text)
    text = re.sub(r"\s+", "-", text)
    return text[:max_len] or "untitled"


def _filename_for(paper: dict) -> str:
    authors = paper.get("authors") or []
    first = ""
    if authors:
        a0 = authors[0] if isinstance(authors, list) else str(authors).split(",")[0]
        first = a0.split(" ")[0].split(",")[0]
    year = paper.get("year") or "noyear"
    tags = paper.get("tags") or []
    first_tag = ""
    if isinstance(tags, list) and tags:
        first_tag = tags[0]
    elif isinstance(tags, str):
        try:
            arr = json.loads(tags)
            first_tag = arr[0] if arr else ""
        except json.JSONDecodeError:
            pass
    base = "-".join(p for p in [first, str(year), first_tag] if p) or _slugify(paper.get("title", "untitled"))
    return _slugify(base) + ".md"


# ---------------------------------------------------------------------------
# JSON field helpers
# ---------------------------------------------------------------------------

def _to_json(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, (list, dict)):
        return json.dumps(value, ensure_ascii=False)
    return value


def _row_to_paper(row: dict | None) -> dict | None:
    if not row:
        return None
    out = dict(row)
    for k in (
        "authors", "tags", "structured_tags", "related_ids", "relation_types",
        "key_tools", "cell_types", "figures",
    ):
        v = out.get(k)
        if isinstance(v, str) and v:
            try:
                out[k] = json.loads(v)
            except json.JSONDecodeError:
                pass
    out["is_preprint"] = bool(out.get("is_preprint"))
    return out


# ---------------------------------------------------------------------------
# 어휘 통제 — organism/tissue/cell_types/key_tools 표기 통일
# ---------------------------------------------------------------------------

# 학명/변형 표기 → 위키 표준 표기 (소문자 키)
_ORGANISM_CANON = {
    "mus musculus": "mouse",
    "mice": "mouse",
    "homo sapiens": "human",
    "humans": "human",
    "rattus norvegicus": "rat",
    "danio rerio": "zebrafish",
    "drosophila melanogaster": "drosophila",
    "macaca mulatta": "macaque",
    "macaca fascicularis": "macaque",
    "caenorhabditis elegans": "c. elegans",
}


def get_existing_vocab() -> dict:
    """DB에 이미 쓰인 메타데이터 값 목록 (표기 통일의 기준)."""
    conn = db.get_conn()
    organisms = [r[0] for r in conn.execute(
        "SELECT DISTINCT organism FROM papers WHERE organism IS NOT NULL AND organism != ''"
    )]
    tissues = [r[0] for r in conn.execute(
        "SELECT DISTINCT tissue FROM papers WHERE tissue IS NOT NULL AND tissue != ''"
    )]
    cell_types: set[str] = set()
    key_tools: set[str] = set()
    for r in conn.execute("SELECT cell_types, key_tools FROM papers"):
        for col, bucket in ((r[0], cell_types), (r[1], key_tools)):
            if not col:
                continue
            try:
                for v in json.loads(col):
                    if isinstance(v, str) and v.strip():
                        bucket.add(v.strip())
            except json.JSONDecodeError:
                pass
    return {
        "organism": organisms,
        "tissue": tissues,
        "cell_types": sorted(cell_types),
        "key_tools": sorted(key_tools),
    }


def _match_existing(value: str, existing: list[str]) -> str:
    """대소문자만 다른 기존 표기가 있으면 기존 표기로 통일."""
    low = value.strip().lower()
    for e in existing:
        if e.lower() == low:
            return e
    return value.strip()


def normalize_vocab(data: dict) -> dict:
    """enrichment/저장 직전에 메타데이터 표기를 기존 DB 값과 통일."""
    vocab = get_existing_vocab()
    if isinstance(data.get("organism"), str) and data["organism"]:
        canon = _ORGANISM_CANON.get(data["organism"].strip().lower(), data["organism"])
        data["organism"] = _match_existing(canon, vocab["organism"])
    if isinstance(data.get("tissue"), str) and data["tissue"]:
        data["tissue"] = _match_existing(data["tissue"], vocab["tissue"])
    for k in ("cell_types", "key_tools"):
        if isinstance(data.get(k), list):
            data[k] = [
                _match_existing(v, vocab[k]) for v in data[k]
                if isinstance(v, str) and v.strip()
            ]
    return data


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------

def list_papers(filters: dict | None = None) -> list[dict]:
    conn = db.get_conn()
    where = []
    params: list = []
    filters = filters or {}
    q = (filters.get("q") or "").strip()
    if q:
        where.append("(title LIKE ? OR abstract LIKE ? OR summary LIKE ? OR notes LIKE ? OR tags LIKE ?)")
        like = f"%{q}%"
        params += [like, like, like, like, like]
    if filters.get("year_from"):
        where.append("year >= ?")
        params.append(int(filters["year_from"]))
    if filters.get("year_to"):
        where.append("year <= ?")
        params.append(int(filters["year_to"]))
    if filters.get("status"):
        where.append("read_status = ?")
        params.append(filters["status"])
    if filters.get("relevance"):
        where.append("relevance = ?")
        params.append(filters["relevance"])
    if filters.get("source"):
        where.append("source = ?")
        params.append(filters["source"])
    if filters.get("organism"):
        where.append("organism = ?")
        params.append(filters["organism"])
    if filters.get("cell_type"):
        where.append("cell_types LIKE ?")
        params.append(f"%{filters['cell_type']}%")
    if filters.get("tags"):
        # comma-separated list — AND filter
        tags = [t.strip() for t in filters["tags"].split(",") if t.strip()]
        for t in tags:
            where.append("tags LIKE ?")
            params.append(f"%{t}%")
    sql = "SELECT * FROM papers"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY datetime(updated_at) DESC LIMIT 500"
    rows = conn.execute(sql, params).fetchall()
    return [_row_to_paper(db.row_to_dict(r)) for r in rows]


def get_paper(paper_id: str) -> dict | None:
    row = db.get_conn().execute("SELECT * FROM papers WHERE id = ?", (paper_id,)).fetchone()
    return _row_to_paper(db.row_to_dict(row))


def add_paper(paper_data: dict, source: str = "manual") -> dict:
    """Insert a paper row + create the Obsidian .md file.

    If only a DOI is given, metadata is auto-fetched from PubMed/Crossref.
    """
    paper_data = dict(paper_data or {})
    doi = (paper_data.get("doi") or "").strip()
    if doi and not paper_data.get("title"):
        meta = paper_search.get_paper_metadata_from_doi(doi)
        if meta:
            for k, v in meta.items():
                paper_data.setdefault(k, v)

    if not paper_data.get("title"):
        raise ValueError("title is required (or provide a resolvable DOI)")

    paper_data = normalize_vocab(paper_data)
    pid = uuid.uuid4().hex
    now = db.now_iso()

    conn = db.get_conn()
    # Reject duplicates on DOI
    if doi:
        dup = conn.execute("SELECT id FROM papers WHERE doi = ?", (doi,)).fetchone()
        if dup:
            return get_paper(dup["id"])

    row = {
        "id": pid,
        "title": paper_data.get("title"),
        "authors": _to_json(paper_data.get("authors")),
        "doi": doi or None,
        "pmid": paper_data.get("pmid") or "",
        "biorxiv_id": paper_data.get("biorxiv_id") or "",
        "is_preprint": 1 if paper_data.get("is_preprint") else 0,
        "journal": paper_data.get("journal") or "",
        "year": paper_data.get("year"),
        "volume_issue": paper_data.get("volume_issue") or "",
        "abstract": paper_data.get("abstract") or "",
        "summary": paper_data.get("summary") or "",
        "llm_analysis": paper_data.get("llm_analysis") or "",
        "tags": _to_json(paper_data.get("tags") or []),
        "structured_tags": _to_json(paper_data.get("structured_tags") or {}),
        "related_ids": _to_json(paper_data.get("related_ids") or []),
        "relation_types": _to_json(paper_data.get("relation_types") or {}),
        "geo_accession": paper_data.get("geo_accession") or "",
        "github_url": paper_data.get("github_url") or "",
        "analysis_lang": paper_data.get("analysis_lang") or "",
        "key_tools": _to_json(paper_data.get("key_tools") or []),
        "cell_types": _to_json(paper_data.get("cell_types") or []),
        "organism": paper_data.get("organism") or "",
        "tissue": paper_data.get("tissue") or "",
        "sample_n": paper_data.get("sample_n") or "",
        "read_status": paper_data.get("read_status") or "to-read",
        "relevance": paper_data.get("relevance") or "reference",
        "personal_note": paper_data.get("personal_note") or "",
        "research_note": paper_data.get("research_note") or "",
        "figures": _to_json(paper_data.get("figures") or []),
        "vault_path": None,
        "pdf_path": paper_data.get("pdf_path") or "",
        "source": source,
        "notes": paper_data.get("notes") or "",
        "created_at": now,
        "updated_at": now,
    }
    # Write .md to vault and capture the relative path
    vault_rel = create_obsidian_md(row)
    if vault_rel:
        row["vault_path"] = vault_rel

    cols = ", ".join(row.keys())
    placeholders = ", ".join(["?"] * len(row))
    conn.execute(f"INSERT INTO papers({cols}) VALUES({placeholders})", list(row.values()))
    conn.commit()
    return get_paper(pid)


def update_paper(paper_id: str, patch: dict) -> dict | None:
    current = get_paper(paper_id)
    if not current:
        return None
    allowed = {
        "title", "authors", "doi", "pmid", "biorxiv_id", "is_preprint", "journal",
        "year", "volume_issue", "abstract", "summary", "llm_analysis", "tags",
        "structured_tags", "related_ids", "relation_types", "geo_accession",
        "github_url", "analysis_lang", "key_tools", "cell_types", "organism",
        "tissue", "sample_n", "read_status", "relevance", "personal_note",
        "research_note", "figures", "pdf_path", "notes",
    }
    sets = []
    params: list = []
    for k, v in (patch or {}).items():
        if k not in allowed:
            continue
        if k == "is_preprint":
            v = 1 if v else 0
        if isinstance(v, (list, dict)):
            v = _to_json(v)
        sets.append(f"{k} = ?")
        params.append(v)
    if not sets:
        return current
    sets.append("updated_at = ?")
    params.append(db.now_iso())
    params.append(paper_id)
    db.get_conn().execute(f"UPDATE papers SET {', '.join(sets)} WHERE id = ?", params)
    db.get_conn().commit()
    updated = get_paper(paper_id)
    # Refresh vault .md to keep it in sync
    if updated:
        rel = create_obsidian_md(updated)
        if rel and rel != updated.get("vault_path"):
            db.get_conn().execute(
                "UPDATE papers SET vault_path = ? WHERE id = ?", (rel, paper_id)
            )
            db.get_conn().commit()
            updated["vault_path"] = rel
    return updated


def delete_paper(paper_id: str) -> bool:
    paper = get_paper(paper_id)
    if not paper:
        return False
    vault_dir = _vault_dir()
    if vault_dir and paper.get("vault_path"):
        try:
            full = os.path.join(os.path.dirname(vault_dir), paper["vault_path"])
            if os.path.isfile(full):
                os.remove(full)
        except OSError:
            pass
    db.get_conn().execute("DELETE FROM papers WHERE id = ?", (paper_id,))
    db.get_conn().commit()
    return True


# ---------------------------------------------------------------------------
# Obsidian .md generation (DESIGN.md 섹션 3.2)
# ---------------------------------------------------------------------------

def create_obsidian_md(paper: dict) -> str | None:
    """Write the .md file for the given paper row and return its vault-relative path."""
    vault_dir = _vault_dir()
    if not vault_dir:
        return None

    filename = _filename_for(paper)
    full_path = os.path.join(vault_dir, filename)

    def _coerce_list(value):
        if isinstance(value, list):
            return value
        if isinstance(value, str) and value:
            try:
                return json.loads(value)
            except json.JSONDecodeError:
                return []
        return []

    authors = _coerce_list(paper.get("authors"))
    tags = _coerce_list(paper.get("tags"))
    structured = paper.get("structured_tags")
    if isinstance(structured, str) and structured:
        try:
            structured = json.loads(structured)
        except json.JSONDecodeError:
            structured = {}
    if not isinstance(structured, dict):
        structured = {}
    key_tools = _coerce_list(paper.get("key_tools"))

    today = datetime.date.today().isoformat()

    lines: list[str] = ["---"]
    lines.append(f'title: "{(paper.get("title") or "").replace(chr(34), chr(39))}"')
    lines.append("authors: [" + ", ".join(f'"{a}"' for a in authors) + "]")
    lines.append(f'doi: "{paper.get("doi") or ""}"')
    lines.append(f'pmid: "{paper.get("pmid") or ""}"')
    lines.append(f'biorxiv_id: "{paper.get("biorxiv_id") or ""}"')
    lines.append(f"is_preprint: {'true' if paper.get('is_preprint') else 'false'}")
    lines.append(f'journal: "{paper.get("journal") or ""}"')
    lines.append(f"year: {paper.get('year') or ''}")
    lines.append(f'volume_issue: "{paper.get("volume_issue") or ""}"')
    lines.append("tags: [" + ", ".join(tags) + "]")
    if structured:
        lines.append("structured_tags:")
        for k, v in structured.items():
            vals = v if isinstance(v, list) else [v]
            lines.append(f"  {k}: [" + ", ".join(str(x) for x in vals) + "]")
    lines.append(f'geo_accession: "{paper.get("geo_accession") or ""}"')
    lines.append(f'github_url: "{paper.get("github_url") or ""}"')
    lines.append(f'analysis_lang: "{paper.get("analysis_lang") or ""}"')
    lines.append("key_tools: [" + ", ".join(f'"{t}"' for t in key_tools) + "]")
    lines.append(f"read_status: {paper.get('read_status') or 'to-read'}")
    lines.append(f"relevance: {paper.get('relevance') or 'reference'}")
    lines.append(f"source: {paper.get('source') or 'manual'}")
    lines.append(f"added: {today}")
    lines.append(f"updated: {today}")
    lines.append("---")
    lines.append("")
    lines.append("## Abstract")
    lines.append("")
    lines.append(paper.get("abstract") or "")
    lines.append("")
    if paper.get("llm_analysis"):
        lines.append("## LLM Analysis")
        lines.append("")
        lines.append(paper["llm_analysis"])
        lines.append("")
    lines.append("## Notes")
    lines.append("")
    lines.append(paper.get("notes") or "<!-- 개인 노트 (웹 UI에서 편집) -->")
    lines.append("")
    related = _coerce_list(paper.get("related_ids"))
    if related:
        lines.append("## Related Papers")
        for rid in related:
            lines.append(f"- [[{rid}]]")
        lines.append("")

    body = "\n".join(lines)
    try:
        with open(full_path, "w", encoding="utf-8") as f:
            f.write(body)
    except OSError:
        return None
    cfg = db.load_config()
    sub = cfg.get("vault_papers_subdir") or "papers"
    return f"{sub}/{filename}"


# ---------------------------------------------------------------------------
# LLM enrichment (background)
# ---------------------------------------------------------------------------

_enrichment_locks: dict[str, threading.Lock] = {}


def _set_enrichment(paper_id: str, status: str, error: str | None = None) -> None:
    db.get_conn().execute(
        "UPDATE papers SET enrichment_status = ?, enrichment_error = ? WHERE id = ?",
        (status, error, paper_id),
    )
    db.get_conn().commit()


def enrich_paper_async(paper_id: str) -> None:
    """Kick off a daemon thread that runs Claude to generate tags + summary."""
    lock = _enrichment_locks.setdefault(paper_id, threading.Lock())
    if lock.locked():
        return
    _set_enrichment(paper_id, "pending")
    t = threading.Thread(target=_enrich_paper, args=(paper_id, lock), daemon=True)
    t.start()


def _enrich_paper(paper_id: str, lock: threading.Lock) -> None:
    if not lock.acquire(blocking=False):
        return
    try:
        paper = get_paper(paper_id)
        if not paper:
            return
        _set_enrichment(paper_id, "running")
        cfg = db.load_config()
        model = (cfg.get("llm") or {}).get("model") or "claude-opus-5"

        # 기존 어휘를 프롬프트에 주입 — 같은 의미면 같은 표기를 쓰게 유도
        vocab = get_existing_vocab()
        vocab_lines = []
        for field, label in (("organism", "organism"), ("tissue", "tissue"),
                             ("cell_types", "cell_types"), ("key_tools", "key_tools")):
            vals = vocab.get(field) or []
            if vals:
                vocab_lines.append(f"- {label}: {', '.join(vals[:40])}")
        vocab_block = ""
        if vocab_lines:
            vocab_block = (
                "\n## 기존 위키 어휘 (같은 의미면 반드시 아래 표기 그대로 사용)\n"
                + "\n".join(vocab_lines) + "\n"
            )

        prompt = (
            "다음 논문 정보를 보고 JSON 형식으로 응답해줘. "
            "반드시 ```json 블록으로 감싸고 한국어로 작성:\n\n"
            "{\n"
            '  "summary": "한 줄 요약 (1문장)",\n'
            '  "llm_analysis": "What/How/Key Result/So What/Limitation 5섹션 마크다운",\n'
            '  "tags": ["scRNA-seq", "microglia", ...],\n'
            '  "structured_tags": {"method":["scRNA-seq"], "cell":["microglia"], "tool":["Seurat"]},\n'
            '  "key_tools": ["Seurat", "Harmony"],\n'
            '  "cell_types": ["microglia"],\n'
            '  "organism": "mouse",\n'
            '  "tissue": "brain",\n'
            '  "geo_accession": "GSExxxxx",\n'
            '  "github_url": ""\n'
            "}\n\n"
            f"{vocab_block}"
            "\n## 논문\n"
            f"제목: {paper.get('title')}\n"
            f"저자: {paper.get('authors')}\n"
            f"저널: {paper.get('journal')} ({paper.get('year')})\n"
            f"초록: {(paper.get('abstract') or '')[:3000]}\n"
        )
        raw = claude_runner.run_oneshot(prompt, model=model, timeout=120, max_turns=2)
        if not raw:
            _set_enrichment(paper_id, "failed", "LLM 응답이 비어 있음 (타임아웃 가능)")
            return
        data = llm_parse.extract_json(raw)
        if not data:
            _set_enrichment(paper_id, "failed", "LLM 응답에서 JSON 추출 실패")
            return
        update_paper(paper_id, normalize_vocab(data))
        _set_enrichment(paper_id, "done")
        logger.info("enrichment done: %s", paper_id)
        # 분석이 새로 생겼으니 개념 추출도 이어서 (텔레그램 저장 논문 등)
        if data.get("llm_analysis"):
            try:
                from . import concept_service
                concept_service.extract_from_paper_async(paper_id)
            except Exception:
                logger.warning("concept extraction trigger failed: %s", paper_id, exc_info=True)
    except Exception as exc:
        logger.exception("enrichment failed: %s", paper_id)
        try:
            _set_enrichment(paper_id, "failed", str(exc)[:500])
        except Exception:
            pass
    finally:
        try:
            lock.release()
        except RuntimeError:
            pass


# ---------------------------------------------------------------------------
# Tag aggregation
# ---------------------------------------------------------------------------

def get_all_tags() -> dict:
    rows = db.get_conn().execute(
        "SELECT tags, structured_tags FROM papers"
    ).fetchall()
    free: dict[str, int] = {}
    structured: dict[str, dict[str, int]] = {}
    for r in rows:
        try:
            for t in json.loads(r["tags"] or "[]"):
                if isinstance(t, str):
                    free[t] = free.get(t, 0) + 1
        except json.JSONDecodeError:
            pass
        try:
            stags = json.loads(r["structured_tags"] or "{}")
        except json.JSONDecodeError:
            stags = {}
        if isinstance(stags, dict):
            for category, values in stags.items():
                if isinstance(values, list):
                    bucket = structured.setdefault(category, {})
                    for v in values:
                        if isinstance(v, str):
                            bucket[v] = bucket.get(v, 0) + 1
    return {
        "free": sorted(free.items(), key=lambda x: -x[1]),
        "structured": {k: sorted(v.items(), key=lambda x: -x[1]) for k, v in structured.items()},
    }


# ---------------------------------------------------------------------------
# Vault sync
# ---------------------------------------------------------------------------

def sync_vault() -> dict:
    """Scan the vault directory for .md files and ensure DB rows exist.

    This is a one-way safety net: vault → DB. Only adds new rows for .md files
    we don't have. Existing DB rows are left untouched (DB is source of truth).
    """
    vault_dir = _vault_dir()
    if not vault_dir:
        return {"added": 0, "updated": 0, "error": "vault_path not set"}
    added = 0
    updated = 0
    if not os.path.isdir(vault_dir):
        return {"added": 0, "updated": 0, "error": "vault directory not found"}
    cfg = db.load_config()
    sub = cfg.get("vault_papers_subdir") or "papers"
    for fname in os.listdir(vault_dir):
        if not fname.endswith(".md"):
            continue
        rel = f"{sub}/{fname}"
        existing = db.get_conn().execute(
            "SELECT id FROM papers WHERE vault_path = ?", (rel,)
        ).fetchone()
        if existing:
            continue
        try:
            with open(os.path.join(vault_dir, fname), "r", encoding="utf-8") as f:
                body = f.read()
        except OSError:
            continue
        meta = _parse_frontmatter(body)
        if not meta.get("title"):
            continue
        meta["vault_path"] = rel
        # de-listify some scalar fields
        try:
            add_paper(meta, source=meta.get("source") or "vault-sync")
            added += 1
        except Exception:
            pass
    return {"added": added, "updated": updated}


def _parse_frontmatter(body: str) -> dict:
    if not body.startswith("---"):
        return {}
    end = body.find("\n---", 3)
    if end == -1:
        return {}
    fm = body[3:end].strip()
    out: dict[str, Any] = {}
    for line in fm.splitlines():
        if ":" not in line:
            continue
        k, v = line.split(":", 1)
        k = k.strip()
        v = v.strip()
        if v.startswith("[") and v.endswith("]"):
            inner = v[1:-1].strip()
            if not inner:
                out[k] = []
            else:
                items = [x.strip().strip('"').strip("'") for x in inner.split(",")]
                out[k] = [x for x in items if x]
        elif v.startswith('"') and v.endswith('"'):
            out[k] = v[1:-1]
        elif v in ("true", "false"):
            out[k] = (v == "true")
        elif v.isdigit():
            out[k] = int(v)
        else:
            out[k] = v
    # body section (after frontmatter)
    rest = body[end + 4:]
    abstract = re.search(r"## Abstract\s*\n([\s\S]*?)(?:\n## |\Z)", rest)
    if abstract:
        out["abstract"] = abstract.group(1).strip()
    analysis = re.search(r"## LLM Analysis\s*\n([\s\S]*?)(?:\n## |\Z)", rest)
    if analysis:
        out["llm_analysis"] = analysis.group(1).strip()
    notes = re.search(r"## Notes\s*\n([\s\S]*?)(?:\n## |\Z)", rest)
    if notes:
        out["notes"] = notes.group(1).strip()
    return out
