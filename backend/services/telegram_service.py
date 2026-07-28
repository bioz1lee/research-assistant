"""Telegram bot — polling, callback handlers, digest delivery."""

from __future__ import annotations

import json
import logging
import os
import threading

from .. import db

logger = logging.getLogger(__name__)

try:
    import telebot
    from telebot import types as tg_types
except ImportError:  # pragma: no cover — runtime guard
    telebot = None
    tg_types = None

_bot = None
_bot_lock = threading.Lock()
_polling_thread: threading.Thread | None = None

_SESSION_TIMEOUT = 1800  # 30분
_tg_session_id: str | None = None
_tg_last_active: float = 0.0
_session_lock = threading.Lock()


def _get_session() -> str | None:
    import time
    global _tg_session_id, _tg_last_active
    with _session_lock:
        if _tg_session_id and (time.time() - _tg_last_active) > _SESSION_TIMEOUT:
            _tg_session_id = None
        return _tg_session_id


def _update_session(session_id: str | None) -> None:
    import time
    global _tg_session_id, _tg_last_active
    with _session_lock:
        _tg_session_id = session_id
        _tg_last_active = time.time()


def reset_session() -> None:
    global _tg_session_id, _tg_last_active
    with _session_lock:
        _tg_session_id = None
        _tg_last_active = 0.0


# ---------------------------------------------------------------------------
# Digest feedback (saved / later / skipped) — 선별 개인화의 학습 데이터
# ---------------------------------------------------------------------------

def record_feedback(digest_id: str, index: int, action: str) -> None:
    import uuid
    paper = _resolve_digest_paper(digest_id, index)
    if not paper:
        return
    row = db.get_conn().execute(
        "SELECT keywords FROM digest_entries WHERE id = ?", (digest_id,)
    ).fetchone()
    keywords = row["keywords"] if row else None
    db.get_conn().execute(
        "INSERT INTO digest_feedback(id, digest_id, paper_doi, paper_title, paper_json, action, keywords, created_at)"
        " VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
        (
            uuid.uuid4().hex,
            digest_id,
            paper.get("doi") or "",
            paper.get("title") or "",
            json.dumps(paper, ensure_ascii=False),
            action,
            keywords,
            db.now_iso(),
        ),
    )
    db.get_conn().commit()
    logger.info("digest feedback: %s — %s", action, (paper.get("title") or "")[:60])


# ---------------------------------------------------------------------------
# Bot lifecycle
# ---------------------------------------------------------------------------

def get_bot():
    return _bot


def get_token() -> str:
    """토큰은 환경변수 TELEGRAM_BOT_TOKEN 우선, config.json은 레거시 fallback."""
    return (
        os.environ.get("TELEGRAM_BOT_TOKEN")
        or (db.load_config().get("telegram") or {}).get("token", "")
        or ""
    )


def is_enabled() -> bool:
    cfg = db.load_config().get("telegram") or {}
    return bool(cfg.get("enabled") and get_token())


def init_bot(token: str | None = None):
    """Initialize the singleton TeleBot. Returns the bot or None."""
    global _bot
    if telebot is None:
        return None
    with _bot_lock:
        if _bot is not None:
            return _bot
        if not token:
            token = get_token()
        if not token:
            return None
        _bot = telebot.TeleBot(token, threaded=True)
        _register_handlers(_bot)
        return _bot


