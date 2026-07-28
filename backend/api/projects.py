"""Projects API blueprint."""

from __future__ import annotations

import json
import os
import uuid

from flask import Blueprint, jsonify, request
from werkzeug.utils import secure_filename

from .. import db

bp = Blueprint("projects", __name__)

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
KNOWLEDGE_ROOT = os.path.join(ROOT_DIR, "data", "knowledge")
os.makedirs(KNOWLEDGE_ROOT, exist_ok=True)


# ---------------------------------------------------------------------------
# Row helpers
# ---------------------------------------------------------------------------

def _row_to_project(row) -> dict | None:
    if row is None:
        return None
    out = db.row_to_dict(row)
    for k in ("knowledge_files", "wiki_tags"):
        v = out.get(k)
        if isinstance(v, str) and v:
            try:
                out[k] = json.loads(v)
            except json.JSONDecodeError:
                pass
        elif v is None:
            out[k] = [] if k == "knowledge_files" or k == "wiki_tags" else v
    out["is_active"] = bool(out.get("is_active"))
    return out


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------

@bp.get("/api/projects")
def list_projects():
    rows = db.get_conn().execute(
        "SELECT * FROM projects ORDER BY datetime(updated_at) DESC"
    ).fetchall()
    return jsonify([_row_to_project(r) for r in rows])


@bp.get("/api/projects/active")
def get_active():
    proj = db.get_active_project()
    if not proj:
        return jsonify(None)
    return jsonify(_row_to_project_dict(proj))


def _row_to_project_dict(d: dict) -> dict:
    out = dict(d)
    for k in ("knowledge_files", "wiki_tags"):
        v = out.get(k)
        if isinstance(v, str) and v:
            try:
                out[k] = json.loads(v)
            except json.JSONDecodeError:
                pass
        elif v is None:
            out[k] = []
    out["is_active"] = bool(out.get("is_active"))
    return out


@bp.get("/api/projects/<pid>")
def get_project(pid: str):
    row = db.get_conn().execute("SELECT * FROM projects WHERE id = ?", (pid,)).fetchone()
    if not row:
        return jsonify({"error": "not found"}), 404
    return jsonify(_row_to_project(row))


@bp.post("/api/projects")
def create_project():
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name is required"}), 400
    pid = uuid.uuid4().hex
    now = db.now_iso()
    db.get_conn().execute(
        "INSERT INTO projects(id, name, description, system_prompt, knowledge_files,"
        " wiki_tags, is_active, color, created_at, updated_at)"
        " VALUES(?, ?, ?, ?, ?, ?, 0, ?, ?, ?)",
        (
            pid,
            name,
            data.get("description") or "",
            data.get("system_prompt") or "",
            json.dumps(data.get("knowledge_files") or [], ensure_ascii=False),
            json.dumps(data.get("wiki_tags") or [], ensure_ascii=False),
            data.get("color") or "#9b77d9",
            now,
            now,
        ),
    )
    db.get_conn().commit()
    row = db.get_conn().execute("SELECT * FROM projects WHERE id = ?", (pid,)).fetchone()
    return jsonify(_row_to_project(row)), 201


@bp.put("/api/projects/<pid>")
def update_project(pid: str):
    data = request.get_json(silent=True) or {}
    allowed = {"name", "description", "system_prompt", "knowledge_files", "wiki_tags", "color"}
    sets = []
    params: list = []
    for k, v in data.items():
        if k not in allowed:
            continue
        if isinstance(v, (list, dict)):
            v = json.dumps(v, ensure_ascii=False)
        sets.append(f"{k} = ?")
        params.append(v)
    if not sets:
        return jsonify({"error": "no fields to update"}), 400
    sets.append("updated_at = ?")
    params.append(db.now_iso())
    params.append(pid)
    db.get_conn().execute(f"UPDATE projects SET {', '.join(sets)} WHERE id = ?", params)
    db.get_conn().commit()
    row = db.get_conn().execute("SELECT * FROM projects WHERE id = ?", (pid,)).fetchone()
    if not row:
        return jsonify({"error": "not found"}), 404
    return jsonify(_row_to_project(row))


