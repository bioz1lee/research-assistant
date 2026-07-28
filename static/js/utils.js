/* ========================================================================
   utils.js — 공통 유틸리티
   ======================================================================== */

window.RA = window.RA || {}; // Research Assistant 네임스페이스

// ─── API base ────────────────────────────────────────────
RA.API = window.location.origin;

// ─── HTML escape ─────────────────────────────────────────
RA.escapeHtml = function (str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
};

// ─── Toast ───────────────────────────────────────────────
RA.showToast = function (message, type = "info", duration = 2000) {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = "toast " + type;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add("fade-out");
    setTimeout(() => toast.remove(), 280);
  }, duration);
};

// Convenience aliases
window.showToast = RA.showToast;
window.escapeHtml = RA.escapeHtml;

// ─── Fetch helpers ───────────────────────────────────────
RA.fetchJSON = async function (url, options = {}) {
  const opts = Object.assign({ headers: {} }, options);
  if (opts.body && typeof opts.body !== "string" && !(opts.body instanceof FormData)) {
    opts.body = JSON.stringify(opts.body);
    opts.headers["Content-Type"] = "application/json";
  }
  if (!(opts.body instanceof FormData) && opts.headers["Content-Type"] == null && opts.method) {
    opts.headers["Content-Type"] = "application/json";
  }
  let resp;
  try {
    resp = await fetch(url.startsWith("http") ? url : RA.API + url, opts);
  } catch (e) {
    throw new Error("네트워크 오류: " + (e.message || "연결 실패"));
  }
  if (!resp.ok) {
    let errMsg = `HTTP ${resp.status}`;
    try {
      const data = await resp.json();
      errMsg = data.error || data.message || errMsg;
    } catch (_) {}
    throw new Error(errMsg);
  }
  if (resp.status === 204) return null;
  const ct = resp.headers.get("content-type") || "";
  if (ct.includes("application/json")) return resp.json();
  return resp.text();
};

// ─── SSE stream helper ───────────────────────────────────
// Calls onChunk(eventObj) per server-sent event, onDone(resultEvent?) at end
RA.fetchStream = async function (url, options, onChunk, onDone) {
  const opts = Object.assign({ headers: {} }, options || {});
  if (opts.body && typeof opts.body !== "string" && !(opts.body instanceof FormData)) {
    opts.body = JSON.stringify(opts.body);
    opts.headers["Content-Type"] = "application/json";
  }
  const fullUrl = url.startsWith("http") ? url : RA.API + url;
  const resp = await fetch(fullUrl, opts);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(text || `HTTP ${resp.status}`);
  }
  if (!resp.body) throw new Error("스트리밍 응답 본문 없음");
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let last = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6);
      try {
        const event = JSON.parse(raw);
        last = event;
        if (typeof onChunk === "function") onChunk(event);
      } catch (e) {
        // ignore malformed lines
      }
    }
  }
  if (typeof onDone === "function") onDone(last);
};

// ─── Date formatting ────────────────────────────────────
RA.formatDate = function (iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
};

RA.formatDateShort = function (iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("ko-KR", { month: "short", day: "numeric" });
};

RA.getDateGroup = function (iso) {
  const now = new Date();
  const d = new Date(iso);
  const diff = Math.floor((now - d) / (1000 * 60 * 60 * 24));
  if (diff === 0) return "오늘";
  if (diff === 1) return "어제";
  if (diff <= 7) return "이번 주";
  if (diff <= 14) return "지난 주";
  return "이전";
};

// ─── Debounce ────────────────────────────────────────────
RA.debounce = function (fn, delay = 300) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
};

// ─── Tab switching ───────────────────────────────────────
RA.currentTab = "chat";
RA.tabInitialized = { chat: false, wiki: false, projects: false, study: false, digest: false };
RA.onTabFirstShown = {}; // map tabId -> fn

