/* ========================================================================
   wiki.js — Paper Wiki 화면
   ======================================================================== */

(function () {
  const $ = (id) => document.getElementById(id);

  // State
  let papers = [];
  let tagTree = { structured: {}, free: [] }; // category → [{ tag, count }]
  let selectedTags = new Set();
  let tagFilterMode = "AND"; // or OR
  let viewMode = "grid"; // or "list"
  let searchQuery = "";
  let currentPaper = null;
  let activeDetailTab = "summary"; // "summary" | "figures" | "notes" | "related"
  let notesDebounceTimer = null;

  async function init() {
    bindEvents();
    await Promise.all([loadPapers(), loadTags()]);
    renderPapers();
    renderTagFilters();
  }

  // ─── Wiki mode (papers / concepts) ─────────────────
  let wikiMode = "papers"; // "papers" | "concepts"
  let conceptView = "list"; // "list" | "graph"

  function switchWikiMode(mode) {
    wikiMode = mode;
    $("wiki-mode-papers")?.classList.toggle("active", mode === "papers");
    $("wiki-mode-concepts")?.classList.toggle("active", mode === "concepts");
    $("wiki-papers")?.classList.toggle("hidden", mode !== "papers");
    $("wiki-view-toggle")?.classList.toggle("hidden", mode !== "papers");
    $("concept-view-toggle")?.classList.toggle("hidden", mode !== "concepts");
    if (mode === "concepts") {
      closeSlidePanel();
      applyConceptView();
    } else {
      $("wiki-concepts")?.classList.add("hidden");
      $("wiki-concept-graph")?.classList.add("hidden");
    }
  }

  function applyConceptView() {
    const listMode = conceptView === "list";
    $("concept-view-list")?.classList.toggle("active", listMode);
    $("concept-view-graph")?.classList.toggle("active", !listMode);
    $("wiki-concepts")?.classList.toggle("hidden", !listMode);
    $("wiki-concept-graph")?.classList.toggle("hidden", listMode);
    if (listMode) loadAndRenderConcepts();
    else renderConceptGraph();
  }

  function switchConceptView(v) {
    conceptView = v;
    applyConceptView();
  }

  function bindEvents() {
    const searchEl = $("wiki-search-input");
    if (searchEl) {
      searchEl.addEventListener("input", RA.debounce((e) => {
        searchQuery = e.target.value.trim();
        renderPapers();
      }, 200));
    }
    $("wiki-view-grid")?.addEventListener("click", () => { viewMode = "grid"; updateViewToggle(); renderPapers(); });
    $("wiki-view-list")?.addEventListener("click", () => { viewMode = "list"; updateViewToggle(); renderPapers(); });
    $("wiki-add-btn")?.addEventListener("click", openDoiModal);
    $("wiki-slide-close")?.addEventListener("click", closeSlidePanel);
    $("wiki-delete-btn")?.addEventListener("click", () => { if (currentPaper) deletePaper(currentPaper.id); });
    $("wiki-tag-mode-and")?.addEventListener("click", () => { tagFilterMode = "AND"; updateTagModeBtns(); renderPapers(); });
    $("wiki-tag-mode-or")?.addEventListener("click", () => { tagFilterMode = "OR"; updateTagModeBtns(); renderPapers(); });

    // Wiki mode toggle
    $("wiki-mode-papers")?.addEventListener("click", () => switchWikiMode("papers"));
    $("wiki-mode-concepts")?.addEventListener("click", () => switchWikiMode("concepts"));
    $("concept-view-list")?.addEventListener("click", () => switchConceptView("list"));
    $("concept-view-graph")?.addEventListener("click", () => switchConceptView("graph"));

    // Concept slide panel
    $("concept-slide-close")?.addEventListener("click", closeConceptPanel);
    $("concept-delete-btn")?.addEventListener("click", () => { if (currentConcept) deleteConceptUI(currentConcept.id); });

    // DOI modal
    $("doi-modal-close")?.addEventListener("click", () => RA.closeModal("doi-modal"));
    $("doi-modal-cancel")?.addEventListener("click", () => RA.closeModal("doi-modal"));
    $("doi-modal-submit")?.addEventListener("click", submitDoi);

    // Detail tab clicks
    document.querySelectorAll(".detail-tab").forEach((t) => {
      t.addEventListener("click", () => switchDetailTab(t.dataset.detailTab));
    });

    // Register "new" handler
    RA.newItemHandlers.wiki = openDoiModal;
  }

  function updateViewToggle() {
    $("wiki-view-grid")?.classList.toggle("active", viewMode === "grid");
    $("wiki-view-list")?.classList.toggle("active", viewMode === "list");
  }

  function updateTagModeBtns() {
    $("wiki-tag-mode-and")?.classList.toggle("active", tagFilterMode === "AND");
    $("wiki-tag-mode-or")?.classList.toggle("active", tagFilterMode === "OR");
  }

  // ─── Data loading ────────────────────────────────────
  async function loadPapers() {
    try {
      papers = await RA.fetchJSON("/api/wiki/papers");
    } catch (e) {
      papers = [];
    }
  }

  async function loadTags() {
    try {
      tagTree = await RA.fetchJSON("/api/wiki/tags");
    } catch (e) {
      tagTree = { structured: {}, free: [] };
    }
  }

  // ─── Filtering ───────────────────────────────────────
  function filteredPapers() {
    return papers.filter((p) => {
      // Search filter
      if (searchQuery) {
        const hay = (
          (p.title || "") + " " +
          (Array.isArray(p.authors) ? p.authors.join(" ") : p.authors || "") + " " +
          (p.abstract || "") + " " +
          (p.summary || "") + " " +
          (Array.isArray(p.tags) ? p.tags.join(" ") : p.tags || "")
        ).toLowerCase();
        if (!hay.includes(searchQuery.toLowerCase())) return false;
      }
      // Tag filter
      if (selectedTags.size > 0) {
        const tags = Array.isArray(p.tags) ? p.tags : (() => {
          try { return JSON.parse(p.tags || "[]"); } catch (_) { return []; }
        })();
        const tagsLower = tags.map((t) => String(t).toLowerCase());
        const sel = Array.from(selectedTags).map((t) => String(t).toLowerCase());
        if (tagFilterMode === "AND") {
          if (!sel.every((t) => tagsLower.includes(t))) return false;
        } else {
          if (!sel.some((t) => tagsLower.includes(t))) return false;
        }
      }
      return true;
    });
  }

  // ─── Render papers ──────────────────────────────────
  function renderPapers() {
    const container = $("wiki-papers");
    if (!container) return;
    container.className = "wiki-main-content " + (viewMode === "grid" ? "papers-grid" : "papers-list");
    const list = filteredPapers();

    if (list.length === 0) {
      container.innerHTML = `
        <div class="empty-state" style="grid-column:1/-1">
          <div class="empty-state-icon">◈</div>
          <div class="empty-state-title">아직 논문이 없어요</div>
          <div class="empty-state-msg">Paper Study로 첫 논문을 분석하거나, Digest에서 추가해보세요. 또는 우측 상단 [+] 버튼으로 DOI를 입력할 수 있습니다.</div>
        </div>`;
      return;
    }

    container.innerHTML = "";
    for (const p of list) {
      container.appendChild(renderPaperCard(p));
    }
  }

  function renderPaperCard(p) {
    const card = document.createElement("div");
    card.className = "paper-card" + (currentPaper && currentPaper.id === p.id ? " active" : "");

    const authors = Array.isArray(p.authors) ? p.authors : (() => {
      try { return JSON.parse(p.authors || "[]"); } catch (_) { return []; }
    })();
    const tags = Array.isArray(p.tags) ? p.tags : (() => {
      try { return JSON.parse(p.tags || "[]"); } catch (_) { return []; }
    })();
    const authorsShort = authors.length > 2 ? `${authors[0]} et al.` : authors.join(", ");
    const visibleTags = tags.slice(0, 3);
    const extraCount = tags.length - visibleTags.length;

    const badges = [];
    if (p.is_preprint) badges.push('<span class="badge badge-preprint">PREPRINT</span>');
    if (p.relevance === "core") badges.push('<span class="badge badge-gold">CORE</span>');
    if (p.enrichment_status === "pending" || p.enrichment_status === "running") {
      badges.push('<span class="badge badge-enriching">분석 중…</span>');
    } else if (p.enrichment_status === "failed") {
      badges.push('<span class="badge badge-enrich-failed" title="' + RA.escapeHtml(p.enrichment_error || "") + '">분석 실패</span>');
    }

    card.innerHTML = `
      <div class="paper-card-top">
        <div>
          ${p.journal ? `<span class="paper-card-journal">${RA.escapeHtml(p.journal)}</span>` : ""}
          ${badges.join(" ")}
        </div>
        <span class="paper-card-year">${p.year || ""}</span>
      </div>
      <div class="paper-card-title">${RA.escapeHtml(p.title || "(제목 없음)")}</div>
      <div class="paper-card-authors">${RA.escapeHtml(authorsShort || "")}</div>
      ${p.summary ? `<div class="paper-card-summary">${RA.escapeHtml(p.summary)}</div>` : ""}
      <div class="paper-card-tags">
        ${visibleTags.map((t) => `<span class="tag-pill">${RA.escapeHtml(t)}</span>`).join("")}
        ${extraCount > 0 ? `<span class="tag-pill" style="opacity:.6">+${extraCount}</span>` : ""}
      </div>
      <div class="paper-card-footer">
        <span class="read-status" data-status="${p.read_status || "to-read"}">${p.read_status || "to-read"}</span>
        <span>${RA.formatDate(p.updated_at || p.created_at)}</span>
      </div>
    `;
    card.addEventListener("click", () => openPaperDetail(p));
    return card;
  }

  // ─── Tag filters ────────────────────────────────────
  function renderTagFilters() {
    const container = $("wiki-tag-filters");
    if (!container) return;
    container.innerHTML = "";

    // Tag mode toggle
    const modeWrap = document.createElement("div");
    modeWrap.className = "tag-filter-mode";
    modeWrap.innerHTML = `
      <button id="wiki-tag-mode-and" class="${tagFilterMode === "AND" ? "active" : ""}">AND</button>
      <button id="wiki-tag-mode-or" class="${tagFilterMode === "OR" ? "active" : ""}">OR</button>
    `;
    container.appendChild(modeWrap);
    modeWrap.querySelector("#wiki-tag-mode-and").addEventListener("click", () => { tagFilterMode = "AND"; updateTagModeBtns(); renderPapers(); });
    modeWrap.querySelector("#wiki-tag-mode-or").addEventListener("click", () => { tagFilterMode = "OR"; updateTagModeBtns(); renderPapers(); });

    // Aggregate tags from papers
    const tagCounts = {};
    for (const p of papers) {
      const tags = Array.isArray(p.tags) ? p.tags : (() => {
        try { return JSON.parse(p.tags || "[]"); } catch (_) { return []; }
      })();
      for (const t of tags) {
        tagCounts[t] = (tagCounts[t] || 0) + 1;
      }
    }

    // Group by prefix (method:, cell:, etc.)
    const groups = { method: [], cell: [], tissue: [], organism: [], disease: [], tool: [], "study-type": [], other: [] };
    for (const [t, count] of Object.entries(tagCounts)) {
      const colonIdx = t.indexOf(":");
      if (colonIdx > 0) {
        const prefix = t.slice(0, colonIdx);
        if (groups[prefix]) groups[prefix].push({ tag: t, count });
        else groups.other.push({ tag: t, count });
      } else {
        groups.other.push({ tag: t, count });
      }
    }

    const labelMap = {
      method: "방법론", cell: "세포", tissue: "조직",
      organism: "종", disease: "질환", tool: "도구",
      "study-type": "유형", other: "기타",
    };
    for (const [groupKey, label] of Object.entries(labelMap)) {
      const items = groups[groupKey];
      if (!items || items.length === 0) continue;
      const grpWrap = document.createElement("div");
      grpWrap.className = "tag-filter-group";
      grpWrap.innerHTML = `<div class="tag-filter-group-label">${label}</div>`;
      items.sort((a, b) => b.count - a.count);
      for (const { tag, count } of items) {
        const item = document.createElement("label");
        item.className = "tag-filter-item" + (selectedTags.has(tag) ? " active" : "");
        item.innerHTML = `
          <input type="checkbox" ${selectedTags.has(tag) ? "checked" : ""}>
          <span>${RA.escapeHtml(tag)}</span>
          <span class="count">${count}</span>
        `;
        item.querySelector("input").addEventListener("change", (e) => {
          if (e.target.checked) selectedTags.add(tag);
          else selectedTags.delete(tag);
          item.classList.toggle("active", e.target.checked);
          renderPapers();
        });
        grpWrap.appendChild(item);
      }
      container.appendChild(grpWrap);
    }

    if (Object.values(groups).every((g) => g.length === 0)) {
      container.innerHTML += '<div class="text-muted text-sm" style="padding:12px;text-align:center">태그가 없어요</div>';
    }
  }

  // ─── Detail panel ───────────────────────────────────
  function openPaperDetail(paper) {
    currentPaper = paper;
    activeDetailTab = "summary";
    renderDetail();
    $("wiki-slide-panel")?.classList.add("open");
    // Refresh card active state
    document.querySelectorAll("#wiki-papers .paper-card").forEach((c) => c.classList.remove("active"));
  }

  function closeSlidePanel() {
    $("wiki-slide-panel")?.classList.remove("open");
    currentPaper = null;
  }

  async function deletePaper(id) {
    if (!confirm("이 논문을 Wiki에서 삭제할까요?")) return;
    try {
      await RA.fetchJSON(`/api/wiki/papers/${id}`, { method: "DELETE" });
      RA.showToast("삭제됨", "success");
      closeSlidePanel();
      papers = papers.filter((p) => p.id !== id);
      renderPapers();
      await loadTags();
      renderTagFilters();
    } catch (e) {
      RA.showToast("삭제 실패: " + e.message, "error");
    }
  }

  function renderDetail() {
    if (!currentPaper) return;
    const p = currentPaper;
    const authors = Array.isArray(p.authors) ? p.authors : (() => {
      try { return JSON.parse(p.authors || "[]"); } catch (_) { return []; }
    })();
    const tags = Array.isArray(p.tags) ? p.tags : (() => {
      try { return JSON.parse(p.tags || "[]"); } catch (_) { return []; }
    })();

    const titleEl = $("detail-title");
    const metaEl = $("detail-meta");
    const tagsEl = $("detail-tags");

    if (titleEl) titleEl.textContent = p.title || "(제목 없음)";

    const metaLines = [];
    if (authors.length) metaLines.push(`<strong>${RA.escapeHtml(authors.join(", "))}</strong>`);
    const journalLine = [p.journal, p.year, p.volume_issue].filter(Boolean).map(RA.escapeHtml).join(" · ");
    if (journalLine) metaLines.push(journalLine);
    if (p.doi) metaLines.push(`<span class="detail-doi">DOI: ${RA.escapeHtml(p.doi)}</span>`);
    if (p.geo_accession) metaLines.push(`GEO: <strong>${RA.escapeHtml(p.geo_accession)}</strong>`);
    if (metaEl) metaEl.innerHTML = metaLines.join("<br>");

    if (tagsEl) {
      tagsEl.innerHTML = tags.map((t) => `<span class="tag-pill removable" data-tag="${RA.escapeHtml(t)}">${RA.escapeHtml(t)}</span>`).join("") +
        '<button class="add-tag-btn" id="add-tag-btn">+ 태그</button>';
      tagsEl.querySelectorAll(".tag-pill").forEach((pill) => {
        pill.addEventListener("click", async () => {
          const t = pill.dataset.tag;
          const newTags = tags.filter((x) => x !== t);
          await updatePaper(p.id, { tags: newTags });
        });
      });
      $("add-tag-btn")?.addEventListener("click", async () => {
        const nt = prompt("추가할 태그 (예: method:scRNA-seq):");
        if (nt && nt.trim()) {
          const newTags = [...new Set([...tags, nt.trim()])];
          await updatePaper(p.id, { tags: newTags });
        }
      });
    }

    // Detail tabs
    document.querySelectorAll(".detail-tab").forEach((t) => {
      t.classList.toggle("active", t.dataset.detailTab === activeDetailTab);
    });
    document.querySelectorAll(".detail-tab-content").forEach((c) => {
      c.classList.toggle("active", c.dataset.detailTabContent === activeDetailTab);
    });

    // Fill tab content
    fillSummaryTab(p);
    fillFiguresTab(p);
    fillNotesTab(p);
    fillRelatedTab(p);
  }

  function switchDetailTab(tab) {
    if (!tab) return;
    activeDetailTab = tab;
    renderDetail();
  }

  function fillSummaryTab(p) {
    const el = document.querySelector(".detail-tab-content[data-detail-tab-content='summary']");
    if (!el) return;
    const hasAi = !!p.llm_analysis;
    const isEnriching = p.enrichment_status === "pending" || p.enrichment_status === "running";
    el.innerHTML = `
      ${hasAi ? '<span class="badge badge-ai">AI 추출 — 검토 필요</span>' : ""}
      ${isEnriching ? '<div class="detail-section"><span class="loading-spinner"></span> LLM 분석이 백그라운드에서 진행 중입니다…</div>' : ""}
      ${p.enrichment_status === "failed" ? `<div class="detail-section" style="color:var(--danger,#c0392b)">⚠ 이전 LLM 분석 실패: ${RA.escapeHtml(p.enrichment_error || "원인 미상")} — 아래 버튼으로 재시도하세요.</div>` : ""}
      ${p.summary ? `<div class="detail-section"><div class="detail-section-title">한 줄 요약</div><p>${RA.escapeHtml(p.summary)}</p></div>` : ""}
      ${p.abstract ? `<div class="detail-section"><div class="detail-section-title">Abstract</div><p style="line-height:1.7">${RA.escapeHtml(p.abstract)}</p></div>` : ""}
      ${p.llm_analysis ? `<div class="detail-section"><div class="detail-section-title">LLM Analysis</div>${RA.renderMarkdown(p.llm_analysis)}</div>` : ""}
      <div class="detail-section">
        <button class="btn btn-gold btn-sm" id="enrich-btn">✦ LLM 분석 생성</button>
        ${p.llm_analysis ? '<button class="btn btn-ghost btn-sm" id="extract-concepts-btn" style="margin-left:8px">◈ 개념 추출</button>' : ""}
        ${p.relevance ? `<span class="text-muted text-xs" style="margin-left:10px">중요도: ${RA.escapeHtml(p.relevance)}</span>` : ""}
      </div>
      ${conceptStatusLine(p)}
    `;
    el.querySelector("#enrich-btn")?.addEventListener("click", () => enrichPaper(p));
    el.querySelector("#extract-concepts-btn")?.addEventListener("click", () => extractConcepts(p));
  }

  function conceptStatusLine(p) {
    const s = p.concept_status;
    if (s === "pending" || s === "running") {
      return '<div class="detail-section text-muted text-xs"><span class="loading-spinner"></span> 개념 추출 중…</div>';
    }
    if (s === "failed") {
      return `<div class="detail-section text-xs" style="color:var(--danger,#c0392b)">◈ 개념 추출 실패: ${RA.escapeHtml(p.concept_error || "원인 미상")}</div>`;
    }
    if (s === "done") {
      return '<div class="detail-section text-muted text-xs">◈ 개념 추출 완료 — Concepts 탭에서 확인</div>';
    }
    return "";
  }

  async function extractConcepts(p) {
    try {
      const res = await fetch(`/api/wiki/papers/${p.id}/extract-concepts`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) { RA.showToast(data.error || "추출 실패", "error"); return; }
      RA.showToast("개념 추출 시작 — 1~2분 걸려요", "info", 2500);
      const fresh = await pollConceptStatus(p.id);
      await loadPapers();
      const updated = papers.find((x) => x.id === p.id);
      if (updated) { currentPaper = updated; renderDetail(); }
      if (fresh?.concept_status === "done") RA.showToast("개념 추출 완료", "success");
      else if (fresh?.concept_status === "failed") RA.showToast("개념 추출 실패: " + (fresh.concept_error || ""), "error");
    } catch (e) {
      RA.showToast("개념 추출 실패: " + e.message, "error");
    }
  }

  async function pollConceptStatus(paperId, { intervalMs = 3000, maxWaitMs = 300000 } = {}) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      await new Promise((r) => setTimeout(r, intervalMs));
      try {
        const res = await fetch(`/api/wiki/papers/${paperId}`);
        if (!res.ok) continue;
        const fresh = await res.json();
        if (fresh.concept_status === "done" || fresh.concept_status === "failed") return fresh;
      } catch (_) {}
    }
    return null;
  }

  function fillFiguresTab(p) {
    const el = document.querySelector(".detail-tab-content[data-detail-tab-content='figures']");
    if (!el) return;

    // PDF + llm_analysis 둘 다 있으면 study의 PDF.js 렌더러 재사용
    if (p.pdf_path && p.llm_analysis && RA.study && typeof RA.study.renderPdfFigureGallery === "function") {
      // llm_analysis에서 Figure 표 섹션만 추출
      const tempDiv = document.createElement("div");
      tempDiv.innerHTML = RA.renderMarkdown(p.llm_analysis);

      let figH2 = null;
      for (const h of tempDiv.querySelectorAll("h2")) {
        if (/figure|fig/i.test(h.textContent)) { figH2 = h; break; }
      }

      el.innerHTML = "";
      if (figH2) {
        const nodes = [figH2];
        let sib = figH2.nextElementSibling;
        while (sib && !/^H[12]$/.test(sib.tagName)) { nodes.push(sib); sib = sib.nextElementSibling; }
        nodes.forEach((n) => el.appendChild(n));
      } else {
        el.innerHTML = '<div class="text-muted text-sm" style="padding:16px;text-align:center">llm_analysis에 Figure 표 섹션이 없어요.<br>Paper Study 분석 결과를 위키에 저장하면 자동 연동됩니다.</div>';
      }
      const pdfUrl = `/api/local?path=${encodeURIComponent(p.pdf_path)}`;
      RA.study.renderPdfFigureGallery(el, pdfUrl);
      return;
    }

    // 정적 figures 필드 fallback
    const figs = Array.isArray(p.figures) ? p.figures : (() => {
      try { return JSON.parse(p.figures || "[]"); } catch (_) { return []; }
    })();
    if (figs.length === 0) {
      const hasPdf = !!p.pdf_path;
      el.innerHTML = `<div class="text-muted text-sm" style="padding:24px;text-align:center">
        ${hasPdf
          ? "PDF는 연결됐지만 LLM 분석이 없어요.<br>Paper Study에서 PDF를 분석하고 Wiki에 저장하면 Figure가 표시됩니다."
          : "PDF가 연결되지 않았어요.<br>Paper Study에서 PDF를 분석하고 Wiki에 저장하면 자동으로 연동됩니다."}
      </div>`;
      return;
    }
    el.innerHTML = '<div class="figure-grid">' + figs.map((f) => `
      <div class="figure-item">
        ${f.path ? `<img src="${RA.escapeHtml(f.path)}" alt="figure">` : ""}
        ${f.caption ? `<div class="figure-caption">${RA.escapeHtml(f.caption)}</div>` : ""}
        ${f.personal_note ? `<div class="figure-caption" style="color:var(--gold-bright);font-style:italic;margin-top:4px">내 메모: ${RA.escapeHtml(f.personal_note)}</div>` : ""}
      </div>
    `).join("") + "</div>";
  }

  function fillNotesTab(p) {
    const el = document.querySelector(".detail-tab-content[data-detail-tab-content='notes']");
    if (!el) return;
    el.innerHTML = `
      <textarea class="detail-notes-editor" id="notes-editor" placeholder="Markdown 노트 — 2초 후 자동 저장됩니다">${RA.escapeHtml(p.notes || "")}</textarea>
      <div class="text-muted text-xs mt-2" id="notes-status">저장됨</div>
    `;
    const ta = el.querySelector("#notes-editor");
    const status = el.querySelector("#notes-status");
    ta.addEventListener("input", () => {
      status.textContent = "편집 중...";
      clearTimeout(notesDebounceTimer);
      notesDebounceTimer = setTimeout(async () => {
        try {
          await updatePaper(p.id, { notes: ta.value }, false);
          status.textContent = "저장됨 · " + new Date().toLocaleTimeString();
        } catch (e) {
          status.textContent = "저장 실패";
        }
      }, 2000);
    });
  }

  function fillRelatedTab(p) {
    const el = document.querySelector(".detail-tab-content[data-detail-tab-content='related']");
    if (!el) return;
    const related = Array.isArray(p.related_ids) ? p.related_ids : (() => {
      try { return JSON.parse(p.related_ids || "[]"); } catch (_) { return []; }
    })();
    if (related.length === 0) {
      el.innerHTML = '<div class="text-muted text-sm" style="padding:24px;text-align:center">연관 논문이 아직 없어요. [LLM 분석] 버튼으로 자동 생성할 수 있습니다.</div>';
      return;
    }
    el.innerHTML = related.map((rid) => {
      const target = papers.find((x) => x.id === rid);
      if (!target) return "";
      return `<div class="paper-card" data-id="${rid}" style="margin-bottom:8px;cursor:pointer">
        <div class="paper-card-title">${RA.escapeHtml(target.title || "")}</div>
        <div class="paper-card-authors">${RA.escapeHtml((target.authors || []).slice(0,2).join(", "))}</div>
      </div>`;
    }).join("");
    el.querySelectorAll(".paper-card").forEach((c) => {
      c.addEventListener("click", () => {
        const id = c.dataset.id;
        const t = papers.find((x) => x.id === id);
        if (t) openPaperDetail(t);
      });
    });
  }

  // ─── Update / actions ───────────────────────────────
  async function updatePaper(id, patch, refresh = true) {
    try {
      const updated = await RA.fetchJSON(`/api/wiki/papers/${id}`, { method: "PUT", body: patch });
      const idx = papers.findIndex((p) => p.id === id);
      if (idx >= 0) papers[idx] = updated;
      if (currentPaper && currentPaper.id === id) currentPaper = updated;
      if (refresh) {
        renderPapers();
        renderDetail();
        renderTagFilters();
      }
    } catch (e) {
      RA.showToast("저장 실패: " + e.message, "error");
    }
  }

  // 백그라운드 enrichment가 끝날 때까지 paper 상태를 폴링
  async function pollEnrichment(paperId, { intervalMs = 3000, maxWaitMs = 300000 } = {}) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      await new Promise((r) => setTimeout(r, intervalMs));
      let fresh;
      try {
        const res = await fetch(`/api/wiki/papers/${paperId}`);
        if (!res.ok) continue;
        fresh = await res.json();
      } catch (_) { continue; }
      if (fresh.enrichment_status === "done" || fresh.enrichment_status === "failed") {
        return fresh;
      }
    }
    return null; // timeout
  }

  async function enrichPaper(p) {
    RA.showToast("LLM 분석 시작...", "info", 1500);
    const el = document.querySelector(".detail-tab-content[data-detail-tab-content='summary']");
    if (!el) return;
    el.innerHTML = '<div class="loading-indicator"><span class="loading-spinner"></span><span>분석 생성 중... (1~2분 걸릴 수 있어요)</span></div>';

    try {
      await RA.fetchStream(`/api/wiki/papers/${p.id}/enrich`, { method: "POST" }, () => {});
      const fresh = await pollEnrichment(p.id);
      await loadPapers();
      const updated = papers.find((x) => x.id === p.id);
      if (updated) { currentPaper = updated; renderDetail(); renderPapers(); }
      if (fresh && fresh.enrichment_status === "done") {
        RA.showToast("LLM 분석 완료", "success");
      } else if (fresh && fresh.enrichment_status === "failed") {
        RA.showToast("분석 실패: " + (fresh.enrichment_error || "원인 미상"), "error");
      } else {
        RA.showToast("분석이 아직 진행 중입니다. 잠시 후 새로고침하세요.", "info");
      }
    } catch (e) {
      RA.showToast("분석 실패: " + e.message, "error");
    }
  }

  // ─── DOI input modal ─────────────────────────────────
  function openDoiModal() {
    RA.openModal("doi-modal");
    setTimeout(() => $("doi-input")?.focus(), 50);
  }

  async function submitDoi() {
    const doi = $("doi-input")?.value.trim();
    if (!doi) { RA.showToast("DOI를 입력하세요", "error"); return; }
    const btn = $("doi-modal-submit");
    btn.disabled = true;
    btn.textContent = "메타데이터 가져오는 중...";
    try {
      const paper = await RA.fetchJSON("/api/wiki/papers", { method: "POST", body: { doi } });
      RA.showToast(`'${paper.title?.substring(0, 50)}...' 추가됨`, "success");
      RA.closeModal("doi-modal");
      $("doi-input").value = "";
      await loadPapers();
      await loadTags();
      renderPapers();
      renderTagFilters();
      openPaperDetail(paper);
    } catch (e) {
      RA.showToast("추가 실패: " + e.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "추가";
    }
  }

  // ═══════════════════════════════════════════════════
  // CONCEPTS VIEW
  // ═══════════════════════════════════════════════════

  let concepts = [];
  let currentConcept = null;

  async function loadAndRenderConcepts() {
    const el = $("wiki-concepts");
    if (!el) return;
    el.className = "wiki-main-content concepts-grid";
    el.innerHTML = '<div class="loading-indicator"><span class="loading-spinner"></span><span>개념 문서 로드 중...</span></div>';
    try {
      concepts = await RA.fetchJSON("/api/wiki/concepts");
    } catch (e) {
      concepts = [];
    }
    renderConceptCards();
  }

  async function backfillConcepts() {
    const btn = $("concept-backfill-btn");
    if (btn) { btn.disabled = true; btn.textContent = "추출 중…"; }
    try {
      const data = await RA.fetchJSON("/api/wiki/concepts/backfill", { method: "POST" });
      if (!data.started) {
        RA.showToast("추출할 논문이 없어요 (분석 있는 논문 필요)", "info");
        if (btn) { btn.disabled = false; btn.textContent = "◈ 기존 논문에서 개념 추출"; }
        return;
      }
      RA.showToast(`${data.started}개 논문에서 개념 추출 시작 — 1~3분 걸려요`, "info", 3000);
      // 개념이 들어오기 시작하면 갱신 (최대 5분 폴링)
      const start = Date.now();
      const timer = setInterval(async () => {
        try {
          concepts = await RA.fetchJSON("/api/wiki/concepts");
          if (concepts.length > 0) { renderConceptCards(); }
        } catch (_) {}
        if (Date.now() - start > 300000) clearInterval(timer);
      }, 5000);
    } catch (e) {
      RA.showToast("추출 실패: " + e.message, "error");
      if (btn) { btn.disabled = false; btn.textContent = "◈ 기존 논문에서 개념 추출"; }
    }
  }

  // ─── 개념 지도 (force-directed graph) ──────────────────
  const EDGE_COLORS = {
    "method-of": "#7fb3d5",
    "part-of": "#9b8fd9",
    "applies-to": "#6ec5a0",
    "contrast": "#d99b9b",
    "related": "#8aa0b8",
    "co-occur": "#5a6b80",
  };

  async function renderConceptGraph() {
    const el = $("wiki-concept-graph");
    if (!el) return;
    el.className = "wiki-main-content concept-graph-wrap";
    el.innerHTML = '<div class="loading-indicator"><span class="loading-spinner"></span><span>개념 지도 생성 중...</span></div>';

    let graph;
    try {
      graph = await RA.fetchJSON("/api/wiki/concepts/graph");
    } catch (e) {
      el.innerHTML = '<div class="empty-state"><div class="empty-state-title">지도를 불러올 수 없어요</div></div>';
      return;
    }
    const { nodes, edges } = graph;
    if (!nodes || nodes.length === 0) {
      el.innerHTML = `
        <div class="empty-state" style="margin-top:80px">
          <div class="empty-state-icon">◈</div>
          <div class="empty-state-title">개념 지도가 비어 있어요</div>
          <div class="empty-state-msg">개념을 먼저 추출하세요.</div>
        </div>`;
      return;
    }

    const W = 1000, H = 680;
    const layout = computeForceLayout(nodes, edges, W, H);
    const maxPc = Math.max(1, ...nodes.map((n) => n.paper_count || 0));
    const pos = {};
    layout.forEach((n) => { pos[n.id] = n; });

    const edgeSvg = edges.map((e) => {
      const a = pos[e.from], b = pos[e.to];
      if (!a || !b) return "";
      const color = EDGE_COLORS[e.type] || EDGE_COLORS.related;
      const dash = e.source === "paper" ? ' stroke-dasharray="4 4"' : "";
      const w = e.source === "llm" ? 1.8 : 1.0;
      return `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="${color}" stroke-width="${w}" stroke-opacity="0.5"${dash}/>`;
    }).join("");

    const nodeSvg = layout.map((n) => {
      const r = 10 + 14 * Math.sqrt((n.paper_count || 0) / maxPc);
      const label = n.title.length > 22 ? n.title.slice(0, 21) + "…" : n.title;
      return `
        <g class="graph-node" data-id="${RA.escapeHtml(n.id)}" style="cursor:pointer">
          <circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${r.toFixed(1)}"
            fill="rgba(123,179,213,0.18)" stroke="#7fb3d5" stroke-width="1.5"/>
          <text x="${n.x.toFixed(1)}" y="${(n.y + r + 13).toFixed(1)}" text-anchor="middle"
            font-size="12" fill="var(--text, #cfe0f0)" style="pointer-events:none">${RA.escapeHtml(label)}</text>
        </g>`;
    }).join("");

    el.innerHTML = `
      <div class="concept-graph-bar">
        <span class="text-muted text-xs">개념 ${nodes.length}개 · 관계 ${edges.length}개 &nbsp;|&nbsp; 실선=의미 관계, 점선=같은 논문</span>
        <button class="btn btn-ghost btn-sm" id="rebuild-relations-btn">⟳ 관계 다시 분석</button>
      </div>
      <svg viewBox="0 0 ${W} ${H}" class="concept-graph-svg" preserveAspectRatio="xMidYMid meet">
        <g>${edgeSvg}</g>
        <g>${nodeSvg}</g>
      </svg>
    `;

    el.querySelectorAll(".graph-node").forEach((g) => {
      g.addEventListener("click", async () => {
        const id = g.dataset.id;
        let c = concepts.find((x) => x.id === id);
        if (!c) { try { c = await RA.fetchJSON(`/api/wiki/concepts/${id}`); } catch (_) {} }
        if (c) openConceptDetail(c);
      });
    });
    $("rebuild-relations-btn")?.addEventListener("click", rebuildRelations);
  }

  // 간단한 force-directed 레이아웃 (결정론적 — 랜덤 없음)
  function computeForceLayout(nodes, edges, W, H) {
    const cx = W / 2, cy = H / 2;
    const N = nodes.length;
    const pts = nodes.map((n, i) => {
      const ang = (2 * Math.PI * i) / N;
      return { ...n, x: cx + Math.cos(ang) * 220, y: cy + Math.sin(ang) * 180, vx: 0, vy: 0 };
    });
    const idx = {};
    pts.forEach((p, i) => { idx[p.id] = i; });
    const links = edges
      .map((e) => [idx[e.from], idx[e.to], e.source === "llm" ? 1.4 : 1.0])
      .filter(([a, b]) => a != null && b != null);

    const REPULSION = 42000, SPRING = 0.035, SPRING_LEN = 190, GRAVITY = 0.008, DAMP = 0.86;
    for (let iter = 0; iter < 300; iter++) {
      // 반발
      for (let i = 0; i < N; i++) {
        for (let j = i + 1; j < N; j++) {
          let dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y;
          let d2 = dx * dx + dy * dy || 0.01;
          const f = REPULSION / d2;
          const d = Math.sqrt(d2);
          const fx = (dx / d) * f, fy = (dy / d) * f;
          pts[i].vx += fx; pts[i].vy += fy;
          pts[j].vx -= fx; pts[j].vy -= fy;
        }
      }
      // 스프링(엣지)
      for (const [a, b, mult] of links) {
        let dx = pts[b].x - pts[a].x, dy = pts[b].y - pts[a].y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const f = SPRING * (d - SPRING_LEN) * mult;
        const fx = (dx / d) * f, fy = (dy / d) * f;
        pts[a].vx += fx; pts[a].vy += fy;
        pts[b].vx -= fx; pts[b].vy -= fy;
      }
      // 중력 + 적용
      for (const p of pts) {
        p.vx += (cx - p.x) * GRAVITY;
        p.vy += (cy - p.y) * GRAVITY;
        p.vx *= DAMP; p.vy *= DAMP;
        p.x += p.vx; p.y += p.vy;
        p.x = Math.max(60, Math.min(W - 60, p.x));
        p.y = Math.max(40, Math.min(H - 40, p.y));
      }
    }
    return pts;
  }

  async function rebuildRelations() {
    const btn = $("rebuild-relations-btn");
    if (btn) { btn.disabled = true; btn.textContent = "분석 중…"; }
    try {
      await RA.fetchJSON("/api/wiki/concepts/relations/rebuild", { method: "POST" });
      RA.showToast("관계 재분석 시작 — 의미 관계는 1~2분 후 반영", "info", 3000);
      // 논문 관계는 즉시 반영되므로 바로 다시 그림
      setTimeout(() => renderConceptGraph(), 800);
      // LLM 관계 반영을 위해 한 번 더 갱신
      setTimeout(() => { if (conceptView === "graph") renderConceptGraph(); }, 90000);
    } catch (e) {
      RA.showToast("재분석 실패: " + e.message, "error");
      if (btn) { btn.disabled = false; btn.textContent = "⟳ 관계 다시 분석"; }
    }
  }

  function renderConceptCards() {
    const el = $("wiki-concepts");
    if (!el) return;
    el.className = "wiki-main-content concepts-grid";
    if (concepts.length === 0) {
      el.innerHTML = `
        <div class="empty-state" style="grid-column:1/-1">
          <div class="empty-state-icon">🧠</div>
          <div class="empty-state-title">개념 문서가 없어요</div>
          <div class="empty-state-msg">Paper Study로 논문을 분석하고 Wiki에 저장하면<br>LLM이 자동으로 개념 문서를 추출·생성합니다.</div>
          <button class="btn btn-gold btn-sm" id="concept-backfill-btn" style="margin-top:14px">◈ 기존 논문에서 개념 추출</button>
          <div class="empty-state-msg" style="margin-top:6px;opacity:.6">분석이 있는 논문들에서 개념을 한 번에 뽑아냅니다.</div>
        </div>`;
      el.querySelector("#concept-backfill-btn")?.addEventListener("click", backfillConcepts);
      return;
    }
    el.innerHTML = "";
    for (const c of concepts) {
      el.appendChild(renderConceptCard(c));
    }
  }

  function renderConceptCard(c) {
    const card = document.createElement("div");
    card.className = "concept-card" + (currentConcept?.id === c.id ? " active" : "");
    const paperCount = Array.isArray(c.source_paper_ids) ? c.source_paper_ids.length : 0;
    const tags = Array.isArray(c.tags) ? c.tags : [];
    card.innerHTML = `
      <div class="concept-card-header">
        <span class="concept-card-title">${RA.escapeHtml(c.title)}</span>
        <span class="concept-card-count" title="소스 논문 수">${paperCount}편</span>
      </div>
      ${c.summary ? `<div class="concept-card-summary">${RA.escapeHtml(c.summary)}</div>` : ""}
      <div class="concept-card-footer">
        <span class="concept-card-date">${RA.formatDate(c.updated_at)}</span>
      </div>
    `;
    card.addEventListener("click", () => openConceptDetail(c));
    return card;
  }

  const RELATION_LABELS = {
    "method-of": "방법",
    "part-of": "구성요소",
    "applies-to": "적용",
    "contrast": "대조",
    "co-occur": "함께 등장",
    "related": "관련",
  };

  async function openConceptDetail(concept) {
    currentConcept = concept;
    const panel = $("concept-slide-panel");
    const body = $("concept-slide-body");
    if (!panel || !body) return;
    panel.classList.add("open");
    body.innerHTML = '<div class="loading-indicator"><span class="loading-spinner"></span><span>불러오는 중...</span></div>';

    // 관련 개념까지 포함한 전체 개념 로드
    let full = concept;
    try {
      full = await RA.fetchJSON(`/api/wiki/concepts/${concept.id}`);
    } catch (_) {}
    currentConcept = full;

    const paperIds = Array.isArray(full.source_paper_ids) ? full.source_paper_ids : [];
    const sourcePapers = papers.filter((p) => paperIds.includes(p.id));
    const related = Array.isArray(full.related) ? full.related : [];

    body.innerHTML = `
      <h2 class="detail-title" style="font-size:20px;margin-bottom:8px">${RA.escapeHtml(full.title)}</h2>
      ${full.summary ? `<p class="text-muted text-sm" style="margin-bottom:16px">${RA.escapeHtml(full.summary)}</p>` : ""}
      ${related.length > 0 ? `
      <div class="detail-section">
        <div class="detail-section-title">관련 개념 (${related.length})</div>
        <div class="concept-related-list">
          ${related.map((r) => `
            <button class="concept-related-chip" data-id="${RA.escapeHtml(r.id)}" title="${RA.escapeHtml(r.summary || "")}">
              <span class="concept-related-title">${RA.escapeHtml(r.title)}</span>
              <span class="concept-related-type">${RELATION_LABELS[r.relation_type] || r.relation_type}</span>
            </button>
          `).join("")}
        </div>
      </div>` : ""}
      <div class="detail-section">
        <div class="detail-section-title">개념 문서</div>
        <div class="concept-content-body">${RA.renderMarkdown(full.content || "_내용이 없습니다._")}</div>
      </div>
      ${sourcePapers.length > 0 ? `
      <div class="detail-section">
        <div class="detail-section-title">소스 논문 (${sourcePapers.length}편)</div>
        <div class="concept-source-list">
          ${sourcePapers.map((p) => `
            <div class="concept-source-item" data-id="${p.id}">
              <span class="concept-source-title">${RA.escapeHtml(p.title || "(제목 없음)")}</span>
              <span class="concept-source-meta">${RA.escapeHtml([p.journal, p.year].filter(Boolean).join(" · "))}</span>
            </div>
          `).join("")}
        </div>
      </div>` : ""}
    `;

    // 관련 개념 클릭 → 그 개념으로 이동 (공부 흐름의 핵심)
    body.querySelectorAll(".concept-related-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const target = concepts.find((c) => c.id === chip.dataset.id);
        if (target) openConceptDetail(target);
        else openConceptDetail({ id: chip.dataset.id, title: "", content: "", source_paper_ids: [] });
      });
    });

    // Source paper click → switch to papers mode and open detail
    body.querySelectorAll(".concept-source-item").forEach((item) => {
      item.addEventListener("click", () => {
        const paper = papers.find((p) => p.id === item.dataset.id);
        if (paper) { switchWikiMode("papers"); openPaperDetail(paper); }
      });
    });

    // Update active card
    document.querySelectorAll("#wiki-concepts .concept-card").forEach((c) => {
      c.classList.toggle("active", c.querySelector(".concept-card-title")?.textContent === full.title);
    });
  }

  function closeConceptPanel() {
    $("concept-slide-panel")?.classList.remove("open");
    currentConcept = null;
  }

  async function deleteConceptUI(id) {
    if (!confirm("이 개념 문서를 삭제할까요?")) return;
    try {
      await RA.fetchJSON(`/api/wiki/concepts/${id}`, { method: "DELETE" });
      RA.showToast("삭제됨", "success");
      closeConceptPanel();
      concepts = concepts.filter((c) => c.id !== id);
      renderConceptCards();
    } catch (e) {
      RA.showToast("삭제 실패: " + e.message, "error");
    }
  }

  RA.onTabFirstShown.wiki = init;
  RA.onTabShown.wiki = async () => {
    await loadPapers();
    await loadTags();
    if (wikiMode === "papers") {
      renderPapers();
      renderTagFilters();
    } else {
      await loadAndRenderConcepts();
    }
  };

  RA.wiki = { init, loadPapers, openPaperDetail };
})();
