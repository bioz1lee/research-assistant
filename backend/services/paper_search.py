"""PubMed E-utilities + bioRxiv REST API search helpers.

Most of the PubMed logic is ported from the legacy `/Users/jiwonlee/claude-web-ui/server.py`
implementation.  The bioRxiv portion is new.
"""

from __future__ import annotations

import datetime
import json
import logging
import os
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

logger = logging.getLogger(__name__)

_PREDATORY_PUBLISHERS = frozenset([
    "omics group", "omics international", "omics publishing group",
    "scientific research publishing", "scirp",
    "iomcworld", "waset",
    "world academy of science engineering and technology",
])

USER_AGENT = "research-assistant/1.0"


# ---------------------------------------------------------------------------
# PubMed
# ---------------------------------------------------------------------------

def search_pubmed(
    keywords: list[str] | str,
    days: int = 7,
    max_results: int = 20,
    include_abstract: bool = True,
) -> list[dict]:
    """Search PubMed for the given keyword(s) within the last `days` days.

    For multiple keywords, returns the union (deduplicated by PMID).
    """
    if isinstance(keywords, str):
        keywords = [keywords]
    seen = set()
    out: list[dict] = []
    for kw in keywords:
        try:
            results = _pubmed_search_single(kw, days=days, max_results=max_results, include_abstract=include_abstract)
        except Exception:
            logger.warning("pubmed search failed for keyword %r", kw, exc_info=True)
            results = []
        for paper in results:
            key = paper.get("pmid") or paper.get("doi") or paper.get("title")
            if not key or key in seen:
                continue
            seen.add(key)
            paper["matched_keyword"] = kw
            out.append(paper)
    return out