RA.switchTab = function (tabId) {
  if (!tabId) return;
  RA.currentTab = tabId;
  // nav buttons
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabId);
  });
  // sidebar sections
  document.querySelectorAll(".sidebar-section").forEach((s) => {
    s.classList.toggle("active", s.dataset.tab === tabId);
  });
  // content sections
  document.querySelectorAll(".tab-section").forEach((s) => {
    s.classList.toggle("hidden", s.id !== `tab-${tabId}`);
  });
  // First-time init hook
  if (!RA.tabInitialized[tabId] && RA.onTabFirstShown[tabId]) {
    RA.tabInitialized[tabId] = true;
    try {
      RA.onTabFirstShown[tabId]();
    } catch (e) {
      console.error(`tab ${tabId} init error:`, e);
    }
  } else if (RA.onTabShown && RA.onTabShown[tabId]) {
    try { RA.onTabShown[tabId](); } catch (e) {}
  }
  // Update URL hash (optional)
  history.replaceState(null, "", `#${tabId}`);
};

RA.onTabShown = {}; // map tabId -> fn (called every show)

// ─── Keyboard shortcuts ──────────────────────────────────
RA.initKeyboardShortcuts = function () {
  document.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    // Cmd+1~5
    if (mod && !e.shiftKey && /^[1-5]$/.test(e.key)) {
      e.preventDefault();
      const map = { "1": "chat", "2": "wiki", "3": "projects", "4": "study", "5": "digest" };
      RA.switchTab(map[e.key]);
      RA.openSidebar();
      return;
    }
    // Cmd+\
    if (mod && e.key === "\\") {
      e.preventDefault();
      RA.toggleSidebar();
      return;
    }
    // Cmd+K → global search
    if (mod && e.key === "k") {
      e.preventDefault();
      if (RA.search) RA.search.open();
      return;
    }
    // Cmd+N → new item in current section
    if (mod && e.key === "n") {
      e.preventDefault();
      const handler = RA.newItemHandlers && RA.newItemHandlers[RA.currentTab];
      if (handler) handler();
      return;
    }
    // Esc closes any open modal
    if (e.key === "Escape") {
      document.querySelectorAll(".modal-overlay").forEach((m) => {
        if (!m.classList.contains("hidden") && m.style.display !== "none") {
          m.classList.add("hidden");
        }
      });
    }
  });
};

RA.newItemHandlers = {}; // map tabId -> fn

// ─── Modal helpers ───────────────────────────────────────
RA.openModal = function (id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove("hidden");
  el.style.display = "flex";
};
RA.closeModal = function (id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add("hidden");
  el.style.display = "none";
};

// Click-outside-to-close
document.addEventListener("click", (e) => {
  if (e.target.classList && e.target.classList.contains("modal-overlay")) {
    e.target.classList.add("hidden");
    e.target.style.display = "none";
  }
});

// ─── Storage helpers (localStorage with namespace) ──────
RA.storage = {
  get(key, defaultValue = null) {
    try {
      const v = localStorage.getItem("ra:" + key);
      return v === null ? defaultValue : JSON.parse(v);
    } catch (_) { return defaultValue; }
  },
  set(key, value) {
    try { localStorage.setItem("ra:" + key, JSON.stringify(value)); }
    catch (_) {}
  },
  remove(key) { localStorage.removeItem("ra:" + key); },
};

