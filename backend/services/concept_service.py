"""LLM-Wiki concept service.

논문(paper) → 개념 문서(concept) 추출·병합 파이프라인.

흐름:
  1. paper 저장 후 extract_from_paper_async(paper_id) 호출
  2. LLM이 llm_analysis에서 핵심 개념 3~5개 추출
  3. 제목 유사도로 기존 concept 검색
     - 매칭 → LLM이 기존 content에 새 기여 내용 병합
     - 없음  → 새 concept 생성
"""

from __future__ import annotations

import json
import logging
import re
import threading
import uuid
from typing import Any

from .. import db
from . import claude_runner, llm_parse

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# CRUD helpers
# ---------------------------------------------------------------------------

def _to_json(v: Any) -> str | None:
    if v is None:
        return None
    if isinstance(v, (list, dict)):
        return json.dumps(v, ensure_ascii=False)
    return v


def _parse_ids(v: Any) -> list[str]:
    if isinstance(v, list):
        return v
    if isinstance(v, str) and v:
        try:
            return json.loads(v)
        except json.JSONDecodeError:
            return []
    return []


def _row_to_concept(row: dict | None) -> dict | None:
    if not row:
        return None
    out = dict(row)
    for k in ("tags", "source_paper_ids"):
        val = out.get(k)
        if isinstance(val, str) and val:
            try:
                out[k] = json.loads(val)
            except json.JSONDecodeError:
                pass
        elif val is None:
            out[k] = []
    return out


def list_concepts() -> list[dict]:
    rows = db.get_conn().execute(
        "SELECT * FROM concepts ORDER BY datetime(updated_at) DESC LIMIT 500"
    ).fetchall()
    return [_row_to_concept(db.row_to_dict(r)) for r in rows]


# ---------------------------------------------------------------------------
# 개념 관계 (지식 그래프)
# ---------------------------------------------------------------------------

def _paper_count(concept: dict) -> int:
    ids = concept.get("source_paper_ids")
    return len(ids) if isinstance(ids, list) else 0


def rebuild_paper_relations() -> int:
    """같은 논문에서 나온 개념끼리 자동 연결 (source='paper').

    빠르고 LLM 비용 없음. 기존 paper 엣지를 모두 지우고 재계산한다.
    """
    conn = db.get_conn()
    concepts = list_concepts()
    # paper_id → [concept_id...]
    by_paper: dict[str, list[str]] = {}
    for c in concepts:
        for pid in (c.get("source_paper_ids") or []):
            by_paper.setdefault(pid, []).append(c["id"])

    # 개념쌍 → 공유 논문 수
    pair_weight: dict[tuple[str, str], int] = {}
    for cids in by_paper.values():
        uniq = sorted(set(cids))
        for i in range(len(uniq)):
            for j in range(i + 1, len(uniq)):
                pair_weight[(uniq[i], uniq[j])] = pair_weight.get((uniq[i], uniq[j]), 0) + 1

    conn.execute("DELETE FROM concept_relations WHERE source = 'paper'")
    now = db.now_iso()
    for (a, b), w in pair_weight.items():
        conn.execute(
            "INSERT OR REPLACE INTO concept_relations"
            "(from_id, to_id, relation_type, source, weight, created_at)"
            " VALUES(?, ?, 'co-occur', 'paper', ?, ?)",
            (a, b, w, now),
        )
    conn.commit()
    return len(pair_weight)


_RELATIONS_PROMPT = """\
다음은 한 연구자의 개념 위키 목록이야. 개념들 사이의 의미적 관계를 찾아줘.
각 관계는 방향이 있고, 아래 유형 중 하나로 분류해:
- method-of: A가 B를 측정/구현하는 방법 (예: PADIT-seq → Lower-affinity sites)
- part-of: A가 B의 하위/구성 요소
- applies-to: A 개념이 B 문제/현상에 적용됨
- contrast: A와 B가 대조적/경쟁적
- related: 그 외 밀접하게 관련

정말 의미 있는 관계만 (개념당 최대 4개). 억지로 만들지 마.
반드시 ```json 블록으로 응답:
```json
{{"edges": [{{"from": "개념 id", "to": "개념 id", "type": "method-of"}}]}}
```

## 개념 목록 (id: title — summary)
{listing}
"""