def _pubmed_search_single(
    query: str,
    days: int = 7,
    max_results: int = 20,
    include_abstract: bool = True,
) -> list[dict]:
    ncbi_key = os.environ.get("NCBI_API_KEY", "")
    search_params = {
        "db": "pubmed",
        "term": query,
        "retmax": str(max_results),
        "retmode": "json",
        "sort": "date",
    }
    if days and days > 0:
        today = datetime.date.today()
        from_date = today - datetime.timedelta(days=days)
        search_params["datetype"] = "pdat"
        search_params["mindate"] = from_date.strftime("%Y/%m/%d")
        search_params["maxdate"] = today.strftime("%Y/%m/%d")
    if ncbi_key:
        search_params["api_key"] = ncbi_key

    search_url = (
        "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?"
        + urllib.parse.urlencode(search_params)
    )
    req = urllib.request.Request(search_url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    pmids = data.get("esearchresult", {}).get("idlist", [])
    if not pmids:
        return []

    time.sleep(0.35)  # respect 3 req/s rate limit
    fetch_params = {
        "db": "pubmed",
        "id": ",".join(pmids),
        "retmode": "xml",
        "rettype": "abstract",
    }
    if ncbi_key:
        fetch_params["api_key"] = ncbi_key
    fetch_url = (
        "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?"
        + urllib.parse.urlencode(fetch_params)
    )
    req2 = urllib.request.Request(fetch_url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req2, timeout=20) as resp2:
        xml_data = resp2.read().decode("utf-8")

    root = ET.fromstring(xml_data)
    papers: list[dict] = []
    for article in root.findall(".//PubmedArticle"):
        medline = article.find("MedlineCitation")
        if medline is None:
            continue
        art = medline.find("Article")
        if art is None:
            continue

        title_el = art.find("ArticleTitle")
        title = "".join(title_el.itertext()).strip() if title_el is not None else ""

        journal = art.findtext("Journal/Title", "") or ""
        year = (
            art.findtext("Journal/JournalIssue/PubDate/Year")
            or art.findtext("Journal/JournalIssue/PubDate/MedlineDate", "")[:4]
        )

        authors: list[str] = []
        affiliation = ""
        for i, author in enumerate(art.findall("AuthorList/Author")):
            last = author.findtext("LastName", "")
            fore = author.findtext("ForeName", "")
            if last:
                initials = f" {fore[0]}." if fore else ""
                authors.append(f"{last}{initials}")
            if i == 0 and not affiliation:
                aff_el = author.find("AffiliationInfo/Affiliation")
                if aff_el is not None:
                    affiliation = "".join(aff_el.itertext()).strip()

        doi = None
        for id_el in article.findall(".//ArticleId"):
            if id_el.get("IdType") == "doi":
                doi = id_el.text
                break

        pmid = medline.findtext("PMID", "")

        abstract = ""
        if include_abstract:
            parts = []
            for ab in art.findall(".//AbstractText"):
                label = ab.get("Label")
                text = "".join(ab.itertext()).strip()
                if label and text:
                    parts.append(f"{label}: {text}")
                elif text:
                    parts.append(text)
            abstract = " ".join(parts)

        journal_lower = journal.lower()
        if any(kw in journal_lower for kw in _PREDATORY_PUBLISHERS):
            continue

        # year parsing — fallback to int if possible
        year_int = None
        if year:
            try:
                year_int = int(str(year)[:4])
            except ValueError:
                year_int = None

        papers.append({
            "source": "pubmed",
            "pmid": pmid,
            "title": title,
            "authors": authors,
            "affiliation": affiliation[:150] if affiliation else "",
            "journal": journal,
            "year": year_int,
            "doi": doi,
            "abstract": abstract,
            "url": f"https://doi.org/{doi}" if doi else f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/",
            "is_preprint": False,
        })
    return papers


# ---------------------------------------------------------------------------
# DOI → PubMed metadata (Wiki auto-fill)
# ---------------------------------------------------------------------------

def get_paper_metadata_from_doi(doi: str) -> dict | None:
    """Resolve metadata for a DOI via PubMed (esearch by doi[AID]).

    Returns a single normalized paper dict or None when not found.
    """
    if not doi:
        return None
    doi = doi.strip()
    try:
        search_params = {
            "db": "pubmed",
            "term": f"{doi}[AID]",
            "retmax": "1",
            "retmode": "json",
        }
        ncbi_key = os.environ.get("NCBI_API_KEY", "")
        if ncbi_key:
            search_params["api_key"] = ncbi_key
        url = (
            "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?"
            + urllib.parse.urlencode(search_params)
        )
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        ids = data.get("esearchresult", {}).get("idlist", [])
        if not ids:
            # Try Crossref as a fallback for DOIs not in PubMed (preprints, etc.)
            return _crossref_metadata(doi)
        papers = _pubmed_search_single(f"{doi}[AID]", days=0, max_results=1)
        if papers:
            paper = papers[0]
            paper["doi"] = paper.get("doi") or doi
            return paper
    except Exception:
        pass
    return _crossref_metadata(doi)


def _crossref_metadata(doi: str) -> dict | None:
    try:
        encoded = urllib.parse.quote(doi, safe="")
        url = f"https://api.crossref.org/works/{encoded}?mailto=research-assistant@local"
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8")).get("message", {})
        title = (data.get("title") or [""])[0]
        authors = []
        for a in data.get("author", []):
            last = a.get("family", "")
            given = a.get("given", "")
            initials = f" {given[0]}." if given else ""
            if last:
                authors.append(f"{last}{initials}")
        year = None
        for key in ("published-print", "published-online", "issued"):
            parts = data.get(key, {}).get("date-parts") or []
            if parts and parts[0]:
                try:
                    year = int(parts[0][0])
                    break
                except (ValueError, IndexError):
                    pass
        journal = (data.get("container-title") or [""])[0]
        abstract = data.get("abstract", "") or ""
        # Crossref abstracts include JATS xml — strip tags crudely
        if abstract:
            import re
            abstract = re.sub(r"<[^>]+>", "", abstract).strip()
        return {
            "source": "crossref",
            "doi": doi,
            "title": title,
            "authors": authors,
            "year": year,
            "journal": journal,
            "abstract": abstract,
            "pmid": "",
            "url": f"https://doi.org/{doi}",
            "is_preprint": "biorxiv" in (journal or "").lower(),
        }
    except Exception:
        return None


# ---------------------------------------------------------------------------
# bioRxiv
# ---------------------------------------------------------------------------

def search_biorxiv(
    keywords: list[str] | str,
    days: int = 7,
    max_results: int = 20,
) -> list[dict]:
    """bioRxiv details API filtered by keyword (title+abstract substring)."""
    if isinstance(keywords, str):
        keywords = [keywords]
    today = datetime.date.today()
    date_from = today - datetime.timedelta(days=days)
    interval = f"{date_from.strftime('%Y-%m-%d')}/{today.strftime('%Y-%m-%d')}"

    # bioRxiv details endpoint paginates by 100 records.
    # 7일치는 1000건을 훌쩍 넘으므로 (하루 200건+) 안전 상한까지 끝까지 페이징한다.
    raw: list[dict] = []
    cursor = 0
    total = 0
    max_records = 2000
    while len(raw) < max_records:
        url = f"https://api.biorxiv.org/details/biorxiv/{interval}/{cursor}/json"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=20) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except Exception:
            logger.warning("biorxiv page fetch failed at cursor=%d", cursor, exc_info=True)
            break
        collection = data.get("collection") or []
        if not collection:
            break
        raw.extend(collection)
        # pagination signals
        msg = data.get("messages", [{}])[0] if isinstance(data.get("messages"), list) else {}
        total = int(msg.get("total", 0) or 0)
        cursor += len(collection)
        if cursor >= total:
            break
    if total and len(raw) < total:
        logger.info("biorxiv: scanned %d of %d records in %s (cap)", len(raw), total, interval)

    # Filter by keyword
    kw_lower = [k.lower() for k in keywords]
    results: list[dict] = []
    seen_dois = set()
    for entry in raw:
        title = entry.get("title", "") or ""
        abstract = entry.get("abstract", "") or ""
        haystack = f"{title}\n{abstract}".lower()
        matched = next((k for k in kw_lower if k in haystack), None)
        if not matched:
            continue
        doi = entry.get("doi") or ""
        if doi in seen_dois:
            continue
        seen_dois.add(doi)
        authors_str = entry.get("authors", "")
        authors = [a.strip() for a in authors_str.split(";") if a.strip()]
        try:
            year_int = int(str(entry.get("date", ""))[:4])
        except ValueError:
            year_int = None
        results.append({
            "source": "biorxiv",
            "biorxiv_id": doi,  # bioRxiv DOI doubles as id
            "doi": doi,
            "pmid": "",
            "title": title,
            "authors": authors,
            "affiliation": entry.get("author_corresponding_institution", ""),
            "journal": "bioRxiv",
            "year": year_int,
            "abstract": abstract,
            "url": f"https://www.biorxiv.org/content/{doi}v1",
            "is_preprint": True,
            "matched_keyword": matched,
            "category": entry.get("category", ""),
        })
        if len(results) >= max_results:
            break
    return results
