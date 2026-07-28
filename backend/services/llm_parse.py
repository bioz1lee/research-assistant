"""LLM 출력에서 JSON을 견고하게 추출하는 공용 헬퍼.

정규식 단독 추출은 중첩 중괄호/문자열 내 괄호에서 깨지므로,
json.JSONDecoder.raw_decode 로 첫 JSON 값을 정확히 파싱한다.
"""

from __future__ import annotations

import json
import logging
import re

logger = logging.getLogger(__name__)

_FENCE_RE = re.compile(r"```(?:json)?\s*\n?(.*?)```", re.DOTALL)


def _raw_decode_from(text: str, open_chars: str) -> object | None:
    """text 안에서 open_chars 중 하나로 시작하는 첫 JSON 값을 디코드."""
    decoder = json.JSONDecoder()
    for i, ch in enumerate(text):
        if ch not in open_chars:
            continue
        try:
            value, _ = decoder.raw_decode(text[i:])
            return value
        except json.JSONDecodeError:
            continue
    return None


def extract_json(raw: str | None) -> dict | None:
    """LLM 응답에서 첫 JSON object를 추출. 실패 시 None + 로그."""
    if not raw:
        return None
    # 1차: 코드펜스 내부 우선
    for m in _FENCE_RE.finditer(raw):
        value = _raw_decode_from(m.group(1), "{")
        if isinstance(value, dict):
            return value
    # 2차: 전체 텍스트 스캔
    value = _raw_decode_from(raw, "{")
    if isinstance(value, dict):
        return value
    logger.warning("extract_json failed; raw head=%r", raw[:200])
    return None


def extract_json_list(raw: str | None) -> list | None:
    """LLM 응답에서 첫 JSON array를 추출. 실패 시 None + 로그."""
    if not raw:
        return None
    for m in _FENCE_RE.finditer(raw):
        value = _raw_decode_from(m.group(1), "[")
        if isinstance(value, list):
            return value
    value = _raw_decode_from(raw, "[")
    if isinstance(value, list):
        return value
    logger.warning("extract_json_list failed; raw head=%r", raw[:200])
    return None
