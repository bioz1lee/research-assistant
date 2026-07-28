"""Chat API blueprint — chat streaming + conversation management."""

from __future__ import annotations

import json
import os
import uuid

from flask import Blueprint, Response, jsonify, request, stream_with_context

from .. import db
from ..services import claude_runner

bp = Blueprint("chat", __name__)


# ---------------------------------------------------------------------------
# Chat streaming
# ---------------------------------------------------------------------------

@bp.post("/api/chat")
def post_chat():
    data = request.get_json(silent=True) or {}
    message = data.get("message", "")
    session_id = data.get("session_id") or None
    project_id = data.get("project_id") or None
    cwd = data.get("cwd") or os.path.expanduser("~")
    # 요청에 모델이 없으면 config의 기본 모델을 사용한다.
    model = data.get("model") or (db.load_config().get("llm") or {}).get("model") or None
    system_prompt = data.get("system_prompt") or None
    files = data.get("files") or []
    permission_mode = data.get("permission_mode") or None

    if not message and not files:
        return jsonify({"error": "message is required"}), 400

    gen = claude_runner.run_chat(
        message,
        session_id=session_id,
        cwd=cwd,
        model=model,
        system_prompt=system_prompt,
        project_id=project_id,
        files=files,
        is_paper_study=False,
        permission_mode=permission_mode,
    )

    return Response(
        stream_with_context(gen),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@bp.post("/api/chat/study")
def post_chat_study():
    data = request.get_json(silent=True) or {}
    pdf_path = data.get("pdf_path") or ""
    session_id = data.get("session_id") or None
    cwd = data.get("cwd") or os.path.expanduser("~")
    model = data.get("model") or None
    if not pdf_path:
        return jsonify({"error": "pdf_path is required"}), 400
    if not os.path.isfile(pdf_path):
        return jsonify({"error": f"PDF not found: {pdf_path}"}), 400

    gen = claude_runner.run_paper_study(
        pdf_path,
        session_id=session_id,
        cwd=cwd,
        model=model,
    )
    return Response(
        stream_with_context(gen),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@bp.post("/api/abort")
def post_abort():
    data = request.get_json(silent=True) or {}
    sid = data.get("session_id", "")
    return jsonify({"aborted": claude_runner.abort_session(sid)})


# ---------------------------------------------------------------------------
# Conversation listing
# ---------------------------------------------------------------------------

@bp.get("/api/conversations")
def get_conversations():
    project_id = request.args.get("project_id")
    conn = db.get_conn()
    sql = (
        "SELECT s.session_id, s.title, s.project_id, s.created_at, s.updated_at, "
        " CASE WHEN EXISTS("
        "   SELECT 1 FROM bookmarks b WHERE b.session_id = s.session_id"
        " ) THEN 1 ELSE 0 END AS bookmarked "
        "FROM chat_sessions s "
    )
    params: list = []
    if project_id:
        sql += " WHERE s.project_id = ?"
        params.append(project_id)
    sql += " ORDER BY datetime(s.updated_at) DESC LIMIT 500"
    rows = conn.execute(sql, params).fetchall()
    return jsonify([db.row_to_dict(r) for r in rows])


@bp.get("/api/conversations/<sid>/messages")
def get_messages(sid: str):
    rows = db.get_conn().execute(
        "SELECT id, role, content, pdf_url, created_at FROM chat_messages"
        " WHERE session_id = ? ORDER BY datetime(created_at) ASC",
        (sid,),
    ).fetchall()
    return jsonify([db.row_to_dict(r) for r in rows])


@bp.post("/api/conversations/<sid>/messages")
def save_message(sid: str):
    data = request.get_json(silent=True) or {}
    role = data.get("role") or "user"
    content = data.get("content") or ""
    pdf_url = data.get("pdf_url") or data.get("pdfUrl")
    if not content:
        return jsonify({"error": "content required"}), 400
    conn = db.get_conn()
    # Ensure session exists
    existing = conn.execute(
        "SELECT 1 FROM chat_sessions WHERE session_id = ?", (sid,)
    ).fetchone()
    now = db.now_iso()
    if not existing:
        conn.execute(
            "INSERT INTO chat_sessions(session_id, title, project_id, created_at, updated_at)"
            " VALUES(?, '새 대화', NULL, ?, ?)",
            (sid, now, now),
        )
    conn.execute(
        "INSERT INTO chat_messages(id, session_id, role, content, pdf_url, created_at)"
        " VALUES(?, ?, ?, ?, ?, ?)",
        (uuid.uuid4().hex, sid, role, content, pdf_url, now),
    )
    conn.execute("UPDATE chat_sessions SET updated_at = ? WHERE session_id = ?", (now, sid))
    conn.commit()
    return jsonify({"saved": True})


@bp.delete("/api/conversations/<sid>")
def delete_conversation(sid: str):
    db.get_conn().execute("DELETE FROM chat_sessions WHERE session_id = ?", (sid,))
    db.get_conn().commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Bookmarks (message-level snippets)
# ---------------------------------------------------------------------------

@bp.get("/api/bookmarks")
def list_bookmarks():
    rows = db.get_conn().execute(
        "SELECT id, session_id, title, content, created_at FROM bookmarks"
        " ORDER BY datetime(created_at) DESC"
    ).fetchall()
    return jsonify([db.row_to_dict(r) for r in rows])


@bp.post("/api/bookmarks")
def create_bookmark():
    data = request.get_json(silent=True) or {}
    content = (data.get("content") or "").strip()
    if not content:
        return jsonify({"error": "content required"}), 400
    bid = uuid.uuid4().hex
    conn = db.get_conn()
    conn.execute(
        "INSERT INTO bookmarks(id, session_id, title, content, created_at)"
        " VALUES(?, ?, ?, ?, ?)",
        (bid, data.get("session_id"), data.get("title") or "", content, db.now_iso()),
    )
    conn.commit()
    return jsonify({"id": bid, "saved": True})


@bp.delete("/api/bookmarks/<bid>")
def delete_bookmark(bid: str):
    conn = db.get_conn()
    conn.execute("DELETE FROM bookmarks WHERE id = ?", (bid,))
    conn.commit()
    return jsonify({"ok": True})
