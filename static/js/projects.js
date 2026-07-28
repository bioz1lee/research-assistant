/* ========================================================================
   projects.js — Projects 화면 (CRUD, 파일 업로드, Wiki 연동)
   ======================================================================== */

(function () {
  const $ = (id) => document.getElementById(id);

  // State
  let projects = [];
  let currentId = null;
  let dirty = false;

  const TEMPLATES = {
    paper_analysis: `너는 ${"<연구 주제>"} 전문 연구자야. 논문을 분석할 때는 다음 관점에서 비판적으로 검토해줘:
1. 방법론의 적절성 (샘플 수, 배치 보정, 통계)
2. 결과의 재현 가능성 (데이터/코드 공개 여부)
3. 결론의 일반화 가능성
4. 후속 연구 방향
한국어로 답변하고, 중요한 용어는 영어 병기.`,
    r_code: `너는 R 코드 작성 전문가야. Bioconductor, Seurat, scran, edgeR 등 단일세포/벌크 transcriptomics 도구에 능통해.
- 코드는 reproducible해야 함 (set.seed, sessionInfo 포함)
- 주석은 한국어, 함수명/변수명은 영어
- 시각화는 ggplot2 또는 ComplexHeatmap 기본
- 실수 가능 지점 명시`,
    paper_writing: `너는 학술 논문 작성을 돕는 영어 글쓰기 전문가야.
- 한국어 초안 → 학술 영어 변환 (Nature/Cell 톤)
- Methods: passive voice, 시제 일관
- Results: 수치 명시, 과장 금지
- Discussion: limitation 솔직히 표기
- 재현성을 위해 정확한 파라미터/소프트웨어 버전 포함`,
  };

  async function init() {
    bindEvents();
    await loadProjects();
    renderSidebar();
    if (projects.length > 0) {
      const active = projects.find((p) => p.is_active);
      selectProject(active ? active.id : projects[0].id);
    } else {
      renderEmptyState();
    }
  }

  function bindEvents() {
    $("project-new-btn")?.addEventListener("click", newProject);
    $("project-save-btn")?.addEventListener("click", saveProject);
    $("project-delete-btn")?.addEventListener("click", deleteProject);
    $("project-activate-btn")?.addEventListener("click", activateProject);

    // Template buttons
    document.querySelectorAll(".prompt-template-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const t = btn.dataset.template;
        const promptEl = $("project-system-prompt");
        if (promptEl && TEMPLATES[t]) {
          if (promptEl.value && !confirm("현재 프롬프트를 덮어쓸까요?")) return;
          promptEl.value = TEMPLATES[t];
          dirty = true;
          updateUnsaved();
        }
      });
    });

    // Mark dirty on edits
    ["project-name", "project-system-prompt"].forEach((id) => {
      $(id)?.addEventListener("input", () => { dirty = true; updateUnsaved(); });
    });

    // Knowledge upload (core/reference)
    $("knowledge-upload-core")?.addEventListener("click", () => uploadKnowledge("core"));
    $("knowledge-upload-ref")?.addEventListener("click", () => uploadKnowledge("reference"));
    $("knowledge-file-input")?.addEventListener("change", handleFileSelected);
    $("knowledge-wiki-picker-btn")?.addEventListener("click", openWikiPicker);

    // Wiki picker modal
    $("wiki-picker-close")?.addEventListener("click", () => RA.closeModal("wiki-picker-modal"));
    $("wiki-picker-cancel")?.addEventListener("click", () => RA.closeModal("wiki-picker-modal"));
    $("wiki-picker-confirm")?.addEventListener("click", confirmWikiPicker);

    RA.newItemHandlers.projects = newProject;
  }

  function updateUnsaved() {
    const btn = $("project-save-btn");
    if (btn) {
      btn.textContent = dirty ? "저장 (변경됨)" : "저장";
      btn.classList.toggle("btn-gold", dirty);
    }
  }

  // ─── Data loading ────────────────────────────────────
  async function loadProjects() {
    try {
      projects = await RA.fetchJSON("/api/projects");
    } catch (e) {
      projects = [];
    }
  }

  function renderSidebar() {
    const list = $("project-list");
    if (!list) return;
    list.innerHTML = "";
    if (projects.length === 0) {
      list.innerHTML = '<div class="text-muted text-sm" style="padding:16px;text-align:center">프로젝트가 없어요</div>';
      return;
    }
    for (const p of projects) {
      const item = document.createElement("div");
      item.className = "sidebar-item project-sidebar-item" + (p.id === currentId ? " active" : "");
      item.innerHTML = `
        <div class="project-color-dot ${p.is_active ? "" : "inactive"}"></div>
        <div class="sidebar-item-text">
          <div class="sidebar-item-title">${RA.escapeHtml(p.name || "(이름 없음)")}</div>
          ${p.is_active ? '<div class="sidebar-item-meta" style="color:var(--gold-bright)">● 활성</div>' : ""}
        </div>
      `;
      item.addEventListener("click", () => selectProject(p.id));
      list.appendChild(item);
    }
  }

  function renderEmptyState() {
    const content = $("project-editor-container");
    if (!content) return;
    content.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">⬡</div>
        <div class="empty-state-title">프로젝트를 만들어 보세요</div>
        <div class="empty-state-msg">프로젝트를 만들면 연구 주제별로 AI에게 컨텍스트(시스템 프롬프트 + 지식 파일)를 미리 알려줄 수 있어요.</div>
        <button class="btn btn-gold mt-3" id="empty-new-project-btn">+ 새 프로젝트</button>
      </div>
    `;
    $("empty-new-project-btn")?.addEventListener("click", newProject);
  }

  function selectProject(id) {
    currentId = id;
    dirty = false;
    renderSidebar();
    renderEditor();
  }

  function renderEditor() {
    const p = projects.find((x) => x.id === currentId);
    const container = $("project-editor-container");
    if (!container) return;
    if (!p) {
      renderEmptyState();
      return;
    }
    const kFiles = (() => {
      if (Array.isArray(p.knowledge_files)) return p.knowledge_files;
      try { return JSON.parse(p.knowledge_files || "[]"); } catch (_) { return []; }
    })();
    const wikiTags = (() => {
      if (Array.isArray(p.wiki_tags)) return p.wiki_tags;
      try { return JSON.parse(p.wiki_tags || "[]"); } catch (_) { return []; }
    })();

    container.innerHTML = `
      <div class="project-editor">
        <div class="content-header" style="padding:0;border:none;background:none">
          <div class="content-header-left">
            <h1 class="section-title">프로젝트 편집</h1>
            ${p.is_active ? '<span class="active-indicator">활성 프로젝트</span>' : ""}
          </div>
          <div class="content-header-right">
            ${!p.is_active ? '<button class="btn btn-gold btn-sm" id="project-activate-btn">활성화</button>' : ""}
            <button class="btn btn-danger btn-sm" id="project-delete-btn">삭제</button>
          </div>
        </div>

        <div class="form-row">
          <label class="form-label">프로젝트 이름</label>
          <input id="project-name" class="project-name-input" type="text" value="${RA.escapeHtml(p.name || "")}" placeholder="예: Microglia Analysis">
        </div>

        <div class="form-row">
          <label class="form-label">System Prompt</label>
          <textarea id="project-system-prompt" class="system-prompt-input" placeholder="이 프로젝트에서 Claude에게 매번 알려줄 컨텍스트...">${RA.escapeHtml(p.system_prompt || "")}</textarea>
          <div class="prompt-template-row">
            <button class="prompt-template-btn" data-template="paper_analysis">📚 논문 분석</button>
            <button class="prompt-template-btn" data-template="r_code">⚙ R 코드 도우미</button>
            <button class="prompt-template-btn" data-template="paper_writing">✍ 논문 작성 도우미</button>
          </div>
        </div>

        <div class="form-row">
          <label class="form-label">지식 파일</label>
          <div class="knowledge-section">
            <div class="knowledge-group">
              <div class="knowledge-group-label">
                <span class="core-tag">CORE</span>
                <span>핵심 파일 (항상 로드)</span>
              </div>
              <div class="knowledge-hint">매 대화마다 system prompt 다음에 자동 prepend (권장 5개 이내, 각 파일 8000자까지)</div>
              <div class="knowledge-list" id="knowledge-list-core"></div>
              <div class="knowledge-add-row">
                <button class="btn btn-primary btn-sm" id="knowledge-upload-core">+ 파일 업로드</button>
                <button class="btn btn-ghost btn-sm" id="knowledge-wiki-picker-btn">Wiki에서 선택</button>
              </div>
            </div>
            <div class="knowledge-group">
              <div class="knowledge-group-label">
                <span class="ref-tag">REF</span>
                <span>참고 파일 (필요 시 로드)</span>
              </div>
              <div class="knowledge-hint">"@파일명" 또는 명시적 요청 시 로드 (v2)</div>
              <div class="knowledge-list" id="knowledge-list-ref"></div>
              <div class="knowledge-add-row">
                <button class="btn btn-primary btn-sm" id="knowledge-upload-ref">+ 파일 업로드</button>
              </div>
            </div>
          </div>
          <input type="file" id="knowledge-file-input" multiple style="display:none">
        </div>

        <div class="form-row">
          <label class="form-label">Wiki 태그 연동</label>
          <div class="form-hint">선택한 태그를 가진 논문이 대화 컨텍스트에 자동 추천됩니다 (v2)</div>
          <div id="project-wiki-tags" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">
            ${wikiTags.map((t) => `<span class="tag-pill removable" data-tag="${RA.escapeHtml(t)}">${RA.escapeHtml(t)}</span>`).join("")}
            <button class="add-tag-btn" id="add-wiki-tag-btn">+ 태그</button>
          </div>
        </div>

        <div class="project-editor-footer">
          <span class="text-muted text-xs">${p.updated_at ? "마지막 수정: " + RA.formatDate(p.updated_at) : ""}</span>
          <button class="btn btn-primary" id="project-save-btn">저장</button>
        </div>
      </div>
    `;

    // Re-bind events for newly inserted elements
    $("project-name")?.addEventListener("input", () => { dirty = true; updateUnsaved(); });
    $("project-system-prompt")?.addEventListener("input", () => { dirty = true; updateUnsaved(); });
    $("project-save-btn")?.addEventListener("click", saveProject);
    $("project-delete-btn")?.addEventListener("click", deleteProject);
    $("project-activate-btn")?.addEventListener("click", activateProject);

    document.querySelectorAll(".prompt-template-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const t = btn.dataset.template;
        const pe = $("project-system-prompt");
        if (pe && TEMPLATES[t]) {
          if (pe.value && !confirm("현재 프롬프트를 덮어쓸까요?")) return;
          pe.value = TEMPLATES[t];
          dirty = true;
          updateUnsaved();
        }
      });
    });

    $("knowledge-upload-core")?.addEventListener("click", () => uploadKnowledge("core"));
    $("knowledge-upload-ref")?.addEventListener("click", () => uploadKnowledge("reference"));
    $("knowledge-file-input")?.addEventListener("change", handleFileSelected);
    $("knowledge-wiki-picker-btn")?.addEventListener("click", openWikiPicker);

    $("add-wiki-tag-btn")?.addEventListener("click", () => {
      const t = prompt("Wiki 태그 (예: cell:microglia):");
      if (t && t.trim()) {
        const newTags = [...new Set([...wikiTags, t.trim()])];
        saveField("wiki_tags", newTags);
      }
    });
    document.querySelectorAll("#project-wiki-tags .tag-pill").forEach((pill) => {
      pill.addEventListener("click", () => {
        const t = pill.dataset.tag;
        const newTags = wikiTags.filter((x) => x !== t);
        saveField("wiki_tags", newTags);
      });
    });

    renderKnowledgeList(kFiles);
  }

  function renderKnowledgeList(files) {
    const core = $("knowledge-list-core");
    const ref = $("knowledge-list-ref");
    if (!core || !ref) return;
    core.innerHTML = "";
    ref.innerHTML = "";
    let coreCount = 0, refCount = 0;
    for (const f of files) {
      const item = document.createElement("div");
      item.className = "knowledge-item";
      item.innerHTML = `
        <span class="filename">📄 ${RA.escapeHtml(f.filename || "(이름 없음)")}</span>
        ${f.size ? `<span class="size">${formatSize(f.size)}</span>` : ""}
        <button class="remove-btn" title="제거">×</button>
      `;
      item.querySelector(".remove-btn").addEventListener("click", () => removeKnowledge(f));
      if (f.type === "core") { core.appendChild(item); coreCount++; }
      else { ref.appendChild(item); refCount++; }
    }
    if (coreCount === 0) core.innerHTML = '<div class="text-muted text-xs" style="padding:6px">아직 핵심 파일이 없어요</div>';
    if (refCount === 0) ref.innerHTML = '<div class="text-muted text-xs" style="padding:6px">아직 참고 파일이 없어요</div>';
  }

  function formatSize(b) {
    if (!b) return "";
    if (b < 1024) return b + " B";
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
    return (b / 1024 / 1024).toFixed(1) + " MB";
  }

  // ─── CRUD ───────────────────────────────────────────
  async function newProject() {
    try {
      const p = await RA.fetchJSON("/api/projects", {
        method: "POST",
        body: { name: "새 프로젝트", system_prompt: "", knowledge_files: [] },
      });
      projects.push(p);
      currentId = p.id;
      renderSidebar();
      renderEditor();
      setTimeout(() => $("project-name")?.focus(), 50);
    } catch (e) {
      RA.showToast("생성 실패: " + e.message, "error");
    }
  }

  async function saveProject() {
    const p = projects.find((x) => x.id === currentId);
    if (!p) return;
    const payload = {
      name: $("project-name")?.value || p.name,
      system_prompt: $("project-system-prompt")?.value || "",
    };
    try {
      const updated = await RA.fetchJSON(`/api/projects/${p.id}`, { method: "PUT", body: payload });
      const idx = projects.findIndex((x) => x.id === p.id);
      if (idx >= 0) projects[idx] = updated;
      dirty = false;
      updateUnsaved();
      renderSidebar();
      RA.showToast("저장됨", "success");
    } catch (e) {
      RA.showToast("저장 실패: " + e.message, "error");
    }
  }

  async function deleteProject() {
    const p = projects.find((x) => x.id === currentId);
    if (!p) return;
    if (!confirm(`'${p.name}' 프로젝트를 삭제하시겠습니까?`)) return;
    try {
      await RA.fetchJSON(`/api/projects/${p.id}`, { method: "DELETE" });
      projects = projects.filter((x) => x.id !== p.id);
      currentId = projects[0]?.id || null;
      RA.showToast("삭제됨", "success");
      renderSidebar();
      if (currentId) renderEditor(); else renderEmptyState();
    } catch (e) {
      RA.showToast("삭제 실패: " + e.message, "error");
    }
  }

  async function activateProject() {
    const p = projects.find((x) => x.id === currentId);
    if (!p) return;
    try {
      await RA.fetchJSON(`/api/projects/${p.id}/activate`, { method: "POST" });
      for (const proj of projects) proj.is_active = proj.id === p.id ? 1 : 0;
      RA.showToast(`'${p.name}' 활성화됨`, "success");
      renderSidebar();
      renderEditor();
      // Refresh chat module
      if (RA.chat && RA.chat.loadProjects) RA.chat.loadProjects();
    } catch (e) {
      RA.showToast("활성화 실패: " + e.message, "error");
    }
  }

  async function saveField(field, value) {
    const p = projects.find((x) => x.id === currentId);
    if (!p) return;
    try {
      const updated = await RA.fetchJSON(`/api/projects/${p.id}`, {
        method: "PUT",
        body: { [field]: value },
      });
      const idx = projects.findIndex((x) => x.id === p.id);
      if (idx >= 0) projects[idx] = updated;
      renderEditor();
    } catch (e) {
      RA.showToast("저장 실패: " + e.message, "error");
    }
  }

  // ─── Knowledge upload ─────────────────────────────────
  let pendingType = "core";

  function uploadKnowledge(type) {
    pendingType = type;
    $("knowledge-file-input")?.click();
  }

  async function handleFileSelected(e) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const p = projects.find((x) => x.id === currentId);
    if (!p) return;
    for (const f of files) {
      try {
        const formData = new FormData();
        formData.append("file", f);
        formData.append("type", pendingType);
        const resp = await fetch(`${RA.API}/api/projects/${p.id}/knowledge`, {
          method: "POST",
          body: formData,
        });
        if (!resp.ok) throw new Error("업로드 실패");
        RA.showToast(`${f.name} 업로드됨`, "success");
      } catch (err) {
        RA.showToast(`업로드 실패: ${f.name}`, "error");
      }
    }
    e.target.value = "";
    // Reload project
    try {
      const fresh = await RA.fetchJSON(`/api/projects/${p.id}`);
      const idx = projects.findIndex((x) => x.id === p.id);
      if (idx >= 0) projects[idx] = fresh;
      renderEditor();
    } catch (_) {}
  }

  async function removeKnowledge(file) {
    const p = projects.find((x) => x.id === currentId);
    if (!p) return;
    if (!confirm(`'${file.filename}' 제거?`)) return;
    try {
      await RA.fetchJSON(`/api/projects/${p.id}/knowledge/${encodeURIComponent(file.filename)}`, { method: "DELETE" });
      const fresh = await RA.fetchJSON(`/api/projects/${p.id}`);
      const idx = projects.findIndex((x) => x.id === p.id);
      if (idx >= 0) projects[idx] = fresh;
      renderEditor();
      RA.showToast("제거됨", "success");
    } catch (e) {
      RA.showToast("제거 실패: " + e.message, "error");
    }
  }

  // ─── Wiki picker modal ────────────────────────────────
  async function openWikiPicker() {
    RA.openModal("wiki-picker-modal");
    const listEl = $("wiki-picker-list");
    if (!listEl) return;
    listEl.innerHTML = '<div class="text-muted text-sm" style="padding:12px">로드 중...</div>';
    try {
      const papers = await RA.fetchJSON("/api/wiki/papers");
      listEl.innerHTML = "";
      if (papers.length === 0) {
        listEl.innerHTML = '<div class="text-muted text-sm" style="padding:12px">Wiki에 논문이 없어요</div>';
        return;
      }
      for (const p of papers) {
        const div = document.createElement("label");
        div.style.cssText = "display:flex;align-items:center;gap:8px;padding:8px;border-radius:6px;cursor:pointer;transition:all .15s";
        div.addEventListener("mouseenter", () => div.style.background = "rgba(168,216,248,0.05)");
        div.addEventListener("mouseleave", () => div.style.background = "");
        div.innerHTML = `
          <input type="checkbox" data-id="${p.id}" data-path="${RA.escapeHtml(p.vault_path || '')}" data-title="${RA.escapeHtml(p.title || '')}" data-pdf="${RA.escapeHtml(p.pdf_path || '')}">
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;color:var(--silver);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${RA.escapeHtml(p.title || '')}</div>
            <div style="font-size:11px;color:var(--silver-muted)">${RA.escapeHtml(p.journal || '')} · ${p.year || ''}</div>
          </div>
        `;
        listEl.appendChild(div);
      }
    } catch (e) {
      listEl.innerHTML = '<div class="text-muted text-sm" style="padding:12px">불러올 수 없습니다</div>';
    }
  }

  async function confirmWikiPicker() {
    const selected = $("wiki-picker-list")?.querySelectorAll("input[type=checkbox]:checked") || [];
    if (selected.length === 0) {
      RA.closeModal("wiki-picker-modal");
      return;
    }
    const p = projects.find((x) => x.id === currentId);
    if (!p) return;
    const existing = (() => {
      if (Array.isArray(p.knowledge_files)) return p.knowledge_files;
      try { return JSON.parse(p.knowledge_files || "[]"); } catch (_) { return []; }
    })();
    const newFiles = [...existing];
    for (const cb of selected) {
      const path = cb.dataset.pdf || cb.dataset.path;
      const filename = cb.dataset.title?.substring(0, 80) || "(wiki)";
      if (path && !newFiles.find((f) => f.path === path)) {
        newFiles.push({ path, filename, type: "core", source: "wiki", wiki_id: cb.dataset.id });
      }
    }
    try {
      const updated = await RA.fetchJSON(`/api/projects/${p.id}`, {
        method: "PUT",
        body: { knowledge_files: newFiles },
      });
      const idx = projects.findIndex((x) => x.id === p.id);
      if (idx >= 0) projects[idx] = updated;
      RA.closeModal("wiki-picker-modal");
      RA.showToast(`${selected.length}개 논문 추가됨`, "success");
      renderEditor();
    } catch (e) {
      RA.showToast("추가 실패: " + e.message, "error");
    }
  }

  RA.onTabFirstShown.projects = init;
  RA.onTabShown.projects = async () => {
    await loadProjects();
    renderSidebar();
    if (currentId && projects.find((p) => p.id === currentId)) renderEditor();
    else if (projects.length > 0) selectProject(projects[0].id);
    else renderEmptyState();
  };

  RA.projects = { init, loadProjects };
})();