def _register_handlers(bot) -> None:
    @bot.callback_query_handler(func=lambda call: (call.data or "").startswith("add_wiki:"))
    def handle_add_wiki(call):
        logger.info("add_wiki callback: %s", call.data)

        # 즉시 응답 — 30초 타임아웃 전에 spinner 해제
        try:
            bot.answer_callback_query(call.id, "")
        except Exception:
            logger.warning("answer_callback_query failed", exc_info=True)

        try:
            _, digest_id, index = (call.data or "").split(":", 2)
        except ValueError:
            bot.send_message(call.message.chat.id, "❌ 잘못된 요청입니다.")
            return

        from . import wiki_service  # local import to avoid cycle
        paper = _resolve_digest_paper(digest_id, int(index))
        if not paper:
            bot.send_message(call.message.chat.id, "❌ 논문 정보를 찾을 수 없습니다.")
            return

        def _save():
            try:
                saved = wiki_service.add_paper(paper, source="telegram")
                _mark_digest_paper_added(digest_id, int(index))
                try:
                    record_feedback(digest_id, int(index), "saved")
                except Exception:
                    logger.warning("feedback record failed (saved)", exc_info=True)
                if saved and saved.get("id"):
                    wiki_service.enrich_paper_async(saved["id"])
                title = (paper.get("title") or "")[:60]
                bot.send_message(call.message.chat.id, f"✅ Wiki에 저장됨\n{title}")
                try:
                    bot.edit_message_reply_markup(
                        chat_id=call.message.chat.id,
                        message_id=call.message.message_id,
                        reply_markup=_done_keyboard(),
                    )
                except Exception:
                    pass
            except Exception as exc:
                logger.exception("add_wiki save failed")
                bot.send_message(call.message.chat.id, f"❌ 저장 실패: {exc}")

        threading.Thread(target=_save, daemon=True).start()

    @bot.callback_query_handler(func=lambda call: (call.data or "").startswith("skip:"))
    def handle_skip(call):
        try:
            bot.answer_callback_query(call.id, "건너뛰었습니다. (취향에 반영돼요)")
        except Exception:
            pass
        try:
            _, digest_id, index = (call.data or "").split(":", 2)
            record_feedback(digest_id, int(index), "skipped")
        except Exception:
            logger.warning("feedback record failed (skipped)", exc_info=True)

    @bot.callback_query_handler(func=lambda call: (call.data or "").startswith("later:"))
    def handle_later(call):
        try:
            bot.answer_callback_query(call.id, "내일 digest에서 다시 보여드릴게요.")
        except Exception:
            pass
        try:
            _, digest_id, index = (call.data or "").split(":", 2)
            record_feedback(digest_id, int(index), "later")
        except Exception:
            logger.warning("feedback record failed (later)", exc_info=True)

    @bot.message_handler(commands=["start", "help"])
    def handle_start(message):
        bot.reply_to(
            message,
            "Local Research Assistant 봇입니다.\n"
            "메시지를 보내면 Claude가 대화 맥락을 유지하며 답합니다.\n\n"
            "/new — 대화 맥락 초기화\n"
            "/test — 연결 확인\n\n"
            "30분 이상 대화가 없으면 자동으로 새 대화가 시작됩니다.",
        )

    @bot.message_handler(commands=["test"])
    def handle_test(message):
        bot.reply_to(message, "✅ 봇이 정상적으로 동작 중입니다.")

    @bot.message_handler(commands=["new"])
    def handle_new(message):
        reset_session()
        bot.reply_to(message, "🔄 새 대화를 시작합니다.")

    @bot.message_handler(func=lambda m: m.content_type == "text" and not (m.text or "").startswith("/"))
    def handle_chat(message):
        cfg_chat_id = str((db.load_config().get("telegram") or {}).get("chat_id", ""))
        if cfg_chat_id and str(message.chat.id) != cfg_chat_id:
            return

        def _respond():
            thinking = bot.reply_to(message, "⏳ 생각 중...")
            try:
                from . import claude_runner
                current_session = _get_session()
                model = (db.load_config().get("llm") or {}).get("model") or None
                response, new_session = claude_runner.run_oneshot_with_session(
                    message.text, session_id=current_session, model=model, timeout=120
                )
                _update_session(new_session)
                reply = response or "(응답 없음)"
            except Exception as exc:
                reply = f"오류: {exc}"
            chunks = [reply[i:i + 4096] for i in range(0, len(reply), 4096)]
            try:
                bot.edit_message_text(chunks[0], chat_id=message.chat.id, message_id=thinking.message_id)
            except Exception:
                bot.send_message(message.chat.id, chunks[0])
            for chunk in chunks[1:]:
                bot.send_message(message.chat.id, chunk)

        threading.Thread(target=_respond, daemon=True).start()


# ---------------------------------------------------------------------------
# Polling
# ---------------------------------------------------------------------------

def start_polling() -> bool:
    """Start infinity_polling in a daemon thread. Returns True on success."""
    global _polling_thread
    if not is_enabled():
        return False
    bot = init_bot()
    if bot is None:
        return False
    if _polling_thread and _polling_thread.is_alive():
        return True

    def _run():
        try:
            bot.infinity_polling(timeout=30, long_polling_timeout=30)
        except Exception:
            logger.exception("telegram polling crashed")

    _polling_thread = threading.Thread(target=_run, daemon=True)
    _polling_thread.start()
    return True


# ---------------------------------------------------------------------------
# Message sending
# ---------------------------------------------------------------------------

def send_test() -> dict:
    bot = init_bot()
    if bot is None:
        return {"ok": False, "error": "Bot not initialized (token missing or telebot not installed)"}
    chat_id = (db.load_config().get("telegram") or {}).get("chat_id")
    if not chat_id:
        return {"ok": False, "error": "chat_id is not configured"}
    try:
        bot.send_message(chat_id, "✅ 테스트 메시지: Local Research Assistant 연결 성공")
        return {"ok": True}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def send_digest(digest_entry: dict) -> dict:
    """Send a digest entry to the configured chat_id. Returns telegram_msg_id on success."""
    bot = init_bot()
    if bot is None:
        return {"ok": False, "error": "Bot not initialized"}
    chat_id = (db.load_config().get("telegram") or {}).get("chat_id")
    if not chat_id:
        return {"ok": False, "error": "chat_id is not configured"}

    papers = digest_entry.get("papers") or []
    if isinstance(papers, str):
        try:
            papers = json.loads(papers)
        except json.JSONDecodeError:
            papers = []
    date = digest_entry.get("date") or ""

    sent_msg_ids: list[int] = []
    header = f"오늘의 논문 다이제스트 ({date})"
    try:
        m = bot.send_message(chat_id, header)
        sent_msg_ids.append(m.message_id)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}

    for idx, p in enumerate(papers, start=1):
        text = _format_paper_message(idx, p)
        keyboard = _paper_keyboard(digest_entry.get("id"), idx - 1)
        try:
            m = bot.send_message(chat_id, text, reply_markup=keyboard, disable_web_page_preview=False)
            sent_msg_ids.append(m.message_id)
        except Exception:
            continue

    highlight = digest_entry.get("highlight") or ""
    if highlight:
        try:
            bot.send_message(chat_id, f"오늘의 하이라이트: {highlight}")
        except Exception:
            pass

    return {"ok": True, "message_ids": sent_msg_ids}


