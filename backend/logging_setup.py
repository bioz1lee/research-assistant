"""File logging — data/logs/app.log (rotating)."""

from __future__ import annotations

import logging
import logging.handlers
import os

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOG_DIR = os.path.join(ROOT_DIR, "data", "logs")
LOG_PATH = os.path.join(LOG_DIR, "app.log")

_configured = False


def setup_logging(level: int = logging.INFO) -> None:
    """Attach a rotating file handler to the root logger. Idempotent."""
    global _configured
    if _configured:
        return
    os.makedirs(LOG_DIR, exist_ok=True)

    root = logging.getLogger()
    root.setLevel(level)

    file_handler = logging.handlers.RotatingFileHandler(
        LOG_PATH, maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8"
    )
    file_handler.setFormatter(logging.Formatter(
        "%(asctime)s %(levelname)-7s [%(name)s] %(message)s"
    ))
    root.addHandler(file_handler)

    console = logging.StreamHandler()
    console.setLevel(logging.WARNING)
    console.setFormatter(logging.Formatter("%(levelname)s [%(name)s] %(message)s"))
    root.addHandler(console)

    # Flask/Werkzeug의 요청 로그는 파일에만, 콘솔 스팸 방지
    logging.getLogger("werkzeug").setLevel(logging.WARNING)

    _configured = True