def rebuild_llm_relations(model: str | None = None) -> int:
    """전체 개념 목록을 LLM 1회 분석 → 의미 관계 엣지 (source='llm')."""
    conn = db.get_conn()
    concepts = list_concepts()
    if len(concepts) < 2:
        return 0
    cfg = db.load_config()
    model = model or (cfg.get("llm") or {}).get("model") or "claude-opus-5"
    valid_ids = {c["id"] for c in concepts}
    listing = "\n".join(
        f"- {c['id']}: {c['title']} — {(c.get('summary') or '')[:80]}" for c in concepts
    )
    raw = _call_llm(_RELATIONS_PROMPT.format(listing=listing), model=model, timeout=120)
    data = llm_parse.extract_json(raw) or {}
    edges = data.get("edges") or []

    conn.execute("DELETE FROM concept_relations WHERE source = 'llm'")
    now = db.now_iso()
    saved = 0
    for e in edges:
        a, b = e.get("from"), e.get("to")
        rtype = e.get("type") or "related"
        if a in valid_ids and b in valid_ids and a != b:
            conn.execute(
                "INSERT OR REPLACE INTO concept_relations"
                "(from_id, to_id, relation_type, source, weight, created_at)"
                " VALUES(?, ?, ?, 'llm', 1, ?)",
                (a, b, rtype, now),
            )
            saved += 1
    conn.commit()
    logger.info("LLM concept relations rebuilt: %d edges", saved)
    return saved


def rebuild_all_relations_async() -> None:
    """논문 관계(즉시) + LLM 관계(백그라운드) 재구성."""
    rebuild_paper_relations()

    def _run():
        try:
            rebuild_llm_relations()
        except Exception:
            logger.exception("rebuild_llm_relations failed")

    threading.Thread(target=_run, daemon=True).start()


def get_related(concept_id: str) -> list[dict]:
    """한 개념의 관련 개념 목록 (양방향, 본문 패널용)."""
    conn = db.get_conn()
    rows = conn.execute(
        "SELECT from_id, to_id, relation_type, source, weight FROM concept_relations"
        " WHERE from_id = ? OR to_id = ?",
        (concept_id, concept_id),
    ).fetchall()
    # 상대 개념 id → 관계 정보 (llm 관계 우선)
    seen: dict[str, dict] = {}
    for r in rows:
        other = r["to_id"] if r["from_id"] == concept_id else r["from_id"]
        directed = r["from_id"] == concept_id
        info = {
            "id": other,
            "relation_type": r["relation_type"],
            "source": r["source"],
            "weight": r["weight"],
            "directed": directed,
        }
        if other not in seen or r["source"] == "llm":
            seen[other] = info
    # 제목 붙이기
    out = []
    for cid, info in seen.items():
        c = get_concept(cid)
        if c:
            info["title"] = c["title"]
            info["summary"] = c.get("summary") or ""
            out.append(info)
    # llm 관계 먼저, 그다음 weight 큰 순
    out.sort(key=lambda x: (x["source"] != "llm", -x["weight"]))
    return out


def get_graph() -> dict:
    """전체 개념 그래프: nodes(논문 수=크기) + edges."""
    concepts = list_concepts()
    nodes = [
        {
            "id": c["id"],
            "title": c["title"],
            "summary": c.get("summary") or "",
            "paper_count": _paper_count(c),
        }
        for c in concepts
    ]
    valid = {c["id"] for c in concepts}
    rows = db.get_conn().execute(
        "SELECT from_id, to_id, relation_type, source, weight FROM concept_relations"
    ).fetchall()
    edges = []
    for r in rows:
        if r["from_id"] in valid and r["to_id"] in valid:
            edges.append({
                "from": r["from_id"],
                "to": r["to_id"],
                "type": r["relation_type"],
                "source": r["source"],
                "weight": r["weight"],
            })
    return {"nodes": nodes, "edges": edges}


def get_concept(concept_id: str) -> dict | None:
    row = db.get_conn().execute(
        "SELECT * FROM concepts WHERE id = ?", (concept_id,)
    ).fetchone()
    return _row_to_concept(db.row_to_dict(row))


