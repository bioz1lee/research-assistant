"""Daily paper digest pipeline: crawl → dedupe → Claude select → save → notify."""

from __future__ import annotations

import datetime
import json
import logging
import uuid
from typing import Iterator

from .. import db
from . import claude_runner, llm_parse, paper_search, telegram_service

logger = logging.getLogger(__name__)


def run_daily_digest(*, send_telegram: bool = True) -> dict:
    """Top-level entry: crawl, select top 3, save digest_entries, send to Telegram."""
    cfg = db.load_config()
    dcfg = cfg.get("digest") or {}
    keywords_obj = dcfg.get("keywords") or {}
    sources = dcfg.get("sources") or ["biorxiv", "pubmed"]
    max_per = int(dcfg.get("max_results_per_keyword") or 20)

    primary = keywords_obj.get("primary") or []
    secondary = keywords_obj.get("secondary") or []
    methods = keywords_obj.get("methods_watch") or []
    keywords = [k for k in (primary + secondary + methods) if k]
    if not keywords:
        return {"ok": False, "error": "no keywords configured"}

    raw: list[dict] = []
    if "biorxiv" in sources:
        try:
            raw += paper_search.search_biorxiv(keywords, days=7, max_results=max_per)
        except Exception:
            logger.exception("biorxiv search failed")
    if "pubmed" in sources:
        try:
            raw += paper_search.search_pubmed(keywords, days=7, max_results=max_per)
        except Exception:
            logger.exception("pubmed search failed")

    # Deduplicate by DOI/title and exclude papers already in the wiki
    existing_dois = db.get_all_paper_dois()
    seen: set[str] = set()
    candidates: list[dict] = []
    for p in raw:
        key = (p.get("doi") or p.get("title") or "").strip().lower()
        if not key or key in seen:
            continue
        seen.add(key)
        if p.get("doi") and p["doi"] in existing_dois:
            continue
        candidates.append(p)

    if not candidates:
        return {"ok": False, "error": "no new candidates"}

    selection = select_top_papers_with_claude(candidates, keywords)
    top_papers = selection.get("papers") or candidates[:3]
    highlight = selection.get("highlight") or ""

    # "나중에" 표시했던 논문을 1회 재노출 (이미 위키에 있으면 제외)
    revisit = _pop_later_papers(limit=3, existing_dois=existing_dois)
    all_papers = top_papers + revisit

    entry = create_digest_entry(all_papers, keywords, highlight=highlight)

    if send_telegram and telegram_service.is_enabled():
        result = telegram_service.send_digest(entry)
        if result.get("ok"):
            db.get_conn().execute(
                "UPDATE digest_entries SET status = 'sent', telegram_msg_id = ? WHERE id = ?",
                (json.dumps(result.get("message_ids") or []), entry["id"]),
            )
            db.get_conn().commit()
            entry["status"] = "sent"
            entry["telegram_msg_id"] = json.dumps(result.get("message_ids") or [])
        else:
            db.get_conn().execute(
                "UPDATE digest_entries SET status = 'failed' WHERE id = ?", (entry["id"],)
            )
            db.get_conn().commit()
            entry["status"] = "failed"

    return {"ok": True, "digest_id": entry["id"], "count": len(all_papers), "entry": entry}


def _pop_later_papers(limit: int = 3, existing_dois: set | None = None) -> list[dict]:
    """미재노출 'later' 피드백 논문을 꺼내고 reshown=1 처리. revisit 플래그를 단다."""
    rows = db.get_conn().execute(
        "SELECT id, paper_doi, paper_json FROM digest_feedback"
        " WHERE action = 'later' AND reshown = 0 ORDER BY created_at ASC LIMIT ?",
        (limit,),
    ).fetchall()
    out: list[dict] = []
    for r in rows:
        db.get_conn().execute(
            "UPDATE digest_feedback SET reshown = 1 WHERE id = ?", (r["id"],)
        )
        if existing_dois and r["paper_doi"] and r["paper_doi"] in existing_dois:
            continue  # 이미 위키에 저장됨 — 재노출 불필요
        try:
            paper = json.loads(r["paper_json"] or "{}")
        except json.JSONDecodeError:
            continue
        if paper.get("title"):
            paper["revisit"] = True
            out.append(paper)
    db.get_conn().commit()
    return out


def get_feedback_signal(limit: int = 30) -> dict:
    """최근 saved/skipped 논문 제목 — Claude 선별 프롬프트의 취향 신호."""
    rows = db.get_conn().execute(
        "SELECT paper_title, action FROM digest_feedback"
        " WHERE action IN ('saved', 'skipped')"
        " ORDER BY created_at DESC LIMIT ?",
        (limit * 2,),
    ).fetchall()
    saved = [r["paper_title"] for r in rows if r["action"] == "saved"][:limit]
    skipped = [r["paper_title"] for r in rows if r["action"] == "skipped"][:limit]
    return {"saved": saved, "skipped": skipped}