// ─── Lightweight markdown renderer ───────────────────────
RA.renderMarkdown = function (text) {
  if (!text) return "";
  // Extract code blocks before escaping so original text is preserved for copy
  const codeBlocks = [];
  const textWithPlaceholders = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    codeBlocks.push({ lang, code: code.trim() });
    return `\x00CODEBLOCK${codeBlocks.length - 1}\x00`;
  });
  // Extract LaTeX math (after code blocks so $ inside code is untouched)
  const mathBlocks = [];
  let withMath = textWithPlaceholders;
  // display math $$...$$ first
  withMath = withMath.replace(/\$\$([\s\S]+?)\$\$/g, (_, expr) => {
    mathBlocks.push({ expr: expr.trim(), display: true });
    return `\x00MATH${mathBlocks.length - 1}\x00`;
  });
  // inline math $...$ (single line, non-empty)
  withMath = withMath.replace(/\$([^\$\n]+?)\$/g, (_, expr) => {
    mathBlocks.push({ expr: expr.trim(), display: false });
    return `\x00MATH${mathBlocks.length - 1}\x00`;
  });
  let html = RA.escapeHtml(withMath);
  // inline code
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  // bold
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  // italic
  html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>");
  // headings
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");
  html = html.replace(/^---$/gm, "<hr>");
  html = html.replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>");
  // tables
  html = html.replace(/^(\|.+\|)\n(\|[-| :]+\|)\n((?:\|.+\|\n?)+)/gm, (_, header, sep, body) => {
    const headerCols = header.split("|");
    const ths = headerCols.slice(1, headerCols.length - 1).map((c) => `<th>${c.trim()}</th>`).join("");
    const rows = body.trim().split("\n").map((row) => {
      const rowCols = row.split("|");
      const tds = rowCols.slice(1, rowCols.length - 1).map((c) => `<td>${c.trim()}</td>`).join("");
      return `<tr>${tds}</tr>`;
    }).join("");
    return `<table><thead><tr>${ths}</tr></thead><tbody>${rows}</tbody></table>`;
  });
  // lists
  html = html.replace(/^- (.+)$/gm, "<li>$1</li>");
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, "<ul>$1</ul>");
  html = html.replace(/^\d+\. (.+)$/gm, "<oli>$1</oli>");
  html = html.replace(/((?:<oli>.*<\/oli>\n*)+)/g, (m) => "<ol>" + m.replace(/<\/?oli>/g, (t) => t.replace("oli", "li")) + "</ol>");
  // links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // paragraphs
  html = html.replace(/\n\n/g, "</p><p>");
  if (!html.startsWith("<")) html = "<p>" + html;
  if (!html.endsWith(">")) html += "</p>";
  html = html.replace(/<p><\/p>/g, "");
  // unwrap p around blocks
  const blockTags = ["h1", "h2", "h3", "pre", "ul", "ol", "table", "blockquote", "hr"];
  for (const t of blockTags) {
    html = html.replace(new RegExp(`<p>(<${t}>)`, "g"), "$1");
    html = html.replace(new RegExp(`(</${t}>)</p>`, "g"), "$1");
  }
  html = html.replace(/<p>(<hr>)/g, "$1");
  // unwrap <p> around code-block placeholders before restoring them
  html = html.replace(/<p>(\x00CODEBLOCK\d+\x00)<\/p>/g, "$1");
  // unwrap <p> around display-math placeholders
  html = html.replace(/<p>(\x00MATH\d+\x00)<\/p>/g, "$1");
  // Restore math via KaTeX (before code blocks; expr never contains code placeholders)
  html = html.replace(/\x00MATH(\d+)\x00/g, (_, i) => {
    const { expr, display } = mathBlocks[Number(i)];
    if (window.katex) {
      try {
        return katex.renderToString(expr, { displayMode: display, throwOnError: false });
      } catch (e) {
        return `<code>${RA.escapeHtml(expr)}</code>`;
      }
    }
    const d = display ? "$$" : "$";
    return RA.escapeHtml(d + expr + d);
  });
  // Restore code blocks LAST so their inner \n\n is not turned into </p><p>
  html = html.replace(/\x00CODEBLOCK(\d+)\x00/g, (_, i) => {
    const { lang, code } = codeBlocks[Number(i)];
    const langLabel = lang ? `<span class="code-lang-label">${lang}</span>` : `<span class="code-lang-label"></span>`;
    return `<div class="code-block-wrapper" data-code="${encodeURIComponent(code)}">`
      + `<div class="code-block-header">${langLabel}<button class="code-copy-btn" onclick="RA.copyCode(this)">복사</button></div>`
      + `<pre><code class="lang-${lang || ""}">${RA.escapeHtml(code)}</code></pre></div>`;
  });
  return html;
};