def create_concept(title: str, content: str, summary: str = "",
                   tags: list | None = None,
                   source_paper_ids: list | None = None) -> dict:
    cid = uuid.uuid4().hex
    now = db.now_iso()
    row = {
        "id": cid,
        "title": title,
        "summary": summary,
        "content": content,
        "tags": _to_json(tags or []),
        "source_paper_ids": _to_json(source_paper_ids or []),
        "created_at": now,
        "updated_at": now,
    }
    cols = ", ".join(row.keys())
    placeholders = ", ".join(["?"] * len(row))
    db.get_conn().execute(
        f"INSERT INTO concepts({cols}) VALUES({placeholders})", list(row.values())
    )
    db.get_conn().commit()
    return get_concept(cid)


def update_concept(concept_id: str, patch: dict) -> dict | None:
    current = get_concept(concept_id)
    if not current:
        return None
    allowed = {"title", "summary", "content", "tags", "source_paper_ids"}
    sets, params = [], []
    for k, v in patch.items():
        if k not in allowed:
            continue
        if isinstance(v, (list, dict)):
            v = _to_json(v)
        sets.append(f"{k} = ?")
        params.append(v)
    if not sets:
        return current
    sets.append("updated_at = ?")
    params.append(db.now_iso())
    params.append(concept_id)
    db.get_conn().execute(
        f"UPDATE concepts SET {', '.join(sets)} WHERE id = ?", params
    )
    db.get_conn().commit()
    return get_concept(concept_id)


def delete_concept(concept_id: str) -> bool:
    if not get_concept(concept_id):
        return False
    db.get_conn().execute("DELETE FROM concepts WHERE id = ?", (concept_id,))
    db.get_conn().commit()
    return True


# ---------------------------------------------------------------------------
# Title similarity — simple normalisation + substring match
# ---------------------------------------------------------------------------

def _normalise(text: str) -> str:
    text = text.lower().strip()
    text = re.sub(r"[\s\-_/]+", " ", text)
    # strip common Korean/English noise words
    for w in ("the", "a", "an", "of", "in", "for", "and", "관련", "기반", "을위한"):
        text = re.sub(r"\b" + w + r"\b", "", text)
    return text.strip()


def find_similar_concept(title: str, threshold: float = 0.55) -> dict | None:
    """Return the best-matching existing concept, or None."""
    norm_new = _normalise(title)
    if not norm_new:
        return None
    rows = db.get_conn().execute(
        "SELECT id, title FROM concepts"
    ).fetchall()
    best_concept = None
    best_score = 0.0
    for r in rows:
        norm_ex = _normalise(r["title"])
        if not norm_ex:
            continue
        # Jaccard on word sets
        a = set(norm_new.split())
        b = set(norm_ex.split())
        if not a or not b:
            continue
        score = len(a & b) / len(a | b)
        # bonus for substring containment
        if norm_new in norm_ex or norm_ex in norm_new:
            score = max(score, 0.70)
        if score > best_score:
            best_score = score
            best_concept = r
    if best_score >= threshold and best_concept:
        return get_concept(best_concept["id"])
    return None


# ---------------------------------------------------------------------------
# LLM helpers
# ---------------------------------------------------------------------------

_EXTRACT_PROMPT = """\
다음 논문 분석을 읽고, 이 논문이 다루는 핵심 개념 3~5개를 추출해줘.
각 개념은 독립된 연구 개념이어야 해 (예: "DAM", "TREM2 signaling", "microglial heterogeneity").
개념 이름은 영어로, 기여 내용은 한국어로.

반드시 ```json 블록으로 응답:
```json
[
  {{
    "title": "개념명 (영어, 10단어 이내)",
    "summary": "이 개념 한 줄 정의",
    "contribution": "이 논문이 이 개념에 대해 보여준 것 (2~3문장, 한국어)"
  }}
]
```

논문: {title} ({year}, {journal})
분석:
{llm_analysis}
"""