# ---------------------------------------------------------------------------
# Claude selection
# ---------------------------------------------------------------------------

def select_top_papers_with_claude(papers: list[dict], keywords: list[str]) -> dict:
    """Call Claude to select top 3 papers and return the enriched objects.

    Returns {"papers": [...], "highlight": str}. Falls back to first 3 raw on failure.
    """
    if not papers:
        return {"papers": [], "highlight": ""}
    cfg = db.load_config()
    model = (cfg.get("llm") or {}).get("model") or "claude-opus-5"

    if len(papers) > 50:
        logger.info("digest selection: %d candidates, only first 50 sent to Claude", len(papers))
    listing_parts = []
    for i, p in enumerate(papers[:50], start=1):
        listing_parts.append(
            f"[{i}] DOI={p.get('doi','')}\n"
            f"  source={p.get('source','')}\n"
            f"  title={p.get('title','')[:200]}\n"
            f"  journal={p.get('journal','')}, year={p.get('year','')}\n"
            f"  is_preprint={p.get('is_preprint', False)}\n"
            f"  abstract={(p.get('abstract','') or '')[:600]}"
        )
    listing = "\n\n".join(listing_parts)

    # 과거 피드백을 취향 신호로 주입
    signal = get_feedback_signal(limit=30)
    feedback_block = ""
    if signal["saved"] or signal["skipped"]:
        feedback_block = "\n## 사용자 취향 신호 (과거 digest 반응)\n"
        if signal["saved"]:
            feedback_block += "저장한 논문 (이런 논문 선호):\n" + "\n".join(
                f"- {t[:120]}" for t in signal["saved"]
            ) + "\n"
        if signal["skipped"]:
            feedback_block += "건너뛴 논문 (이런 논문 비선호):\n" + "\n".join(
                f"- {t[:120]}" for t in signal["skipped"]
            ) + "\n"
        feedback_block += "위 신호를 선별에 참고하되, 기준 1~4가 우선이다.\n"

    prompt = (
        "다음은 최근 publish된 논문 목록이야. 사용자의 관심 키워드:\n"
        f"{', '.join(keywords)}\n"
        f"{feedback_block}\n"
        "이 중에서 아래 기준으로 top 3을 골라줘 (반드시 ```json 블록으로 응답):\n"
        "선별 기준 (우선순위 순):\n"
        "1. 사용자 관심 키워드와의 직접 관련성\n"
        "2. 방법론 신규성 (기존 대비 명확한 차별점)\n"
        "3. 저널 신뢰도 — 아래 목록 우선:\n"
        "   [최상위] Nature, Science, Cell\n"
        "   [Nature 패밀리] Nature Methods, Nature Biotechnology, Nature Genetics, Nature Cell Biology, Nature Communications, Nature Computational Science\n"
        "   [Science 패밀리] Science Advances\n"
        "   [Cell 패밀리] Cell Systems, Cell Genomics, Cell Reports Methods, Molecular Cell, Current Biology\n"
        "   [전문지] Genome Biology, Genome Research, Nucleic Acids Research, Bioinformatics, PLOS Computational Biology, PNAS\n"
        "   [차상위] eLife, Cell Reports\n"
        "   위 목록 외 저널은 기준 1·2가 탁월할 때만 선택\n"
        "4. 데이터/코드 공개 여부 (GEO/GitHub 있으면 우선)\n"
        "※ 인용 수는 기준으로 삼지 마세요 (최신 논문은 인용이 적음)\n\n"
        "```json\n"
        "{\n"
        '  "highlight": "오늘의 하이라이트 1문장 (Top 3 중 가장 중요한 이유)",\n'
        '  "papers": [\n'
        "    {\n"
        '      "index": 1,  // 위 목록의 [N] 번호\n'
        '      "summary": "50자 이내 제목 요약",\n'
        '      "one_liner": "한 줄 요지 (이 논문이 새롭게 보여주는 것, 1문장)",\n'
        '      "tags": ["scRNA-seq", "microglia"],\n'
        '      "method": "scRNA-seq",\n'
        '      "cell_types": ["microglia"],\n'
        '      "organism": "mouse",\n'
        '      "tissue": "brain",\n'
        '      "geo_accession": "GSExxxxx",\n'
        '      "github_url": ""\n'
        "    }\n"
        "  ]\n"
        "}\n"
        "```\n\n"
        "## 후보 논문\n\n"
        f"{listing}\n"
    )
    raw = claude_runner.run_oneshot(prompt, model=model, timeout=150, max_turns=2)
    if not raw:
        logger.warning("digest selection: empty LLM response, falling back to first 3")
        return {"papers": papers[:3], "highlight": ""}
    data = llm_parse.extract_json(raw)
    if not data:
        logger.warning("digest selection: JSON extract failed, falling back to first 3")
        return {"papers": papers[:3], "highlight": ""}

    selected = []
    for item in (data.get("papers") or [])[:3]:
        try:
            idx = int(item.get("index"))
        except (TypeError, ValueError):
            continue
        if 1 <= idx <= len(papers):
            base = dict(papers[idx - 1])
            base["summary"] = item.get("summary") or base.get("title")
            base["one_liner"] = item.get("one_liner") or ""
            base["tags"] = item.get("tags") or []
            base["method"] = item.get("method") or ""
            base["cell_types"] = item.get("cell_types") or []
            base["organism"] = item.get("organism") or ""
            base["tissue"] = item.get("tissue") or ""
            base["geo_accession"] = item.get("geo_accession") or ""
            base["github_url"] = item.get("github_url") or ""
            base["wiki_added"] = False
            selected.append(base)
    if not selected:
        selected = papers[:3]
    return {"papers": selected, "highlight": data.get("highlight") or ""}


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------

