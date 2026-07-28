"""Paper Wiki API blueprint."""

from __future__ import annotations

import json

from flask import Blueprint, Response, jsonify, request, stream_with_context

from .. import db
from ..services import wiki_service

bp = Blueprint("wiki", __name__)


@bp.get("/api/wiki/papers")
def list_papers():
    filters = {
        "q": request.args.get("q"),
        "tags": request.args.get("tags"),
        "year_from": request.args.get("year_from"),
        "year_to": request.args.get("year_to"),
        "status": request.args.get("status"),
        "relevance": request.args.get("relevance"),
        "source": request.args.get("source"),
        "organism": request.args.get("organism"),
        "cell_type": request.args.get("cell_type"),
    }
    filters = {k: v for k, v in filters.items() if v}
    try:
        papers = wiki_service.list_papers(filters)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500
    return jsonify(papers)


@bp.get("/api/wiki/papers/<pid>")
def get_paper(pid: str):
    paper = wiki_service.get_paper(pid)
    if not paper:
        return jsonify({"error": "not found"}), 404
    return jsonify(paper)


@bp.post("/api/wiki/papers")
def create_paper():
    data = request.get_json(silent=True) or {}
    source = data.pop("source", "manual")
    try:
        paper = wiki_service.add_paper(data, source=source)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500
    # Skip enrichment if llm_analysis was already provided (e.g. from paper study)
    if paper and paper.get("id") and not data.get("llm_analysis"):
        wiki_service.enrich_paper_async(paper["id"])
    # Concept extraction (async) — runs after enrich completes naturally via separate thread
    if paper and paper.get("id") and paper.get("llm_analysis"):
        from ..services import concept_service
        concept_service.extract_from_paper_async(paper["id"])
    return jsonify(paper), 201


@bp.put("/api/wiki/papers/<pid>")
def update_paper(pid: str):
    data = request.get_json(silent=True) or {}
    paper = wiki_service.update_paper(pid, data)
    if not paper:
        return jsonify({"error": "not found"}), 404
    return jsonify(paper)


@bp.delete("/api/wiki/papers/<pid>")
def delete_paper(pid: str):
    ok = wiki_service.delete_paper(pid)
    if not ok:
        return jsonify({"error": "not found"}), 404
    return jsonify({"ok": True})


@bp.post("/api/wiki/papers/<pid>/enrich")
def enrich_paper(pid: str):
    paper = wiki_service.get_paper(pid)
    if not paper:
        return jsonify({"error": "not found"}), 404
    wiki_service.enrich_paper_async(pid)

    def _stream():
        # The enrichment runs in a daemon thread; we just emit a status event.
        yield f"data: {json.dumps({'type': 'status', 'message': 'enrichment started'})}\n\n"
        yield f"data: {json.dumps({'type': 'done', 'paper_id': pid})}\n\n"

    return Response(
        stream_with_context(_stream()),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@bp.post("/api/wiki/papers/<pid>/sync-vault")
def sync_paper_vault(pid: str):
    paper = wiki_service.get_paper(pid)
    if not paper:
        return jsonify({"error": "not found"}), 404
    rel = wiki_service.create_obsidian_md(paper)
    if rel:
        db.get_conn().execute(
            "UPDATE papers SET vault_path = ? WHERE id = ?", (rel, pid)
        )
        db.get_conn().commit()
    return jsonify({"ok": True, "vault_path": rel})


@bp.get("/api/wiki/tags")
def get_tags():
    return jsonify(wiki_service.get_all_tags())


@bp.post("/api/wiki/sync-vault")
def sync_vault():
    return jsonify(wiki_service.sync_vault())
