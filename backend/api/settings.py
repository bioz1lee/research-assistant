"""Settings API blueprint — read/write config.json."""

from __future__ import annotations

from flask import Blueprint, jsonify, request

from .. import db, scheduler
from ..services import telegram_service

bp = Blueprint("settings", __name__)


@bp.get("/api/settings")
def get_settings():
    cfg = db.load_config()
    # Token is never sent to the client — env var TELEGRAM_BOT_TOKEN is the source
    safe = dict(cfg)
    tg = dict(safe.get("telegram") or {})
    tg.pop("token", None)
    tg["token_set"] = bool(telegram_service.get_token())
    safe["telegram"] = tg
    return jsonify(safe)


@bp.put("/api/settings")
def update_settings():
    data = request.get_json(silent=True) or {}
    cfg = db.load_config()
    # Apply top-level patches with one-level deep merge for known dicts
    for key, value in data.items():
        if isinstance(value, dict) and isinstance(cfg.get(key), dict):
            merged = dict(cfg[key])
            for k, v in value.items():
                # token은 config.json에 저장하지 않음 (.env로 관리)
                if key == "telegram" and k in ("token", "token_set"):
                    continue
                merged[k] = v
            cfg[key] = merged
        else:
            cfg[key] = value
    db.save_config(cfg)
    # Re-apply scheduler if digest section changed
    if "digest" in data:
        scheduler.reload_schedule()
    return jsonify({"ok": True})
