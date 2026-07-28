// 전역 검색 (Cmd+K) — FTS5 기반 papers/concepts/chats 통합 검색
(() => {
  const $ = (id) => document.getElementById(id);
  let flatItems = [];   // 키보드 네비게이션용 평탄화 목록
  let selected = 0;
  let debounceTimer = null;
  let lastQuery = "";

  function open() {
    RA.openModal("search-modal");
    const input = $("search-input");
    if (input) {
      input.value = "";
      setTimeout(() => input.focus(), 30);
    }
    renderEmpty("검색어를 입력하세요 (논문 · 개념 · 대화)");
  }

  function close() {
    RA.closeModal("search-modal");
  }

  function renderEmpty(msg) {
    flatItems = [];
    selected = 0;
    const box = $("search-results");
    if (box) box.innerHTML = `<div class="search-empty">${RA.escapeHtml(msg)}</div>`;
  }

  async function runSearch(q) {
    lastQuery = q;
    if (q.trim().length < 2) {
      renderEmpty("두 글자 이상 입력하세요");
      return;
    }
    let data;
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      data = await res.json();
    } catch (_) {
      renderEmpty("검색 실패 — 서버 연결을 확인하세요");
      return;
    }
    if (q !== lastQuery) return; // 오래된 응답 무시
    render(data);
  }

  // snippet은 서버가 escape 없이 <mark>만 끼워 보내므로, mark 기준으로 분리해 escape
  function safeSnippet(snip) {
    if (!snip) return "";
    return snip
      .split(/(<mark>|<\/mark>)/)
      .map((part) =>
        part === "<mark>" || part === "</mark>" ? part : RA.escapeHtml(part)
      )
      .join("");
  }

  function render(data) {
    const box = $("search-results");
    if (!box) return;
    flatItems = [];
    selected = 0;

    const groups = [
      { key: "papers", label: "논문", items: data.papers || [] },
      { key: "concepts", label: "개념", items: data.concepts || [] },
      { key: "chats", label: "대화", items: data.chats || [] },
    ];
    const total = groups.reduce((n, g) => n + g.items.length, 0);
    if (total === 0) {
      renderEmpty("결과 없음");
      return;
    }

    let html = "";
    for (const g of groups) {
      if (!g.items.length) continue;
      html += `<div class="search-group-label">${g.label} (${g.items.length})</div>`;
      for (const item of g.items) {
        const idx = flatItems.length;
        flatItems.push({ type: g.key, item });
        const title =
          g.key === "chats"
            ? item.title
            : item.title + (item.year ? ` · ${item.year}` : "");
        html += `
          <div class="search-item${idx === 0 ? " active" : ""}" data-idx="${idx}">
            <div class="search-item-title">${RA.escapeHtml(title || "")}</div>
            <div class="search-item-snippet">${safeSnippet(item.snippet)}</div>
          </div>`;
      }
    }
    box.innerHTML = html;
    box.querySelectorAll(".search-item").forEach((el) => {
      el.addEventListener("click", () => openItem(parseInt(el.dataset.idx, 10)));
      el.addEventListener("mousemove", () => setSelected(parseInt(el.dataset.idx, 10)));
    });
  }

  function setSelected(idx) {
    if (idx < 0 || idx >= flatItems.length) return;
    selected = idx;
    document.querySelectorAll("#search-results .search-item").forEach((el) => {
      el.classList.toggle("active", parseInt(el.dataset.idx, 10) === idx);
    });
    const el = document.querySelector(`#search-results .search-item[data-idx="${idx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }

  async function openItem(idx) {
    const entry = flatItems[idx];
    if (!entry) return;
    close();
    const { type, item } = entry;
    if (type === "papers") {
      RA.switchTab("wiki");
      try {
        const paper = await RA.fetchJSON(`/api/wiki/papers/${item.id}`);
        // wiki 탭 첫 진입이면 init이 도는 시간을 잠깐 기다림
        setTimeout(() => RA.wiki?.openPaperDetail?.(paper), 250);
      } catch (_) {}
    } else if (type === "concepts") {
      RA.switchTab("wiki");
    } else if (type === "chats") {
      RA.switchTab("chat");
      setTimeout(() => RA.chat?.openConversation?.(item.session_id, item.title), 250);
    }
  }

  function init() {
    const input = $("search-input");
    if (!input) return;
    input.addEventListener("input", () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => runSearch(input.value), 180);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); setSelected(selected + 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setSelected(selected - 1); }
      else if (e.key === "Enter") { e.preventDefault(); openItem(selected); }
      else if (e.key === "Escape") { close(); }
    });
  }

  document.addEventListener("DOMContentLoaded", init);
  RA.search = { open, close };
})();
