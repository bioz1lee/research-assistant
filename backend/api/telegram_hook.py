"""Telegram-related API blueprint."""

from __future__ import annotations

from flask import Blueprint, jsonify

from ..services import telegram_service

bp = Blueprint("telegram_hook", __name__)


@bp.get("/api/telegram/status")
def status():
    return jsonify(telegram_service.get_status())


@bp.post("/api/telegram/test")
def test_message():
    result = telegram_service.send_test()
    status_code = 200 if result.get("ok") else 400
    return jsonify(result), status_code


@bp.post("/api/telegram/start")
def start():
    """Re-initialize the bot and resume polling (after settings change)."""
    started = telegram_service.start_polling()
    return jsonify({"ok": True, "polling": started, "status": telegram_service.get_status()})