_MERGE_PROMPT = """\
기존 개념 문서에 새 논문의 내용을 자연스럽게 통합해줘.
- 기존 내용의 구조와 흐름을 유지해
- 새로운 관점/결과/방법론은 적절한 위치에 추가
- 중복되는 내용은 합쳐서 간결하게
- 논문 출처는 "(저자 et al., 연도)" 형식으로 인라인 표기
- 마크다운 형식 유지

개념: **{concept_title}**

[기존 내용]
{existing_content}

[새 논문: {paper_title} ({paper_year})]
{new_contribution}

통합된 개념 문서 전체를 마크다운으로:
"""

_MATCH_PROMPT = """\
다음은 새 논문에서 추출한 개념 후보 목록과, 기존 위키의 개념 목록이야.
각 후보가 기존 개념과 같은 연구 개념이면 그 id를, 아니면 null을 매겨줘.
- 표면 단어가 달라도 같은 개념이면 매칭해 (예: "scRNA-seq integration" ≈ "single-cell data harmonization")
- 상위/하위 개념은 다른 개념으로 취급 (예: "microglia" ≠ "disease-associated microglia")
- 확실하지 않으면 null

반드시 ```json 블록으로 응답:
```json
{{"matches": {{"후보 제목": "기존 id 또는 null"}}}}
```

## 개념 후보
{candidates}

## 기존 개념 (id: title — summary)
{existing}
"""


_CREATE_PROMPT = """\
아래 개념에 대한 위키 문서 초안을 마크다운으로 작성해줘.
- 개념 정의 (2~3문장)
- 연구적 의의
- 논문에서의 기여 내용 포함
- 간결하게 (200~400자)

개념: **{concept_title}**
논문: {paper_title} ({paper_year})
논문 기여:
{contribution}

마크다운 문서:
"""


def _call_llm(prompt: str, model: str, timeout: int = 90) -> str:
    return claude_runner.run_oneshot(prompt, model=model, timeout=timeout, max_turns=2)


_FENCE_WRAP_RE = re.compile(r"^\s*```[a-zA-Z]*\s*\n(.*?)\n?\s*```\s*$", re.DOTALL)


def _strip_md_fence(text: str) -> str:
    """LLM이 본문 전체를 ```markdown ... ``` 로 감싼 경우 펜스를 제거.

    개념 본문은 마크다운 그 자체이므로, 통째로 감싼 펜스는 렌더러에서
    코드 블록으로 잘못 표시된다(가로 넘침 + '복사' 버튼). 안쪽만 남긴다.
    """
    if not text:
        return text
    m = _FENCE_WRAP_RE.match(text.strip())
    return m.group(1).strip() if m else text.strip()


def _extract_json_list(raw: str) -> list:
    return llm_parse.extract_json_list(raw) or []


def _match_concepts_llm(candidate_titles: list[str], model: str) -> dict[str, str]:
    """후보 제목 → 기존 concept id 매핑을 LLM 1회 호출로 판정.

    Jaccard 단독 판정은 동의어 개념("integration" vs "harmonization")을
    놓쳐 위키가 파편화되므로, 의미 기반 판정을 우선한다.
    실패 시 빈 dict (호출부에서 Jaccard fallback).
    """
    rows = db.get_conn().execute(
        "SELECT id, title, summary FROM concepts"
    ).fetchall()
    if not rows or not candidate_titles:
        return {}
    existing_listing = "\n".join(
        f"- {r['id']}: {r['title']} — {(r['summary'] or '')[:80]}" for r in rows
    )
    cand_listing = "\n".join(f"- {t}" for t in candidate_titles)
    prompt = _MATCH_PROMPT.format(candidates=cand_listing, existing=existing_listing)
    raw = _call_llm(prompt, model=model)
    data = llm_parse.extract_json(raw) or {}
    matches = data.get("matches") or {}
    valid_ids = {r["id"] for r in rows}
    return {
        k: v for k, v in matches.items()
        if isinstance(v, str) and v in valid_ids
    }


# ---------------------------------------------------------------------------
# Async extraction pipeline
# ---------------------------------------------------------------------------

_extract_locks: dict[str, threading.Lock] = {}


def _set_concept_status(paper_id: str, status: str, error: str | None = None) -> None:
    db.get_conn().execute(
        "UPDATE papers SET concept_status = ?, concept_error = ? WHERE id = ?",
        (status, error, paper_id),
    )
    db.get_conn().commit()


