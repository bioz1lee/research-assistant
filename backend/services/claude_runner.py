"""Claude CLI subprocess runner with SSE streaming.

This module mirrors the legacy `/Users/jiwonlee/claude-web-ui/server.py` behavior:
spawn `claude -p --output-format stream-json --verbose ...`, parse line-delimited
JSON events from stdout, and yield SSE-formatted strings for Flask
`stream_with_context`.

Public surface:
    - run_chat(message, session_id, cwd, model, system_prompt, project_id, ...)
        Generator yielding SSE strings ("data: {...}\n\n").
    - run_paper_study(pdf_path, session_id, cwd)
        Convenience wrapper applying the Paper Study prompt template.
    - run_oneshot(prompt, model, timeout)
        Synchronous call returning the trimmed stdout. Used by services
        (wiki enrichment, digest selection, title generation, etc.).
    - active_procs / abort_session(session_id)
"""

from __future__ import annotations

import logging

import json
import os
import select
import shutil
import subprocess
import threading
import uuid
from typing import Generator, Iterable

from .. import db

# ---------------------------------------------------------------------------
# claude CLI 경로 해석
# ---------------------------------------------------------------------------
# GUI(.app/Dock)로 서버를 띄우면 셸 PATH를 상속받지 못해 `claude`가 PATH에서
# 안 잡힌다("claude CLI not found"). PATH 우선으로 찾되, 없으면 알려진 설치
# 위치를 직접 탐색한다.

def _resolve_claude_bin() -> str:
    found = shutil.which("claude")
    if found:
        return found
    candidates = [
        os.path.expanduser("~/.local/bin/claude"),
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude",
    ]
    for c in candidates:
        if os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    return "claude"  # 최후의 수단 — PATH에 맡긴다


CLAUDE_BIN = _resolve_claude_bin()

# ---------------------------------------------------------------------------
# Active process tracking (used by /api/abort)
# ---------------------------------------------------------------------------

logger = logging.getLogger(__name__)

active_procs: dict[str, subprocess.Popen] = {}
active_procs_lock = threading.Lock()


def abort_session(session_id: str) -> bool:
    with active_procs_lock:
        proc = active_procs.pop(session_id, None)
    if proc and proc.poll() is None:
        try:
            proc.terminate()
        except Exception:
            return False
        return True
    return False


# ---------------------------------------------------------------------------
# Context building (project_id → system prompt + core knowledge files)
# ---------------------------------------------------------------------------

def _read_truncated(path: str, max_chars: int) -> str:
    if not path or not os.path.isfile(path):
        return ""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            text = f.read(max_chars + 1)
    except OSError:
        return ""
    if len(text) > max_chars:
        return text[:max_chars] + "\n…(truncated)"
    return text


def build_project_context(project_id: str | None) -> str:
    """Return a system-prompt string that includes the project's prompt + any
    core knowledge files concatenated below it.  Empty string if no project."""
    if not project_id:
        return ""
    project = db.get_project(project_id)
    if not project:
        return ""
    cfg = db.load_config()
    max_chars = int(((cfg.get("llm") or {}).get("knowledge_file_max_chars")) or 8000)
    parts: list[str] = []
    if project.get("system_prompt"):
        parts.append(project["system_prompt"].strip())
    try:
        files = json.loads(project.get("knowledge_files") or "[]")
    except json.JSONDecodeError:
        files = []
    for f in files:
        if not isinstance(f, dict):
            continue
        if f.get("type") != "core":
            continue
        path = f.get("path") or ""
        filename = f.get("filename") or os.path.basename(path) or path
        body = _read_truncated(path, max_chars=max_chars)
        if not body:
            continue
        parts.append(f"\n---\n파일: {filename}\n{body}")
    return "\n".join(parts).strip()


# ---------------------------------------------------------------------------
# Paper Study prompt
# ---------------------------------------------------------------------------

