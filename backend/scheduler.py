"""APScheduler setup — daily digest cron job."""

from __future__ import annotations

import logging
import threading

from . import db
from .services import digest_service

logger = logging.getLogger(__name__)

try:
    from apscheduler.schedulers.background import BackgroundScheduler
    from apscheduler.triggers.cron import CronTrigger
except ImportError:  # pragma: no cover
    BackgroundScheduler = None
    CronTrigger = None

_scheduler = None
_lock = threading.Lock()


def start_scheduler():
    """Boot the BackgroundScheduler with the configured digest cron."""
    global _scheduler
    if BackgroundScheduler is None:
        return None
    with _lock:
        if _scheduler is not None:
            return _scheduler
        cfg = db.load_config().get("digest") or {}
        schedule = (cfg.get("schedule") or "08:00").strip()
        timezone = cfg.get("timezone") or "Asia/Seoul"
        try:
            hour, minute = schedule.split(":")
            hour = int(hour)
            minute = int(minute)
        except (ValueError, AttributeError):
            hour, minute = 8, 0
        try:
            _scheduler = BackgroundScheduler(timezone=timezone)
            _scheduler.add_job(
                _run_digest_job,
                CronTrigger(hour=hour, minute=minute, timezone=timezone),
                id="daily_digest",
                replace_existing=True,
                misfire_grace_time=3600,
            )
            _scheduler.start()
            logger.info("digest scheduler started: %02d:%02d %s", hour, minute, timezone)
        except Exception:
            logger.exception("scheduler start failed")
            _scheduler = None
        return _scheduler


def _run_digest_job():
    try:
        result = digest_service.run_daily_digest(send_telegram=True)
        logger.info("daily digest job finished: %s", result)
    except Exception:
        logger.exception("daily digest job failed")


def reload_schedule():
    """Re-read config.json and reset the cron trigger."""
    if _scheduler is None:
        return False
    cfg = db.load_config().get("digest") or {}
    schedule = (cfg.get("schedule") or "08:00").strip()
    timezone = cfg.get("timezone") or "Asia/Seoul"
    try:
        hour, minute = schedule.split(":")
        hour = int(hour)
        minute = int(minute)
    except (ValueError, AttributeError):
        hour, minute = 8, 0
    try:
        _scheduler.reschedule_job(
            "daily_digest",
            trigger=CronTrigger(hour=hour, minute=minute, timezone=timezone),
        )
        return True
    except Exception:
        return False