def create_digest_entry(papers: list[dict], keywords: list[str], highlight: str = "") -> dict:
    entry_id = uuid.uuid4().hex
    date = datetime.date.today().isoformat()
    now = db.now_iso()
    sources = sorted({p.get("source", "") for p in papers if p.get("source")})
    source_label = (
        sources[0] if len(sources) == 1 else "both" if len(sources) > 1 else "manual"
    )
    db.get_conn().execute(
        "INSERT INTO digest_entries(id, date, keywords, source, status, papers, highlight, telegram_msg_id, created_at)"
        " VALUES(?, ?, ?, ?, 'pending', ?, ?, NULL, ?)",
        (
            entry_id,
            date,
            json.dumps(keywords, ensure_ascii=False),
            source_label,
            json.dumps(papers, ensure_ascii=False),
            highlight,
            now,
        ),
    )
    db.get_conn().commit()
    return {
        "id": entry_id,
        "date": date,
        "keywords": keywords,
        "source": source_label,
        "status": "pending",
        "papers": papers,
        "highlight": highlight,
        "created_at": now,
    }


def list_digests(limit: int = 30) -> list[dict]:
    rows = db.get_conn().execute(
        "SELECT id, date, status, papers, highlight, source, created_at"
        " FROM digest_entries ORDER BY date DESC, created_at DESC LIMIT ?",
        (limit,),
    ).fetchall()
    out: list[dict] = []
    for r in rows:
        try:
            papers = json.loads(r["papers"] or "[]")
        except json.JSONDecodeError:
            papers = []
        out.append({
            "id": r["id"],
            "date": r["date"],
            "status": r["status"],
            "source": r["source"],
            "highlight": r["highlight"] or "",
            "papers_count": len(papers),
            "created_at": r["created_at"],
        })
    return out


def get_digest(digest_id: str) -> dict | None:
    row = db.get_conn().execute(
        "SELECT * FROM digest_entries WHERE id = ?", (digest_id,)
    ).fetchone()
    if not row:
        return None
    out = db.row_to_dict(row)
    for k in ("keywords", "papers"):
        try:
            out[k] = json.loads(out.get(k) or "[]")
        except json.JSONDecodeError:
            out[k] = []
    return out


# ---------------------------------------------------------------------------
# SSE streaming wrapper (for manual trigger)
# ---------------------------------------------------------------------------

def run_daily_digest_stream() -> Iterator[str]:
    """Yield SSE strings describing pipeline progress + final result."""
    def _sse(obj):
        return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"

    yield _sse({"type": "status", "stage": "crawl", "message": "논문 크롤 시작"})
    try:
        result = run_daily_digest(send_telegram=False)
    except Exception as exc:
        yield _sse({"type": "error", "error": str(exc)})
        return
    if not result.get("ok"):
        yield _sse({"type": "error", "error": result.get("error", "unknown")})
        return
    yield _sse({"type": "status", "stage": "saved", "digest_id": result["digest_id"], "count": result["count"]})
    if telegram_service.is_enabled():
        yield _sse({"type": "status", "stage": "telegram", "message": "Telegram 전송 중"})
        try:
            entry = get_digest(result["digest_id"])
            if entry:
                tg_result = telegram_service.send_digest(entry)
                if tg_result.get("ok"):
                    db.get_conn().execute(
                        "UPDATE digest_entries SET status = 'sent', telegram_msg_id = ? WHERE id = ?",
                        (json.dumps(tg_result.get("message_ids") or []), entry["id"]),
                    )
                    db.get_conn().commit()
                    yield _sse({"type": "status", "stage": "telegram", "ok": True})
                else:
                    yield _sse({"type": "status", "stage": "telegram", "ok": False, "error": tg_result.get("error", "")})
        except Exception as exc:
            yield _sse({"type": "status", "stage": "telegram", "ok": False, "error": str(exc)})
    yield _sse({"type": "done", "digest_id": result["digest_id"]})