PAPER_STUDY_PROMPT = (
    "첨부된 PDF는 학술 논문이야. 아래 포맷을 정확히 따라 한국어로 분석해줘. 구구절절 쓰지 마.\n\n"
    "## 메타데이터\n"
    "PAPER_TITLE: [논문 제목 원문 — 영어 그대로]\n"
    "DOI: [DOI 또는 N/A]\n"
    "AUTHORS: [제1저자, 제2저자, ... (3명 이상이면 et al.)]\n"
    "YEAR: [출판연도]\n"
    "JOURNAL: [저널명]\n"
    "TAGS: [method:xxx, cell:xxx, organism:xxx, tissue:xxx — 쉼표 구분, 해당 항목만]\n\n"
    "---\n\n"
    "## 1) 배경 Context (2-3줄)\n"
    "이 연구가 왜 중요한지, 기존 연구 landscape에서 어떤 gap을 메우는지.\n\n"
    "## 2) 요약 5줄\n"
    "- **What:** 이 논문이 뭔지 한 줄\n"
    "- **How:** 핵심 방법론 한 줄\n"
    "- **Key Result:** 가장 중요한 결과 한 줄 (수치 포함)\n"
    "- **So What:** 이 결과가 왜 중요한지 한 줄\n"
    "- **Limitation:** 핵심 한계 한 줄\n\n"
    "## 3) Story Flow\n"
    "Fig1→Fig2→...→한줄결론 형태로.\n\n"
    "## 4) Figure 표 (main figures만)\n"
    "|Panel|보여주는 것(10단어↓)|핵심결과(1문장)|읽는 법(뭘 봐야 하는지 한 줄)|\n"
    "|---|---|---|---|\n"
    "Main figure(Fig 1, 2, 3…)만 포함. Extended Data Figure 제외.\n"
    "Panel 컬럼은 반드시 숫자로 시작 (예: 1a, 2b, 3). Fig/Figure 접두어 없이.\n\n"
    "## 5) Technical Glossary\n"
    "| Term (English) | 한줄 설명 |\n"
    "|---|---|\n"
    "전문 용어는 반드시 영어 원문으로 표기.\n\n"
    "## 6) Limitation 심화 (3-4가지)\n\n"
    "## 7) 실용 포인트\n"
    "\"내 연구에 어떻게 쓸 수 있나?\" 관점에서 3가지.\n"
)


# ---------------------------------------------------------------------------
# Core: subprocess + SSE generator
# ---------------------------------------------------------------------------

def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"


