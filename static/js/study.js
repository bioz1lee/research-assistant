/* ========================================================================
   study.js — Paper Study 화면 (PDF 분석 + Wiki 저장)
   ======================================================================== */

(function () {
  const $ = (id) => document.getElementById(id);

  let currentFile = null; // {path, url, filename, size, type, isLocal}
  let studyHistory = []; // [{id, filename, created_at, result}]
  let currentResult = ""; // analysis text
  let currentSessionId = null;
  let analyzing = false;

  const PAPER_STUDY_PROMPT = `첨부 논문을 분석해줘. 아래 포맷을 정확히 따라. 구구절절 쓰지 마.

## 1) 배경 Context (2-3줄)
이 연구가 왜 중요한지, 기존 연구 landscape에서 어떤 gap을 메우는지 간결하게.

## 2) 요약 5줄
- **What:** 이 논문이 뭔지 한 줄
- **How:** 핵심 방법론 한 줄
- **Key Result:** 가장 중요한 결과 한 줄 (수치 포함)
- **So What:** 이 결과가 왜 중요한지 한 줄
- **Limitation:** 핵심 한계 한 줄

## 3) Story Flow
Fig1→Fig2→...→한줄결론 형태로.

## 4) Figure 표 (main figures만)
|Panel|보여주는 것(10단어↓)|핵심결과(1문장)|읽는 법(뭘 봐야 하는지 한 줄)|

## 5) 전문용어 Glossary
|용어|한줄 설명|

## 6) Limitation 심화 (3-4가지)

## 7) 실용 포인트
"내 연구에 어떻게 쓸 수 있나?" 관점에서 3가지.`;

  async function init() {
    bindEvents();
    await loadHistory();
    renderHistory();
  }

  function bindEvents() {
    const dropArea = $("study-drop-area");
    const fileInput = $("study-file-input");
    const pathInput = $("study-path-input");

    if (dropArea) {
      dropArea.addEventListener("click", (e) => {
        if (e.target.tagName !== "BUTTON" && e.target.tagName !== "INPUT") fileInput?.click();
      });
      dropArea.addEventListener("dragover", (e) => { e.preventDefault(); dropArea.classList.add("drag-over"); });
      dropArea.addEventListener("dragleave", () => dropArea.classList.remove("drag-over"));
      dropArea.addEventListener("drop", (e) => {
        e.preventDefault();
        dropArea.classList.remove("drag-over");
        if (e.dataTransfer.files.length) uploadPdf(e.dataTransfer.files[0]);
      });
    }

    fileInput?.addEventListener("change", (e) => {
      if (e.target.files.length) uploadPdf(e.target.files[0]);
      e.target.value = "";
    });

    $("study-path-attach-btn")?.addEventListener("click", () => {
      const p = pathInput?.value.trim();
      if (!p) { RA.showToast("PDF 경로를 입력하세요", "error"); return; }
      currentFile = {
        path: p,
        url: "/api/local?path=" + encodeURIComponent(p),
        filename: p.split("/").pop(),
        size: null,
        type: "application/pdf",
        isLocal: true,
      };
      renderAttachedFile();
    });

    $("study-analyze-btn")?.addEventListener("click", startAnalysis);
    $("study-clear-btn")?.addEventListener("click", clearAll);
    $("study-save-wiki-btn")?.addEventListener("click", openWikiSaveModal);

    $("wiki-save-modal-close")?.addEventListener("click", () => RA.closeModal("wiki-save-modal"));
    $("wiki-save-modal-cancel")?.addEventListener("click", () => RA.closeModal("wiki-save-modal"));
    $("wiki-save-modal-submit")?.addEventListener("click", submitWikiSave);

    RA.newItemHandlers.study = () => $("study-file-input")?.click();
  }

  async function uploadPdf(file) {
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      RA.showToast("PDF 파일만 가능합니다", "error");
      return;
    }
    try {
      const formData = new FormData();
      formData.append("file", file);
      const resp = await fetch(`${RA.API}/api/upload`, { method: "POST", body: formData });
      if (!resp.ok) throw new Error("업로드 실패");
      const data = await resp.json();
      currentFile = {
        path: data.file_path,
        url: data.url,
        filename: file.name,
        size: file.size,
        type: file.type,
        isLocal: false,
      };
      renderAttachedFile();
      RA.showToast(`${file.name} 업로드됨`, "success");
    } catch (e) {
      RA.showToast("업로드 실패: " + e.message, "error");
    }
  }

  function renderAttachedFile() {
    const wrap = $("study-attached-wrap");
    if (!wrap) return;
    if (!currentFile) {
      wrap.innerHTML = "";
      $("study-analyze-btn").disabled = true;
      return;
    }
    wrap.innerHTML = `
      <div class="study-attached-file">
        <span class="icon">📄</span>
        <div class="file-info">
          <div class="file-name">${RA.escapeHtml(currentFile.filename)}</div>
          <div class="file-meta">${currentFile.isLocal ? '로컬 경로' : (currentFile.size ? formatSize(currentFile.size) : '')}</div>
        </div>
        <button class="btn btn-ghost btn-sm" id="study-remove-file">제거</button>
      </div>
    `;
    $("study-remove-file")?.addEventListener("click", () => {
      currentFile = null;
      renderAttachedFile();
    });
    $("study-analyze-btn").disabled = false;
  }

  function formatSize(b) {
    if (b < 1024) return b + " B";
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
    return (b / 1024 / 1024).toFixed(1) + " MB";
  }

  // ─── Analysis ────────────────────────────────────────
  async function startAnalysis() {
    if (!currentFile || analyzing) return;
    analyzing = true;
    currentResult = "";
    currentSessionId = null;

    const resultEl = $("study-result");
    if (resultEl) {
      resultEl.classList.remove("hidden");
      resultEl.innerHTML = '<div class="loading-indicator"><span class="loading-spinner"></span><span>논문 분석 중...</span></div>';
    }
    $("study-analyze-btn").disabled = true;
    $("study-analyze-btn").textContent = "분석 중...";
    $("study-save-wiki-btn")?.classList.add("hidden");

    const payload = {
      pdf_path: currentFile.path,
    };

    let accumulated = "";
    let firstText = false;

    const showStatus = (msg) => {
      if (!firstText) {
        resultEl.innerHTML = `<div class="loading-indicator"><span class="loading-spinner"></span><span>${RA.escapeHtml(msg)}</span></div>`;
      }
    };

    const onChunk = (event) => {
      if (event.type === "init" && event.session_id) currentSessionId = event.session_id;
      if (event.type === "text") {
        firstText = true;
        accumulated += event.text;
        resultEl.innerHTML = RA.renderMarkdown(accumulated);
      } else if (event.type === "tool_use") {
        const toolName = event.tool || "";
        const statusMap = {
          "Read": "PDF 파일 읽는 중...",
          "Write": "파일 저장 중...",
          "Bash": "명령 실행 중...",
        };
        showStatus(statusMap[toolName] || `도구 실행 중: ${toolName}`);
      } else if (event.type === "result") {
        if (event.text) {
          firstText = true;
          accumulated = event.text;
          resultEl.innerHTML = RA.renderMarkdown(accumulated);
        }
        currentResult = accumulated;
      } else if (event.type === "error") {
        resultEl.innerHTML = `<div style="color:var(--error)">오류: ${RA.escapeHtml(event.error || "알 수 없음")}</div>`;
      }
    };

    try {
      await RA.fetchStream("/api/chat/study", { method: "POST", body: payload }, onChunk);
      RA.showToast("분석 완료", "success");
      $("study-save-wiki-btn")?.classList.remove("hidden");
      addToHistory();
      if (currentFile?.url) {
        renderPdfFigureGallery(resultEl, currentFile.url);
      }
    } catch (e) {
      if (!resultEl) { analyzing = false; return; }

      const errWrap = document.createElement("div");
      errWrap.style.cssText = "padding:10px;font-size:12px;display:flex;flex-direction:column;gap:6px;";

      const errMsg = document.createElement("span");
      errMsg.style.color = "var(--error)";
      errMsg.textContent = `연결 오류: ${e.message} — 잠시 후 재시도합니다...`;
      errWrap.appendChild(errMsg);

      const retryBtn = document.createElement("button");
      retryBtn.textContent = "지금 재시도";
      retryBtn.style.cssText = "align-self:flex-start;font-size:11px;padding:4px 10px;border:1px solid rgba(30,111,168,0.35);border-radius:6px;cursor:pointer;background:rgba(30,111,168,0.07);color:var(--blue-mid);transition:all 0.15s;";
      errWrap.appendChild(retryBtn);

      if (!firstText) resultEl.innerHTML = "";
      resultEl.appendChild(errWrap);

      let autoRetried = false;
      const doRetry = async () => {
        if (analyzing) return;
        errWrap.remove();
        firstText = false;
        accumulated = "";
        analyzing = true;
        $("study-analyze-btn").disabled = true;
        $("study-analyze-btn").textContent = "분석 중...";
        resultEl.innerHTML = '<div class="loading-indicator"><span class="loading-spinner"></span><span>재연결 중...</span></div>';

        // Wait for server to be ready
        for (let i = 0; i < 10; i++) {
          try {
            const h = await fetch(RA.API + "/healthz");
            if (h.ok) break;
          } catch (_) {}
          await new Promise((r) => setTimeout(r, 1000));
        }

        try {
          await RA.fetchStream("/api/chat/study", { method: "POST", body: payload }, onChunk);
          RA.showToast("분석 완료", "success");
          $("study-save-wiki-btn")?.classList.remove("hidden");
          addToHistory();
          if (currentFile?.url) renderPdfFigureGallery(resultEl, currentFile.url);
        } catch (e2) {
          if (resultEl) resultEl.innerHTML = `<div style="color:var(--error);padding:10px">연결 오류: ${RA.escapeHtml(e2.message)}</div>`;
        } finally {
          analyzing = false;
          $("study-analyze-btn").disabled = false;
          $("study-analyze-btn").innerHTML = "✦ 분석 시작";
        }
      };

      retryBtn.addEventListener("click", () => { autoRetried = true; doRetry(); });
      setTimeout(() => { if (!autoRetried) doRetry(); }, 4000);
    } finally {
      analyzing = false;
      $("study-analyze-btn").disabled = false;
      $("study-analyze-btn").innerHTML = "✦ 분석 시작";
    }
  }

  function clearAll() {
    currentFile = null;
    currentResult = "";
    currentSessionId = null;
    renderAttachedFile();
    const re = $("study-result");
    if (re) { re.classList.add("hidden"); re.innerHTML = ""; }
    $("study-save-wiki-btn")?.classList.add("hidden");
    if ($("study-path-input")) $("study-path-input").value = "";
  }

  // ─── History ────────────────────────────────────────
  async function loadHistory() {
    try {
      studyHistory = RA.storage.get("study_history", []);
    } catch (e) {
      studyHistory = [];
    }
  }

  function addToHistory() {
    const entry = {
      id: Date.now().toString(),
      filename: currentFile?.filename || "unknown.pdf",
      file_path: currentFile?.path,
      created_at: new Date().toISOString(),
      result: currentResult.substring(0, 5000),
    };
    studyHistory.unshift(entry);
    studyHistory = studyHistory.slice(0, 30);
    RA.storage.set("study_history", studyHistory);
    renderHistory();
  }

  function renderHistory() {
    const list = $("study-history-list");
    if (!list) return;
    list.innerHTML = "";
    if (studyHistory.length === 0) {
      list.innerHTML = '<div class="text-muted text-sm" style="padding:18px;text-align:center">아직 분석 기록이 없어요</div>';
      return;
    }
    for (const h of studyHistory) {
      const item = document.createElement("div");
      item.className = "sidebar-item";
      item.innerHTML = `
        <div class="sidebar-item-text">
          <div class="sidebar-item-title">📄 ${RA.escapeHtml(h.filename)}</div>
          <div class="sidebar-item-meta">${RA.formatDateShort(h.created_at)}</div>
        </div>
        <button class="sidebar-item-delete" title="삭제">×</button>
      `;
      item.querySelector(".sidebar-item-text").addEventListener("click", () => {
        currentResult = h.result;
        currentFile = { filename: h.filename, path: h.file_path, isLocal: false };
        renderAttachedFile();
        const re = $("study-result");
        if (re) { re.classList.remove("hidden"); re.innerHTML = RA.renderMarkdown(h.result); }
        $("study-save-wiki-btn")?.classList.remove("hidden");
      });
      item.querySelector(".sidebar-item-delete").addEventListener("click", (e) => {
        e.stopPropagation();
        studyHistory = studyHistory.filter((x) => x.id !== h.id);
        RA.storage.set("study_history", studyHistory);
        renderHistory();
      });
      list.appendChild(item);
    }
  }

  // ─── Wiki save modal ─────────────────────────────────
  function _extractMeta(text, key) {
    // Matches both "KEY: value" and "**KEY:** value" formats
    const m = text.match(new RegExp(
      "(?:\\*\\*" + key + ":\\*\\*|" + key + ":)\\s*(.+)", "i"
    ));
    return m ? m[1].trim() : "";
  }

  function openWikiSaveModal() {
    if (!currentResult) {
      RA.showToast("먼저 분석을 완료하세요", "error");
      return;
    }

    const rawTitle = _extractMeta(currentResult, "PAPER_TITLE");
    const rawDoi   = _extractMeta(currentResult, "DOI");
    const rawTags  = _extractMeta(currentResult, "TAGS");
    // Summary: prefer What line, fallback to first content line after "한 줄 요지" heading
    const whatMatch    = currentResult.match(/\*\*What:\*\*\s*(.+)/i);
    const summaryMatch = currentResult.match(/한\s*줄\s*(?:요지|요약)[^\n]*\n+([^\n#\-\|]{10,})/i);
    const rawSummary   = whatMatch ? whatMatch[1].trim()
                       : summaryMatch ? summaryMatch[1].trim() : "";

    const title   = rawTitle || currentFile?.filename?.replace(/\.pdf$/i, "") || "";
    const doi     = rawDoi.replace(/^N\/A$/i, "");
    const tags    = rawTags;
    const summary = rawSummary;

    if ($("wiki-save-title"))    $("wiki-save-title").value    = title;
    if ($("wiki-save-summary"))  $("wiki-save-summary").value  = summary;
    if ($("wiki-save-doi"))      $("wiki-save-doi").value      = doi;
    if ($("wiki-save-tags"))     $("wiki-save-tags").value     = tags;
    if ($("wiki-save-analysis")) $("wiki-save-analysis").value = currentResult;
    RA.openModal("wiki-save-modal");
  }

  async function submitWikiSave() {
    const title = $("wiki-save-title")?.value.trim();
    const summary = $("wiki-save-summary")?.value.trim();
    const doi = $("wiki-save-doi")?.value.trim();
    const tagsRaw = $("wiki-save-tags")?.value.trim();
    const analysis = $("wiki-save-analysis")?.value.trim();

    if (!title) { RA.showToast("제목을 입력하세요", "error"); return; }

    const tags = tagsRaw ? tagsRaw.split(",").map((t) => t.trim()).filter(Boolean) : [];

    // Extract authors/year/journal from currentResult for richer wiki entry
    const rawAuthors = _extractMeta(currentResult, "AUTHORS");
    const rawYear    = _extractMeta(currentResult, "YEAR");
    const rawJournal = _extractMeta(currentResult, "JOURNAL");
    const authors = rawAuthors ? rawAuthors.split(",").map((a) => a.trim()).filter(Boolean) : [];
    const year    = rawYear ? parseInt(rawYear, 10) || null : null;

    const payload = {
      title,
      summary,
      doi: doi || null,
      tags,
      llm_analysis: analysis,
      authors: authors.length ? authors : undefined,
      year: year || undefined,
      journal: rawJournal || undefined,
      pdf_path: currentFile?.path || null,
      source: "paper_study",
      read_status: "annotated",
    };

    const btn = $("wiki-save-modal-submit");
    btn.disabled = true;
    btn.textContent = "저장 중...";
    try {
      const paper = await RA.fetchJSON("/api/wiki/papers", { method: "POST", body: payload });
      RA.showToast("Wiki에 저장됨", "success");
      RA.closeModal("wiki-save-modal");
    } catch (e) {
      RA.showToast("저장 실패: " + e.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Wiki에 저장";
    }
  }

  // ─── PDF.js Figure Gallery ───────────────────────────
  const PDFJS_LOCAL = "/static/lib/pdfjs/pdf.min.js";
  const PDFJS_WORKER_LOCAL = "/static/lib/pdfjs/pdf.worker.min.js";
  const PDFJS_CDN = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
  const PDFJS_WORKER_CDN = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  async function ensurePdfJs() {
    if (window.pdfjsLib) return true;
    const tryLoad = (src, workerSrc) => new Promise(resolve => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => {
        pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;
        resolve(true);
      };
      s.onerror = () => resolve(false);
      document.head.appendChild(s);
    });
    // Try local first, then CDN
    const ok = await tryLoad(PDFJS_LOCAL, PDFJS_WORKER_LOCAL);
    if (ok) return true;
    return tryLoad(PDFJS_CDN, PDFJS_WORKER_CDN);
  }

  async function renderPdfFigureGallery(contentEl, pdfUrl) {
    const ok = await ensurePdfJs();
    if (!ok) {
      console.warn("[study] PDF.js 로드 실패 — figure gallery 생략");
      return;
    }
    await new Promise(r => requestAnimationFrame(r));

    // Find Figure 표 heading
    let figHeading = null;
    for (const h of contentEl.querySelectorAll("h2")) {
      if (/figure|fig/i.test(h.textContent)) { figHeading = h; break; }
    }
    if (!figHeading) return;

    let tableEl = null;
    let el = figHeading.nextElementSibling;
    while (el) {
      if (el.tagName === "TABLE") { tableEl = el; break; }
      if (/^H[123]$/.test(el.tagName)) break;
      el = el.nextElementSibling;
    }
    if (!tableEl) return;

    const headers = Array.from(tableEl.querySelectorAll("thead th")).map(th => th.textContent.trim());
    const panelIdx = headers.findIndex(h => /^panel$/i.test(h));
    const rows = Array.from(tableEl.querySelectorAll("tbody tr"));
    if (!rows.length) return;

    // Loading indicator
    const loadingEl = document.createElement("div");
    loadingEl.className = "figure-loading";
    loadingEl.innerHTML = `<div class="figure-loading-bar"><div class="figure-loading-fill"></div></div><span class="figure-loading-text">PDF 로드 중...</span>`;
    figHeading.insertAdjacentElement("afterend", loadingEl);
    const loadingFill = loadingEl.querySelector(".figure-loading-fill");
    const loadingText = loadingEl.querySelector(".figure-loading-text");
    const updateLoading = (pct, msg) => { loadingFill.style.width = `${pct}%`; loadingText.textContent = msg; };

    let pdf;
    try {
      pdf = await pdfjsLib.getDocument(pdfUrl).promise;
      updateLoading(15, `PDF ${pdf.numPages}p — 페이지 분석 중...`);
    } catch (e) {
      console.warn("[study] PDF 로드 실패:", e);
      loadingEl.innerHTML = `<span style="color:var(--error);font-size:11px">PDF figure 렌더링 실패: ${e?.message || "알 수 없는 오류"}</span>`;
      setTimeout(() => loadingEl.remove(), 3000);
      return;
    }

    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) pages.push(await pdf.getPage(i));
    const textResults = await Promise.all(pages.map(async (page) => {
      const tc = await page.getTextContent();
      return { page, items: tc.items, text: tc.items.map(it => it.str).join(" ") };
    }));
    const pageIndex = textResults.map((tr, i) => ({
      pageNum: i + 1, page: tr.page, text: tr.text, textItems: tr.items, textLength: tr.text.length,
    }));
    updateLoading(40, "페이지 분석 완료 — Figure 위치 매칭 중...");

    // References boundary — trigger ONLY on a standalone References/Bibliography
    // heading in the back of the document.
    // The old logic also accepted "page contains the word 'references' AND has
    // >=5 four-digit numbers". Both are trivially satisfied by ordinary pages:
    // journal-header years/page-ranges ("2026", "1517", "1529") supply the digits,
    // and non-bibliographic uses of the word ("reference and alternate alleles"
    // in variant calling, "reference genome", "cross-references") supply the word.
    // That collapsed refsBoundary onto an early body page, excluding every figure
    // whose caption lives past it — so figures fell back to body pages that merely
    // *mention* the figure. A missed boundary is safe (all pages stay searchable);
    // a false-early one silently loses figures, so we bias hard toward strictness.
    let refsBoundary = pdf.numPages + 1;
    const minRefsPage = Math.floor(pdf.numPages * 0.4);
    for (const p of pageIndex) {
      if (p.pageNum <= minRefsPage) continue;
      if (/(?:^|\n)\s*(?:references|bibliography|literature\s+cited)\s*\d*\s*(?:\n|$)/im.test(p.text)) {
        refsBoundary = p.pageNum;
        break;
      }
    }

    function findPageForFig(figNum) {
      const figPat = new RegExp(`\\bfig(?:ure|\\.)?\\s*\\.?\\s*${figNum}(?=[^\\d]|$)`, "i");
      const captionPat = new RegExp(`(?:^|[\\n ])\\s*Fig(?:ure|\\.)?\\s*\\.?\\s*${figNum}\\b[.:|\\s]`, "im");
      const suppRefPat = new RegExp(`(?:extended\\s+(?:data\\s+)?|supplement(?:ary|al)?\\s+|supp\\.?\\s*|SI\\s+|S\\d+\\s+)fig(?:ure|\\.)?\\s*\\.?\\s*${figNum}(?=[^\\d]|$)`, "gi");
      const mainPages = pageIndex.filter(p => p.pageNum < refsBoundary && figPat.test(p.text));
      const pool = mainPages.length ? mainPages : pageIndex.filter(p => figPat.test(p.text));
      if (!pool.length) return null;
      let bestPage = null, bestScore = -Infinity;
      for (const p of pool) {
        let score = 0;
        const cleanText = p.text.replace(suppRefPat, "");
        score += captionPat.test(cleanText) ? 50 : (figPat.test(cleanText) ? 5 : 0);
        score += p.textLength < 300 ? 15 : p.textLength < 800 ? 20 : p.textLength < 1500 ? 12 : 3;
        const cnt = (cleanText.match(figPat) || []).length;
        score += cnt >= 3 ? 10 : cnt >= 2 ? 5 : 0;
        if (p.pageNum === 1) score -= 20;
        const all = p.text.match(/\bfig(?:ure|\.)?\s*\.?\s*\d+/gi);
        if (all && all.length >= 5) score -= 10;
        if (score > bestScore) { bestScore = score; bestPage = p; }
      }
      return bestPage;
    }

    const BASE_SCALE = 2.5;
    function findCaptionY(page, figNum, scale, textItems) {
      const vp1 = page.getViewport({ scale: 1 });
      const pageH = vp1.height;
      const items = (textItems || []).filter(it => "str" in it);
      const captionPat = new RegExp(`(?:^|\\s)Fig(?:ure|\\.)?\\s*\\.?\\s*${figNum}\\b`, "i");
      const extPat = /extended|supplementary|supp\.?/i;
      for (const item of items) {
        const s = item.str.trim();
        if (captionPat.test(s) && !extPat.test(s)) {
          const canvasY = (pageH - item.transform[5]) * scale;
          const ratio = canvasY / (pageH * scale);
          if (ratio >= 0.20 && ratio <= 0.95) return canvasY;
        }
      }
      for (let i = 0; i < items.length; i++) {
        const baseY = items[i].transform[5];
        let concat = "", j = i;
        while (j < items.length && Math.abs(items[j].transform[5] - baseY) < 3) { concat += items[j].str; j++; }
        if (captionPat.test(concat) && !extPat.test(concat)) {
          const canvasY = (pageH - baseY) * scale;
          const ratio = canvasY / (pageH * scale);
          if (ratio >= 0.20 && ratio <= 0.95) return canvasY;
        }
      }
      return null;
    }

    // 캡션이 본문 페이지 하단에 있고 그림은 다음 장에 실리는 레이아웃 대응.
    //
    // renderPage는 "그림은 캡션 바로 위에 있다"고 가정하고 페이지 상단부터
    // 캡션까지를 잘라낸다. Nature 계열은 전면 그림을 다음 장에 싣고 캡션만
    // 앞 페이지 하단에 남기는 경우가 있는데, 그러면 이 가정이 깨져서 본문
    // 텍스트만 크롭돼 나온다. 게다가 그림 페이지에는 "Fig N" 문자열이 아예
    // 없어서(축 라벨과 유전자명뿐) 텍스트 검색 기반인 findPageForFig는 그
    // 페이지를 후보에조차 올리지 못한다.
    //
    // 판별은 두 신호가 모두 성립할 때만 — 오작동 시 기존 동작으로 되돌아간다.
    //   (1) 캡션 위쪽 글자 밀도가 높다  = 그 영역은 그림이 아니라 본문이다
    //   (2) 인접 페이지의 글자 수가 훨씬 적다 = 그쪽이 그림 페이지다
    const CAPTION_PAGE_TEXT_DENSITY = 4500; // 측정값: 그림 2173·2923 vs 본문 7838~8240
    const FIGURE_PAGE_TEXT_RATIO = 0.6;     // 측정값: 그림 0.22~0.40 vs 본문 1.49·2.03

    function charsAboveCaption(pd, captionCssY, cssH, pageH) {
      let n = 0;
      for (const it of pd.textItems || []) {
        if (!("str" in it)) continue;
        const y = (pageH - it.transform[5]) * BASE_SCALE;
        // 상단 8%는 저널 러닝 헤더 — 본문 밀도 계산에서 제외
        if (y < captionCssY && y / cssH > 0.08) n += it.str.length;
      }
      return n;
    }

    function resolveFigurePage(pd, figNum) {
      if (!pd) return { pd, crop: true };
      const pageH = pd.page.getViewport({ scale: 1 }).height;
      const cssH = pageH * BASE_SCALE;
      const captionCssY = findCaptionY(pd.page, figNum, BASE_SCALE, pd.textItems);
      if (captionCssY == null) return { pd, crop: true };
      const ratio = captionCssY / cssH;
      const density = charsAboveCaption(pd, captionCssY, cssH, pageH) / ratio;
      if (density <= CAPTION_PAGE_TEXT_DENSITY) return { pd, crop: true };
      // 캡션 위가 본문 → 그림은 인접 페이지. 다음 장을 먼저, 없으면 이전 장.
      const neighbors = [pageIndex[pd.pageNum], pageIndex[pd.pageNum - 2]];
      for (const cand of neighbors) {
        if (cand && cand.textLength < pd.textLength * FIGURE_PAGE_TEXT_RATIO) {
          return { pd: cand, crop: false }; // 전면 그림이므로 자르지 않는다
        }
      }
      return { pd, crop: true };
    }

    async function renderPage(pd, figNum, crop = true) {
      const dpr = window.devicePixelRatio || 1;
      const physScale = BASE_SCALE * dpr;
      const vp = pd.page.getViewport({ scale: physScale });
      const cssVp = pd.page.getViewport({ scale: BASE_SCALE });
      const captionCssY = (crop && figNum != null) ? findCaptionY(pd.page, figNum, BASE_SCALE, pd.textItems) : null;
      const fullCanvas = document.createElement("canvas");
      fullCanvas.width = Math.round(vp.width);
      fullCanvas.height = Math.round(vp.height);
      await pd.page.render({ canvasContext: fullCanvas.getContext("2d"), viewport: vp }).promise;
      const cssW = cssVp.width, cssH = cssVp.height;
      let cropCssH = null;
      if (captionCssY != null) {
        const ratio = captionCssY / cssH;
        if (ratio >= 0.20 && ratio <= 0.95) cropCssH = Math.round(captionCssY + 6);
      }
      if (cropCssH == null) {
        return fullCanvas;
      }
      const physCropH = Math.round(cropCssH * dpr);
      const physW = Math.round(cssVp.width * dpr);
      const cropped = document.createElement("canvas");
      cropped.width = physW; cropped.height = physCropH;
      cropped.getContext("2d").drawImage(fullCanvas, 0, 0, physW, physCropH, 0, 0, physW, physCropH);
      return cropped;
    }

    function extractFigNum(panelText) {
      const plain = panelText.match(/^(\d+)[a-z]?$/i);
      if (plain) return parseInt(plain[1]);
      const labeled = panelText.match(/fig(?:ure|\.?)\.?\s*(\d+)/i);
      if (labeled) return parseInt(labeled[1]);
      return null;
    }

    const figGroups = new Map();
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll("td"));
      if (!cells.length) continue;
      const panelText = (panelIdx >= 0 ? cells[panelIdx] : cells[0])?.textContent.trim() || "";
      const figNum = extractFigNum(panelText);
      if (figNum == null) continue;
      if (!figGroups.has(figNum)) {
        figGroups.set(figNum, { pd: findPageForFig(figNum), rows: [] });
      }
      figGroups.get(figNum).rows.push({ cells, panelText });
    }

    // Order correction
    const figNums = Array.from(figGroups.keys()).sort((a, b) => a - b);
    for (let i = 1; i < figNums.length; i++) {
      const prev = figGroups.get(figNums[i - 1]);
      const curr = figGroups.get(figNums[i]);
      if (prev?.pd && curr?.pd && curr.pd.pageNum < prev.pd.pageNum) {
        const figPat = new RegExp(`\\bfig(?:ure|\\.)?\\s*\\.?\\s*${figNums[i]}(?=[^\\d]|$)`, "i");
        const laterPages = pageIndex.filter(p => p.pageNum >= prev.pd.pageNum && p.pageNum < refsBoundary && figPat.test(p.text));
        if (laterPages.length) curr.pd = laterPages.reduce((a, b) => a.textLength <= b.textLength ? a : b);
      }
    }

    // 캡션 페이지 → 실제 그림 페이지 보정 (페이지 라벨도 같이 맞도록 렌더 전에 수행)
    for (const [figNum, group] of figGroups) {
      if (!group.pd) continue;
      const resolved = resolveFigurePage(group.pd, figNum);
      group.pd = resolved.pd;
      group.crop = resolved.crop;
    }

    const figEntries = Array.from(figGroups.entries());
    const canvasMap = new Map();
    const totalFigs = figEntries.filter(([, g]) => g.pd).length;
    updateLoading(60, `Figure ${totalFigs}개 매칭 — 이미지 렌더링 중...`);
    let rendered = 0;
    await Promise.all(figEntries.map(async ([figNum, group]) => {
      if (group.pd) {
        canvasMap.set(figNum, await renderPage(group.pd, figNum, group.crop !== false));
        rendered++;
        updateLoading(60 + Math.round((rendered / totalFigs) * 35), `렌더링 중... (${rendered}/${totalFigs})`);
      }
    }));

    const fragment = document.createDocumentFragment();
    for (const [figNum, group] of figEntries) {
      const section = document.createElement("div");
      section.className = "figure-section";
      const canvas = canvasMap.get(figNum);
      if (canvas && group.pd) {
        const imgWrap = document.createElement("div");
        imgWrap.className = "figure-section-img-wrap";
        canvas.title = `Fig ${figNum} · p.${group.pd.pageNum} — 클릭하여 확대`;
        canvas.addEventListener("click", () => toggleFigureZoom(imgWrap, group.pd));
        const pgLbl = document.createElement("span");
        pgLbl.className = "figure-section-page-label";
        pgLbl.textContent = `Fig ${figNum}  ·  p.${group.pd.pageNum}`;
        imgWrap.appendChild(canvas);
        imgWrap.appendChild(pgLbl);
        section.appendChild(imgWrap);
      }
      const table = document.createElement("table");
      table.className = "figure-panel-table";
      const thead = document.createElement("thead");
      const hRow = document.createElement("tr");
      headers.forEach(hdr => { const th = document.createElement("th"); th.textContent = hdr; hRow.appendChild(th); });
      thead.appendChild(hRow);
      table.appendChild(thead);
      const tbody = document.createElement("tbody");
      for (const { cells } of group.rows) {
        const tr = document.createElement("tr");
        headers.forEach((_, ci) => {
          const td = document.createElement("td");
          if (ci === (panelIdx >= 0 ? panelIdx : 0)) td.className = "panel-id";
          td.innerHTML = cells[ci]?.innerHTML || "";
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      section.appendChild(table);
      fragment.appendChild(section);
    }

    updateLoading(100, `완료 — Figure ${canvasMap.size}개`);
    await new Promise(r => setTimeout(r, 400));
    loadingEl.remove();
    tableEl.replaceWith(fragment);
  }

  async function toggleFigureZoom(imgWrap, pd) {
    const isZoomed = imgWrap.classList.contains("zoomed");
    if (isZoomed) {
      imgWrap.classList.remove("zoomed");
      imgWrap.querySelector(".figure-zoom-canvas")?.remove();
      const orig = imgWrap.querySelector("canvas:not(.figure-zoom-canvas)");
      if (orig) orig.style.display = "";
      return;
    }
    imgWrap.classList.add("zoomed");
    const orig = imgWrap.querySelector("canvas:not(.figure-zoom-canvas)");
    if (orig) orig.style.display = "none";
    const dpr = window.devicePixelRatio || 1;
    const ZOOM_SCALE = 3.5;
    const vp = pd.page.getViewport({ scale: ZOOM_SCALE * dpr });
    const c = document.createElement("canvas");
    c.className = "figure-zoom-canvas";
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    c.title = "클릭하여 축소";
    c.addEventListener("click", () => toggleFigureZoom(imgWrap, pd));
    imgWrap.insertBefore(c, imgWrap.querySelector(".figure-section-page-label"));
    await pd.page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
  }

  RA.onTabFirstShown.study = init;
  RA.study = { init, renderPdfFigureGallery };
})();
