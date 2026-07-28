"""전역 검색 API — FTS5 (papers / concepts / chat_messages)."""

from __future__ import annotations

import logging

from flask import Blueprint, jsonify, request

from .. import db

logger = logging.getLogger(__name__)

bp = Blueprint("search", __name__)


def _fts_query(q: str) -> str:
    """사용자 입력을 안전한 FTS5 MATCH 식으로 변환.

    각 토큰을 따옴표로 감싸 구문 오류를 차단하고 (AND 매칭),
    마지막 토큰은 prefix 매칭(*)으로 입력 중 검색을 지원한다.
    """
    tokens = [t.replace('"', '""') for t in q.split() if t.strip()]
    if not tokens:
        return ""
    quoted = [f'"{t}"' for t in tokens[:-1]]
    quoted.append(f'"{tokens[-1]}"*')
    return " ".join(quoted)


@bp.get("/api/search")
def global_search():
    q = (request.args.get("q") or "").strip()
    if len(q) < 2:
        return jsonify({"papers": [], "concepts": [], "chats": []})
    match = _fts_query(q)
    if not match:
        return jsonify({"papers": [], "concepts": [], "chats": []})
    limit = min(int(request.args.get("limit") or 8), 30)
    conn = db.get_conn()
    out = {"papers": [], "concepts": [], "chats": []}

    try:
        rows = conn.execute(
            "SELECT p.id, p.title, p.year, p.journal,"
            " snippet(papers_fts, -1, '<mark>', '</mark>', '…', 18) AS snip"
            " FROM papers_fts JOIN papers p ON p.rowid = papers_fts.rowid"
            " WHERE papers_fts MATCH ? ORDER BY rank LIMIT ?",
            (match, limit),
        ).fetchall()
        out["papers"] = [
            {"id": r["id"], "title": r["title"], "year": r["year"],
             "journal": r["journal"], "snippet": r["snip"]}
            for r in rows
        ]
    except Exception:
        logger.exception("papers fts search failed")

    try:
        rows = conn.execute(
            "SELECT c.id, c.title, c.summary,"
            " snippet(concepts_fts, -1, '<mark>', '</mark>', '…', 18) AS snip"
            " FROM concepts_fts JOIN concepts c ON c.rowid = concepts_fts.rowid"
            " WHERE concepts_fts MATCH ? ORDER BY rank LIMIT ?",
            (match, limit),
        ).fetchall()
        out["concepts"] = [
            {"id": r["id"], "title": r["title"], "summary": r["summary"],
             "snippet": r["snip"]}
            for r in rows
        ]
    except Exception:
        logger.exception("concepts fts search failed")

    try:
        # snippet()은 GROUP BY 집계와 함께 못 쓰므로, 랭크순으로 넉넉히 받아
        # 세션당 1건으로 Python에서 dedupe
        rows = conn.execute(
            "SELECT m.session_id, s.title, m.created_at,"
            " snippet(chat_fts, 0, '<mark>', '</mark>', '…', 18) AS snip"
            " FROM chat_fts JOIN chat_messages m ON m.rowid = chat_fts.rowid"
            " LEFT JOIN chat_sessions s ON s.session_id = m.session_id"
            " WHERE chat_fts MATCH ? ORDER BY rank LIMIT ?",
            (match, limit * 5),
        ).fetchall()
        seen_sessions: set[str] = set()
        for r in rows:
            sid = r["session_id"]
            if sid in seen_sessions:
                continue
            seen_sessions.add(sid)
            out["chats"].append({
                "session_id": sid,
                "title": r["title"] or "(제목 없음)",
                "snippet": r["snip"],
                "created_at": r["created_at"],
            })
            if len(out["chats"]) >= limit:
                break
    except Exception:
        logger.exception("chat fts search failed")

    return jsonify(out)
