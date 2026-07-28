/* ========================================================================
   chat.js — Chat 화면 (대화목록, 메시지 전송, SSE 스트리밍, 프로젝트 선택)
   ======================================================================== */

(function () {
  const $ = (id) => document.getElementById(id);

  // State
  let sessionId = null;
  let sending = false;
  let abortController = null;
  let attachments = [];
  let lastInputTokens = 0;
  let lastNumTurns = 0;
  let activeProject = null; // { id, name, knowledge_files }
  let projects = [];
  let conversations = [];
  let searchQuery = "";
  let sidebarTab = "conversations"; // "conversations" | "bookmarks"
  let bookmarks = [];
  let lastSentPayload = null; // for network-error retry
  let planMode = false; // 안전모드: claude가 계획만 세우고 변경/실행 안 함

  const DEFAULT_MODEL = "claude-opus-5";
  const MODEL_CONTEXT = {
    "claude-opus-5": 1000000,
    "claude-fable-5": 1000000,
    "claude-sonnet-5": 1000000,
    "claude-haiku-4-5": 200000,
    "": 200000,
  };
  let maxContext = MODEL_CONTEXT[DEFAULT_MODEL];

  // ─── Init function (called from tab show) ───────────
  async function init() {
    bindEvents();
    await loadProjects();
    await loadConversations();
    showEmpty();
  }

  // ─── DOM references (lazy) ───────────────────────────
  function refs() {
    return {
      messages: $("chat-messages"),
      input: $("chat-input"),
      sendBtn: $("chat-send-btn"),
      modelSelect: $("model-select"),
      planToggle: $("plan-toggle"),
      projectSelect: $("project-select"),
      contextBadge: $("chat-context-badge"),
      contextBar: $("context-bar"),
      contextFill: $("context-fill"),
      contextLabel: $("context-label"),
      attachBtn: $("chat-attach-btn"),
      attachPathBtn: $("chat-attach-path-btn"),
      attachInput: $("chat-attach-input"),
      attachPreview: $("attachments-preview"),
      pathInputRow: $("chat-path-input-row"),
      pathInput: $("chat-path-input"),
      pathInputConfirm: $("chat-path-input-confirm"),
      pathInputCancel: $("chat-path-input-cancel"),
      newChatBtn: $("new-chat-btn"),
      convList: $("conversation-list"),
      sidebarSearch: $("conversation-search"),
      sidebarTabsBtns: document.querySelectorAll("#sidebar-chat .sidebar-tab"),
    };
  }

  // ─── Event bindings ──────────────────────────────────
  function bindEvents() {
    const R = refs();

    // Send button / Enter
    R.sendBtn.addEventListener("click", () => {
      if (sending) abortSend();
      else sendMessage();
    });
    R.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    R.input.addEventListener("input", () => {
      R.input.style.height = "auto";
      R.input.style.height = Math.min(R.input.scrollHeight, 200) + "px";
    });

    // 안전모드(plan) 토글
    if (R.planToggle) {
      R.planToggle.addEventListener("click", () => {
        planMode = !planMode;
        R.planToggle.classList.toggle("active", planMode);
        R.planToggle.setAttribute("aria-pressed", planMode ? "true" : "false");
      });
    }

    // New chat
    R.newChatBtn.addEventListener("click", () => newChat());

    // Project select
    if (R.projectSelect) {
      R.projectSelect.addEventListener("change", () => {
        const id = R.projectSelect.value;
        if (id) {
          const proj = projects.find((p) => p.id === id);
          activeProject = proj || null;
        } else {
          activeProject = null;
        }
        updateContextBadge();
        if (activeProject) {
          RA.showToast(`프로젝트 '${activeProject.name}' 적용됨 — 다음 메시지부터 컨텍스트가 주입됩니다`, "info", 2500);
        }
      });
    }

    // Attach
    if (R.attachBtn) {
      R.attachBtn.addEventListener("click", () => R.attachInput.click());
      R.attachInput.addEventListener("change", (e) => {
        handleFiles(e.target.files);
        R.attachInput.value = "";
      });
    }
    if (R.attachPathBtn) {
      R.attachPathBtn.addEventListener("click", () => {
        R.pathInputRow.style.display = "flex";
        R.pathInput.value = "";
        R.pathInput.focus();
      });
      R.pathInputConfirm.addEventListener("click", confirmPathAttach);
      R.pathInputCancel.addEventListener("click", () => R.pathInputRow.style.display = "none");
      R.pathInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); confirmPathAttach(); }
        if (e.key === "Escape") R.pathInputRow.style.display = "none";
      });
    }

    // Drag and drop
    const inputArea = $("chat-input-area");
    if (inputArea) {
      inputArea.addEventListener("dragover", (e) => {
        e.preventDefault();
        inputArea.classList.add("drag-over");
      });
      inputArea.addEventListener("dragleave", () => inputArea.classList.remove("drag-over"));
      inputArea.addEventListener("drop", (e) => {
        e.preventDefault();
        inputArea.classList.remove("drag-over");
        if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
      });
    }

    // Sidebar tabs
    R.sidebarTabsBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        R.sidebarTabsBtns.forEach((b) => b.classList.toggle("active", b === btn));
        sidebarTab = btn.dataset.tab;
        if (sidebarTab === "conversations") loadConversations();
        else loadBookmarks();
      });
    });

    // Sidebar search
    if (R.sidebarSearch) {
      R.sidebarSearch.addEventListener("input", RA.debounce((e) => {
        searchQuery = e.target.value.trim();
        if (sidebarTab === "conversations") renderConversations();
        else renderBookmarks();
      }, 150));
    }

    // Model select
    if (R.modelSelect) {
      R.modelSelect.addEventListener("change", () => {
        maxContext = MODEL_CONTEXT[R.modelSelect.value] || 200000;
        if (lastInputTokens) updateContextBar();
      });
    }

    // Register "new" handler
    RA.newItemHandlers.chat = () => newChat();
  }

  // ─── Projects dropdown ──────────────────────────────
  async function loadProjects() {
    try {
      projects = await RA.fetchJSON("/api/projects");
      const R = refs();
      if (!R.projectSelect) return;
      R.projectSelect.innerHTML = '<option value="">프로젝트 없음</option>';
      for (const p of projects) {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = p.name + (p.is_active ? " ●" : "");
        R.projectSelect.appendChild(opt);
      }
      // 기본값은 항상 '프로젝트 없음' — 프로젝트는 사용자가 명시적으로 선택
      R.projectSelect.value = "";
      activeProject = null;
      updateContextBadge();
    } catch (e) {
      // Projects API may not yet exist — non-fatal
      projects = [];
    }
  }

  function updateContextBadge() {
    const R = refs();
    if (!R.contextBadge) return;
    if (activeProject) {
      const nFiles = (activeProject.knowledge_files
        ? (Array.isArray(activeProject.knowledge_files) ? activeProject.knowledge_files : JSON.parse(activeProject.knowledge_files || "[]"))
        : []).length;
      const hasPrompt = !!activeProject.system_prompt;
      R.contextBadge.classList.remove("empty");
      R.contextBadge.innerHTML = `
        <span class="dot"></span>
        <strong>${RA.escapeHtml(activeProject.name)}</strong>
        <span class="text-muted">·</span>
        <span>${nFiles} 파일</span>
        ${hasPrompt ? '<span class="text-muted">·</span><span>Custom prompt</span>' : ""}
      `;
    } else {
      R.contextBadge.classList.add("empty");
      R.contextBadge.innerHTML = '<span class="dot"></span><span>프로젝트 없음 — 기본 컨텍스트</span>';
    }
  }

  // ─── Conversations ──────────────────────────────────
  async function loadConversations() {
    try {
      conversations = await RA.fetchJSON("/api/conversations");
    } catch (e) {
      conversations = [];
    }
    renderConversations();
  }

  function renderConversations() {
    const R = refs();
    if (!R.convList) return;
    R.convList.innerHTML = "";
    const filtered = searchQuery
      ? conversations.filter((c) => (c.title || "").toLowerCase().includes(searchQuery.toLowerCase()))
      : conversations;

    if (filtered.length === 0) {
      R.convList.innerHTML = `<div class="text-muted text-sm" style="padding:18px;text-align:center">${
        searchQuery ? "검색 결과 없음" : "아직 대화가 없어요"
      }</div>`;
      return;
    }

    const groups = {};
    const order = ["오늘", "어제", "이번 주", "지난 주", "이전"];
    for (const c of filtered) {
      const g = RA.getDateGroup(c.updated_at || c.created_at);
      if (!groups[g]) groups[g] = [];
      groups[g].push(c);
    }

    for (const groupName of order) {
      if (!groups[groupName]) continue;
      if (!searchQuery) {
        const lbl = document.createElement("div");
        lbl.className = "sidebar-group-label";
        lbl.textContent = groupName;
        R.convList.appendChild(lbl);
      }
      for (const c of groups[groupName]) {
        const item = document.createElement("div");
        item.className = "sidebar-item" + (c.session_id === sessionId ? " active" : "");
        item.innerHTML = `
          <div class="sidebar-item-text">
            <div class="sidebar-item-title">${RA.escapeHtml(c.title || "새 대화")}</div>
            <div class="sidebar-item-meta">${RA.formatDateShort(c.updated_at)}</div>
          </div>
          <button class="sidebar-item-delete" title="삭제">×</button>
        `;
        item.addEventListener("click", () => openConversation(c.session_id, c.title));
        item.querySelector(".sidebar-item-delete").addEventListener("click", async (e) => {
          e.stopPropagation();
          if (!confirm("이 대화를 삭제하시겠습니까?")) return;
          try {
            await RA.fetchJSON(`/api/conversations/${c.session_id}`, { method: "DELETE" });
            if (sessionId === c.session_id) { sessionId = null; showEmpty(); }
            await loadConversations();
          } catch (e) {
            RA.showToast("삭제 실패", "error");
          }
        });
        R.convList.appendChild(item);
      }
    }
  }

  async function openConversation(sid, title) {
    sessionId = sid;
    const R = refs();
    R.messages.innerHTML = "";
    try {
      const messages = await RA.fetchJSON(`/api/conversations/${sid}/messages`);
      if (Array.isArray(messages) && messages.length > 0) {
        for (const msg of messages) {
          const div = addMessage(msg.role, msg.content);
          if (msg.role === "assistant") addBookmarkBtn(div, msg.content);
        }
      } else {
        addMessage("assistant", `이전 대화를 이어갑니다: "${RA.escapeHtml(title || "")}"`);
      }
    } catch (e) {
      addMessage("assistant", "대화를 불러올 수 없습니다.");
    }
    renderConversations();
  }

  // ─── Bookmarks ──────────────────────────────────────
  async function loadBookmarks() {
    try {
      bookmarks = await RA.fetchJSON("/api/bookmarks");
    } catch (e) {
      bookmarks = [];
    }
    renderBookmarks();
  }

  function renderBookmarks() {
    const R = refs();
    if (!R.convList) return;
    R.convList.innerHTML = "";
    const filtered = searchQuery
      ? bookmarks.filter((b) => (b.title || "").toLowerCase().includes(searchQuery.toLowerCase()))
      : bookmarks;

    if (filtered.length === 0) {
      R.convList.innerHTML = `<div class="text-muted text-sm" style="padding:18px;text-align:center">${
        searchQuery ? "검색 결과 없음" : "북마크가 없어요"
      }</div>`;
      return;
    }
    for (const b of filtered) {
      const item = document.createElement("div");
      item.className = "sidebar-item";
      item.innerHTML = `
        <div class="sidebar-item-text">
          <div class="sidebar-item-title">★ ${RA.escapeHtml(b.title || "")}</div>
          <div class="sidebar-item-meta">${RA.formatDateShort(b.created_at)}</div>
        </div>
        <button class="sidebar-item-delete" title="삭제">×</button>
      `;
      item.addEventListener("click", () => {
        const R2 = refs();
        R2.messages.innerHTML = "";
        addMessage("assistant", b.content || "");
      });
      item.querySelector(".sidebar-item-delete").addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          await RA.fetchJSON(`/api/bookmarks/${b.id}`, { method: "DELETE" });
          await loadBookmarks();
        } catch (e) {
          RA.showToast("삭제 실패", "error");
        }
      });
      R.convList.appendChild(item);
    }
  }

  // ─── New chat ───────────────────────────────────────
  function newChat() {
    sessionId = null;
    attachments = [];
    lastInputTokens = 0;
    lastNumTurns = 0;
    renderAttachments();
    showEmpty();
    const R = refs();
    R.input.focus();
    R.contextBar?.classList.remove("visible");
    renderConversations();
  }

  const _ORN = `<svg class="empty-orn" viewBox="0 0 500 68" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <filter id="og" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur in="SourceGraphic" stdDeviation="1.8" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <filter id="glow" x="-60%" y="-60%" width="220%" height="220%">
        <feGaussianBlur in="SourceGraphic" stdDeviation="2.8" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <filter id="crisp" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur in="SourceGraphic" stdDeviation="0.6" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>

    <!-- ════ 좌측 라인 (글로우 3겹) ════ -->
    <line x1="28" y1="34" x2="183" y2="34" stroke="rgba(120,185,255,0.06)" stroke-width="4.0" stroke-linecap="round"/>
    <line x1="28" y1="34" x2="183" y2="34" stroke="rgba(155,210,255,0.14)" stroke-width="1.4" stroke-linecap="round"/>
    <line x1="28" y1="34" x2="183" y2="34" stroke="rgba(185,228,255,0.28)" stroke-width="0.55" stroke-linecap="round"/>
    <line x1="42" y1="31" x2="176" y2="31" stroke="rgba(160,215,255,0.10)" stroke-width="0.30" stroke-linecap="round"/>

    <!-- ════ 우측 라인 (글로우 3겹) ════ -->
    <line x1="317" y1="34" x2="472" y2="34" stroke="rgba(120,185,255,0.06)" stroke-width="4.0" stroke-linecap="round"/>
    <line x1="317" y1="34" x2="472" y2="34" stroke="rgba(155,210,255,0.14)" stroke-width="1.4" stroke-linecap="round"/>
    <line x1="317" y1="34" x2="472" y2="34" stroke="rgba(185,228,255,0.28)" stroke-width="0.55" stroke-linecap="round"/>
    <line x1="330" y1="31" x2="458" y2="31" stroke="rgba(160,215,255,0.10)" stroke-width="0.30" stroke-linecap="round"/>

    <!-- ════ 중앙 연결선 (글로우 3겹) ════ -->
    <line x1="116" y1="34" x2="235" y2="34" stroke="rgba(120,185,255,0.05)" stroke-width="3.5" stroke-linecap="round"/>
    <line x1="116" y1="34" x2="235" y2="34" stroke="rgba(155,210,255,0.12)" stroke-width="1.2" stroke-linecap="round"/>
    <line x1="116" y1="34" x2="235" y2="34" stroke="rgba(185,228,255,0.24)" stroke-width="0.50" stroke-linecap="round"/>
    <line x1="265" y1="34" x2="384" y2="34" stroke="rgba(120,185,255,0.05)" stroke-width="3.5" stroke-linecap="round"/>
    <line x1="265" y1="34" x2="384" y2="34" stroke="rgba(155,210,255,0.12)" stroke-width="1.2" stroke-linecap="round"/>
    <line x1="265" y1="34" x2="384" y2="34" stroke="rgba(185,228,255,0.24)" stroke-width="0.50" stroke-linecap="round"/>

    <!-- ════ 좌측 라인 반짝이 점들 ════ -->
    <circle cx="50"  cy="34" r="1.05" fill="rgba(230,248,255,0.70)" class="pearl"   filter="url(#crisp)"/>
    <circle cx="70"  cy="34" r="0.80" fill="rgba(215,242,255,0.50)" class="pearl-b"/>
    <circle cx="90"  cy="34" r="1.05" fill="rgba(230,248,255,0.68)" class="pearl"   filter="url(#crisp)"/>
    <circle cx="110" cy="34" r="0.80" fill="rgba(215,242,255,0.48)" class="pearl-b"/>
    <circle cx="138" cy="34" r="1.10" fill="rgba(235,250,255,0.72)" class="pearl"   filter="url(#crisp)"/>
    <circle cx="158" cy="34" r="0.80" fill="rgba(215,242,255,0.48)" class="pearl-b"/>
    <circle cx="174" cy="34" r="0.95" fill="rgba(228,246,255,0.60)" class="pearl"   filter="url(#crisp)"/>

    <!-- ════ 우측 라인 반짝이 점들 ════ -->
    <circle cx="326" cy="34" r="0.95" fill="rgba(228,246,255,0.60)" class="pearl"   filter="url(#crisp)"/>
    <circle cx="342" cy="34" r="0.80" fill="rgba(215,242,255,0.48)" class="pearl-b"/>
    <circle cx="362" cy="34" r="1.10" fill="rgba(235,250,255,0.72)" class="pearl"   filter="url(#crisp)"/>
    <circle cx="390" cy="34" r="0.80" fill="rgba(215,242,255,0.48)" class="pearl-b"/>
    <circle cx="410" cy="34" r="1.05" fill="rgba(230,248,255,0.68)" class="pearl"   filter="url(#crisp)"/>
    <circle cx="430" cy="34" r="0.80" fill="rgba(215,242,255,0.50)" class="pearl-b"/>
    <circle cx="450" cy="34" r="1.05" fill="rgba(230,248,255,0.70)" class="pearl"   filter="url(#crisp)"/>

    <!-- ════ 중앙 연결선 반짝이 점들 ════ -->
    <circle cx="132" cy="34" r="0.85" fill="rgba(222,245,255,0.55)" class="pearl"   filter="url(#crisp)"/>
    <circle cx="150" cy="34" r="0.75" fill="rgba(210,240,255,0.42)" class="pearl-b"/>
    <circle cx="168" cy="34" r="0.90" fill="rgba(225,246,255,0.58)" class="pearl"   filter="url(#crisp)"/>
    <circle cx="188" cy="34" r="0.75" fill="rgba(210,240,255,0.42)" class="pearl-b"/>
    <circle cx="208" cy="34" r="0.90" fill="rgba(225,246,255,0.58)" class="pearl"   filter="url(#crisp)"/>
    <circle cx="222" cy="34" r="0.75" fill="rgba(210,240,255,0.42)" class="pearl-b"/>
    <circle cx="278" cy="34" r="0.75" fill="rgba(210,240,255,0.42)" class="pearl-b"/>
    <circle cx="292" cy="34" r="0.90" fill="rgba(225,246,255,0.58)" class="pearl"   filter="url(#crisp)"/>
    <circle cx="312" cy="34" r="0.75" fill="rgba(210,240,255,0.42)" class="pearl-b"/>
    <circle cx="332" cy="34" r="0.90" fill="rgba(225,246,255,0.58)" class="pearl"   filter="url(#crisp)"/>
    <circle cx="350" cy="34" r="0.75" fill="rgba(210,240,255,0.42)" class="pearl-b"/>
    <circle cx="368" cy="34" r="0.85" fill="rgba(222,245,255,0.55)" class="pearl"   filter="url(#crisp)"/>

    <!-- ════ 좌측 얼음 가지 장식 ════ -->
    <path d="M 44 34 Q 53 23 65 20 Q 75 18 79 25" fill="none" stroke="rgba(165,218,255,0.28)" stroke-width="1.2" stroke-linecap="round"/>
    <path d="M 44 34 Q 53 23 65 20 Q 75 18 79 25" fill="none" stroke="rgba(195,232,255,0.38)" stroke-width="0.65" stroke-linecap="round"/>
    <circle cx="79" cy="25" r="1.6" fill="rgba(218,245,255,0.72)" filter="url(#og)"/>
    <path d="M 122 34 Q 128 26 136 24" fill="none" stroke="rgba(165,218,255,0.24)" stroke-width="0.85" stroke-linecap="round"/>
    <path d="M 122 34 Q 128 26 136 24" fill="none" stroke="rgba(190,228,255,0.32)" stroke-width="0.45" stroke-linecap="round"/>
    <circle cx="136" cy="24" r="1.2" fill="rgba(212,242,255,0.60)" filter="url(#crisp)"/>

    <!-- ════ 우측 얼음 가지 장식 (대칭) ════ -->
    <path d="M 456 34 Q 447 23 435 20 Q 425 18 421 25" fill="none" stroke="rgba(165,218,255,0.28)" stroke-width="1.2" stroke-linecap="round"/>
    <path d="M 456 34 Q 447 23 435 20 Q 425 18 421 25" fill="none" stroke="rgba(195,232,255,0.38)" stroke-width="0.65" stroke-linecap="round"/>
    <circle cx="421" cy="25" r="1.6" fill="rgba(218,245,255,0.72)" filter="url(#og)"/>
    <path d="M 378 34 Q 372 26 364 24" fill="none" stroke="rgba(165,218,255,0.24)" stroke-width="0.85" stroke-linecap="round"/>
    <path d="M 378 34 Q 372 26 364 24" fill="none" stroke="rgba(190,228,255,0.32)" stroke-width="0.45" stroke-linecap="round"/>
    <circle cx="364" cy="24" r="1.2" fill="rgba(212,242,255,0.60)" filter="url(#crisp)"/>

    <!-- ════ 좌측 Y형 서리 가지 ════ -->
    <line x1="60"  cy="34" x1="60"  y1="34" x2="60"  y2="27" stroke="rgba(165,215,255,0.32)" stroke-width="0.50"/>
    <line x1="60"  y1="30" x2="56"  y2="26" stroke="rgba(165,215,255,0.22)" stroke-width="0.36"/>
    <line x1="60"  y1="30" x2="64"  y2="26" stroke="rgba(165,215,255,0.22)" stroke-width="0.36"/>
    <circle cx="60"  cy="27" r="0.70" fill="rgba(205,238,255,0.55)"/>
    <circle cx="56"  cy="26" r="0.52" fill="rgba(200,235,255,0.40)"/>
    <circle cx="64"  cy="26" r="0.52" fill="rgba(200,235,255,0.40)"/>

    <line x1="80"  y1="34" x2="80"  y2="26" stroke="rgba(165,215,255,0.34)" stroke-width="0.52"/>
    <line x1="80"  y1="29" x2="76"  y2="25" stroke="rgba(165,215,255,0.24)" stroke-width="0.38"/>
    <line x1="80"  y1="29" x2="84"  y2="25" stroke="rgba(165,215,255,0.24)" stroke-width="0.38"/>
    <circle cx="80"  cy="26" r="0.72" fill="rgba(208,240,255,0.58)"/>
    <circle cx="76"  cy="25" r="0.54" fill="rgba(202,236,255,0.42)"/>
    <circle cx="84"  cy="25" r="0.54" fill="rgba(202,236,255,0.42)"/>

    <line x1="148" y1="34" x2="148" y2="27" stroke="rgba(165,215,255,0.30)" stroke-width="0.48"/>
    <line x1="148" y1="30" x2="144" y2="26" stroke="rgba(165,215,255,0.20)" stroke-width="0.34"/>
    <line x1="148" y1="30" x2="152" y2="26" stroke="rgba(165,215,255,0.20)" stroke-width="0.34"/>
    <circle cx="148" cy="27" r="0.68" fill="rgba(205,238,255,0.52)"/>

    <line x1="165" y1="34" x2="165" y2="28" stroke="rgba(165,215,255,0.26)" stroke-width="0.44"/>
    <line x1="165" y1="30" x2="161" y2="27" stroke="rgba(165,215,255,0.18)" stroke-width="0.30"/>
    <line x1="165" y1="30" x2="169" y2="27" stroke="rgba(165,215,255,0.18)" stroke-width="0.30"/>

    <line x1="200" y1="34" x2="200" y2="28" stroke="rgba(165,215,255,0.24)" stroke-width="0.42"/>
    <line x1="200" y1="31" x2="196" y2="27" stroke="rgba(165,215,255,0.16)" stroke-width="0.28"/>
    <line x1="200" y1="31" x2="204" y2="27" stroke="rgba(165,215,255,0.16)" stroke-width="0.28"/>

    <line x1="218" y1="34" x2="218" y2="29" stroke="rgba(165,215,255,0.20)" stroke-width="0.36"/>
    <line x1="218" y1="31" x2="215" y2="28" stroke="rgba(165,215,255,0.13)" stroke-width="0.24"/>
    <line x1="218" y1="31" x2="221" y2="28" stroke="rgba(165,215,255,0.13)" stroke-width="0.24"/>

    <!-- ════ 우측 Y형 서리 가지 (대칭) ════ -->
    <line x1="440" y1="34" x2="440" y2="27" stroke="rgba(165,215,255,0.32)" stroke-width="0.50"/>
    <line x1="440" y1="30" x2="436" y2="26" stroke="rgba(165,215,255,0.22)" stroke-width="0.36"/>
    <line x1="440" y1="30" x2="444" y2="26" stroke="rgba(165,215,255,0.22)" stroke-width="0.36"/>
    <circle cx="440" cy="27" r="0.70" fill="rgba(205,238,255,0.55)"/>
    <circle cx="436" cy="26" r="0.52" fill="rgba(200,235,255,0.40)"/>
    <circle cx="444" cy="26" r="0.52" fill="rgba(200,235,255,0.40)"/>

    <line x1="420" y1="34" x2="420" y2="26" stroke="rgba(165,215,255,0.34)" stroke-width="0.52"/>
    <line x1="420" y1="29" x2="416" y2="25" stroke="rgba(165,215,255,0.24)" stroke-width="0.38"/>
    <line x1="420" y1="29" x2="424" y2="25" stroke="rgba(165,215,255,0.24)" stroke-width="0.38"/>
    <circle cx="420" cy="26" r="0.72" fill="rgba(208,240,255,0.58)"/>
    <circle cx="416" cy="25" r="0.54" fill="rgba(202,236,255,0.42)"/>
    <circle cx="424" cy="25" r="0.54" fill="rgba(202,236,255,0.42)"/>

    <line x1="352" y1="34" x2="352" y2="27" stroke="rgba(165,215,255,0.30)" stroke-width="0.48"/>
    <line x1="352" y1="30" x2="348" y2="26" stroke="rgba(165,215,255,0.20)" stroke-width="0.34"/>
    <line x1="352" y1="30" x2="356" y2="26" stroke="rgba(165,215,255,0.20)" stroke-width="0.34"/>
    <circle cx="352" cy="27" r="0.68" fill="rgba(205,238,255,0.52)"/>

    <line x1="335" y1="34" x2="335" y2="28" stroke="rgba(165,215,255,0.26)" stroke-width="0.44"/>
    <line x1="335" y1="30" x2="331" y2="27" stroke="rgba(165,215,255,0.18)" stroke-width="0.30"/>
    <line x1="335" y1="30" x2="339" y2="27" stroke="rgba(165,215,255,0.18)" stroke-width="0.30"/>

    <line x1="300" y1="34" x2="300" y2="28" stroke="rgba(165,215,255,0.24)" stroke-width="0.42"/>
    <line x1="300" y1="31" x2="296" y2="27" stroke="rgba(165,215,255,0.16)" stroke-width="0.28"/>
    <line x1="300" y1="31" x2="304" y2="27" stroke="rgba(165,215,255,0.16)" stroke-width="0.28"/>

    <line x1="282" y1="34" x2="282" y2="29" stroke="rgba(165,215,255,0.20)" stroke-width="0.36"/>
    <line x1="282" y1="31" x2="279" y2="28" stroke="rgba(165,215,255,0.13)" stroke-width="0.24"/>
    <line x1="282" y1="31" x2="285" y2="28" stroke="rgba(165,215,255,0.13)" stroke-width="0.24"/>

    <!-- ════ 좌측 얼음꽃 at x=105 ════ -->
    <g transform="translate(105,34)">
      <circle cx="0" cy="0" r="8.5" fill="rgba(140,200,255,0.06)" filter="url(#og)"/>
      <ellipse cx="0" cy="-6.5" rx="2.7" ry="6.5" fill="rgba(205,238,255,0.54)" stroke="rgba(185,225,255,0.30)" stroke-width="0.45"/>
      <ellipse cx="0" cy="-6.5" rx="2.7" ry="6.5" fill="rgba(205,238,255,0.54)" stroke="rgba(185,225,255,0.30)" stroke-width="0.45" transform="rotate(60)"/>
      <ellipse cx="0" cy="-6.5" rx="2.7" ry="6.5" fill="rgba(205,238,255,0.54)" stroke="rgba(185,225,255,0.30)" stroke-width="0.45" transform="rotate(120)"/>
      <ellipse cx="0" cy="-6.5" rx="2.7" ry="6.5" fill="rgba(205,238,255,0.54)" stroke="rgba(185,225,255,0.30)" stroke-width="0.45" transform="rotate(180)"/>
      <ellipse cx="0" cy="-6.5" rx="2.7" ry="6.5" fill="rgba(205,238,255,0.54)" stroke="rgba(185,225,255,0.30)" stroke-width="0.45" transform="rotate(240)"/>
      <ellipse cx="0" cy="-6.5" rx="2.7" ry="6.5" fill="rgba(205,238,255,0.54)" stroke="rgba(185,225,255,0.30)" stroke-width="0.45" transform="rotate(300)"/>
      <circle cx="0" cy="0" r="2.8" fill="rgba(230,250,255,0.90)"/>
      <circle cx="0" cy="0" r="1.2" fill="rgba(252,255,255,0.98)"/>
    </g>

    <!-- ════ 우측 얼음꽃 at x=395 ════ -->
    <g transform="translate(395,34)">
      <circle cx="0" cy="0" r="8.5" fill="rgba(140,200,255,0.06)" filter="url(#og)"/>
      <ellipse cx="0" cy="-6.5" rx="2.7" ry="6.5" fill="rgba(205,238,255,0.54)" stroke="rgba(185,225,255,0.30)" stroke-width="0.45"/>
      <ellipse cx="0" cy="-6.5" rx="2.7" ry="6.5" fill="rgba(205,238,255,0.54)" stroke="rgba(185,225,255,0.30)" stroke-width="0.45" transform="rotate(60)"/>
      <ellipse cx="0" cy="-6.5" rx="2.7" ry="6.5" fill="rgba(205,238,255,0.54)" stroke="rgba(185,225,255,0.30)" stroke-width="0.45" transform="rotate(120)"/>
      <ellipse cx="0" cy="-6.5" rx="2.7" ry="6.5" fill="rgba(205,238,255,0.54)" stroke="rgba(185,225,255,0.30)" stroke-width="0.45" transform="rotate(180)"/>
      <ellipse cx="0" cy="-6.5" rx="2.7" ry="6.5" fill="rgba(205,238,255,0.54)" stroke="rgba(185,225,255,0.30)" stroke-width="0.45" transform="rotate(240)"/>
      <ellipse cx="0" cy="-6.5" rx="2.7" ry="6.5" fill="rgba(205,238,255,0.54)" stroke="rgba(185,225,255,0.30)" stroke-width="0.45" transform="rotate(300)"/>
      <circle cx="0" cy="0" r="2.8" fill="rgba(230,250,255,0.90)"/>
      <circle cx="0" cy="0" r="1.2" fill="rgba(252,255,255,0.98)"/>
    </g>

    <!-- ════ 중앙 대형 얼음꽃 (3-tier, 12-petal+detail) at (250,34) ════ -->
    <g transform="translate(250,34)">
      <!-- 외곽 글로우 헤일로 -->
      <circle cx="0" cy="0" r="16" fill="rgba(130,195,255,0.06)" filter="url(#glow)"/>
      <circle cx="0" cy="0" r="13" fill="rgba(155,210,255,0.08)" filter="url(#og)"/>

      <!-- 1층: 외곽 6 꽃잎 -->
      <ellipse cx="0" cy="-13" rx="5.2" ry="13" fill="rgba(200,236,255,0.50)" stroke="rgba(180,222,255,0.28)" stroke-width="0.5" filter="url(#og)"/>
      <ellipse cx="0" cy="-13" rx="5.2" ry="13" fill="rgba(200,236,255,0.50)" stroke="rgba(180,222,255,0.28)" stroke-width="0.5" transform="rotate(60)"  filter="url(#og)"/>
      <ellipse cx="0" cy="-13" rx="5.2" ry="13" fill="rgba(200,236,255,0.50)" stroke="rgba(180,222,255,0.28)" stroke-width="0.5" transform="rotate(120)" filter="url(#og)"/>
      <ellipse cx="0" cy="-13" rx="5.2" ry="13" fill="rgba(200,236,255,0.50)" stroke="rgba(180,222,255,0.28)" stroke-width="0.5" transform="rotate(180)" filter="url(#og)"/>
      <ellipse cx="0" cy="-13" rx="5.2" ry="13" fill="rgba(200,236,255,0.50)" stroke="rgba(180,222,255,0.28)" stroke-width="0.5" transform="rotate(240)" filter="url(#og)"/>
      <ellipse cx="0" cy="-13" rx="5.2" ry="13" fill="rgba(200,236,255,0.50)" stroke="rgba(180,222,255,0.28)" stroke-width="0.5" transform="rotate(300)" filter="url(#og)"/>

      <!-- 꽃잎 끝 반짝이 점 (6개, 각 꽃잎 끝에) -->
      <circle cx="0"    cy="-13" r="1.4" fill="rgba(235,252,255,0.88)" filter="url(#crisp)"/>
      <circle cx="11.3" cy="-6.5" r="1.2" fill="rgba(230,250,255,0.78)" filter="url(#crisp)"/>
      <circle cx="11.3" cy="6.5"  r="1.2" fill="rgba(230,250,255,0.78)" filter="url(#crisp)"/>
      <circle cx="0"    cy="13"   r="1.4" fill="rgba(235,252,255,0.88)" filter="url(#crisp)"/>
      <circle cx="-11.3" cy="6.5" r="1.2" fill="rgba(230,250,255,0.78)" filter="url(#crisp)"/>
      <circle cx="-11.3" cy="-6.5" r="1.2" fill="rgba(230,250,255,0.78)" filter="url(#crisp)"/>

      <!-- 2층: 중간 6 꽃잎 (30° offset) -->
      <ellipse cx="0" cy="-8" rx="3.0" ry="8" fill="rgba(218,246,255,0.42)" transform="rotate(30)"/>
      <ellipse cx="0" cy="-8" rx="3.0" ry="8" fill="rgba(218,246,255,0.42)" transform="rotate(90)"/>
      <ellipse cx="0" cy="-8" rx="3.0" ry="8" fill="rgba(218,246,255,0.42)" transform="rotate(150)"/>
      <ellipse cx="0" cy="-8" rx="3.0" ry="8" fill="rgba(218,246,255,0.42)" transform="rotate(210)"/>
      <ellipse cx="0" cy="-8" rx="3.0" ry="8" fill="rgba(218,246,255,0.42)" transform="rotate(270)"/>
      <ellipse cx="0" cy="-8" rx="3.0" ry="8" fill="rgba(218,246,255,0.42)" transform="rotate(330)"/>

      <!-- 3층: 내층 6 꽃잎 (0° — 외곽과 동일 방향, 더 작음) -->
      <ellipse cx="0" cy="-4.5" rx="1.6" ry="4.5" fill="rgba(228,250,255,0.55)"/>
      <ellipse cx="0" cy="-4.5" rx="1.6" ry="4.5" fill="rgba(228,250,255,0.55)" transform="rotate(60)"/>
      <ellipse cx="0" cy="-4.5" rx="1.6" ry="4.5" fill="rgba(228,250,255,0.55)" transform="rotate(120)"/>
      <ellipse cx="0" cy="-4.5" rx="1.6" ry="4.5" fill="rgba(228,250,255,0.55)" transform="rotate(180)"/>
      <ellipse cx="0" cy="-4.5" rx="1.6" ry="4.5" fill="rgba(228,250,255,0.55)" transform="rotate(240)"/>
      <ellipse cx="0" cy="-4.5" rx="1.6" ry="4.5" fill="rgba(228,250,255,0.55)" transform="rotate(300)"/>

      <!-- 중심부 다층 -->
      <circle cx="0" cy="0" r="5.5" fill="rgba(185,228,255,0.18)" filter="url(#og)"/>
      <circle cx="0" cy="0" r="3.8" fill="rgba(220,248,255,0.82)" filter="url(#og)"/>
      <circle cx="0" cy="0" r="2.2" fill="rgba(242,253,255,0.94)" filter="url(#og)"/>
      <circle cx="0" cy="0" r="1.1" fill="rgba(255,255,255,1.00)"/>
    </g>
  </svg>`;

  function showEmpty() {
    const R = refs();
    R.messages.innerHTML = `
      <div class="chat-empty">
        ${_ORN}
        <div class="title">Research Assistant</div>
        <div class="subtitle">scRNA-seq · spatial transcriptomics · microglia · brain cell multi-omics</div>
        ${_ORN.replace('class="empty-orn"', 'class="empty-orn flip"')}
      </div>
    `;
  }

  // ─── Attachments ────────────────────────────────────
  const MAX_FILE_SIZE = 200 * 1024 * 1024;
  function handleFiles(fileList) {
    for (const file of fileList) {
      if (file.size > MAX_FILE_SIZE) {
        RA.showToast(`파일이 너무 큽니다: ${file.name}`, "error");
        continue;
      }
      uploadFile(file);
    }
  }

  async function uploadFile(file) {
    const tempId = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    const isImage = file.type.startsWith("image/");
    let localUrl = isImage ? URL.createObjectURL(file) : null;

    const tempAtt = {
      id: tempId,
      file_path: null,
      original_name: file.name,
      size: file.size,
      type: file.type,
      localUrl,
      uploading: true,
    };
    attachments.push(tempAtt);
    renderAttachments();

    try {
      const formData = new FormData();
      formData.append("file", file);
      const resp = await fetch(RA.API + "/api/upload", { method: "POST", body: formData });
      if (!resp.ok) throw new Error("업로드 실패");
      const data = await resp.json();
      tempAtt.file_path = data.file_path;
      tempAtt.uploading = false;
      renderAttachments();
    } catch (err) {
      attachments = attachments.filter((a) => a.id !== tempId);
      renderAttachments();
      RA.showToast(`업로드 실패: ${file.name}`, "error");
    }
  }

  function confirmPathAttach() {
    const R = refs();
    const p = R.pathInput.value.trim();
    if (!p) return;
    const displayName = p.split("/").pop() || p;
    const mime = p.toLowerCase().endsWith(".pdf")
      ? "application/pdf"
      : p.match(/\.(png|jpg|jpeg|gif|webp)$/i)
      ? "image/" + p.split(".").pop().toLowerCase()
      : "application/octet-stream";
    attachments.push({
      id: Date.now() + "-local",
      file_path: p,
      original_name: displayName,
      size: null,
      type: mime,
      localUrl: null,
      uploading: false,
      isLocalPath: true,
    });
    renderAttachments();
    R.pathInputRow.style.display = "none";
  }

  function renderAttachments() {
    const R = refs();
    if (!R.attachPreview) return;
    R.attachPreview.innerHTML = "";
    for (const a of attachments) {
      const isImage = a.type && a.type.startsWith("image/");
      const item = document.createElement("div");
      item.className = "attachment-item" + (a.uploading ? " uploading" : "");
      if (isImage && a.localUrl) {
        item.innerHTML = `<img src="${a.localUrl}" alt="${RA.escapeHtml(a.original_name)}">`;
      } else {
        item.innerHTML = `<span>📄 ${RA.escapeHtml(a.original_name)}</span>`;
      }
      const rm = document.createElement("span");
      rm.className = "remove";
      rm.textContent = "×";
      rm.addEventListener("click", () => {
        if (a.localUrl) URL.revokeObjectURL(a.localUrl);
        attachments = attachments.filter((x) => x.id !== a.id);
        renderAttachments();
      });
      item.appendChild(rm);
      R.attachPreview.appendChild(item);
    }
  }

  // ─── Send / SSE stream ──────────────────────────────
  async function sendMessage() {
    const R = refs();
    const text = R.input.value.trim();
    if (!text && attachments.length === 0) return;
    if (sending) return;

    // Remove empty state if present
    if (R.messages.querySelector(".chat-empty")) R.messages.innerHTML = "";

    const files = attachments
      .filter((a) => a.file_path && !a.uploading)
      .map((a) => ({ path: a.file_path, type: a.type || "application/octet-stream" }));

    let displayText = text;
    if (attachments.length > 0) {
      const names = attachments.map((a) => a.original_name);
      displayText = (text ? text + "\n" : "") + "[첨부: " + names.join(", ") + "]";
    }

    sending = true;
    abortController = new AbortController();
    R.input.value = "";
    R.input.style.height = "auto";
    R.sendBtn.classList.add("stop-mode");
    R.sendBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`;

    // Save user message in UI
    addMessage("user", displayText);
    const assistantEl = addMessage("assistant", "");
    const contentEl = assistantEl.querySelector(".message-content");
    contentEl.innerHTML = `<div class="loading-indicator"><span class="loading-spinner"></span><span>응답 생성 중</span></div>`;

    const metaEl = document.createElement("div");
    metaEl.className = "message-meta";
    assistantEl.appendChild(metaEl);

    const payload = {
      message: text,
      session_id: sessionId,
    };
    if (activeProject) payload.project_id = activeProject.id;
    if (R.modelSelect && R.modelSelect.value) payload.model = R.modelSelect.value;
    if (files.length > 0) payload.files = files;
    if (planMode) payload.permission_mode = "plan";

    lastSentPayload = JSON.parse(JSON.stringify(payload)); // save for retry

    // Clear attachments
    for (const a of attachments) {
      if (a.localUrl) URL.revokeObjectURL(a.localUrl);
    }
    attachments = [];
    renderAttachments();

    let gotContent = false;
    let textParts = []; // accumulator of text segments
    let finalText = "";

    const runStream = async (pl) => {
      await RA.fetchStream(
        "/api/chat",
        { method: "POST", body: pl, signal: abortController?.signal },
        (event) => {
          if (event.type === "init") {
            if (event.session_id) {
              sessionId = event.session_id;
              lastSentPayload.session_id = event.session_id; // keep for retry
            }
          } else if (event.type === "text") {
            if (!gotContent) { contentEl.innerHTML = ""; gotContent = true; }
            if (textParts.length === 0) textParts.push("");
            textParts[textParts.length - 1] = event.text;
            contentEl.innerHTML = RA.renderMarkdown(textParts.join(""));
            scrollToBottom();
          } else if (event.type === "tool_use") {
            if (!gotContent) { contentEl.innerHTML = ""; gotContent = true; }
            contentEl.appendChild(renderToolUse(event.tool || "", event.input || {}));
            textParts.push(""); // next text segment
            scrollToBottom();
          } else if (event.type === "result") {
            if (event.session_id) sessionId = event.session_id;
            if (!gotContent && event.text) {
              contentEl.innerHTML = RA.renderMarkdown(event.text);
              gotContent = true;
            }
            finalText = textParts.join("\n").trim() || event.text || "";
            const stats = [];
            if (event.input_tokens) stats.push(`입력 ${event.input_tokens.toLocaleString()}T`);
            if (event.output_tokens) stats.push(`출력 ${event.output_tokens.toLocaleString()}T`);
            if (event.duration_ms) stats.push(`${(event.duration_ms / 1000).toFixed(1)}s`);
            metaEl.innerHTML = stats.join("  ·  ");
            lastInputTokens = (event.input_tokens || 0) + (event.cache_read_tokens || 0);
            lastNumTurns = event.num_turns || lastNumTurns;
            updateContextBar();
          } else if (event.type === "error") {
            if (!gotContent) contentEl.innerHTML = "";
            const errDiv = document.createElement("div");
            errDiv.style.cssText = "color:var(--error);padding:8px 10px;background:rgba(224,90,90,0.08);border:1px solid rgba(224,90,90,0.25);border-radius:6px;font-size:12px;";
            errDiv.textContent = "오류: " + (event.error || "알 수 없음");
            contentEl.appendChild(errDiv);
          } else if (event.type === "title_update") {
            loadConversations();
          }
        }
      );
    };

    try {
      await runStream(payload);
    } catch (err) {
      if (err.name === "AbortError") {
        // User clicked stop — do nothing
      } else {
        // Network error (server restart, connection drop, etc.)
        // Show error with auto-retry button
        if (!gotContent) contentEl.innerHTML = "";
        const errWrap = document.createElement("div");
        errWrap.style.cssText = "padding:8px 10px;font-size:12px;display:flex;flex-direction:column;gap:6px;";

        const errMsg = document.createElement("span");
        errMsg.style.color = "var(--error)";
        errMsg.textContent = "연결이 끊겼습니다. 서버 재시작 후 자동 재연결을 시도합니다...";
        errWrap.appendChild(errMsg);

        const retryBtn = document.createElement("button");
        retryBtn.textContent = "재연결 시도";
        retryBtn.style.cssText = "align-self:flex-start;font-size:11px;padding:4px 10px;border:1px solid rgba(30,111,168,0.35);border-radius:6px;cursor:pointer;background:rgba(30,111,168,0.07);color:var(--blue-mid);transition:all 0.15s;";
        errWrap.appendChild(retryBtn);
        contentEl.appendChild(errWrap);

        // Auto-retry once after 3 seconds
        let autoRetried = false;
        const doRetry = async () => {
          if (sending) return; // already retrying
          retryBtn.disabled = true;
          retryBtn.textContent = "재연결 중...";
          errMsg.textContent = "서버에 재연결 중...";

          // Wait for server to come back up (max 6 attempts × 1s)
          for (let i = 0; i < 6; i++) {
            await new Promise(r => setTimeout(r, 1000));
            try {
              const h = await fetch("/healthz");
              if (h.ok) break;
            } catch (_) {}
          }

          // Remove error UI, keep any partial content already in contentEl
          errWrap.remove();
          gotContent = true; textParts = []; finalText = "";
          sending = true;
          abortController = new AbortController();
          const retryPayload = Object.assign({}, lastSentPayload, { session_id: sessionId });
          try {
            await runStream(retryPayload);
          } catch (e2) {
            const failEl = document.createElement("div");
            failEl.style.cssText = "color:var(--error);padding:8px 10px;font-size:12px;";
            failEl.textContent = "재연결 실패: " + (e2.message || "서버를 확인해주세요");
            contentEl.appendChild(failEl);
          }
          sending = false;
          abortController = null;
          R.sendBtn.classList.remove("stop-mode");
          R.sendBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;
          if (finalText) addBookmarkBtn(assistantEl, finalText);
          loadConversations();
        };

        retryBtn.addEventListener("click", doRetry);
        // Auto-retry after 3 seconds
        setTimeout(() => { if (!autoRetried) { autoRetried = true; doRetry(); } }, 3000);
      }
    }

    sending = false;
    abortController = null;
    R.sendBtn.classList.remove("stop-mode");
    R.sendBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;
    R.input.focus();
    if (finalText) addBookmarkBtn(assistantEl, finalText);
    loadConversations();
  }

  function abortSend() {
    if (abortController) abortController.abort();
    // 서버에서 돌고 있는 claude 프로세스도 종료 (토큰 낭비 방지)
    if (sessionId) {
      fetch(RA.API + "/api/abort", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId }),
      }).catch(() => {});
    }
    sending = false;
    const R = refs();
    R.sendBtn.classList.remove("stop-mode");
  }

  // ─── Tool-use 렌더링 (Edit/Write는 diff 미리보기) ────
  function renderToolUse(tool, input) {
    const wrap = document.createElement("div");
    wrap.className = "tool-mention";

    const fp = input.file_path || input.path || "";
    const fname = fp ? fp.split("/").pop() : "";
    const head = document.createElement("div");
    head.className = "tool-mention-head";
    head.textContent = `▸ ${tool}${fname ? " · " + fname : ""}`;
    wrap.appendChild(head);

    const esc = (s) =>
      (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    // old/new 문자열을 +/- diff 블록으로. 긴 내용은 40줄에서 자른다.
    const diffBlock = (oldS, newS) => {
      const MAX = 40;
      const pre = document.createElement("pre");
      pre.className = "tool-diff";
      const lines = [];
      const push = (text, cls) => {
        const arr = (text || "").split("\n");
        const shown = arr.slice(0, MAX);
        shown.forEach((l) => lines.push(`<span class="${cls}">${cls === "d-del" ? "- " : "+ "}${esc(l)}</span>`));
        if (arr.length > MAX) lines.push(`<span class="d-meta">…(${arr.length - MAX}줄 더)</span>`);
      };
      if (oldS) push(oldS, "d-del");
      if (newS) push(newS, "d-add");
      pre.innerHTML = lines.join("\n");
      return pre;
    };

    if (tool === "Edit" && (input.old_string || input.new_string)) {
      wrap.appendChild(diffBlock(input.old_string, input.new_string));
    } else if (tool === "Write" && input.content) {
      wrap.appendChild(diffBlock("", input.content));
    } else if (tool === "MultiEdit" && Array.isArray(input.edits)) {
      input.edits.forEach((e) => wrap.appendChild(diffBlock(e.old_string, e.new_string)));
    }
    return wrap;
  }

  // ─── Message renderers ──────────────────────────────
  function addMessage(role, text) {
    const R = refs();
    const div = document.createElement("div");
    div.className = `message ${role}`;
    div.innerHTML = `
      <div class="message-role ${role}">${role === "user" ? "You" : "Claude"}</div>
      <div class="message-content">${text ? RA.renderMarkdown(text) : ""}</div>
    `;
    R.messages.appendChild(div);
    scrollToBottom();
    return div;
  }

  function scrollToBottom() {
    const R = refs();
    R.messages.scrollTop = R.messages.scrollHeight;
  }

  function addBookmarkBtn(messageEl, text) {
    if (!text || !text.trim()) return;
    const bar = document.createElement("div");
    bar.className = "message-actions";
    const btn = document.createElement("button");
    btn.className = "bookmark-btn";
    btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg> 북마크`;
    btn.addEventListener("click", async () => {
      try {
        await RA.fetchJSON("/api/bookmarks", {
          method: "POST",
          body: { session_id: sessionId, title: text.substring(0, 80).split("\n")[0], content: text },
        });
        btn.classList.add("bookmarked");
        btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg> 저장됨`;
        RA.showToast("북마크 저장됨", "success");
      } catch (e) {
        RA.showToast("북마크 저장 실패", "error");
      }
    });
    bar.appendChild(btn);
    const contentEl = messageEl.querySelector(".message-content");
    if (contentEl && contentEl.nextSibling) {
      messageEl.insertBefore(bar, contentEl.nextSibling);
    } else {
      messageEl.appendChild(bar);
    }
  }

  function updateContextBar() {
    const R = refs();
    if (!R.contextBar || !R.contextFill || !R.contextLabel) return;
    if (!lastInputTokens) {
      R.contextBar.classList.remove("visible");
      return;
    }
    R.contextBar.classList.add("visible");
    const pct = Math.min((lastInputTokens / maxContext) * 100, 100);
    R.contextFill.style.width = pct + "%";
    R.contextFill.className = "context-bar-fill" + (pct > 75 ? " danger" : pct > 50 ? " warn" : "");
    const usedK = Math.round(lastInputTokens / 1000);
    const maxStr = maxContext >= 1000000 ? `${(maxContext / 1000000).toFixed(0)}M` : `${maxContext / 1000}K`;
    const turnStr = lastNumTurns > 0 ? ` · ${lastNumTurns} turns` : "";
    R.contextLabel.textContent = `${usedK}K / ${maxStr}${turnStr}`;
  }

  // ─── Register tab init ──────────────────────────────
  RA.onTabFirstShown.chat = init;
  RA.onTabShown.chat = async () => {
    // Re-load projects in case they changed
    await loadProjects();
  };

  // Expose for cross-module access
  RA.chat = {
    init,
    loadProjects,
    newChat,
    sendMessage,
    openConversation,
  };

  // If chat is the initial tab, init immediately after DOM
  document.addEventListener("DOMContentLoaded", () => {
    if (RA.currentTab === "chat" && !RA.tabInitialized.chat) {
      RA.tabInitialized.chat = true;
      init();
    }
  });
})();
