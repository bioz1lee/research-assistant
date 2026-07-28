"""Concepts API blueprint — LLM-Wiki 개념 문서 CRUD."""

from __future__ import annotations

from flask import Blueprint, jsonify, request

from .. import db
from ..services import concept_service, wiki_service

bp = Blueprint("concepts", __name__)


@bp.get("/api/wiki/concepts")
def list_concepts():
    return jsonify(concept_service.list_concepts())


@bp.get("/api/wiki/concepts/graph")
def concept_graph():
    return jsonify(concept_service.get_graph())


@bp.post("/api/wiki/concepts/relations/rebuild")
def rebuild_relations():
    """논문 관계(즉시) + LLM 의미 관계(백그라운드) 재구성."""
    paper_edges = concept_service.rebuild_paper_relations()
    concept_service.rebuild_all_relations_async()
    return jsonify({"ok": True, "paper_edges": paper_edges, "llm": "started"})


@bp.get("/api/wiki/concepts/<cid>")
def get_concept(cid: str):
    c = concept_service.get_concept(cid)
    if not c:
        return jsonify({"error": "not found"}), 404
    c["related"] = concept_service.get_related(cid)
    return jsonify(c)


@bp.post("/api/wiki/concepts")
def create_concept():
    data = request.get_json(silent=True) or {}
    title = (data.get("title") or "").strip()
    if not title:
        return jsonify({"error": "title is required"}), 400
    c = concept_service.create_concept(
        title=title,
        content=data.get("content") or "",
        summary=data.get("summary") or "",
        tags=data.get("tags") or [],
        source_paper_ids=data.get("source_paper_ids") or [],
    )
    return jsonify(c), 201


@bp.put("/api/wiki/concepts/<cid>")
def update_concept(cid: str):
    data = request.get_json(silent=True) or {}
    c = concept_service.update_concept(cid, data)
    if not c:
        return jsonify({"error": "not found"}), 404
    return jsonify(c)


@bp.delete("/api/wiki/concepts/<cid>")
def delete_concept(cid: str):
    ok = concept_service.delete_concept(cid)
    if not ok:
        return jsonify({"error": "not found"}), 404
    return jsonify({"ok": True})


@bp.post("/api/wiki/papers/<pid>/extract-concepts")
def extract_concepts(pid: str):
    paper = wiki_service.get_paper(pid)
    if not paper:
        return jsonify({"error": "paper not found"}), 404
    if not paper.get("llm_analysis"):
        return jsonify({"error": "llm_analysis가 없어요. 먼저 Paper Study로 분석하세요."}), 400
    concept_service.extract_from_paper_async(pid)
    return jsonify({"ok": True, "message": "개념 추출 시작됨 (백그라운드)"})


@bp.post("/api/wiki/concepts/backfill")
def backfill_concepts():
    """분석은 있는데 개념 추출이 안 된(none/failed) 논문을 일괄 추출."""
    rows = db.get_conn().execute(
        "SELECT id FROM papers"
        " WHERE llm_analysis IS NOT NULL AND llm_analysis != ''"
        " AND (concept_status IS NULL OR concept_status IN ('none', 'failed'))"
    ).fetchall()
    started = 0
    for r in rows:
        concept_service.extract_from_paper_async(r["id"])
        started += 1
    return jsonify({"ok": True, "started": started})