def run_chat(
    message: str,
    *,
    session_id: str | None = None,
    cwd: str | None = None,
    model: str | None = None,
    system_prompt: str | None = None,
    project_id: str | None = None,
    files: list[dict] | None = None,
    is_paper_study: bool = False,
    extra_env: dict | None = None,
    max_turns: int | None = None,
    permission_mode: str | None = None,
) -> Generator[str, None, None]:
    """Yield SSE strings from a streaming Claude CLI invocation.

    Persists user + assistant messages into chat_messages once stream finishes.

    permission_mode="plan" 이면 안전모드: claude가 계획만 세우고 파일 변경·실행은
    하지 않는다. 그 외(None/default)에는 기존처럼 권한 확인 없이 전부 실행한다.
    """
    if not cwd:
        cwd = os.path.expanduser("~")

    # Inject project context (if any) into system_prompt
    project_system = build_project_context(project_id)
    if project_system:
        if system_prompt:
            system_prompt = f"{project_system}\n\n---\n{system_prompt}"
        else:
            system_prompt = project_system

    # Append file references to message body (preserves legacy behavior)
    if files:
        file_parts: list[str] = []
        for f in files:
            fpath = (f or {}).get("path", "")
            ftype = (f or {}).get("type", "")
            if not fpath or not os.path.isfile(fpath):
                continue
            if ftype.startswith("image/"):
                file_parts.append(f"[첨부 이미지: {fpath}] 이 이미지 파일을 읽어서 확인해주세요.")
            else:
                file_parts.append(f"이 파일을 참고해주세요: {fpath}")
        if file_parts:
            message = message + "\n\n" + "\n".join(file_parts)

    cmd = [
        CLAUDE_BIN,
        "-p",
        "--output-format", "stream-json",
        "--verbose",
    ]
    if permission_mode == "plan":
        cmd += ["--permission-mode", "plan"]
    else:
        cmd += ["--dangerously-skip-permissions"]
    if model:
        cmd += ["--model", model]
    if max_turns is not None:
        cmd += ["--max-turns", str(max_turns)]
    if system_prompt:
        cmd += ["--system-prompt", system_prompt]
    if session_id:
        cmd += ["--resume", session_id]

    proc_key = session_id or f"pending-{uuid.uuid4().hex[:8]}"
    final_session_id: str | None = session_id
    assistant_text_parts: list[str] = []

    try:
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            cwd=cwd,
        )
    except FileNotFoundError as exc:
        yield _sse({"type": "error", "error": f"claude CLI not found: {exc}"})
        return
    except Exception as exc:
        yield _sse({"type": "error", "error": str(exc)})
        return

    with active_procs_lock:
        active_procs[proc_key] = proc

    try:
        proc.stdin.write(message)
        proc.stdin.close()
    except BrokenPipeError:
        pass

    try:
        while True:
            # Wait up to 20 s for output; send a keepalive comment so the browser
            # doesn't close the connection while Claude is processing a large PDF.
            try:
                ready, _, _ = select.select([proc.stdout], [], [], 10)
            except (ValueError, OSError):
                break
            if ready:
                line = proc.stdout.readline()
                if not line:
                    break  # EOF
                line = line.strip()
                if not line:
                    continue
            else:
                # Nothing in 20 s — process might still be running
                if proc.poll() is not None:
                    break
                yield ": keepalive\n\n"
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            etype = event.get("type", "")

            if etype == "system" and event.get("subtype") == "init":
                new_sid = event.get("session_id", "")
                if new_sid and new_sid != proc_key:
                    with active_procs_lock:
                        active_procs.pop(proc_key, None)
                        active_procs[new_sid] = proc
                        proc_key = new_sid
                final_session_id = new_sid or final_session_id
                yield _sse({
                    "type": "init",
                    "session_id": new_sid,
                    "model": event.get("model", ""),
                    "cwd": event.get("cwd", ""),
                })

            elif etype == "assistant" and "message" in event:
                msg = event["message"]
                sid = event.get("session_id", "") or final_session_id
                for block in msg.get("content", []):
                    if block.get("type") == "text":
                        yield _sse({"type": "text", "text": block["text"]})
                        assistant_text_parts.append(block["text"])
                    elif block.get("type") == "tool_use":
                        yield _sse({
                            "type": "tool_use",
                            "tool": block.get("name", ""),
                            "input": block.get("input", {}),
                            "id": block.get("id", ""),
                        })
                if sid:
                    final_session_id = sid
                    yield _sse({"type": "session_id", "session_id": sid})

            elif etype == "user":
                msg = event.get("message", {})
                for block in msg.get("content", []):
                    if isinstance(block, dict) and block.get("type") == "tool_result":
                        content = block.get("content", "")
                        text = ""
                        if isinstance(content, list):
                            for c in content:
                                if isinstance(c, dict) and c.get("type") == "text":
                                    text += c.get("text", "")
                        elif isinstance(content, str):
                            text = content
                        yield _sse({
                            "type": "tool_result",
                            "tool_use_id": block.get("tool_use_id", ""),
                            "content": text[:2000],
                            "is_error": block.get("is_error", False),
                        })

            elif etype == "result":
                text = event.get("result", "")
                usage = event.get("usage", {})
                result_sid = event.get("session_id", "") or final_session_id
                final_session_id = result_sid
                yield _sse({
                    "type": "result",
                    "text": text,
                    "session_id": result_sid,
                    "input_tokens": usage.get("input_tokens", 0),
                    "cache_read_tokens": usage.get("cache_read_input_tokens", 0),
                    "cache_creation_tokens": usage.get("cache_creation_input_tokens", 0),
                    "output_tokens": usage.get("output_tokens", 0),
                    "cost_usd": round(event.get("total_cost_usd", 0), 4),
                    "duration_ms": event.get("duration_ms", 0),
                    "num_turns": event.get("num_turns", 1),
                })

        proc.wait()
    except BrokenPipeError:
        pass
    except Exception as exc:
        yield _sse({"type": "error", "error": str(exc)})
    finally:
        stderr_out = ""
        try:
            stderr_out = (proc.stderr.read() or "").strip()
        except Exception:
            pass
        if stderr_out:
            logger.warning("claude stderr: %s", stderr_out[:500])
        with active_procs_lock:
            active_procs.pop(proc_key, None)

    # Persist messages to SQLite
    try:
        _persist_messages(final_session_id, message, "".join(assistant_text_parts), project_id, is_paper_study)
    except Exception:
        pass

    # Background: auto-generate title for brand-new conversations
    if not session_id and final_session_id and assistant_text_parts:
        threading.Thread(
            target=_generate_title_async,
            args=(final_session_id, message, "".join(assistant_text_parts)),
            daemon=True,
        ).start()

    yield _sse({"type": "done"})


def _persist_messages(
    session_id: str | None,
    user_message: str,
    assistant_text: str,
    project_id: str | None,
    is_paper_study: bool,
) -> None:
    if not session_id:
        return
    conn = db.get_conn()
    now = db.now_iso()
    # Ensure session row
    existing = conn.execute(
        "SELECT title FROM chat_sessions WHERE session_id = ?", (session_id,)
    ).fetchone()
    title_fallback = (user_message or "새 대화").splitlines()[0][:50] or "새 대화"
    if existing is None:
        conn.execute(
            "INSERT INTO chat_sessions(session_id, title, project_id, created_at, updated_at)"
            " VALUES(?, ?, ?, ?, ?)",
            (session_id, title_fallback, project_id, now, now),
        )
    else:
        conn.execute(
            "UPDATE chat_sessions SET updated_at = ?, project_id = COALESCE(?, project_id)"
            " WHERE session_id = ?",
            (now, project_id, session_id),
        )
    if user_message:
        conn.execute(
            "INSERT INTO chat_messages(id, session_id, role, content, pdf_url, created_at)"
            " VALUES(?, ?, 'user', ?, NULL, ?)",
            (uuid.uuid4().hex, session_id, user_message, now),
        )
    if assistant_text:
        conn.execute(
            "INSERT INTO chat_messages(id, session_id, role, content, pdf_url, created_at)"
            " VALUES(?, ?, 'assistant', ?, NULL, ?)",
            (uuid.uuid4().hex, session_id, assistant_text, now),
        )
    conn.commit()


