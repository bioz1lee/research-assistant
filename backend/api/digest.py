"""Digest API blueprint."""

from __future__ import annotations

from flask import Blueprint, Response, jsonify, request, stream_with_context

from .. import db, scheduler
from ..services import digest_service

bp = Blueprint("digest", __name__)


@bp.get("/api/digest")
def list_digests():
    limit = int(request.args.get("limit", 30))
    return jsonify(digest_service.list_digests(limit=limit))


@bp.get("/api/digest/<did>")
def get_digest(did: str):
    entry = digest_service.get_digest(did)
    if not entry:
        return jsonify({"error": "not found"}), 404
    return jsonify(entry)


@bp.post("/api/digest/run")
def run_digest():
    """Manual trigger: runs the same pipeline as the cron job but streams progress."""
    gen = digest_service.run_daily_digest_stream()
    return Response(
        stream_with_context(gen),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@bp.get("/api/digest/settings")
def get_settings():
    cfg = db.load_config().get("digest") or {}
    return jsonify(cfg)


@bp.put("/api/digest/settings")
def update_settings():
    data = request.get_json(silent=True) or {}
    cfg = db.load_config()
    digest_cfg = dict(cfg.get("digest") or {})
    for key in ("schedule", "timezone", "keywords", "sources", "max_results_per_keyword"):
        if key in data:
            digest_cfg[key] = data[key]
    cfg["digest"] = digest_cfg
    db.save_config(cfg)
    # Reload schedule cron
    scheduler.reload_schedule()
    return jsonify({"ok": True, "digest": digest_cfg})
