"""SQLite connection, schema bootstrap, config helpers."""

from __future__ import annotations

import datetime
import json
import os
import sqlite3
import threading
from typing import Any, Iterable

# ---------------------------------------------------------------------------
# Path constants
# ---------------------------------------------------------------------------

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT_DIR, "data")
DB_PATH = os.path.join(DATA_DIR, "app.db")
MIGRATIONS_DIR = os.path.join(ROOT_DIR, "migrations")

os.makedirs(DATA_DIR, exist_ok=True)

# Connection pool is per-thread via threading.local
_local = threading.local()
_init_lock = threading.Lock()
_initialized = False


# ---------------------------------------------------------------------------
# Connection helpers
# ---------------------------------------------------------------------------

def get_conn() -> sqlite3.Connection:
    """Return a thread-local connection with WAL mode + Row factory."""
    conn = getattr(_local, "conn", None)
    if conn is None:
        conn = sqlite3.connect(DB_PATH, timeout=30, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        # PRAGMAs per connection
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA foreign_keys=ON")
        _local.conn = conn
    return conn


# ---------------------------------------------------------------------------
# Schema initialization
# ---------------------------------------------------------------------------

def init_db() -> None:
    """Apply pending migrations/*.sql in filename order. Idempotent.

    Applied migrations are recorded in meta as 'migration:<filename>'.
    (001 is itself idempotent via IF NOT EXISTS, so first-time recording
    on an existing DB is safe.)
    """
    global _initialized
    with _init_lock:
        if _initialized:
            return
        os.makedirs(DATA_DIR, exist_ok=True)
        conn = get_conn()
        # meta 테이블은 마이그레이션 추적 자체에 필요하므로 먼저 보장
        conn.execute(
            "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
        )
        if os.path.isdir(MIGRATIONS_DIR):
            for fname in sorted(os.listdir(MIGRATIONS_DIR)):
                if not fname.endswith(".sql"):
                    continue
                key = f"migration:{fname}"
                row = conn.execute(
                    "SELECT 1 FROM meta WHERE key = ?", (key,)
                ).fetchone()
                if row:
                    continue
                with open(os.path.join(MIGRATIONS_DIR, fname), "r", encoding="utf-8") as f:
                    conn.executescript(f.read())
                conn.execute(
                    "INSERT INTO meta(key, value) VALUES(?, ?)", (key, now_iso())
                )
                conn.commit()
        _initialized = True


# ---------------------------------------------------------------------------
# Meta key/value helpers
# ---------------------------------------------------------------------------

def get_meta(key: str) -> str | None:
    row = get_conn().execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def set_meta(key: str, value: str) -> None:
    conn = get_conn()
    conn.execute(
        "INSERT INTO meta(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )
    conn.commit()


# ---------------------------------------------------------------------------
# Row helpers
# ---------------------------------------------------------------------------

def row_to_dict(row: sqlite3.Row | None) -> dict | None:
    if row is None:
        return None
    return {k: row[k] for k in row.keys()}


def rows_to_dicts(rows: Iterable[sqlite3.Row]) -> list[dict]:
    return [row_to_dict(r) for r in rows]


def now_iso() -> str:
    return datetime.datetime.now().isoformat()


# ---------------------------------------------------------------------------
# Project helpers (used by claude_runner + projects API)
# ---------------------------------------------------------------------------

def get_project(project_id: str) -> dict | None:
    row = get_conn().execute(
        "SELECT * FROM projects WHERE id = ?", (project_id,)
    ).fetchone()
    return row_to_dict(row)


def get_active_project() -> dict | None:
    row = get_conn().execute(
        "SELECT * FROM projects WHERE is_active = 1 LIMIT 1"
    ).fetchone()
    return row_to_dict(row)


def get_all_paper_dois() -> set[str]:
    rows = get_conn().execute(
        "SELECT doi FROM papers WHERE doi IS NOT NULL AND doi != ''"
    ).fetchall()
    return {r["doi"] for r in rows}


# ---------------------------------------------------------------------------
# Config file helpers (config.json)
# ---------------------------------------------------------------------------

CONFIG_PATH = os.path.join(ROOT_DIR, "config.json")


def load_config() -> dict:
    if not os.path.isfile(CONFIG_PATH):
        return {}
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_config(cfg: dict) -> None:
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


def update_config(patch: dict) -> dict:
    """Deep-merge top-level keys (one level deep is enough for our schema)."""
    cfg = load_config()
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(cfg.get(key), dict):
            cfg[key] = {**cfg[key], **value}
        else:
            cfg[key] = value
    save_config(cfg)
    return cfg