// ─── Code copy ───────────────────────────────────────────
RA.copyCode = function (btn) {
  const wrapper = btn.closest(".code-block-wrapper");
  const code = decodeURIComponent(wrapper.dataset.code);
  navigator.clipboard.writeText(code).then(() => {
    btn.textContent = "✓";
    setTimeout(() => { btn.textContent = "복사"; }, 1500);
  });
};

// ─── Sidebar toggle ──────────────────────────────────────
RA.toggleSidebar = function () {
  const sb = document.getElementById("sidebar");
  if (window.innerWidth <= 1280) {
    sb.classList.toggle("open");
    sb.classList.remove("collapsed");
  } else {
    sb.classList.toggle("collapsed");
    sb.classList.remove("open");
  }
};

RA.openSidebar = function () {
  const sb = document.getElementById("sidebar");
  if (window.innerWidth <= 1280) {
    sb.classList.add("open");
    sb.classList.remove("collapsed");
  } else {
    sb.classList.remove("collapsed");
    sb.classList.remove("open");
  }
};

RA.closeSidebar = function () {
  const sb = document.getElementById("sidebar");
  if (window.innerWidth <= 1280) {
    sb.classList.remove("open");
  } else {
    sb.classList.add("collapsed");
  }
};

// ─── Init nav buttons ────────────────────────────────────
RA.initNav = function () {
  document.querySelectorAll(".nav-btn[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tabId = btn.dataset.tab;
      if (RA.currentTab === tabId) {
        RA.toggleSidebar();
      } else {
        RA.switchTab(tabId);
        RA.openSidebar();
      }
    });
  });

  // Sidebar toggle button
  document.querySelectorAll(".sidebar-toggle-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      RA.toggleSidebar();
    });
  });

  // Click-outside closes sidebar
  document.addEventListener("click", (e) => {
    const sb = document.getElementById("sidebar");
    const nav = document.getElementById("main-nav");

    if (window.innerWidth <= 1280) {
      if (!sb.classList.contains("open")) return;
      if (!sb.contains(e.target) && !e.target.closest(".sidebar-toggle-btn")) {
        sb.classList.remove("open");
      }
      return;
    }

    // 데스크탑: 사이드바 외부 클릭 시 닫기
    if (sb.classList.contains("collapsed")) return;
    if (sb.contains(e.target) || (nav && nav.contains(e.target)) || e.target.closest(".sidebar-toggle-btn")) return;
    sb.classList.add("collapsed");
  });

  // Initial tab from hash (사이드바는 닫힌 상태로 시작)
  const hash = (window.location.hash || "#chat").slice(1);
  RA.switchTab(["chat", "wiki", "projects", "study", "digest"].includes(hash) ? hash : "chat");
};

// ─── Theme (light/dark) ─────────────────────────────────
RA.applyTheme = function (theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("ra-theme", theme);
  const icon = document.getElementById("theme-toggle-icon");
  const label = document.getElementById("theme-toggle-label");
  // 버튼은 "전환될 대상"을 표시
  if (icon) icon.textContent = theme === "light" ? "☾" : "☀";
  if (label) label.textContent = theme === "light" ? "Dark" : "Light";
  document.dispatchEvent(new CustomEvent("ra:theme", { detail: { theme } }));
};

RA.initThemeToggle = function () {
  RA.applyTheme(localStorage.getItem("ra-theme") || "dark");
  const btn = document.getElementById("nav-theme-toggle");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme");
    RA.applyTheme(cur === "light" ? "dark" : "light");
  });
};

// ─── Auto init ──────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  RA.initNav();
  RA.initKeyboardShortcuts();
  RA.initThemeToggle();
});