@bp.delete("/api/projects/<pid>")
def delete_project(pid: str):
    db.get_conn().execute("DELETE FROM projects WHERE id = ?", (pid,))
    db.get_conn().commit()
    return jsonify({"ok": True})


@bp.post("/api/projects/<pid>/activate")
def activate_project(pid: str):
    conn = db.get_conn()
    row = conn.execute("SELECT id FROM projects WHERE id = ?", (pid,)).fetchone()
    if not row:
        return jsonify({"error": "not found"}), 404
    conn.execute("UPDATE projects SET is_active = 0")
    conn.execute(
        "UPDATE projects SET is_active = 1, updated_at = ? WHERE id = ?",
        (db.now_iso(), pid),
    )
    conn.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Knowledge files
# ---------------------------------------------------------------------------

@bp.post("/api/projects/<pid>/knowledge")
def upload_knowledge(pid: str):
    conn = db.get_conn()
    row = conn.execute("SELECT * FROM projects WHERE id = ?", (pid,)).fetchone()
    if not row:
        return jsonify({"error": "project not found"}), 404

    file_type = request.form.get("type", "core")
    if file_type not in ("core", "reference"):
        file_type = "core"

    if "file" not in request.files:
        return jsonify({"error": "file field is required"}), 400
    f = request.files["file"]
    if not f.filename:
        return jsonify({"error": "filename missing"}), 400

    project_dir = os.path.join(KNOWLEDGE_ROOT, pid)
    os.makedirs(project_dir, exist_ok=True)
    safe = secure_filename(f.filename) or f"{uuid.uuid4().hex}.bin"
    save_path = os.path.join(project_dir, safe)
    try:
        f.save(save_path)
    except OSError as exc:
        return jsonify({"error": str(exc)}), 500

    try:
        files = json.loads(row["knowledge_files"] or "[]")
    except (TypeError, json.JSONDecodeError):
        files = []
    # Replace existing entry with same filename
    files = [x for x in files if x.get("filename") != safe]
    entry = {"path": save_path, "filename": safe, "type": file_type}
    files.append(entry)
    conn.execute(
        "UPDATE projects SET knowledge_files = ?, updated_at = ? WHERE id = ?",
        (json.dumps(files, ensure_ascii=False), db.now_iso(), pid),
    )
    conn.commit()
    return jsonify(entry), 201


@bp.delete("/api/projects/<pid>/knowledge/<path:filename>")
def delete_knowledge(pid: str, filename: str):
    # 업로드 시 secure_filename으로 저장되므로 경로 구분자가 올 수 없다
    if "/" in filename or "\\" in filename or ".." in filename:
        return jsonify({"error": "invalid filename"}), 400
    conn = db.get_conn()
    row = conn.execute("SELECT knowledge_files FROM projects WHERE id = ?", (pid,)).fetchone()
    if not row:
        return jsonify({"error": "not found"}), 404
    try:
        files = json.loads(row["knowledge_files"] or "[]")
    except (TypeError, json.JSONDecodeError):
        files = []
    new_files = []
    removed_path = None
    for f in files:
        if f.get("filename") == filename:
            removed_path = f.get("path")
            continue
        new_files.append(f)
    if removed_path and os.path.isfile(removed_path) and removed_path.startswith(KNOWLEDGE_ROOT):
        try:
            os.remove(removed_path)
        except OSError:
            pass
    conn.execute(
        "UPDATE projects SET knowledge_files = ?, updated_at = ? WHERE id = ?",
        (json.dumps(new_files, ensure_ascii=False), db.now_iso(), pid),
    )
    conn.commit()
    return jsonify({"ok": True})
