// 팀 워크스페이스 저장소: 서버의 JSON 파일 하나(workspaces.json)와
// 공유 문서 본문 파일(shared/<id>.json)에 저장한다. 별도 DB 없이 동작한다.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const ROLES = Object.freeze(["owner", "editor", "viewer"]);
export const ROLE_LABELS = Object.freeze({ owner: "관리자", editor: "편집자", viewer: "보기 전용" });
export const WORKSPACE_COLORS = Object.freeze(["forest", "blue", "coral", "violet", "amber"]);
const GUEST_WORKSPACE_TTL = 12 * 60 * 60 * 1000;

const LIMITS = Object.freeze({
  workspaceName: 40,
  description: 200,
  memberName: 30,
  username: 20,
  note: 500,
  title: 80,
  itemText: 400,
  items: 20,
  workspaces: 50,
  members: 100,
  sharedDocuments: 200,
  insights: 500,
});

export class WorkspaceError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function cleanText(value, maxLength, { required = false, label = "값" } = {}) {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (required && !text) throw new WorkspaceError(400, "INVALID_INPUT", `${label}을(를) 입력해 주세요.`);
  if (text.length > maxLength) throw new WorkspaceError(400, "INVALID_INPUT", `${label}은(는) ${maxLength}자 이하로 입력해 주세요.`);
  return text;
}

function cleanMultiline(value, maxLength, label) {
  const text = typeof value === "string" ? value.replace(/\r\n/g, "\n").trim() : "";
  if (text.length > maxLength) throw new WorkspaceError(400, "INVALID_INPUT", `${label}은(는) ${maxLength}자 이하로 입력해 주세요.`);
  return text;
}

function cleanId(value, label = "사용자") {
  const id = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) throw new WorkspaceError(400, "INVALID_ACTOR", `${label} 정보가 올바르지 않습니다.`);
  return id;
}

function createEmptyState() {
  return { version: 1, workspaces: [] };
}

function seedState() {
  const now = Date.now();
  return {
    version: 1,
    workspaces: [{
      id: "ws-product-team",
      name: "프로덕트 팀",
      description: "업무 자료와 시각화 인사이트를 함께 보는 기본 워크스페이스예요.",
      color: "forest",
      createdAt: now,
      updatedAt: now,
      settings: { allowEditorShare: true, allowViewerInsights: true },
      members: [],
      sharedDocuments: [],
      insights: [],
    }],
  };
}

function summarizeRecord(record) {
  if (record.type === "pdf") return `${record.pageCount || record.pages?.length || 0}페이지 · PDF`;
  const sheets = Array.isArray(record.sheets) ? record.sheets : [];
  const rows = sheets.reduce((total, sheet) => total + (Number(sheet.rowCount) || sheet.rows?.length || 0), 0);
  if (record.type === "csv") return `${rows}행 · CSV`;
  return `${sheets.length}개 시트 · 총 ${rows}행`;
}

function validateRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new WorkspaceError(400, "INVALID_DOCUMENT", "공유할 문서 정보가 없습니다.");
  }
  if (!["pdf", "csv", "excel"].includes(record.type)) {
    throw new WorkspaceError(400, "INVALID_DOCUMENT", "PDF, CSV, Excel 문서만 공유할 수 있어요.");
  }
  if (record.type === "pdf" && !Array.isArray(record.pages)) {
    throw new WorkspaceError(400, "INVALID_DOCUMENT", "PDF 페이지 내용이 없습니다.");
  }
  if (record.type !== "pdf" && !Array.isArray(record.sheets)) {
    throw new WorkspaceError(400, "INVALID_DOCUMENT", "표 내용이 없습니다.");
  }
  const name = cleanText(record.name, 200, { required: true, label: "문서 이름" });
  // 브라우저 전용 값(File 객체 등)은 저장하지 않는다.
  const { file, ...rest } = record;
  return { ...rest, name };
}

function publicWorkspace(workspace) {
  return {
    id: workspace.id,
    name: workspace.name,
    description: workspace.description,
    color: workspace.color,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    settings: workspace.settings,
    members: workspace.members,
    sharedDocumentCount: workspace.sharedDocuments.length,
    insightCount: workspace.insights.length,
  };
}

