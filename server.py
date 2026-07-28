#!/usr/bin/env python3
"""Local Research Assistant — Flask entry point.

Boots the Flask application, registers Blueprints, applies SQLite migrations,
runs the conversations.json → SQLite migration once, starts APScheduler, and
(if configured) launches the Telegram polling thread.
"""

from __future__ import annotations

import os
import shutil
import signal
import sys

from flask import Flask, jsonify, request, send_from_directory

# ---------------------------------------------------------------------------
# Path constants
# ---------------------------------------------------------------------------

ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(ROOT_DIR, "static")
UPLOAD_DIR = os.path.join(ROOT_DIR, "uploads")

os.makedirs(STATIC_DIR, exist_ok=True)
os.makedirs(UPLOAD_DIR, exist_ok=True)


def _load_dotenv() -> None:
    """ROOT_DIR/.env 의 KEY=VALUE 를 환경변수로 로드 (이미 설정된 값은 유지)."""
    env_path = os.path.join(ROOT_DIR, ".env")
    if not os.path.isfile(env_path):
        return
    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key, value = key.strip(), value.strip().strip('"').strip("'")
            if key and value:
                os.environ.setdefault(key, value)


def _bootstrap_config() -> None:
    """최초 실행 시 config.example.json → config.json 복사.

    config.json 은 개인 설정(vault 경로, 텔레그램 chat_id)이라 git에 올라가지
    않는다. 새로 clone 한 환경에서는 파일이 없으므로 템플릿에서 만들어 준다.
    """
    config_path = os.path.join(ROOT_DIR, "config.json")
    example_path = os.path.join(ROOT_DIR, "config.example.json")
    if os.path.isfile(config_path) or not os.path.isfile(example_path):
        return
    shutil.copyfile(example_path, config_path)
    print("  config.json 을 config.example.json 에서 생성했습니다. Settings 탭에서 설정하세요.")

# ---------------------------------------------------------------------------
# Flask app factory
# ---------------------------------------------------------------------------

def create_app() -> Flask:
    _load_dotenv()
    _bootstrap_config()
    from backend.logging_setup import setup_logging
    setup_logging()

    app = Flask(__name__, static_folder=STATIC_DIR, static_url_path="/static")
    app.config["MAX_CONTENT_LENGTH"] = 256 * 1024 * 1024  # 256MB upload cap
    # Local single-user app: don't let the browser serve stale JS/CSS after edits.
    # max_age=0 still uses conditional GET (304), so only changed files re-download.
    app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0

    # CORS — local-only, but allow same-origin tools without surprises
    try:
        from flask_cors import CORS
        CORS(app, resources={r"/api/*": {"origins": "*"}})
    except ImportError:
        pass

    # --- DB init + migrations ------------------------------------------------
    from backend import db
    db.init_db()

    # --- Blueprints ----------------------------------------------------------
    from backend.api import chat as chat_api
    from backend.api import wiki as wiki_api
    from backend.api import concepts as concepts_api
    from backend.api import projects as projects_api
    from backend.api import digest as digest_api
    from backend.api import settings as settings_api
    from backend.api import telegram_hook as telegram_api
    from backend.api import search as search_api

    app.register_blueprint(chat_api.bp)
    app.register_blueprint(search_api.bp)
    app.register_blueprint(wiki_api.bp)
    app.register_blueprint(concepts_api.bp)
    app.register_blueprint(projects_api.bp)
    app.register_blueprint(digest_api.bp)
    app.register_blueprint(settings_api.bp)
    app.register_blueprint(telegram_api.bp)

    # --- Root / static fallback ---------------------------------------------
    @app.get("/")
    def index():
        index_path = os.path.join(STATIC_DIR, "index.html")
        if os.path.isfile(index_path):
            return send_from_directory(STATIC_DIR, "index.html")
        return (
            "<h1>Local Research Assistant</h1>"
            "<p>Frontend assets not yet built. Place static/index.html.</p>"
        ), 200

    @app.get("/index.html")
    def index_html():
        return index()

    # Serve uploads/ as a public-ish directory (localhost only anyway)
    @app.get("/uploads/<path:filename>")
    def serve_upload(filename: str):
        return send_from_directory(UPLOAD_DIR, filename)

    # General file upload helper (used by Chat attach + project knowledge picker)
    @app.post("/api/upload")
    def upload():
        import uuid
        if "file" not in request.files:
            return jsonify({"error": "file field is required"}), 400
        f = request.files["file"]
        if not f.filename:
            return jsonify({"error": "filename missing"}), 400
        ext = os.path.splitext(f.filename)[1]
        safe = f"{uuid.uuid4().hex}{ext}"
        save_path = os.path.join(UPLOAD_DIR, safe)
        try:
            f.save(save_path)
        except OSError as exc:
            return jsonify({"error": str(exc)}), 500
        return jsonify({
            "file_path": save_path,
            "filename": f.filename,
            "url": f"/uploads/{safe}",
            "type": f.mimetype,
            "size": os.path.getsize(save_path),
        })

    # Local file fetch (legacy: PDFs referenced by absolute path)
    # Supports Range requests so PDF.js can load pages efficiently.
    # 임의 경로 노출을 막기 위해 허용 디렉토리 화이트리스트로 제한한다.
    def _allowed_local_roots() -> list[str]:
        roots = [UPLOAD_DIR, os.path.join(ROOT_DIR, "data")]
        vault = (db.load_config().get("vault_path") or "").strip()
        if vault:
            roots.append(os.path.expanduser(vault))
        return [os.path.realpath(r) for r in roots]

    @app.get("/api/local")
    def local_file():
        path = request.args.get("path")
        if not path or not os.path.isfile(path):
            return jsonify({"error": "not found"}), 404
        real = os.path.realpath(path)
        if not any(
            real == root or real.startswith(root + os.sep)
            for root in _allowed_local_roots()
        ):
            return jsonify({"error": "path not allowed"}), 403
        return send_from_directory(os.path.dirname(real), os.path.basename(real))

    # --- Scheduler + Telegram polling ---------------------------------------
    from backend import scheduler
    try:
        scheduler.start_scheduler()
    except Exception as exc:
        print(f"[scheduler] warning: {exc}", file=sys.stderr)

    from backend.services import telegram_service
    if telegram_service.is_enabled():
        try:
            started = telegram_service.start_polling()
            if started:
                print("[telegram] polling started")
        except Exception as exc:
            print(f"[telegram] warning: {exc}", file=sys.stderr)
    else:
        print("[telegram] disabled (configure token + chat_id in config.json)")

    # Health check
    @app.get("/healthz")
    def healthz():
        return jsonify({"ok": True})

    return app


# ---------------------------------------------------------------------------
# CLI entry
# ---------------------------------------------------------------------------

def main():
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8321"))
    app = create_app()
    print(f"\n  Local Research Assistant: http://{host}:{port}\n")
    print("  localhost only / Ctrl+C to stop\n")

    def _shutdown(sig, frame):
        print("\n  Shutting down…")
        sys.exit(0)

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)
    # Disable Flask reloader so APScheduler / Telegram threads stay singular
    app.run(host=host, port=port, threaded=True, use_reloader=False, debug=False)


if __name__ == "__main__":
    main()
