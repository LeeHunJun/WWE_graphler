// 팀 워크스페이스 화면: 워크스페이스 전환, 프로필 메뉴, 공유 문서, 저장한 인사이트, 팀 설정.
// 데이터는 서버(/api/workspaces)의 JSON 저장소에 보관하고, 내 문서 보관함(IndexedDB)은 그대로 둔다.
import { INSIGHT_LEVEL_LABELS, sortInsightsByPriority } from "./insight-priority.js";

const WORKSPACE_KEY = "grappler-current-workspace";
const ROLE_LABELS = { owner: "관리자", editor: "편집자", viewer: "보기 전용" };
const COLOR_LABELS = { forest: "숲", blue: "파랑", coral: "코랄", violet: "보라", amber: "앰버" };
const TYPE_LABELS = { pdf: "PDF", csv: "CSV", excel: "Excel" };
const VIEW_TITLES = { overview: "개요", shared: "공유 문서", insights: "저장한 인사이트" };
const OFFLINE_MESSAGE = "워크스페이스 서버에 연결하지 못했어요. 서버가 켜져 있는지 확인해 주세요.";

const $ = (selector) => document.querySelector(selector);

function el(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = text;
  return element;
}

function readStorage(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // 저장소를 쓸 수 없는 브라우저에서는 이번 방문 동안만 유지한다.
  }
}

function initialOf(name) {
  const text = (name || "?").trim();
  return text ? Array.from(text)[0].toUpperCase() : "?";
}

function formatDate(timestamp) {
  if (!timestamp) return "";
  return new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(timestamp));
}

