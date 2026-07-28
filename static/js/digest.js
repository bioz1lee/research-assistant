/* ========================================================================
   digest.js — Daily Paper Digest 화면
   ======================================================================== */

(function () {
  const $ = (id) => document.getElementById(id);

  // State
  let digestHistory = [];   // [{id, date, status, papers_count}]
  let currentDigest = null; // full {id, date, papers, highlight, ...}
  let telegramStatus = null;
  let running = false;
  let runLog = "";

  async function init() {
    bindEvents();
    await Promise.all([loadHistory(), loadTelegramStatus()]);
    renderHistory();
    if (digestHistory.length > 0) await loadDigest(digestHistory[0].id);
    else renderEmpty();
  }

  function bindEvents() {
    $("digest-run-btn")?.addEventListener("click", runDigest);
    $("digest-telegram-btn")?.addEventListener("click", openTelegramModal);
    $("telegram-modal-close")?.addEventListener("click", () => RA.closeModal("telegram-modal"));
    $("telegram-modal-cancel")?.addEventListener("click", () => RA.closeModal("telegram-modal"));
    $("telegram-modal-save")?.addEventListener("click", saveTelegramSettings);
    $("telegram-test-btn")?.addEventListener("click", testTelegram);

    RA.newItemHandlers.digest = runDigest;
  }

  // ─── Data ────────────────────────────────────────────
  async function loadHistory() {
    try {
      digestHistory = await RA.fetchJSON("/api/digest?limit=30");
    } catch (e) {
      digestHistory = [];
    }
  }

  async function loadDigest(id) {
    try {
      currentDigest = await RA.fetchJSON(`/api/digest/${id}`);
      renderDigest();
      renderHistory();
    } catch (e) {
      currentDigest = null;
      renderEmpty();
    }
  }

  async function loadTelegramStatus() {
    try {
      telegramStatus = await RA.fetchJSON("/api/telegram/status");
    } catch (e) {
      telegramStatus = { enabled: false, connected: false };
    }
    renderTelegramBadge();
  }

  function renderTelegramBadge() {
    const el = $("telegram-status-badge");
    if (!el) return;
    if (telegramStatus && telegramStatus.connected) {
      el.className = "telegram-status connected";
      el.textContent = "Telegram 연결됨";
    } else if (telegramStatus && telegramStatus.enabled) {
      el.className = "telegram-status disconnected";
      el.textContent = "Telegram 연결 실패";
    } else {
      el.className = "telegram-status disconnected";
      el.textContent = "Telegram 미설정";
    }
  }

  // ─── Sidebar / history ─────────────────────────────
  function renderHistory() {
    const list = $("digest-history-list");
    if (!list) return;
    list.innerHTML = "";
    if (digestHistory.length === 0) {
      list.innerHTML = '<div class="text-muted text-sm" style="padding:18px;text-align:center">히스토리가 없어요</div>';
      return;
    }
    for (const h of digestHistory) {
      const isToday = new Date(h.date).toDateString() === new Date().toDateString();
      const item = document.createElement("div");
      item.className = "sidebar-item" + (currentDigest && currentDigest.id === h.id ? " active" : "");
      item.innerHTML = `
        <div class="sidebar-item-text">
          <div class="sidebar-item-title">${h.date}${isToday ? ' <span class="text-xs text-gold">(오늘)</span>' : ''}</div>
          <div class="sidebar-item-meta">${h.papers_count || 0}편 · ${h.status || ""}</div>
        </div>
      `;
      item.addEventListener("click", () => loadDigest(h.id));
      list.appendChild(item);
    }
  }

  // ─── Main content ──────────────────────────────────
  function renderEmpty() {
    const container = $("digest-content");
    if (!container) return;
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">✧</div>
        <div class="empty-state-title">Daily Paper Digest</div>
        <div class="empty-state-msg">
          매일 아침, bioRxiv와 PubMed에서 키워드 기반 최신 논문을 크롤링하여<br>
          Claude가 top 3를 선별한 다이제스트를 생성합니다.<br><br>
          Telegram 봇을 설정하면 알림으로 받고, [저장] 버튼으로 Wiki에 바로 추가할 수 있어요.
        </div>
        <div class="digest-actions mt-3">
          <button class="btn btn-primary" id="digest-empty-run-btn">✦ 지금 실행</button>
          <button class="btn btn-gold" id="digest-empty-tg-btn">Telegram 설정</button>
        </div>
      </div>
    `;
    $("digest-empty-run-btn")?.addEventListener("click", runDigest);
    $("digest-empty-tg-btn")?.addEventListener("click", openTelegramModal);
  }

  function renderDigest() {
    const container = $("digest-content");
    if (!container || !currentDigest) return;

    const papers = Array.isArray(currentDigest.papers)
      ? currentDigest.papers
      : (() => { try { return JSON.parse(currentDigest.papers || "[]"); } catch (_) { return []; } })();

    const keywords = Array.isArray(currentDigest.keywords)
      ? currentDigest.keywords
      : (() => { try { return JSON.parse(currentDigest.keywords || "[]"); } catch (_) { return []; } })();

    if (papers.length === 0) {
      container.innerHTML = `
        <div class="digest-container">
          <div class="digest-header">
            <div class="digest-date">${currentDigest.date}</div>
          </div>
          <div class="empty-state-msg">이 날짜의 다이제스트에 논문이 없습니다.</div>
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <div class="digest-container">
        <div class="digest-header">
          <div class="digest-date">${currentDigest.date} ${new Date(currentDigest.date).toDateString() === new Date().toDateString() ? "<span class='text-xs text-gold'>(오늘)</span>" : ""}</div>
          ${keywords.length ? `<div class="digest-keywords">키워드: ${RA.escapeHtml(keywords.slice(0,4).join(", "))}${keywords.length > 4 ? " ..." : ""}</div>` : ""}
        </div>
        ${papers.map((p, i) => renderPaperCard(p, i)).join("")}
        ${currentDigest.highlight ? `<div class="digest-highlight">${RA.escapeHtml(currentDigest.highlight)}</div>` : ""}
        <div class="digest-actions">
          <button class="btn btn-ghost" id="digest-telegram-btn">⚙ Telegram 설정</button>
          <button class="btn btn-primary" id="digest-run-btn">✦ 지금 실행</button>
        </div>
      </div>
    `;

    // Re-attach handlers for newly created buttons
    $("digest-run-btn")?.addEventListener("click", runDigest);
    $("digest-telegram-btn")?.addEventListener("click", openTelegramModal);

    // Per-paper buttons
    container.querySelectorAll(".digest-paper-card").forEach((card) => {
      const idx = parseInt(card.dataset.index, 10);
      const paper = papers[idx];
      card.querySelector(".btn-add-wiki")?.addEventListener("click", () => addToWiki(paper, idx));
      card.querySelector(".btn-skip")?.addEventListener("click", () => markSkip(paper, idx));
      card.querySelector(".btn-later")?.addEventListener("click", () => markLater(paper, idx));
    });
  }

  function renderPaperCard(p, idx) {
    const tags = Array.isArray(p.tags) ? p.tags : (() => { try { return JSON.parse(p.tags || "[]"); } catch (_) { return []; } })();
    const authorsShort = Array.isArray(p.authors)
      ? (p.authors.length > 2 ? `${p.authors[0]} et al.` : p.authors.join(", "))
      : (p.authors || "");
    const sourceLabel = p.is_preprint ? "bioRxiv" : (p.journal || "PubMed");

    return `
      <div class="digest-paper-card" data-index="${idx}">
        <div class="digest-paper-rank">${idx + 1}</div>
        <div class="digest-paper-meta">
          ${p.is_preprint ? '<span class="badge badge-preprint">PREPRINT</span>' : ""}
          <span>${RA.escapeHtml(sourceLabel)}</span>
          ${p.year ? `<span>· ${p.year}</span>` : ""}
          ${p.wiki_added ? '<span class="badge badge-gold">✓ Wiki 저장됨</span>' : ""}
        </div>
        <div class="digest-paper-title">${RA.escapeHtml(p.title || "")}</div>
        <div class="digest-paper-authors">${RA.escapeHtml(authorsShort)}</div>
        ${p.summary ? `<div class="digest-paper-summary">${RA.escapeHtml(p.summary)}</div>` : ""}
        <div class="digest-paper-info">
          ${p.method ? `<span class="info-item"><strong>방법:</strong> ${RA.escapeHtml(p.method)}</span>` : ""}
          ${p.cell_types ? `<span class="info-item"><strong>대상:</strong> ${RA.escapeHtml(Array.isArray(p.cell_types) ? p.cell_types.join(", ") : p.cell_types)}</span>` : ""}
          ${p.organism ? `<span class="info-item"><strong>종:</strong> ${RA.escapeHtml(p.organism)}</span>` : ""}
          ${p.geo_accession ? `<span class="info-item"><strong>GEO:</strong> ${RA.escapeHtml(p.geo_accession)}</span>` : ""}
          ${p.github_url ? `<span class="info-item"><a href="${RA.escapeHtml(p.github_url)}" target="_blank">GitHub</a></span>` : ""}
          ${p.doi ? `<span class="info-item"><a href="https://doi.org/${RA.escapeHtml(p.doi)}" target="_blank">DOI</a></span>` : ""}
        </div>
        ${tags.length ? `<div class="paper-card-tags">${tags.slice(0, 5).map((t) => `<span class="tag-pill">${RA.escapeHtml(t)}</span>`).join("")}</div>` : ""}
        <div class="digest-paper-actions">
          ${p.wiki_added
            ? '<button class="btn btn-ghost btn-sm" disabled>✓ Wiki에 저장됨</button>'
            : '<button class="btn btn-gold btn-sm btn-add-wiki">✦ Wiki에 추가</button>'}
          <button class="btn btn-ghost btn-sm btn-later">나중에</button>
          <button class="btn btn-ghost btn-sm btn-skip">건너뛰기</button>
        </div>
      </div>
    `;
  }

  // ─── Run digest ────────────────────────────────────
  async function runDigest() {
    if (running) return;
    running = true;
    runLog = "";

    const container = $("digest-content");
    if (container) {
      container.innerHTML = `
        <div class="digest-container">
          <div class="digest-running-banner">
            <div class="spinner"></div>
            <span>Digest 생성 중... 크롤 → 선별 → 저장 순으로 진행됩니다.</span>
          </div>
          <pre class="digest-log" id="digest-run-log"></pre>
        </div>
      `;
    }
    const logEl = $("digest-run-log");

    try {
      await RA.fetchStream(
        "/api/digest/run",
        { method: "POST" },
        (event) => {
          if (event.type === "log" || event.type === "progress") {
            runLog += (event.message || event.text || "") + "\n";
            if (logEl) {
              logEl.textContent = runLog;
              logEl.scrollTop = logEl.scrollHeight;
            }
          } else if (event.type === "result") {
            runLog += "✓ 완료\n";
            if (logEl) logEl.textContent = runLog;
          } else if (event.type === "error") {
            runLog += "✗ 오류: " + (event.error || "") + "\n";
            if (logEl) logEl.textContent = runLog;
          }
        }
      );
      RA.showToast("Digest 생성 완료", "success");
      await loadHistory();
      renderHistory();
      if (digestHistory.length > 0) await loadDigest(digestHistory[0].id);
    } catch (e) {
      RA.showToast("Digest 실패: " + e.message, "error");
    } finally {
      running = false;
    }
  }

  // ─── Paper actions ─────────────────────────────────
  async function addToWiki(paper, idx) {
    try {
      const payload = {
        title: paper.title,
        authors: paper.authors,
        doi: paper.doi,
        abstract: paper.abstract,
        summary: paper.summary,
        tags: paper.tags,
        is_preprint: paper.is_preprint ? 1 : 0,
        journal: paper.journal,
        year: paper.year,
        geo_accession: paper.geo_accession,
        github_url: paper.github_url,
        source: "digest",
      };
      await RA.fetchJSON("/api/wiki/papers", { method: "POST", body: payload });
      paper.wiki_added = true;
      // Persist on backend (update digest entry)
      try {
        await RA.fetchJSON(`/api/digest/${currentDigest.id}/papers/${idx}/wiki-added`, { method: "POST" });
      } catch (_) {}
      renderDigest();
      RA.showToast("Wiki에 추가됨", "success");
    } catch (e) {
      RA.showToast("추가 실패: " + e.message, "error");
    }
  }

  async function markSkip(paper, idx) {
    paper._skipped = true;
    RA.showToast("건너뛰었습니다", "info", 1200);
  }

  async function markLater(paper, idx) {
    paper._later = true;
    RA.showToast("나중에 보기로 표시했습니다", "info", 1200);
  }

  // ─── Telegram modal ────────────────────────────────
  async function openTelegramModal() {
    RA.openModal("telegram-modal");
    try {
      const settings = await RA.fetchJSON("/api/settings");
      const tg = settings?.telegram || {};
      if ($("telegram-token")) $("telegram-token").value = tg.token || "";
      if ($("telegram-chat-id")) $("telegram-chat-id").value = tg.chat_id || "";
      if ($("telegram-enabled")) $("telegram-enabled").checked = !!tg.enabled;
    } catch (e) { /* keep empty */ }
  }

  async function saveTelegramSettings() {
    const payload = {
      telegram: {
        token: $("telegram-token")?.value.trim() || "",
        chat_id: $("telegram-chat-id")?.value.trim() || "",
        enabled: !!$("telegram-enabled")?.checked,
      },
    };
    const btn = $("telegram-modal-save");
    btn.disabled = true;
    btn.textContent = "저장 중...";
    try {
      await RA.fetchJSON("/api/settings", { method: "PUT", body: payload });
      RA.showToast("Telegram 설정 저장됨", "success");
      await loadTelegramStatus();
      RA.closeModal("telegram-modal");
    } catch (e) {
      RA.showToast("저장 실패: " + e.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "저장";
    }
  }

  async function testTelegram() {
    const btn = $("telegram-test-btn");
    btn.disabled = true;
    btn.textContent = "전송 중...";
    try {
      await RA.fetchJSON("/api/telegram/test", { method: "POST" });
      RA.showToast("테스트 메시지 전송됨", "success");
    } catch (e) {
      RA.showToast("실패: " + e.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "테스트 전송";
    }
  }

  RA.onTabFirstShown.digest = init;
  RA.onTabShown.digest = async () => {
    await loadHistory();
    renderHistory();
    if (currentDigest) renderDigest();
  };

  RA.digest = { init };
})();