export function createWorkspaceStore({ dataDir, seed = true } = {}) {
  if (!dataDir) throw new Error("dataDir is required");
  const statePath = path.join(dataDir, "workspaces.json");
  const sharedDir = path.join(dataDir, "shared");
  let state = null;
  let queue = Promise.resolve();

  async function load() {
    if (!state) {
      try {
        const parsed = JSON.parse(await readFile(statePath, "utf8"));
        state = parsed && Array.isArray(parsed.workspaces) ? parsed : createEmptyState();
      } catch (error) {
        if (error.code !== "ENOENT") throw new WorkspaceError(500, "STORE_UNREADABLE", "워크스페이스 저장 파일을 읽지 못했습니다.");
        state = seed ? seedState() : createEmptyState();
      }
    }
    await pruneExpiredGuestWorkspaces(state);
    return state;
  }

  async function persist() {
    await mkdir(dataDir, { recursive: true });
    const temporaryPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(state, null, 2), "utf8");
    await rename(temporaryPath, statePath);
  }

  // 모든 변경은 한 번에 하나씩 처리해 JSON 파일이 꼬이지 않게 한다.
  function serialize(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  }

  function mutate(task) {
    return serialize(async () => {
      await load();
      const result = await task(state);
      await persist();
      return result;
    });
  }

  function findWorkspace(current, workspaceId) {
    const workspace = current.workspaces.find((item) => item.id === workspaceId);
    if (!workspace) throw new WorkspaceError(404, "WORKSPACE_NOT_FOUND", "워크스페이스를 찾을 수 없어요.");
    return workspace;
  }

  function requireMember(workspace, actorId, allowedRoles = ROLES) {
    const member = workspace.members.find((item) => item.id === actorId);
    if (!member) throw new WorkspaceError(403, "NOT_A_MEMBER", "이 워크스페이스의 멤버가 아니에요.");
    if (!allowedRoles.includes(member.role)) {
      throw new WorkspaceError(403, "FORBIDDEN", `${allowedRoles.map((role) => ROLE_LABELS[role]).join("·")}만 할 수 있어요.`);
    }
    return member;
  }

  function sharedPath(documentId) {
    return path.join(sharedDir, `${cleanId(documentId, "문서")}.json`);
  }

  async function pruneExpiredGuestWorkspaces(current) {
    const now = Date.now();
    const expired = current.workspaces.filter((workspace) => workspace.guestOwnerId && workspace.guestExpiresAt <= now);
    if (expired.length === 0) return;
    const expiredIds = new Set(expired.map((workspace) => workspace.id));
    current.workspaces = current.workspaces.filter((workspace) => !expiredIds.has(workspace.id));
    await Promise.all(expired.flatMap((workspace) => workspace.sharedDocuments.map((item) => rm(sharedPath(item.id), { force: true }))));
    await persist();
  }

  function createGuestWorkspace(actor) {
    return mutate((current) => {
      const actorId = cleanId(actor?.id);
      const existing = current.workspaces.find((workspace) => workspace.guestOwnerId === actorId);
      if (existing) return publicWorkspace(existing);
      if (current.workspaces.length >= LIMITS.workspaces) {
        throw new WorkspaceError(400, "LIMIT_REACHED", "워크스페이스를 더 만들 수 없어요.");
      }
      const now = Date.now();
      const workspace = {
        id: `ws-${randomUUID()}`,
        name: "게스트 개인 공간",
        description: "12시간 동안 사용할 수 있는 비공개 체험 공간이에요.",
        color: "forest",
        createdAt: now,
        updatedAt: now,
        settings: { allowEditorShare: true, allowViewerInsights: true },
        members: [{
          id: actorId,
          name: cleanText(actor?.name, LIMITS.memberName, { required: true, label: "이름" }),
          username: cleanText(actor?.username, LIMITS.username, { label: "아이디" }),
          role: "owner",
          joinedAt: now,
        }],
        sharedDocuments: [],
        insights: [],
        guestOwnerId: actorId,
        guestExpiresAt: now + GUEST_WORKSPACE_TTL,
      };
      current.workspaces.push(workspace);
      return publicWorkspace(workspace);
    });
  }

  return {
    // 내가 멤버인 워크스페이스만 보여준다. 다른 워크스페이스는 초대 링크로 참여한다.
    async listWorkspaces(actorId) {
      const current = await serialize(load);
      const visible = actorId === undefined
        ? current.workspaces
        : current.workspaces.filter((workspace) => workspace.members.some((member) => member.id === actorId));
      return visible.map(publicWorkspace);
    },

    // 처음 로그인해 속한 워크스페이스가 없으면 기본 워크스페이스에 참여시킨다.
    async ensureDefaultMembership(actor) {
      if (actor?.isGuest) return [await createGuestWorkspace(actor)];
      const mine = await this.listWorkspaces(actor.id);
      if (mine.length > 0) return mine;
      const current = await serialize(load);
      const target = current.workspaces.find((workspace) => workspace.id === "ws-product-team") || current.workspaces[0];
      if (!target) return [];
      return [await this.joinWorkspace(target.id, { actor })];
    },

    deleteGuestWorkspaces(actorId) {
      return mutate(async (current) => {
        const ownerId = cleanId(actorId);
        const removed = current.workspaces.filter((workspace) => workspace.guestOwnerId === ownerId);
        if (removed.length === 0) return { count: 0 };
        const removedIds = new Set(removed.map((workspace) => workspace.id));
        current.workspaces = current.workspaces.filter((workspace) => !removedIds.has(workspace.id));
        await Promise.all(removed.flatMap((workspace) => workspace.sharedDocuments.map((item) => rm(sharedPath(item.id), { force: true }))));
        return { count: removed.length };
      });
    },

    async getWorkspace(workspaceId) {
      const current = await serialize(load);
      return publicWorkspace(findWorkspace(current, workspaceId));
    },

    createWorkspace({ actor, name, description, color }) {
      return mutate((current) => {
        if (current.workspaces.length >= LIMITS.workspaces) {
          throw new WorkspaceError(400, "LIMIT_REACHED", "워크스페이스를 더 만들 수 없어요.");
        }
        const actorId = cleanId(actor?.id);
        const now = Date.now();
        const workspace = {
          id: `ws-${randomUUID()}`,
          name: cleanText(name, LIMITS.workspaceName, { required: true, label: "워크스페이스 이름" }),
          description: cleanText(description, LIMITS.description, { label: "설명" }),
          color: WORKSPACE_COLORS.includes(color) ? color : WORKSPACE_COLORS[current.workspaces.length % WORKSPACE_COLORS.length],
          createdAt: now,
          updatedAt: now,
          settings: { allowEditorShare: true, allowViewerInsights: true },
          members: [{
            id: actorId,
            name: cleanText(actor?.name, LIMITS.memberName, { required: true, label: "이름" }),
            username: cleanText(actor?.username, LIMITS.username, { label: "아이디" }),
            role: "owner",
            joinedAt: now,
          }],
          sharedDocuments: [],
          insights: [],
        };
        current.workspaces.push(workspace);
        return publicWorkspace(workspace);
      });
    },

    joinWorkspace(workspaceId, { actor }) {
      return mutate((current) => {
        const workspace = findWorkspace(current, workspaceId);
        const actorId = cleanId(actor?.id);
        const name = cleanText(actor?.name, LIMITS.memberName, { required: true, label: "이름" });
        const username = cleanText(actor?.username, LIMITS.username, { label: "아이디" });
        const existing = workspace.members.find((member) => member.id === actorId);
        if (existing) {
          existing.name = name;
          existing.username = username;
        } else {
          if (workspace.members.length >= LIMITS.members) throw new WorkspaceError(400, "LIMIT_REACHED", "멤버 수 한도에 도달했어요.");
          // 아무도 없는 워크스페이스에 처음 들어온 사람이 관리자가 된다.
          workspace.members.push({ id: actorId, name, username, role: workspace.members.length === 0 ? "owner" : "editor", joinedAt: Date.now() });
        }
        workspace.updatedAt = Date.now();
        return publicWorkspace(workspace);
      });
    },

    updateWorkspace(workspaceId, { actorId, name, description, color, settings }) {
      return mutate((current) => {
        const workspace = findWorkspace(current, workspaceId);
        requireMember(workspace, actorId, ["owner"]);
        if (name !== undefined) workspace.name = cleanText(name, LIMITS.workspaceName, { required: true, label: "워크스페이스 이름" });
        if (description !== undefined) workspace.description = cleanText(description, LIMITS.description, { label: "설명" });
        if (color !== undefined) {
          if (!WORKSPACE_COLORS.includes(color)) throw new WorkspaceError(400, "INVALID_INPUT", "지원하지 않는 색상이에요.");
          workspace.color = color;
        }
        if (settings && typeof settings === "object") {
          if (typeof settings.allowEditorShare === "boolean") workspace.settings.allowEditorShare = settings.allowEditorShare;
          if (typeof settings.allowViewerInsights === "boolean") workspace.settings.allowViewerInsights = settings.allowViewerInsights;
        }
        workspace.updatedAt = Date.now();
        return publicWorkspace(workspace);
      });
    },

    deleteWorkspace(workspaceId, { actorId }) {
      return mutate(async (current) => {
        const workspace = findWorkspace(current, workspaceId);
        requireMember(workspace, actorId, ["owner"]);
        if (current.workspaces.length <= 1) throw new WorkspaceError(400, "LAST_WORKSPACE", "마지막 워크스페이스는 삭제할 수 없어요.");
        current.workspaces = current.workspaces.filter((item) => item.id !== workspaceId);
        await Promise.all(workspace.sharedDocuments.map((item) => rm(sharedPath(item.id), { force: true })));
        return { id: workspaceId };
      });
    },

    updateMember(workspaceId, memberId, { actorId, role }) {
      return mutate((current) => {
        const workspace = findWorkspace(current, workspaceId);
        requireMember(workspace, actorId, ["owner"]);
        if (!ROLES.includes(role)) throw new WorkspaceError(400, "INVALID_INPUT", "지원하지 않는 역할이에요.");
        const member = workspace.members.find((item) => item.id === memberId);
        if (!member) throw new WorkspaceError(404, "MEMBER_NOT_FOUND", "멤버를 찾을 수 없어요.");
        const owners = workspace.members.filter((item) => item.role === "owner");
        if (member.role === "owner" && role !== "owner" && owners.length <= 1) {
          throw new WorkspaceError(400, "LAST_OWNER", "관리자가 최소 한 명은 있어야 해요.");
        }
        member.role = role;
        workspace.updatedAt = Date.now();
        return publicWorkspace(workspace);
      });
    },

    removeMember(workspaceId, memberId, { actorId }) {
      return mutate((current) => {
        const workspace = findWorkspace(current, workspaceId);
        // 본인은 스스로 나갈 수 있고, 다른 멤버는 관리자만 내보낼 수 있다.
        requireMember(workspace, actorId, actorId === memberId ? ROLES : ["owner"]);
        const member = workspace.members.find((item) => item.id === memberId);
        if (!member) throw new WorkspaceError(404, "MEMBER_NOT_FOUND", "멤버를 찾을 수 없어요.");
        const owners = workspace.members.filter((item) => item.role === "owner");
        if (member.role === "owner" && owners.length <= 1) {
          throw new WorkspaceError(400, "LAST_OWNER", "마지막 관리자는 나갈 수 없어요. 다른 멤버를 관리자로 지정해 주세요.");
        }
        workspace.members = workspace.members.filter((item) => item.id !== memberId);
        workspace.updatedAt = Date.now();
        return publicWorkspace(workspace);
      });
    },

    // 계정 프로필(이름·아이디)이 바뀌면 모든 워크스페이스의 멤버 정보에도 반영한다.
    syncMemberProfile(user) {
      return mutate((current) => {
        for (const workspace of current.workspaces) {
          const member = workspace.members.find((item) => item.id === user.id);
          if (member) {
            member.name = cleanText(user.name, LIMITS.memberName, { required: true, label: "이름" });
            member.username = cleanText(user.username, LIMITS.username, { label: "아이디" });
          }
        }
      });
    },

    async listSharedDocuments(workspaceId) {
      const current = await serialize(load);
      return [...findWorkspace(current, workspaceId).sharedDocuments].sort((a, b) => b.sharedAt - a.sharedAt);
    },

    shareDocument(workspaceId, { actorId, note, record }) {
      return mutate(async (current) => {
        const workspace = findWorkspace(current, workspaceId);
        const member = requireMember(workspace, actorId, workspace.settings.allowEditorShare ? ["owner", "editor"] : ["owner"]);
        if (workspace.sharedDocuments.length >= LIMITS.sharedDocuments) {
          throw new WorkspaceError(400, "LIMIT_REACHED", "공유 문서 수 한도에 도달했어요.");
        }
        const cleanRecord = validateRecord(record);
        const id = randomUUID();
        const entry = {
          id,
          name: cleanRecord.name,
          type: cleanRecord.type,
          size: Number(cleanRecord.size) || 0,
          summary: summarizeRecord(cleanRecord),
          hasAiSummary: Boolean(cleanRecord.aiSummary),
          originId: typeof cleanRecord.id === "string" ? cleanRecord.id.slice(0, 80) : null,
          note: cleanMultiline(note, LIMITS.note, "메모"),
          sharedBy: { id: member.id, name: member.name },
          sharedAt: Date.now(),
        };
        await mkdir(sharedDir, { recursive: true });
        await writeFile(sharedPath(id), JSON.stringify({ ...cleanRecord, id }), "utf8");
        workspace.sharedDocuments.push(entry);
        workspace.updatedAt = Date.now();
        return entry;
      });
    },

    async getSharedDocument(workspaceId, documentId, { actorId }) {
      const current = await serialize(load);
      const workspace = findWorkspace(current, workspaceId);
      requireMember(workspace, actorId);
      const entry = workspace.sharedDocuments.find((item) => item.id === documentId);
      if (!entry) throw new WorkspaceError(404, "DOCUMENT_NOT_FOUND", "공유 문서를 찾을 수 없어요.");
      try {
        const record = JSON.parse(await readFile(sharedPath(documentId), "utf8"));
        return { entry, record };
      } catch {
        throw new WorkspaceError(404, "DOCUMENT_NOT_FOUND", "공유 문서 내용을 찾을 수 없어요.");
      }
    },

    unshareDocument(workspaceId, documentId, { actorId }) {
      return mutate(async (current) => {
        const workspace = findWorkspace(current, workspaceId);
        const member = requireMember(workspace, actorId);
        const entry = workspace.sharedDocuments.find((item) => item.id === documentId);
        if (!entry) throw new WorkspaceError(404, "DOCUMENT_NOT_FOUND", "공유 문서를 찾을 수 없어요.");
        if (member.role !== "owner" && entry.sharedBy.id !== member.id) {
          throw new WorkspaceError(403, "FORBIDDEN", "공유한 사람이나 관리자만 공유를 해제할 수 있어요.");
        }
        workspace.sharedDocuments = workspace.sharedDocuments.filter((item) => item.id !== documentId);
        await rm(sharedPath(documentId), { force: true });
        workspace.updatedAt = Date.now();
        return { id: documentId };
      });
    },

    async listInsights(workspaceId) {
      const current = await serialize(load);
      return [...findWorkspace(current, workspaceId).insights].sort((a, b) => b.savedAt - a.savedAt);
    },

    saveInsight(workspaceId, { actorId, title, note, document: source, items }) {
      return mutate((current) => {
        const workspace = findWorkspace(current, workspaceId);
        const member = requireMember(workspace, actorId, workspace.settings.allowViewerInsights ? ROLES : ["owner", "editor"]);
        if (workspace.insights.length >= LIMITS.insights) throw new WorkspaceError(400, "LIMIT_REACHED", "인사이트 저장 한도에 도달했어요.");
        if (!Array.isArray(items) || items.length === 0) throw new WorkspaceError(400, "INVALID_INPUT", "저장할 인사이트를 하나 이상 골라 주세요.");
        const cleanItems = items.slice(0, LIMITS.items).map((item) => ({
          kind: ["summary", "key_point", "highlight", "caption"].includes(item?.kind) ? item.kind : "caption",
          level: ["critical", "important", "info"].includes(item?.level) ? item.level : "info",
          visualTitle: cleanText(item?.visualTitle, LIMITS.title, { label: "그래프 제목" }),
          text: cleanText(item?.text, LIMITS.itemText, { required: true, label: "인사이트 내용" }),
          detail: cleanText(item?.detail, LIMITS.itemText, { label: "근거" }),
        }));
        const insight = {
          id: randomUUID(),
          title: cleanText(title, LIMITS.title, { required: true, label: "제목" }),
          note: cleanMultiline(note, LIMITS.note, "메모"),
          document: {
            id: typeof source?.id === "string" ? source.id.slice(0, 80) : null,
            name: cleanText(source?.name, 200, { label: "문서 이름" }),
            type: ["pdf", "csv", "excel"].includes(source?.type) ? source.type : null,
            sharedDocumentId: typeof source?.sharedDocumentId === "string" ? source.sharedDocumentId.slice(0, 80) : null,
          },
          items: cleanItems,
          savedBy: { id: member.id, name: member.name },
          savedAt: Date.now(),
        };
        workspace.insights.push(insight);
        workspace.updatedAt = Date.now();
        return insight;
      });
    },

    deleteInsight(workspaceId, insightId, { actorId }) {
      return mutate((current) => {
        const workspace = findWorkspace(current, workspaceId);
        const member = requireMember(workspace, actorId);
        const insight = workspace.insights.find((item) => item.id === insightId);
        if (!insight) throw new WorkspaceError(404, "INSIGHT_NOT_FOUND", "인사이트를 찾을 수 없어요.");
        if (member.role !== "owner" && insight.savedBy.id !== member.id) {
          throw new WorkspaceError(403, "FORBIDDEN", "저장한 사람이나 관리자만 삭제할 수 있어요.");
        }
        workspace.insights = workspace.insights.filter((item) => item.id !== insightId);
        workspace.updatedAt = Date.now();
        return { id: insightId };
      });
    },
  };
}