def extract_from_paper_async(paper_id: str) -> None:
    """Kick off background thread: paper → extract concepts → merge/create."""
    lock = _extract_locks.setdefault(paper_id, threading.Lock())
    if lock.locked():
        return
    _set_concept_status(paper_id, "pending")
    t = threading.Thread(target=_run_extraction, args=(paper_id, lock), daemon=True)
    t.start()


def _run_extraction(paper_id: str, lock: threading.Lock) -> None:
    if not lock.acquire(blocking=False):
        return
    created_or_merged = 0
    try:
        from . import wiki_service  # late import to avoid circular
        paper = wiki_service.get_paper(paper_id)
        if not paper or not paper.get("llm_analysis"):
            _set_concept_status(paper_id, "failed", "llm_analysis가 없어 추출할 수 없음")
            return
        _set_concept_status(paper_id, "running")

        cfg = db.load_config()
        model = (cfg.get("llm") or {}).get("model") or "claude-opus-5"

        # Step 1: extract concept candidates
        prompt = _EXTRACT_PROMPT.format(
            title=paper.get("title", ""),
            year=paper.get("year", ""),
            journal=paper.get("journal", ""),
            llm_analysis=(paper.get("llm_analysis") or "")[:4000],
        )
        raw = _call_llm(prompt, model=model)
        candidates = _extract_json_list(raw)
        if not candidates:
            _set_concept_status(paper_id, "failed", "LLM이 개념 후보를 추출하지 못함")
            return

        # 의미 기반 매칭 (LLM 1회) — 실패 시 빈 dict → Jaccard fallback
        valid_titles = [
            (c.get("title") or "").strip()
            for c in candidates[:5]
            if (c.get("title") or "").strip()
        ]
        try:
            llm_matches = _match_concepts_llm(valid_titles, model=model)
        except Exception:
            logger.warning("LLM concept matching failed, falling back to Jaccard", exc_info=True)
            llm_matches = {}

        for cand in candidates[:5]:
            title = (cand.get("title") or "").strip()
            summary = (cand.get("summary") or "").strip()
            contribution = (cand.get("contribution") or "").strip()
            if not title or not contribution:
                continue

            existing = None
            if title in llm_matches:
                existing = get_concept(llm_matches[title])
            if not existing:
                existing = find_similar_concept(title)

            if existing:
                # Merge into existing concept
                merge_prompt = _MERGE_PROMPT.format(
                    concept_title=existing["title"],
                    existing_content=existing.get("content") or "",
                    paper_title=paper.get("title", ""),
                    paper_year=paper.get("year", ""),
                    new_contribution=contribution,
                )
                new_content = _call_llm(merge_prompt, model=model)
                if new_content:
                    ids = list(set(_parse_ids(existing.get("source_paper_ids")) + [paper_id]))
                    update_concept(existing["id"], {
                        "content": _strip_md_fence(new_content),
                        "source_paper_ids": ids,
                    })
                    created_or_merged += 1
            else:
                # Create new concept
                create_prompt = _CREATE_PROMPT.format(
                    concept_title=title,
                    paper_title=paper.get("title", ""),
                    paper_year=paper.get("year", ""),
                    contribution=contribution,
                )
                content = _call_llm(create_prompt, model=model)
                if content:
                    create_concept(
                        title=title,
                        content=_strip_md_fence(content),
                        summary=summary,
                        source_paper_ids=[paper_id],
                    )
                    created_or_merged += 1

        _set_concept_status(paper_id, "done")
        logger.info("concept extraction done: paper=%s, %d concepts", paper_id, created_or_merged)
        # 논문 기반 관계는 즉시 갱신 (저렴). 의미 관계는 사용자가 명시적으로 재구성
        try:
            rebuild_paper_relations()
        except Exception:
            logger.warning("rebuild_paper_relations after extraction failed", exc_info=True)
    except Exception as exc:
        logger.exception("concept extraction failed: paper=%s", paper_id)
        try:
            _set_concept_status(paper_id, "failed", str(exc)[:500])
        except Exception:
            pass
    finally:
        try:
            lock.release()
        except RuntimeError:
            pass