# ---------------------------------------------------------------------------
# Paper Study convenience wrapper
# ---------------------------------------------------------------------------

def run_paper_study(
    pdf_path: str,
    *,
    session_id: str | None = None,
    cwd: str | None = None,
    model: str | None = None,
) -> Generator[str, None, None]:
    """Stream a Paper Study analysis for the given PDF file."""
    if not pdf_path or not os.path.isfile(pdf_path):
        yield _sse({"type": "error", "error": f"PDF not found: {pdf_path}"})
        return
    # Paper Study 화면은 모델을 따로 보내지 않으므로 config의 기본 모델을 사용한다.
    if not model:
        model = (db.load_config().get("llm") or {}).get("model") or None
    message = (
        f"{PAPER_STUDY_PROMPT}\n\n"
        f"분석할 논문 PDF 경로: {pdf_path}\n"
        f"이 파일을 읽어서 위 포맷을 정확히 따라 한국어로 분석해줘."
    )
    yield from run_chat(
        message,
        session_id=session_id,
        cwd=cwd,
        model=model,
        is_paper_study=True,
        max_turns=5,
    )


# ---------------------------------------------------------------------------
# One-shot synchronous helper (services use this)
# ---------------------------------------------------------------------------

def run_oneshot(prompt: str, model: str | None = None, timeout: int = 60, max_turns: int = 1) -> str:
    """Synchronously call `claude -p` and return trimmed stdout. Empty on failure."""
    cmd = [CLAUDE_BIN, "-p", "--max-turns", str(max_turns)]
    if model:
        cmd += ["--model", model]
    try:
        result = subprocess.run(
            cmd,
            input=prompt,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return ""
    if result.returncode != 0:
        return ""
    return (result.stdout or "").strip()


# ---------------------------------------------------------------------------
# One-shot with session support (used by Telegram chat)
# ---------------------------------------------------------------------------

def run_oneshot_with_session(
    prompt: str,
    session_id: str | None = None,
    model: str | None = None,
    timeout: int = 120,
) -> tuple[str, str | None]:
    """Run Claude with optional session resumption. Returns (response_text, new_session_id)."""
    cmd = [
        CLAUDE_BIN, "-p",
        "--output-format", "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
        "--max-turns", "1",
    ]
    if model:
        cmd += ["--model", model]
    if session_id:
        cmd += ["--resume", session_id]

    try:
        proc = subprocess.run(
            cmd,
            input=prompt,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return "", session_id

    if proc.returncode != 0:
        return "", session_id

    response_text = ""
    new_session_id = session_id

    for line in (proc.stdout or "").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        etype = event.get("type", "")
        if etype == "system" and event.get("subtype") == "init":
            new_session_id = event.get("session_id") or new_session_id
        elif etype == "result":
            response_text = event.get("result", "")
            result_sid = event.get("session_id")
            if result_sid:
                new_session_id = result_sid

    return response_text.strip(), new_session_id


# ---------------------------------------------------------------------------
# Background title generation
# ---------------------------------------------------------------------------

def _generate_title_async(session_id: str, user_message: str, assistant_response: str) -> None:
    try:
        prompt = (
            "아래 대화를 보고, 이 대화의 핵심 주제를 한국어로 30자 이내의 짧은 제목 한 줄로 요약해줘. "
            "제목만 출력하고 다른 설명은 붙이지 마.\n\n"
            f"사용자: {(user_message or '')[:500]}\n\n"
            f"응답: {(assistant_response or '')[:500]}"
        )
        title = run_oneshot(prompt, model="claude-haiku-4-5", timeout=15, max_turns=1)
        title = (title or "").splitlines()[0].strip()
        if not title or len(title) > 60:
            return
        conn = db.get_conn()
        conn.execute(
            "UPDATE chat_sessions SET title = ? WHERE session_id = ?",
            (title, session_id),
        )
        conn.commit()
    except Exception:
        pass
