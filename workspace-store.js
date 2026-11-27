// 계정, 팀 멤버십, 공유 문서와 인사이트를 공용 SQLite 데이터베이스에 저장한다.
import { randomUUID } from "node:crypto";
import { withTransaction } from "./database.js";

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
  // 회원마다 개인 공간이 생기므로 서버 전체 워크스페이스 한도를 넉넉히 둔다.
  workspaces: 5000,
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
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(id)) throw new WorkspaceError(400, "INVALID_ACTOR", `${label} 정보가 올바르지 않습니다.`);
  return id;
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
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
  const { file, ...rest } = record;
  return { ...rest, name };
}

function mapMember(row) {
  return { id: row.member_id, name: row.name, username: row.username, role: row.role, joinedAt: row.joined_at };
}

function mapSharedDocument(row) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    size: row.size,
    summary: row.summary,
    hasAiSummary: Boolean(row.has_ai_summary),
    originId: row.origin_id,
    note: row.note,
    sharedBy: { id: row.shared_by_id, name: row.shared_by_name },
    sharedAt: row.shared_at,
  };
}

function mapInsight(row) {
  return {
    id: row.id,
    title: row.title,
    note: row.note,
    document: parseJson(row.document_json, {}),
    items: parseJson(row.items_json, []),
    savedBy: { id: row.saved_by_id, name: row.saved_by_name },
    savedAt: row.saved_at,
  };
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

export function createWorkspaceStore({ database, seed = true } = {}) {
  if (!database) throw new Error("database is required");

  const statements = {
    workspace: database.prepare("SELECT * FROM workspaces WHERE id = ?"),
    workspaces: database.prepare("SELECT id FROM workspaces ORDER BY created_at, id"),
    members: database.prepare("SELECT * FROM workspace_members WHERE workspace_id = ? ORDER BY joined_at, member_id"),
    member: database.prepare("SELECT * FROM workspace_members WHERE workspace_id = ? AND member_id = ?"),
    sharedDocuments: database.prepare("SELECT * FROM shared_documents WHERE workspace_id = ? ORDER BY shared_at DESC, id"),
    sharedDocument: database.prepare("SELECT * FROM shared_documents WHERE workspace_id = ? AND id = ?"),
    insights: database.prepare("SELECT * FROM insights WHERE workspace_id = ? ORDER BY saved_at DESC, id"),
    insight: database.prepare("SELECT * FROM insights WHERE workspace_id = ? AND id = ?"),
  };

  function pruneExpiredGuestWorkspaces() {
    database.prepare("DELETE FROM workspaces WHERE guest_owner_id IS NOT NULL AND guest_expires_at <= ?").run(Date.now());
  }

  function getWorkspaceRecord(workspaceId) {
    const row = statements.workspace.get(workspaceId);
    if (!row) throw new WorkspaceError(404, "WORKSPACE_NOT_FOUND", "워크스페이스를 찾을 수 없어요.");
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      color: row.color,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      settings: parseJson(row.settings_json, { allowEditorShare: true, allowViewerInsights: true }),
      guestOwnerId: row.guest_owner_id,
      guestExpiresAt: row.guest_expires_at,
      members: statements.members.all(workspaceId).map(mapMember),
      sharedDocuments: statements.sharedDocuments.all(workspaceId).map(mapSharedDocument),
      insights: statements.insights.all(workspaceId).map(mapInsight),
    };
  }

  function getWorkspaceCount() {
    return Number(database.prepare("SELECT COUNT(*) AS count FROM workspaces").get().count);
  }

  function findMember(workspace, memberId) {
    return workspace.members.find((member) => member.id === memberId);
  }

  function requireMember(workspace, actorId, allowedRoles = ROLES) {
    const member = findMember(workspace, actorId);
    if (!member) throw new WorkspaceError(403, "NOT_A_MEMBER", "이 워크스페이스의 멤버가 아니에요.");
    if (!allowedRoles.includes(member.role)) {
      throw new WorkspaceError(403, "FORBIDDEN", `${allowedRoles.map((role) => ROLE_LABELS[role]).join("·")}만 할 수 있어요.`);
    }
    return member;
  }

  function insertMember(workspaceId, member) {
    database.prepare(`
      INSERT INTO workspace_members (workspace_id, member_id, name, username, role, joined_at)
      VALUES (@workspaceId, @memberId, @name, @username, @role, @joinedAt)
    `).run({
      workspaceId,
      memberId: member.id,
      name: member.name,
      username: member.username || "",
      role: member.role,
      joinedAt: member.joinedAt,
    });
  }

  function insertDefaultWorkspace() {
    const now = Date.now();
    database.prepare(`
      INSERT INTO workspaces (id, name, description, color, created_at, updated_at, settings_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      "ws-product-team",
      "프로덕트 팀",
      "업무 자료와 시각화 인사이트를 함께 보는 기본 워크스페이스예요.",
      "forest",
      now,
      now,
      JSON.stringify({ allowEditorShare: true, allowViewerInsights: true }),
    );
  }

  pruneExpiredGuestWorkspaces();
  if (seed) {
    withTransaction(database, () => {
      pruneExpiredGuestWorkspaces();
      if (getWorkspaceCount() === 0) insertDefaultWorkspace();
    });
  }

  function createGuestWorkspace(actor) {
    const actorId = cleanId(actor?.id);
    const now = Date.now();
    const id = `ws-${randomUUID()}`;
    const guestExpiresAt = Number.isFinite(actor?.guestExpiresAt) ? actor.guestExpiresAt : now + GUEST_WORKSPACE_TTL;
    return withTransaction(database, () => {
      pruneExpiredGuestWorkspaces();
      const existingRow = database.prepare("SELECT id FROM workspaces WHERE guest_owner_id = ?").get(actorId);
      if (existingRow) return publicWorkspace(getWorkspaceRecord(existingRow.id));
      if (getWorkspaceCount() >= LIMITS.workspaces) {
        throw new WorkspaceError(400, "LIMIT_REACHED", "워크스페이스를 더 만들 수 없어요.");
      }
      database.prepare(`
        INSERT INTO workspaces (
          id, name, description, color, created_at, updated_at, settings_json, guest_owner_id, guest_expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        "게스트 개인 공간",
        "12시간 동안 사용할 수 있는 비공개 체험 공간이에요.",
        "forest",
        now,
        now,
        JSON.stringify({ allowEditorShare: true, allowViewerInsights: true }),
        actorId,
        guestExpiresAt,
      );
      insertMember(id, {
        id: actorId,
        name: cleanText(actor?.name, LIMITS.memberName, { required: true, label: "이름" }),
        username: cleanText(actor?.username, LIMITS.username, { label: "아이디" }),
        role: "owner",
        joinedAt: now,
      });
      return publicWorkspace(getWorkspaceRecord(id));
    });
  }

  return {
    async listWorkspaces(actorId) {
      pruneExpiredGuestWorkspaces();
      const ids = actorId === undefined
        ? statements.workspaces.all().map((row) => row.id)
        : database.prepare(`
          SELECT w.id FROM workspaces AS w
          INNER JOIN workspace_members AS m ON m.workspace_id = w.id
          WHERE m.member_id = ? ORDER BY w.created_at, w.id
        `).all(actorId).map((row) => row.id);
      return ids.map((id) => publicWorkspace(getWorkspaceRecord(id)));
    },

    async ensureDefaultMembership(actor) {
      pruneExpiredGuestWorkspaces();
      if (actor?.isGuest) return [createGuestWorkspace(actor)];
      const mine = await this.listWorkspaces(actor.id);
      if (mine.length > 0) return mine;
      // 신규 회원을 다른 사람의 팀(예: 프로덕트 팀)에 자동으로 넣지 않는다.
      // 혼자 쓰는 개인 공간을 하나 만들어 주고, 팀은 직접 만들거나 초대 링크로 참여한다.
      const displayName = cleanText(actor?.name, LIMITS.memberName, { required: true, label: "이름" });
      return [await this.createWorkspace({
        actor,
        name: `${displayName}님의 개인 공간`.slice(0, LIMITS.workspaceName),
        description: "나만 보는 개인 공간이에요. 팀과 함께 쓰려면 새 팀을 만들거나 초대 링크로 참여하세요.",
        color: "forest",
      })];
    },

    async deleteGuestWorkspaces(actorId) {
      const ownerId = cleanId(actorId);
      const result = withTransaction(database, () => database.prepare("DELETE FROM workspaces WHERE guest_owner_id = ?").run(ownerId));
      return { count: result.changes };
    },

    async getWorkspace(workspaceId) {
      pruneExpiredGuestWorkspaces();
      return publicWorkspace(getWorkspaceRecord(workspaceId));
    },

    async createWorkspace({ actor, name, description, color }) {
      pruneExpiredGuestWorkspaces();
      const actorId = cleanId(actor?.id);
      const cleanName = cleanText(name, LIMITS.workspaceName, { required: true, label: "워크스페이스 이름" });
      const cleanDescription = cleanText(description, LIMITS.description, { label: "설명" });
      const now = Date.now();
      const id = `ws-${randomUUID()}`;
      return withTransaction(database, () => {
        pruneExpiredGuestWorkspaces();
        if (getWorkspaceCount() >= LIMITS.workspaces) {
          throw new WorkspaceError(400, "LIMIT_REACHED", "워크스페이스를 더 만들 수 없어요.");
        }
        const selectedColor = WORKSPACE_COLORS.includes(color) ? color : WORKSPACE_COLORS[getWorkspaceCount() % WORKSPACE_COLORS.length];
        database.prepare(`
          INSERT INTO workspaces (id, name, description, color, created_at, updated_at, settings_json)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(id, cleanName, cleanDescription, selectedColor, now, now, JSON.stringify({ allowEditorShare: true, allowViewerInsights: true }));
        insertMember(id, {
          id: actorId,
          name: cleanText(actor?.name, LIMITS.memberName, { required: true, label: "이름" }),
          username: cleanText(actor?.username, LIMITS.username, { label: "아이디" }),
          role: "owner",
          joinedAt: now,
        });
        return publicWorkspace(getWorkspaceRecord(id));
      });
    },

    async joinWorkspace(workspaceId, { actor }) {
      pruneExpiredGuestWorkspaces();
      const actorId = cleanId(actor?.id);
      const name = cleanText(actor?.name, LIMITS.memberName, { required: true, label: "이름" });
      const username = cleanText(actor?.username, LIMITS.username, { label: "아이디" });
      withTransaction(database, () => {
        const workspace = getWorkspaceRecord(workspaceId);
        const existing = findMember(workspace, actorId);
        if (existing) {
          database.prepare("UPDATE workspace_members SET name = ?, username = ? WHERE workspace_id = ? AND member_id = ?")
            .run(name, username, workspaceId, actorId);
        } else {
          if (workspace.members.length >= LIMITS.members) throw new WorkspaceError(400, "LIMIT_REACHED", "멤버 수 한도에 도달했어요.");
          insertMember(workspaceId, { id: actorId, name, username, role: workspace.members.length === 0 ? "owner" : "editor", joinedAt: Date.now() });
        }
        database.prepare("UPDATE workspaces SET updated_at = ? WHERE id = ?").run(Date.now(), workspaceId);
      });
      return publicWorkspace(getWorkspaceRecord(workspaceId));
    },

    async updateWorkspace(workspaceId, { actorId, name, description, color, settings }) {
      pruneExpiredGuestWorkspaces();
      withTransaction(database, () => {
        const workspace = getWorkspaceRecord(workspaceId);
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
        database.prepare(`
          UPDATE workspaces SET name = ?, description = ?, color = ?, settings_json = ?, updated_at = ? WHERE id = ?
        `).run(workspace.name, workspace.description, workspace.color, JSON.stringify(workspace.settings), Date.now(), workspaceId);
      });
      return publicWorkspace(getWorkspaceRecord(workspaceId));
    },

    async deleteWorkspace(workspaceId, { actorId }) {
      pruneExpiredGuestWorkspaces();
      return withTransaction(database, () => {
        const workspace = getWorkspaceRecord(workspaceId);
        requireMember(workspace, actorId, ["owner"]);
        if (getWorkspaceCount() <= 1) throw new WorkspaceError(400, "LAST_WORKSPACE", "마지막 워크스페이스는 삭제할 수 없어요.");
        database.prepare("DELETE FROM workspaces WHERE id = ?").run(workspaceId);
        return { id: workspaceId };
      });
    },

    async updateMember(workspaceId, memberId, { actorId, role }) {
      pruneExpiredGuestWorkspaces();
      withTransaction(database, () => {
        const workspace = getWorkspaceRecord(workspaceId);
        requireMember(workspace, actorId, ["owner"]);
        if (!ROLES.includes(role)) throw new WorkspaceError(400, "INVALID_INPUT", "지원하지 않는 역할이에요.");
        const member = findMember(workspace, memberId);
        if (!member) throw new WorkspaceError(404, "MEMBER_NOT_FOUND", "멤버를 찾을 수 없어요.");
        const owners = workspace.members.filter((item) => item.role === "owner");
        if (member.role === "owner" && role !== "owner" && owners.length <= 1) {
          throw new WorkspaceError(400, "LAST_OWNER", "관리자가 최소 한 명은 있어야 해요.");
        }
        database.prepare("UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND member_id = ?").run(role, workspaceId, memberId);
        database.prepare("UPDATE workspaces SET updated_at = ? WHERE id = ?").run(Date.now(), workspaceId);
      });
      return publicWorkspace(getWorkspaceRecord(workspaceId));
    },

    async removeMember(workspaceId, memberId, { actorId }) {
      pruneExpiredGuestWorkspaces();
      withTransaction(database, () => {
        const workspace = getWorkspaceRecord(workspaceId);
        requireMember(workspace, actorId, actorId === memberId ? ROLES : ["owner"]);
        const member = findMember(workspace, memberId);
        if (!member) throw new WorkspaceError(404, "MEMBER_NOT_FOUND", "멤버를 찾을 수 없어요.");
        const owners = workspace.members.filter((item) => item.role === "owner");
        if (member.role === "owner" && owners.length <= 1) {
          throw new WorkspaceError(400, "LAST_OWNER", "마지막 관리자는 나갈 수 없어요. 다른 멤버를 관리자로 지정해 주세요.");
        }
        database.prepare("DELETE FROM workspace_members WHERE workspace_id = ? AND member_id = ?").run(workspaceId, memberId);
        database.prepare("UPDATE workspaces SET updated_at = ? WHERE id = ?").run(Date.now(), workspaceId);
      });
      return publicWorkspace(getWorkspaceRecord(workspaceId));
    },

    async syncMemberProfile(user) {
      const name = cleanText(user.name, LIMITS.memberName, { required: true, label: "이름" });
      const username = cleanText(user.username, LIMITS.username, { label: "아이디" });
      withTransaction(database, () => {
        database.prepare("UPDATE workspace_members SET name = ?, username = ? WHERE member_id = ?").run(name, username, user.id);
      });
    },

    // 내가 공유한 문서가 어느 워크스페이스에 올라가 있는지(내 문서 보관함 표시용). 지금도 멤버인 곳만 돌려준다.
    async listMySharedDocuments(actorId) {
      pruneExpiredGuestWorkspaces();
      const id = cleanId(actorId);
      return database.prepare(`
        SELECT d.id, d.workspace_id, w.name AS workspace_name, d.origin_id, d.shared_at
        FROM shared_documents AS d
        INNER JOIN workspaces AS w ON w.id = d.workspace_id
        INNER JOIN workspace_members AS m ON m.workspace_id = d.workspace_id AND m.member_id = d.shared_by_id
        WHERE d.shared_by_id = ? AND d.origin_id IS NOT NULL
        ORDER BY d.shared_at DESC, d.id
      `).all(id).map((row) => ({
        id: row.id,
        workspaceId: row.workspace_id,
        workspaceName: row.workspace_name,
        originId: row.origin_id,
        sharedAt: row.shared_at,
      }));
    },

    async listSharedDocuments(workspaceId) {
      pruneExpiredGuestWorkspaces();
      getWorkspaceRecord(workspaceId);
      return statements.sharedDocuments.all(workspaceId).map(mapSharedDocument);
    },

    async shareDocument(workspaceId, { actorId, note, record }) {
      pruneExpiredGuestWorkspaces();
      return withTransaction(database, () => {
        const workspace = getWorkspaceRecord(workspaceId);
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
        database.prepare(`
          INSERT INTO shared_documents (
            id, workspace_id, name, type, size, summary, has_ai_summary, origin_id, note,
            shared_by_id, shared_by_name, shared_at, record_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id,
          workspaceId,
          entry.name,
          entry.type,
          entry.size,
          entry.summary,
          entry.hasAiSummary ? 1 : 0,
          entry.originId,
          entry.note,
          entry.sharedBy.id,
          entry.sharedBy.name,
          entry.sharedAt,
          JSON.stringify({ ...cleanRecord, id }),
        );
        database.prepare("UPDATE workspaces SET updated_at = ? WHERE id = ?").run(Date.now(), workspaceId);
        return entry;
      });
    },

    async getSharedDocument(workspaceId, documentId, { actorId }) {
      pruneExpiredGuestWorkspaces();
      const workspace = getWorkspaceRecord(workspaceId);
      requireMember(workspace, actorId);
      const row = statements.sharedDocument.get(workspaceId, documentId);
      if (!row || !row.record_json) throw new WorkspaceError(404, "DOCUMENT_NOT_FOUND", "공유 문서 내용을 찾을 수 없어요.");
      const record = parseJson(row.record_json, null);
      if (!record) throw new WorkspaceError(404, "DOCUMENT_NOT_FOUND", "공유 문서 내용을 찾을 수 없어요.");
      return { entry: mapSharedDocument(row), record };
    },

    async unshareDocument(workspaceId, documentId, { actorId }) {
      pruneExpiredGuestWorkspaces();
      return withTransaction(database, () => {
        const workspace = getWorkspaceRecord(workspaceId);
        const member = requireMember(workspace, actorId);
        const entry = statements.sharedDocument.get(workspaceId, documentId);
        if (!entry) throw new WorkspaceError(404, "DOCUMENT_NOT_FOUND", "공유 문서를 찾을 수 없어요.");
        if (member.role !== "owner" && entry.shared_by_id !== member.id) {
          throw new WorkspaceError(403, "FORBIDDEN", "공유한 사람이나 관리자만 공유를 해제할 수 있어요.");
        }
        database.prepare("DELETE FROM shared_documents WHERE workspace_id = ? AND id = ?").run(workspaceId, documentId);
        database.prepare("UPDATE workspaces SET updated_at = ? WHERE id = ?").run(Date.now(), workspaceId);
        return { id: documentId };
      });
    },

    async listInsights(workspaceId) {
      pruneExpiredGuestWorkspaces();
      getWorkspaceRecord(workspaceId);
      return statements.insights.all(workspaceId).map(mapInsight);
    },

    async saveInsight(workspaceId, { actorId, title, note, document: source, items }) {
      pruneExpiredGuestWorkspaces();
      return withTransaction(database, () => {
        const workspace = getWorkspaceRecord(workspaceId);
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
        database.prepare(`
          INSERT INTO insights (id, workspace_id, title, note, document_json, items_json, saved_by_id, saved_by_name, saved_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          insight.id,
          workspaceId,
          insight.title,
          insight.note,
          JSON.stringify(insight.document),
          JSON.stringify(insight.items),
          insight.savedBy.id,
          insight.savedBy.name,
          insight.savedAt,
        );
        database.prepare("UPDATE workspaces SET updated_at = ? WHERE id = ?").run(Date.now(), workspaceId);
        return insight;
      });
    },

    async deleteInsight(workspaceId, insightId, { actorId }) {
      pruneExpiredGuestWorkspaces();
      return withTransaction(database, () => {
        const workspace = getWorkspaceRecord(workspaceId);
        const member = requireMember(workspace, actorId);
        const row = statements.insight.get(workspaceId, insightId);
        if (!row) throw new WorkspaceError(404, "INSIGHT_NOT_FOUND", "인사이트를 찾을 수 없어요.");
        if (member.role !== "owner" && row.saved_by_id !== member.id) {
          throw new WorkspaceError(403, "FORBIDDEN", "저장한 사람이나 관리자만 삭제할 수 있어요.");
        }
        database.prepare("DELETE FROM insights WHERE workspace_id = ? AND id = ?").run(workspaceId, insightId);
        database.prepare("UPDATE workspaces SET updated_at = ? WHERE id = ?").run(Date.now(), workspaceId);
        return { id: insightId };
      });
    },
  };
}