export function collectInsightCandidates(record, spec) {
  const candidates = [];
  const summary = record?.aiSummary;
  if (summary?.spec?.status === "ok") {
    (summary.summary || []).slice(0, 2).forEach((item) => {
      if (item?.text) candidates.push({ kind: "summary", level: "important", visualTitle: "AI 핵심 요약", text: item.text, detail: item.evidence || "" });
    });
    (summary.key_points || []).slice(0, 5).forEach((item) => {
      if (item?.text) candidates.push({ kind: "key_point", level: "info", visualTitle: "AI 핵심 내용", text: item.text, detail: item.evidence || "" });
    });
  }

  for (const visual of spec?.visuals || []) {
    for (const highlight of visual?.highlights || []) {
      if (!highlight?.label && !highlight?.reason) continue;
      const text = [highlight.label, highlight.reason].filter(Boolean).join(" · ");
      candidates.push({
        kind: "highlight",
        level: ["critical", "important", "info"].includes(highlight.level) ? highlight.level : "info",
        visualTitle: visual.title || "",
        text,
        detail: highlight.derived?.formula ? `계산법: ${highlight.derived.formula}` : "",
      });
    }
    if (visual?.caption) {
      candidates.push({ kind: "caption", level: "info", visualTitle: visual.title || "", text: visual.caption, detail: "" });
    }
  }

  const seen = new Set();
  return sortInsightsByPriority(candidates)
    .filter((item) => {
      const key = `${item.visualTitle}|${item.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((item) => ({ ...item, text: item.text.slice(0, 400), detail: item.detail.slice(0, 400), visualTitle: item.visualTitle.slice(0, 80) }))
    .slice(0, 20);
}

export function initWorkspace(hooks) {
  const state = {
    profile: { id: hooks.user.id, name: hooks.user.name, username: hooks.user.username || "", isGuest: hooks.user.isGuest === true },
    workspaces: [],
    workspace: null,
    sharedDocuments: [],
    myShares: [],
    insights: [],
    online: false,
    loading: true,
    view: "overview",
    insightFilter: "all",
  };

  const elements = {
    main: $("#overview"),
    switchButton: $("#workspace-switch"),
    workspaceMenu: $("#workspace-menu"),
    workspaceAvatar: $("#workspace-avatar"),
    workspaceName: $("#workspace-name"),
    breadcrumbWorkspace: $("#breadcrumb-workspace"),
    breadcrumbCurrent: $("#breadcrumb-current"),
    userChip: $("#user-chip"),
    profileMenu: $("#profile-menu"),
    userAvatar: $("#user-avatar"),
    userName: $("#user-name"),
    settingsButton: $("#open-team-settings"),
    sharedCount: $("#sidebar-shared-count"),
    insightCount: $("#sidebar-insight-count"),
    sharedView: $("#shared-view"),
    sharedList: $("#shared-list"),
    sharedSearch: $("#shared-search"),
    sharedWorkspaceLabel: $("#shared-workspace-label"),
    insightsView: $("#insights-view"),
    insightList: $("#insight-list"),
    insightSearch: $("#insight-search"),
    insightWorkspaceLabel: $("#insights-workspace-label"),
    saveInsightButton: $("#save-insight-button"),
  };

  // ---------- 서버 요청 ----------
  async function api(path, { method = "GET", body } = {}) {
    let response;
    try {
      response = await fetch(`/api/workspaces${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error(OFFLINE_MESSAGE);
    }
    let payload = {};
    try {
      payload = await response.json();
    } catch {
      if (!response.ok) throw new Error(OFFLINE_MESSAGE);
    }
    if (response.status === 401) {
      hooks.onSignedOut?.();
      throw new Error(payload.error || "로그인이 필요해요.");
    }
    if (!response.ok) {
      const error = new Error(payload.error || "요청을 처리하지 못했어요.");
      error.code = payload.code;
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function myMember() {
    return state.workspace?.members.find((member) => member.id === state.profile.id) || null;
  }

  function myRole() {
    return myMember()?.role || null;
  }

  function canShare() {
    const role = myRole();
    return role === "owner" || (role === "editor" && state.workspace?.settings?.allowEditorShare !== false);
  }

  function canSaveInsight() {
    const role = myRole();
    return role === "owner" || role === "editor" || (role === "viewer" && state.workspace?.settings?.allowViewerInsights !== false);
  }

  function requireOnline() {
    if (state.online && state.workspace) return true;
    hooks.showToast(OFFLINE_MESSAGE);
    return false;
  }

  async function loadWorkspaceData() {
    if (!state.workspace) return;
    const workspaceId = state.workspace.id;
    const [shared, insights] = await Promise.all([
      api(`/${encodeURIComponent(workspaceId)}/shared-documents`),
      api(`/${encodeURIComponent(workspaceId)}/insights`),
    ]);
    if (state.workspace?.id !== workspaceId) return;
    state.sharedDocuments = shared.documents || [];
    state.insights = insights.insights || [];
  }

  async function enterWorkspace(workspaceId, { announce = false } = {}) {
    const { workspace } = await api(`/${encodeURIComponent(workspaceId)}/join`, { method: "POST", body: {} });
    state.workspace = workspace;
    state.workspaces = state.workspaces.map((item) => (item.id === workspace.id ? workspace : item));
    if (!state.workspaces.some((item) => item.id === workspace.id)) state.workspaces.push(workspace);
    writeStorage(WORKSPACE_KEY, workspace.id);
    state.sharedDocuments = [];
    state.insights = [];
    await loadWorkspaceData();
    renderAll();
    if (announce) hooks.showToast(`“${workspace.name}” 워크스페이스로 전환했어요.`);
  }

  // 신규 회원은 개인 공간 하나로 시작한다. 팀을 만들거나 초대 링크로 참여하는 방법을 한 번만 알려 준다.
  function showPersonalSpaceTip(workspaces) {
    if (state.profile.isGuest || workspaces.length !== 1) return;
    const [only] = workspaces;
    if (!only?.name?.endsWith("님의 개인 공간")) return;
    const key = `grappler-personal-tip-${state.profile.id}`;
    try {
      if (window.localStorage.getItem(key)) return;
      window.localStorage.setItem(key, "1");
    } catch {
      return;
    }
    hooks.showToast("개인 공간에서 시작해요. 팀과 함께 쓰려면 왼쪽 위 워크스페이스 메뉴에서 ‘새 워크스페이스 만들기’를 누르거나, 팀원에게 받은 초대 링크로 들어오세요.");
  }

  async function refresh({ quiet = true } = {}) {
    try {
      const { workspaces, myShares } = await api("");
      state.workspaces = workspaces;
      state.myShares = Array.isArray(myShares) ? myShares : [];
      state.online = true;
      const params = new URLSearchParams(window.location.search);
      const invited = params.get("workspace");
      if (invited && !workspaces.some((item) => item.id === invited)) {
        try {
          const { workspace } = await api(`/${encodeURIComponent(invited)}/join`, { method: "POST", body: {} });
          workspaces.push(workspace);
        } catch {
          hooks.showToast("초대 링크의 워크스페이스를 찾을 수 없어요.");
        }
      }
      const preferred = [invited, state.workspace?.id, readStorage(WORKSPACE_KEY)].find((id) => id && workspaces.some((item) => item.id === id));
      const target = preferred || workspaces[0]?.id;
      if (!target) {
        state.workspace = null;
        renderAll();
        return;
      }
      await enterWorkspace(target);
      showPersonalSpaceTip(workspaces);
      if (invited) {
        const joined = state.workspace?.id === invited;
        params.delete("workspace");
        const query = params.toString();
        window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
        if (joined) hooks.showToast(`초대받은 “${state.workspace.name}” 워크스페이스에 참여했어요.`);
      }
    } catch (error) {
      state.online = false;
      if (!quiet) hooks.showToast(error.message || OFFLINE_MESSAGE);
      renderAll();
    } finally {
      state.loading = false;
    }
  }

  // ---------- 화면 그리기 ----------
  function renderIdentity() {
    const workspace = state.workspace;
    const name = workspace?.name || (state.loading ? "불러오는 중" : state.online ? "워크스페이스 없음" : "내 워크스페이스");
    elements.workspaceName.textContent = name;
    elements.workspaceAvatar.textContent = initialOf(workspace?.name || "내");
    elements.workspaceAvatar.dataset.color = workspace?.color || "forest";
    elements.breadcrumbWorkspace.textContent = name;
    elements.switchButton.title = state.online ? "워크스페이스 전환" : OFFLINE_MESSAGE;

    elements.userAvatar.textContent = initialOf(state.profile.name);
    elements.userName.textContent = state.profile.name;
    elements.settingsButton.hidden = state.profile.isGuest;
    elements.sharedCount.textContent = String(state.sharedDocuments.length);
    elements.insightCount.textContent = String(state.insights.length);
  }

  function menuItem(label, { description, onClick, checked = false, danger = false, icon } = {}) {
    const button = el("button", `menu-item${danger ? " is-danger" : ""}${checked ? " is-checked" : ""}`);
    button.type = "button";
    button.setAttribute("role", "menuitem");
    if (icon) button.append(icon);
    const copy = el("span", "menu-item-copy");
    copy.append(el("span", "menu-item-label", label));
    if (description) copy.append(el("span", "menu-item-description", description));
    button.append(copy);
    if (checked) {
      button.setAttribute("aria-current", "true");
      button.append(el("span", "menu-check", "✓"));
    }
    button.addEventListener("click", () => {
      closeMenus();
      onClick?.();
    });
    return button;
  }

  function avatar(name, color, className = "menu-avatar") {
    const span = el("span", className, initialOf(name));
    span.dataset.color = color || "forest";
    span.setAttribute("aria-hidden", "true");
    return span;
  }

  function renderWorkspaceMenu() {
    const menu = elements.workspaceMenu;
    menu.replaceChildren();
    menu.append(el("p", "menu-heading", "워크스페이스 전환"));
    if (!state.online) {
      menu.append(el("p", "menu-empty", OFFLINE_MESSAGE));
      menu.append(menuItem("다시 연결", { onClick: () => refresh({ quiet: false }) }));
      return;
    }
    const list = el("div", "menu-list");
    state.workspaces.forEach((workspace) => {
      list.append(menuItem(workspace.name, {
        description: `멤버 ${workspace.members.length}명 · 공유 문서 ${workspace.sharedDocumentCount}개`,
        checked: workspace.id === state.workspace?.id,
        icon: avatar(workspace.name, workspace.color),
        onClick: () => {
          if (workspace.id === state.workspace?.id) return;
          enterWorkspace(workspace.id, { announce: true }).catch((error) => hooks.showToast(error.message));
        },
      }));
    });
    menu.append(list);
    if (!state.profile.isGuest) {
      menu.append(el("hr", "menu-divider"));
      menu.append(menuItem("새 워크스페이스 만들기", { onClick: openCreateWorkspaceDialog }));
      menu.append(menuItem("팀 설정", { onClick: openTeamSettings }));
    }
  }

  function renderProfileMenu() {
    const menu = elements.profileMenu;
    menu.replaceChildren();
    const header = el("div", "profile-menu-header");
    header.append(avatar(state.profile.name, "forest", "menu-avatar is-large"));
    const copy = el("div", "profile-menu-copy");
    copy.append(el("strong", "", state.profile.name));
    copy.append(el("span", "", state.profile.isGuest ? "계정 없이 체험 중" : `@${state.profile.username}`));
    const role = myRole();
    if (role) copy.append(el("span", `role-badge role-${role}`, `${state.workspace.name} · ${state.profile.isGuest ? "비공개 체험" : ROLE_LABELS[role]}`));
    header.append(copy);
    menu.append(header, el("hr", "menu-divider"));
    // 좁은 화면에서는 사이드바가 숨으므로 워크스페이스 전환을 프로필 메뉴에서도 제공한다.
    if (!state.profile.isGuest && state.online && state.workspaces.length > 0) {
      const mobileSwitch = el("div", "menu-list mobile-only");
      mobileSwitch.append(el("p", "menu-heading", "워크스페이스"));
      state.workspaces.forEach((workspace) => {
        mobileSwitch.append(menuItem(workspace.name, {
          checked: workspace.id === state.workspace?.id,
          icon: avatar(workspace.name, workspace.color),
          onClick: () => {
            if (workspace.id !== state.workspace?.id) enterWorkspace(workspace.id, { announce: true }).catch((error) => hooks.showToast(error.message));
          },
        }));
      });
      mobileSwitch.append(menuItem("새 워크스페이스 만들기", { onClick: openCreateWorkspaceDialog }));
      mobileSwitch.append(el("hr", "menu-divider"));
      menu.append(mobileSwitch);
    }
    if (!state.profile.isGuest) menu.append(menuItem("프로필 편집", { description: "이름과 비밀번호를 바꿔요", onClick: openProfileDialog }));
    menu.append(menuItem("저장한 인사이트", { description: `${state.insights.length}개`, onClick: () => navigate("insights") }));
    menu.append(menuItem("공유 문서", { description: `${state.sharedDocuments.length}개`, onClick: () => navigate("shared") }));
    if (!state.profile.isGuest) menu.append(menuItem("팀 설정", { onClick: openTeamSettings }));
    menu.append(el("hr", "menu-divider"));
    menu.append(menuItem("로그아웃", {
      description: state.profile.isGuest ? "체험 종료 · 저장한 자료 삭제" : `@${state.profile.username}`,
      onClick: () => hooks.signOut(),
    }));
  }

  function renderSharedView() {
    const query = elements.sharedSearch.value.trim().toLocaleLowerCase("ko");
    elements.sharedWorkspaceLabel.textContent = state.workspace
      ? state.profile.isGuest ? "게스트 개인 공간에만 저장돼요." : `${state.workspace.name} 멤버 모두가 볼 수 있어요.`
      : OFFLINE_MESSAGE;
    const list = elements.sharedList;
    list.replaceChildren();
    const documents = state.sharedDocuments.filter((item) => !query
      || `${item.name} ${item.note} ${item.sharedBy?.name}`.toLocaleLowerCase("ko").includes(query));

    if (documents.length === 0) {
      const empty = el("div", "team-empty");
      empty.append(el("strong", "", state.sharedDocuments.length === 0 ? "아직 공유된 문서가 없어요." : "검색 결과가 없어요."));
      empty.append(el("span", "", state.sharedDocuments.length === 0
        ? "문서 보관함에서 문서 옆 공유 버튼을 누르면 팀원과 함께 볼 수 있어요."
        : "문서 이름, 메모, 공유한 사람으로 다시 검색해 보세요."));
      list.append(empty);
      return;
    }

    const localDocuments = hooks.getDocuments();
    documents.forEach((item) => {
      const card = el("article", "team-card shared-card");
      const top = el("div", "team-card-top");
      top.append(el("span", `team-type-badge type-${item.type}`, TYPE_LABELS[item.type] || item.type));
      const titleBlock = el("div", "team-card-title");
      titleBlock.append(el("h3", "", item.name));
      titleBlock.append(el("p", "", `${item.summary}${item.hasAiSummary ? " · AI 요약 포함" : ""}`));
      top.append(titleBlock);
      card.append(top);
      if (item.note) card.append(el("p", "team-card-note", item.note));
      const meta = el("p", "team-card-meta", `${item.sharedBy?.name || "알 수 없음"} 님이 공유 · ${formatDate(item.sharedAt)}`);
      card.append(meta);

      const actions = el("div", "team-card-actions");
      const imported = Boolean(findLocalDocument(item, localDocuments));
      const openButton = el("button", "team-primary-button", imported ? "보관함에서 보기" : "내 보관함으로 열기");
      openButton.type = "button";
      openButton.addEventListener("click", async () => {
        openButton.disabled = true;
        try {
          await openSharedDocument(item.id);
        } finally {
          openButton.disabled = false;
        }
      });
      actions.append(openButton);
      if (myRole() === "owner" || item.sharedBy?.id === state.profile.id) {
        const removeButton = el("button", "team-ghost-button", "공유 해제");
        removeButton.type = "button";
        removeButton.addEventListener("click", () => confirmAction({
          title: "공유를 해제할까요?",
          message: `“${item.name}” 문서가 팀 공유 목록에서 사라져요. 이미 자기 보관함으로 연 팀원의 사본은 남아 있어요.`,
          confirmLabel: "공유 해제",
          danger: true,
          onConfirm: async () => {
            await api(`/${encodeURIComponent(state.workspace.id)}/shared-documents/${encodeURIComponent(item.id)}`, { method: "DELETE" });
            state.sharedDocuments = state.sharedDocuments.filter((entry) => entry.id !== item.id);
            state.myShares = state.myShares.filter((entry) => entry.id !== item.id);
            renderAll();
            hooks.showToast(`“${item.name}” 공유를 해제했어요.`);
          },
        }));
        actions.append(removeButton);
      }
      card.append(actions);
      list.append(card);
    });
  }

  function renderInsightsView() {
    const query = elements.insightSearch.value.trim().toLocaleLowerCase("ko");
    elements.insightWorkspaceLabel.textContent = state.workspace
      ? state.profile.isGuest
        ? "게스트 개인 공간에 저장한 인사이트예요. 공간은 12시간 후 만료되며 로그아웃하면 삭제돼요."
        : `${state.workspace.name}에서 저장한 인사이트예요. 시각화 패널의 ‘인사이트 저장’으로 추가할 수 있어요.`
      : OFFLINE_MESSAGE;
    document.querySelectorAll("[data-insight-filter]").forEach((button) => {
      const selected = button.dataset.insightFilter === state.insightFilter;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    const list = elements.insightList;
    list.replaceChildren();
    const insights = state.insights.filter((insight) => {
      if (state.insightFilter === "mine" && insight.savedBy?.id !== state.profile.id) return false;
      if (!query) return true;
      const text = `${insight.title} ${insight.note} ${insight.document?.name} ${insight.items.map((item) => item.text).join(" ")}`;
      return text.toLocaleLowerCase("ko").includes(query);
    });

    if (insights.length === 0) {
      const empty = el("div", "team-empty");
      empty.append(el("strong", "", state.insights.length === 0 ? "아직 저장한 인사이트가 없어요." : "조건에 맞는 인사이트가 없어요."));
      empty.append(el("span", "", "문서를 선택한 뒤 시각화 패널의 ‘인사이트 저장’을 누르면 중요한 강조 내용을 모아 둘 수 있어요."));
      list.append(empty);
      return;
    }

    insights.forEach((insight) => {
      const card = el("article", "team-card insight-card");
      const top = el("div", "team-card-top");
      const titleBlock = el("div", "team-card-title");
      titleBlock.append(el("h3", "", insight.title));
      titleBlock.append(el("p", "", insight.document?.name ? `문서: ${insight.document.name}` : "문서 정보 없음"));
      top.append(titleBlock);
      card.append(top);

      const items = el("ul", "saved-insight-items");
      insight.items.forEach((item) => {
        const li = el("li", `saved-insight-item level-${item.level}`);
        li.append(el("span", `insight-level-badge level-${item.level}`, INSIGHT_LEVEL_LABELS[item.level] || "참고"));
        const copy = el("span", "saved-insight-copy");
        if (item.visualTitle) copy.append(el("span", "saved-insight-visual", item.visualTitle));
        copy.append(el("span", "saved-insight-text", item.text));
        if (item.detail) copy.append(el("span", "saved-insight-detail", item.detail));
        li.append(copy);
        items.append(li);
      });
      card.append(items);
      if (insight.note) card.append(el("p", "team-card-note", insight.note));
      card.append(el("p", "team-card-meta", `${insight.savedBy?.name || "알 수 없음"} 님이 저장 · ${formatDate(insight.savedAt)}`));

      const actions = el("div", "team-card-actions");
      const openButton = el("button", "team-primary-button", "문서 열기");
      openButton.type = "button";
      openButton.addEventListener("click", () => openInsightDocument(insight));
      actions.append(openButton);
      if (myRole() === "owner" || insight.savedBy?.id === state.profile.id) {
        const removeButton = el("button", "team-ghost-button", "삭제");
        removeButton.type = "button";
        removeButton.addEventListener("click", () => confirmAction({
          title: "인사이트를 삭제할까요?",
          message: `“${insight.title}” 인사이트가 팀에서 삭제돼요. 삭제 후에는 되돌릴 수 없어요.`,
          confirmLabel: "삭제",
          danger: true,
          onConfirm: async () => {
            await api(`/${encodeURIComponent(state.workspace.id)}/insights/${encodeURIComponent(insight.id)}`, { method: "DELETE" });
            state.insights = state.insights.filter((entry) => entry.id !== insight.id);
            renderAll();
            hooks.showToast("인사이트를 삭제했어요.");
          },
        }));
        actions.append(removeButton);
      }
      card.append(actions);
      list.append(card);
    });
  }

  function renderView() {
    const view = state.view;
    elements.main.classList.toggle("is-team-view", view !== "overview");
    elements.sharedView.hidden = view !== "shared";
    elements.insightsView.hidden = view !== "insights";
    elements.breadcrumbCurrent.textContent = VIEW_TITLES[view];
    document.querySelectorAll(".side-nav .nav-item[data-view]").forEach((link) => {
      const active = link.dataset.view === view;
      link.classList.toggle("is-active", active);
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
  }

  function renderAll() {
    renderIdentity();
    renderView();
    if (state.view === "shared") renderSharedView();
    if (state.view === "insights") renderInsightsView();
    if (!elements.workspaceMenu.hidden) renderWorkspaceMenu();
    if (!elements.profileMenu.hidden) renderProfileMenu();
    if (elements.saveInsightButton) elements.saveInsightButton.disabled = !hooks.getSelectedDocument();
    hooks.onWorkspaceChange?.();
  }

  // ---------- 라우팅 ----------
  function viewFromHash() {
    const hash = window.location.hash.replace("#", "");
    return hash === "shared" || hash === "insights" ? hash : "overview";
  }

  function navigate(view) {
    if (view === "overview") window.location.hash = "overview";
    else window.location.hash = view;
  }

  function handleHashChange() {
    const previous = state.view;
    state.view = viewFromHash();
    renderAll();
    if (state.view !== "overview") {
      window.scrollTo({ top: 0 });
      syncWorkspace();
    } else if (previous !== "overview") {
      const target = document.getElementById(window.location.hash.replace("#", ""));
      if (target && target !== elements.main) target.scrollIntoView();
      else window.scrollTo({ top: 0 });
    }
  }

  // ---------- 메뉴 ----------
  function closeMenus() {
    elements.workspaceMenu.hidden = true;
    elements.profileMenu.hidden = true;
    elements.switchButton.setAttribute("aria-expanded", "false");
    elements.userChip.setAttribute("aria-expanded", "false");
  }

  function toggleMenu(menu, button, render) {
    const willOpen = menu.hidden;
    closeMenus();
    if (!willOpen) return;
    if (menu === elements.workspaceMenu && state.online) {
      api("").then(({ workspaces }) => {
        state.workspaces = workspaces;
        if (!menu.hidden) renderWorkspaceMenu();
      }).catch(() => {});
    }
    render();
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    menu.querySelector("button")?.focus();
  }

  // ---------- 대화상자 ----------
  function openDialog(dialog) {
    closeMenus();
    if (!dialog.open) dialog.showModal();
  }

  function setFormError(form, message) {
    const error = form.querySelector(".form-error");
    if (!error) return;
    error.textContent = message || "";
    error.hidden = !message;
  }

  async function runForm(form, task) {
    const submit = form.querySelector("[type=submit]");
    setFormError(form, "");
    if (submit) submit.disabled = true;
    try {
      await task();
      form.closest("dialog")?.close();
    } catch (error) {
      setFormError(form, error.message || "요청을 처리하지 못했어요.");
    } finally {
      if (submit) submit.disabled = false;
    }
  }

  function confirmAction({ title, message, confirmLabel = "확인", danger = false, onConfirm }) {
    const dialog = $("#team-confirm-dialog");
    const form = $("#team-confirm-form");
    $("#team-confirm-title").textContent = title;
    $("#team-confirm-message").textContent = message;
    const submit = form.querySelector("[type=submit]");
    submit.textContent = confirmLabel;
    submit.classList.toggle("is-danger", danger);
    form.onsubmit = (event) => {
      event.preventDefault();
      runForm(form, onConfirm);
    };
    setFormError(form, "");
    openDialog(dialog);
  }

  function openProfileDialog() {
    const form = $("#profile-form");
    form.reset();
    form.elements.name.value = state.profile.name;
    form.elements.username.value = state.profile.username;
    setFormError(form, "");
    openDialog($("#profile-dialog"));
    form.elements.name.select();
  }

  function openCreateWorkspaceDialog() {
    if (!requireOnline()) return;
    const form = $("#workspace-create-form");
    form.reset();
    setFormError(form, "");
    openDialog($("#workspace-create-dialog"));
    form.elements.name.focus();
  }

  function renderTeamSettings() {
    const workspace = state.workspace;
    const form = $("#team-settings-form");
    const isOwner = myRole() === "owner";
    $("#team-settings-role").textContent = isOwner
      ? "관리자로 설정을 바꿀 수 있어요."
      : `${ROLE_LABELS[myRole()] || "멤버"} 권한이라 설정은 볼 수만 있어요. 관리자에게 변경을 요청해 주세요.`;
    form.elements.name.value = workspace.name;
    form.elements.description.value = workspace.description || "";
    form.querySelectorAll("input[name=color]").forEach((input) => { input.checked = input.value === workspace.color; });
    form.elements.allowEditorShare.checked = workspace.settings?.allowEditorShare !== false;
    form.elements.allowViewerInsights.checked = workspace.settings?.allowViewerInsights !== false;
    form.querySelectorAll("input, textarea").forEach((input) => { input.disabled = !isOwner; });
    form.querySelector("[type=submit]").hidden = !isOwner;
    $("#team-invite-link").value = `${window.location.origin}${window.location.pathname}?workspace=${encodeURIComponent(workspace.id)}`;

    const memberList = $("#team-member-list");
    memberList.replaceChildren();
    $("#team-member-count").textContent = `${workspace.members.length}명`;
    workspace.members.forEach((member) => {
      const row = el("li", "team-member-row");
      row.append(avatar(member.name, "forest", "menu-avatar"));
      const copy = el("span", "team-member-copy");
      copy.append(el("strong", "", `${member.name}${member.id === state.profile.id ? " (나)" : ""}`));
      copy.append(el("span", "", member.username ? `@${member.username}` : `참여 ${formatDate(member.joinedAt)}`));
      row.append(copy);
      if (isOwner) {
        const select = el("select", "team-role-select");
        select.setAttribute("aria-label", `${member.name} 역할`);
        Object.entries(ROLE_LABELS).forEach(([value, label]) => {
          const option = el("option", "", label);
          option.value = value;
          option.selected = value === member.role;
          select.append(option);
        });
        select.addEventListener("change", async () => {
          try {
            const { workspace: updated } = await api(`/${encodeURIComponent(workspace.id)}/members/${encodeURIComponent(member.id)}`, {
              method: "PATCH",
              body: { role: select.value },
            });
            applyWorkspace(updated);
            hooks.showToast(`${member.name} 님의 역할을 ${ROLE_LABELS[select.value]}(으)로 바꿨어요.`);
          } catch (error) {
            select.value = member.role;
            hooks.showToast(error.message);
          }
        });
        row.append(select);
        if (member.id !== state.profile.id) {
          const remove = el("button", "team-icon-button", "내보내기");
          remove.type = "button";
          remove.addEventListener("click", () => confirmAction({
            title: "멤버를 내보낼까요?",
            message: `${member.name} 님이 “${workspace.name}”에서 빠져요. 그동안 공유한 문서와 인사이트는 남아 있어요.`,
            confirmLabel: "내보내기",
            danger: true,
            onConfirm: async () => {
              const { workspace: updated } = await api(`/${encodeURIComponent(workspace.id)}/members/${encodeURIComponent(member.id)}`, { method: "DELETE" });
              applyWorkspace(updated);
              openTeamSettings();
            },
          }));
          row.append(remove);
        }
      } else {
        row.append(el("span", `role-badge role-${member.role}`, ROLE_LABELS[member.role]));
      }
      memberList.append(row);
    });

    $("#team-delete-workspace").hidden = !isOwner;
    $("#team-delete-workspace").disabled = state.workspaces.length <= 1;
    $("#team-delete-workspace").title = state.workspaces.length <= 1 ? "마지막 워크스페이스는 삭제할 수 없어요." : "";
  }

  function openTeamSettings() {
    if (!requireOnline()) return;
    setFormError($("#team-settings-form"), "");
    renderTeamSettings();
    openDialog($("#team-settings-dialog"));
    // 다른 팀원이 그사이 참여했을 수 있으니 최신 멤버 목록으로 다시 그린다.
    syncWorkspace().then(() => {
      if ($("#team-settings-dialog").open) renderTeamSettings();
    });
  }

  // 현재 워크스페이스 정보와 공유 문서·인사이트 목록을 서버에서 다시 받아온다.
  async function syncWorkspace() {
    if (!state.online || !state.workspace) return;
    try {
      const { workspace } = await api(`/${encodeURIComponent(state.workspace.id)}`);
      if (state.workspace?.id !== workspace.id) return;
      state.workspace = workspace;
      state.workspaces = state.workspaces.map((item) => (item.id === workspace.id ? workspace : item));
      await loadWorkspaceData();
      renderAll();
    } catch (error) {
      if (error.code === "WORKSPACE_NOT_FOUND") refresh({ quiet: false });
    }
  }

  function applyWorkspace(workspace) {
    state.workspace = workspace;
    state.workspaces = state.workspaces.map((item) => (item.id === workspace.id ? workspace : item));
    renderAll();
    if ($("#team-settings-dialog").open) renderTeamSettings();
  }

  function openShareDialog(record) {
    if (!record || !requireOnline()) return;
    if (!canShare()) {
      hooks.showToast(myRole() === "viewer"
        ? "보기 전용 멤버는 문서를 공유할 수 없어요."
        : "이 워크스페이스는 관리자만 문서를 공유할 수 있어요.");
      return;
    }
    const form = $("#share-document-form");
    form.reset();
    setFormError(form, "");
    $("#share-document-name").textContent = record.name;
    $("#share-document-workspace").textContent = state.workspace.name;
    const alreadyShared = state.sharedDocuments.some((item) => item.originId === record.id || item.id === record.sharedFrom?.documentId);
    $("#share-document-warning").hidden = !alreadyShared;
    form.onsubmit = (event) => {
      event.preventDefault();
      runForm(form, async () => {
        await shareRecord(record, form.elements.note.value);
        hooks.showToast(`“${record.name}”을(를) ${state.workspace.name}에 공유했어요.`);
      });
    };
    openDialog($("#share-document-dialog"));
    form.elements.note.focus();
  }

  async function shareRecord(record, note) {
    const { file, ...payload } = record;
    const { document } = await api(`/${encodeURIComponent(state.workspace.id)}/shared-documents`, {
      method: "POST",
      body: { note, record: payload },
    });
    state.sharedDocuments = [document, ...state.sharedDocuments];
    if (document.originId) {
      state.myShares = [{
        id: document.id,
        workspaceId: state.workspace.id,
        workspaceName: state.workspace.name,
        originId: document.originId,
        sharedAt: document.sharedAt,
      }, ...state.myShares];
    }
    renderAll();
    return document;
  }

  function openSaveInsightDialog() {
    const record = hooks.getSelectedDocument();
    if (!record) {
      hooks.showToast("먼저 문서 보관함에서 문서를 선택해 주세요.");
      return;
    }
    if (!requireOnline()) return;
    if (!canSaveInsight()) {
      hooks.showToast("이 워크스페이스에서는 보기 전용 멤버가 인사이트를 저장할 수 없어요.");
      return;
    }
    const candidates = collectInsightCandidates(record, hooks.getVisualSpec(record));
    const form = $("#save-insight-form");
    form.reset();
    setFormError(form, "");
    form.elements.title.value = `${record.name.replace(/\.[^.]+$/, "")} 핵심 인사이트`.slice(0, 80);
    $("#save-insight-document").textContent = record.name;

    const list = $("#save-insight-candidates");
    list.replaceChildren();
    if (candidates.length === 0) {
      list.append(el("p", "menu-empty", "이 문서에는 저장할 강조 내용이 아직 없어요. AI 요약을 실행하거나 아래 메모만 남길 수 있어요."));
    }
    const preselected = new Set(candidates
      .map((item, index) => (["critical", "important"].includes(item.level) ? index : -1))
      .filter((index) => index >= 0));
    if (preselected.size === 0) candidates.slice(0, 3).forEach((_, index) => preselected.add(index));
    candidates.forEach((item, index) => {
      const label = el("label", `insight-candidate level-${item.level}`);
      const input = document.createElement("input");
      input.type = "checkbox";
      input.name = "candidate";
      input.value = String(index);
      input.checked = preselected.has(index);
      label.append(input);
      label.append(el("span", `insight-level-badge level-${item.level}`, INSIGHT_LEVEL_LABELS[item.level] || "참고"));
      const copy = el("span", "saved-insight-copy");
      if (item.visualTitle) copy.append(el("span", "saved-insight-visual", item.visualTitle));
      copy.append(el("span", "saved-insight-text", item.text));
      label.append(copy);
      list.append(label);
    });

    const sharedEntry = state.sharedDocuments.find((item) => item.id === record.sharedFrom?.documentId || item.originId === record.id);
    const shareField = $("#save-insight-share-field");
    shareField.hidden = Boolean(sharedEntry) || !canShare();
    form.elements.shareDocument.checked = !sharedEntry && canShare();

    form.onsubmit = (event) => {
      event.preventDefault();
      runForm(form, async () => {
        const items = [...form.querySelectorAll("input[name=candidate]:checked")].map((input) => candidates[Number(input.value)]);
        const note = form.elements.note.value.trim();
        if (items.length === 0 && note) items.push({ kind: "caption", level: "info", visualTitle: "", text: note.slice(0, 400), detail: "" });
        if (items.length === 0) throw new Error("저장할 인사이트를 하나 이상 고르거나 메모를 남겨 주세요.");
        let sharedDocumentId = sharedEntry?.id || null;
        if (!sharedDocumentId && form.elements.shareDocument.checked && !shareField.hidden) {
          sharedDocumentId = (await shareRecord(record, `인사이트 “${form.elements.title.value.trim()}”의 원본 문서`)).id;
        }
        const { insight } = await api(`/${encodeURIComponent(state.workspace.id)}/insights`, {
          method: "POST",
          body: {
            title: form.elements.title.value,
            note,
            items,
            document: { id: record.id, name: record.name, type: record.type, sharedDocumentId },
          },
        });
        state.insights = [insight, ...state.insights];
        renderAll();
        hooks.showToast(`인사이트 ${items.length}개를 저장했어요. ‘저장한 인사이트’에서 볼 수 있어요.`);
      });
    };
    openDialog($("#save-insight-dialog"));
  }

  // 공유 문서에 해당하는 내 보관함 문서: 내가 공유한 원본이거나, 이미 내 보관함으로 연 사본.
  function findLocalDocument(entry, localDocuments = hooks.getDocuments()) {
    if (!entry) return null;
    return localDocuments.find((record) => record.sharedFrom?.documentId === entry.id)
      || (entry.originId ? localDocuments.find((record) => record.id === entry.originId) : null)
      || null;
  }

  // 이 문서가 공유된 워크스페이스 이름 목록(중복 제거).
  function sharedWorkspacesFor(record) {
    if (!record) return [];
    const names = new Map();
    for (const share of state.myShares) {
      if (share.originId === record.id) names.set(share.workspaceId, share.workspaceName);
    }
    if (state.workspace && state.sharedDocuments.some((item) => item.originId === record.id && item.sharedBy?.id === state.profile.id)) {
      names.set(state.workspace.id, state.workspace.name);
    }
    return [...names.values()];
  }

  async function openSharedDocument(sharedDocumentId) {
    const local = findLocalDocument(state.sharedDocuments.find((item) => item.id === sharedDocumentId) || { id: sharedDocumentId });
    if (local) {
      navigate("overview");
      hooks.openDocument(local.id);
      return;
    }
    if (!requireOnline()) return;
    try {
      const { entry, record } = await api(`/${encodeURIComponent(state.workspace.id)}/shared-documents/${encodeURIComponent(sharedDocumentId)}`);
      record.id = `shared-${entry.id}`;
      record.createdAt = Date.now();
      record.sharedFrom = {
        workspaceId: state.workspace.id,
        workspaceName: state.workspace.name,
        documentId: entry.id,
        sharedBy: entry.sharedBy?.name || "",
        sharedAt: entry.sharedAt,
      };
      await hooks.importDocument(record);
      navigate("overview");
      hooks.openDocument(record.id);
      hooks.showToast(`“${entry.name}”을(를) 내 문서 보관함에 열었어요.`);
    } catch (error) {
      hooks.showToast(error.message || "공유 문서를 열지 못했어요.");
    }
  }

  function openInsightDocument(insight) {
    const local = hooks.getDocuments().find((record) => record.id === insight.document?.id);
    if (local) {
      navigate("overview");
      hooks.openDocument(local.id);
      return;
    }
    const sharedId = insight.document?.sharedDocumentId;
    if (sharedId && state.sharedDocuments.some((item) => item.id === sharedId)) {
      openSharedDocument(sharedId);
      return;
    }
    hooks.showToast("원본 문서가 저장한 사람의 브라우저에만 있어요. 공유 문서로 올려 달라고 요청해 주세요.");
  }

  // ---------- 이벤트 연결 ----------
  elements.switchButton.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleMenu(elements.workspaceMenu, elements.switchButton, renderWorkspaceMenu);
  });
  elements.userChip.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleMenu(elements.profileMenu, elements.userChip, renderProfileMenu);
  });
  [elements.workspaceMenu, elements.profileMenu].forEach((menu) => menu.addEventListener("click", (event) => event.stopPropagation()));
  document.addEventListener("click", closeMenus);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const openButton = !elements.workspaceMenu.hidden ? elements.switchButton : !elements.profileMenu.hidden ? elements.userChip : null;
    closeMenus();
    openButton?.focus();
  });

  $("#open-team-settings").addEventListener("click", openTeamSettings);
  elements.saveInsightButton?.addEventListener("click", openSaveInsightDialog);
  elements.sharedSearch.addEventListener("input", renderSharedView);
  elements.insightSearch.addEventListener("input", renderInsightsView);
  document.querySelectorAll("[data-insight-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.insightFilter = button.dataset.insightFilter;
      renderInsightsView();
    });
  });
  document.querySelectorAll("[data-close-dialog]").forEach((button) => {
    button.addEventListener("click", () => button.closest("dialog")?.close());
  });
  document.querySelectorAll("[data-go-view]").forEach((button) => {
    button.addEventListener("click", () => navigate(button.dataset.goView));
  });

  $("#profile-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    runForm(form, async () => {
      const newPassword = form.elements.newPassword.value;
      if (newPassword && newPassword !== form.elements.newPasswordConfirm.value) throw new Error("새 비밀번호가 서로 달라요.");
      const user = await hooks.updateProfile({
        name: form.elements.name.value,
        currentPassword: form.elements.currentPassword.value,
        newPassword: newPassword || undefined,
      });
      state.profile = { id: user.id, name: user.name, username: user.username };
      if (state.online && state.workspace) await enterWorkspace(state.workspace.id);
      else renderAll();
      hooks.showToast("프로필을 저장했어요.");
    });
  });

  $("#workspace-create-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    runForm(form, async () => {
      const { workspace } = await api("", {
        method: "POST",
        body: { name: form.elements.name.value, description: form.elements.description.value },
      });
      state.workspaces.push(workspace);
      await enterWorkspace(workspace.id);
      hooks.showToast(`“${workspace.name}” 워크스페이스를 만들었어요. 팀 설정에서 초대 링크를 복사해 팀원을 초대해 보세요.`);
    });
  });

  $("#team-settings-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    runForm(form, async () => {
      const { workspace } = await api(`/${encodeURIComponent(state.workspace.id)}`, {
        method: "PATCH",
        body: {
          name: form.elements.name.value,
          description: form.elements.description.value,
          color: form.querySelector("input[name=color]:checked")?.value,
          settings: {
            allowEditorShare: form.elements.allowEditorShare.checked,
            allowViewerInsights: form.elements.allowViewerInsights.checked,
          },
        },
      });
      applyWorkspace(workspace);
      hooks.showToast("팀 설정을 저장했어요.");
    });
  });

  $("#team-copy-invite").addEventListener("click", async () => {
    const input = $("#team-invite-link");
    try {
      await navigator.clipboard.writeText(input.value);
      hooks.showToast("초대 링크를 복사했어요. 팀원이 이 링크로 들어오면 편집자로 참여해요.");
    } catch {
      input.select();
      hooks.showToast("링크를 선택했어요. Ctrl+C로 복사해 주세요.");
    }
  });

  $("#team-leave-workspace").addEventListener("click", () => {
    const workspace = state.workspace;
    confirmAction({
      title: "워크스페이스에서 나갈까요?",
      message: `“${workspace.name}”의 공유 문서와 인사이트를 더 이상 볼 수 없어요. 초대 링크로 다시 참여할 수 있어요.`,
      confirmLabel: "나가기",
      danger: true,
      onConfirm: async () => {
        await api(`/${encodeURIComponent(workspace.id)}/members/${encodeURIComponent(state.profile.id)}`, { method: "DELETE" });
        const next = state.workspaces.find((item) => item.id !== workspace.id && item.members.some((member) => member.id === state.profile.id));
        writeStorage(WORKSPACE_KEY, next?.id || null);
        state.workspace = null;
        if (next) await enterWorkspace(next.id);
        else await refresh({ quiet: false });
        hooks.showToast(`“${workspace.name}”에서 나왔어요.`);
      },
    });
  });

  $("#team-delete-workspace").addEventListener("click", () => {
    const workspace = state.workspace;
    confirmAction({
      title: "워크스페이스를 삭제할까요?",
      message: `“${workspace.name}”의 공유 문서 ${state.sharedDocuments.length}개와 인사이트 ${state.insights.length}개가 모두 삭제돼요. 팀원의 내 문서 보관함은 그대로 남아요. 삭제 후에는 되돌릴 수 없어요.`,
      confirmLabel: "삭제",
      danger: true,
      onConfirm: async () => {
        await api(`/${encodeURIComponent(workspace.id)}`, { method: "DELETE" });
        state.workspaces = state.workspaces.filter((item) => item.id !== workspace.id);
        writeStorage(WORKSPACE_KEY, null);
        state.workspace = null;
        await refresh({ quiet: false });
        hooks.showToast(`“${workspace.name}” 워크스페이스를 삭제했어요.`);
      },
    });
  });

  window.addEventListener("hashchange", handleHashChange);
  // 다른 탭이나 팀원이 바꾼 내용을 다시 보여준다.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.online && state.workspace) {
      enterWorkspace(state.workspace.id).catch(() => {});
    }
  });

  state.view = viewFromHash();
  renderAll();
  refresh();

  return {
    openShareDialog,
    openSaveInsightDialog,
    refreshView: renderAll,
    isSharedDocument: (record) => state.sharedDocuments.some((item) => item.originId === record.id || item.id === record.sharedFrom?.documentId),
    sharedWorkspacesFor,
  };
}