def _format_paper_message(idx: int, p: dict) -> str:
    preprint = "[PREPRINT] " if p.get("is_preprint") else ""
    journal = p.get("journal") or ("biorxiv" if p.get("is_preprint") else "")
    year = p.get("year") or ""
    title = p.get("title", "")
    authors = p.get("authors") or []
    if isinstance(authors, list) and authors:
        first_author = authors[0]
    elif isinstance(authors, str):
        first_author = authors.split(",")[0]
    else:
        first_author = ""
    summary = p.get("summary") or p.get("one_liner") or ""
    method = p.get("method") or ""
    cell = p.get("cell_types") or ""
    if isinstance(cell, list):
        cell = ", ".join(cell)
    organism = p.get("organism") or ""
    doi = p.get("doi") or ""
    url = p.get("url") or (f"https://doi.org/{doi}" if doi else "")
    geo = p.get("geo_accession") or ""
    github = p.get("github_url") or ""

    revisit = "🔁 다시 보기  " if p.get("revisit") else ""
    lines = [
        f"{revisit}#{idx}  {preprint}{journal} · {year}",
        "",
        title,
        f"{first_author} et al." if first_author else "",
        "",
    ]
    if summary:
        lines.append(f"한 줄 요지: {summary}")
        lines.append("")
    meta_bits = []
    if method:
        meta_bits.append(f"방법: {method}")
    if organism or cell:
        target = ", ".join(x for x in [organism, cell] if x)
        if target:
            meta_bits.append(f"대상: {target}")
    if meta_bits:
        lines.append(" | ".join(meta_bits))
    if geo:
        lines.append(f"GEO: {geo}")
    if github:
        lines.append(f"코드: {github}")
    if url:
        lines.append(url)
    return "\n".join(l for l in lines if l is not None)


def _paper_keyboard(digest_id: str | None, index: int):
    if tg_types is None or digest_id is None:
        return None
    kb = tg_types.InlineKeyboardMarkup()
    kb.row(
        tg_types.InlineKeyboardButton("저장", callback_data=f"add_wiki:{digest_id}:{index}"),
        tg_types.InlineKeyboardButton("나중에", callback_data=f"later:{digest_id}:{index}"),
        tg_types.InlineKeyboardButton("건너뛰기", callback_data=f"skip:{digest_id}:{index}"),
    )
    return kb


def _done_keyboard():
    if tg_types is None:
        return None
    kb = tg_types.InlineKeyboardMarkup()
    kb.row(tg_types.InlineKeyboardButton("✅ 저장됨", callback_data="noop"))
    return kb


# ---------------------------------------------------------------------------
# Digest paper resolution
# ---------------------------------------------------------------------------

def _resolve_digest_paper(digest_id: str, index: int) -> dict | None:
    row = db.get_conn().execute(
        "SELECT papers FROM digest_entries WHERE id = ?", (digest_id,)
    ).fetchone()
    if not row:
        return None
    try:
        papers = json.loads(row["papers"] or "[]")
    except json.JSONDecodeError:
        return None
    if 0 <= index < len(papers):
        return papers[index]
    return None


def _mark_digest_paper_added(digest_id: str, index: int) -> None:
    row = db.get_conn().execute(
        "SELECT papers FROM digest_entries WHERE id = ?", (digest_id,)
    ).fetchone()
    if not row:
        return
    try:
        papers = json.loads(row["papers"] or "[]")
    except json.JSONDecodeError:
        return
    if 0 <= index < len(papers):
        papers[index]["wiki_added"] = True
        db.get_conn().execute(
            "UPDATE digest_entries SET papers = ? WHERE id = ?",
            (json.dumps(papers, ensure_ascii=False), digest_id),
        )
        db.get_conn().commit()


# ---------------------------------------------------------------------------
# Status
# ---------------------------------------------------------------------------

def get_status() -> dict:
    cfg = (db.load_config().get("telegram") or {})
    return {
        "enabled": bool(cfg.get("enabled")),
        "token_set": bool(get_token()),
        "chat_id": cfg.get("chat_id") or "",
        "connected": _bot is not None,
        "polling": bool(_polling_thread and _polling_thread.is_alive()),
        "telebot_installed": telebot is not None,
    }
