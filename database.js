import Database from "better-sqlite3";
import { chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const LEGACY_MIGRATION_ID = "json-to-sqlite-v1";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    guest_user_json TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    CHECK ((user_id IS NOT NULL AND guest_user_json IS NULL) OR (user_id IS NULL AND guest_user_json IS NOT NULL))
  );
  CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);

  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT 'forest',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    settings_json TEXT NOT NULL DEFAULT '{}',
    guest_owner_id TEXT UNIQUE,
    guest_expires_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS workspaces_guest_expiry_idx ON workspaces(guest_expires_at);

  CREATE TABLE IF NOT EXISTS workspace_members (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    member_id TEXT NOT NULL,
    name TEXT NOT NULL,
    username TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, member_id)
  );
  CREATE INDEX IF NOT EXISTS workspace_members_member_idx ON workspace_members(member_id);

  CREATE TABLE IF NOT EXISTS shared_documents (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('pdf', 'csv', 'excel')),
    size INTEGER NOT NULL DEFAULT 0,
    summary TEXT NOT NULL DEFAULT '',
    has_ai_summary INTEGER NOT NULL DEFAULT 0,
    origin_id TEXT,
    note TEXT NOT NULL DEFAULT '',
    shared_by_id TEXT NOT NULL,
    shared_by_name TEXT NOT NULL,
    shared_at INTEGER NOT NULL,
    record_json TEXT
  );
  CREATE INDEX IF NOT EXISTS shared_documents_workspace_idx ON shared_documents(workspace_id, shared_at DESC);

  CREATE TABLE IF NOT EXISTS insights (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    document_json TEXT NOT NULL,
    items_json TEXT NOT NULL,
    saved_by_id TEXT NOT NULL,
    saved_by_name TEXT NOT NULL,
    saved_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS insights_workspace_idx ON insights(workspace_id, saved_at DESC);
`;

async function readLegacyJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`기존 데이터 파일을 읽지 못했습니다: ${path.basename(filePath)}`, { cause: error });
  }
}

function validSharedId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(value);
}

async function readLegacySharedRecord(sharedDir, id) {
  if (!validSharedId(id)) return null;
  return readLegacyJson(path.join(sharedDir, `${id}.json`));
}

async function migrateLegacyJson(database, dataDir) {
  if (database.prepare("SELECT 1 FROM schema_migrations WHERE id = ?").get(LEGACY_MIGRATION_ID)) return;

  const legacyUsers = await readLegacyJson(path.join(dataDir, "users.json"));
  const legacyWorkspaces = await readLegacyJson(path.join(dataDir, "workspaces.json"));
  const workspaceRows = Array.isArray(legacyWorkspaces?.workspaces) ? legacyWorkspaces.workspaces : [];
  const sharedRecords = new Map();

  for (const workspace of workspaceRows) {
    for (const entry of Array.isArray(workspace.sharedDocuments) ? workspace.sharedDocuments : []) {
      if (validSharedId(entry?.id)) sharedRecords.set(entry.id, await readLegacySharedRecord(path.join(dataDir, "shared"), entry.id));
    }
  }

  const insertUsers = database.prepare(`
    INSERT OR IGNORE INTO users (id, name, username, password_salt, password_hash, created_at)
    VALUES (@id, @name, @username, @salt, @passwordHash, @createdAt)
  `);
  const insertSessions = database.prepare(`
    INSERT OR IGNORE INTO sessions (token_hash, user_id, guest_user_json, created_at, expires_at)
    VALUES (@tokenHash, @userId, NULL, @createdAt, @expiresAt)
  `);
  const insertWorkspace = database.prepare(`
    INSERT OR IGNORE INTO workspaces (id, name, description, color, created_at, updated_at, settings_json, guest_owner_id, guest_expires_at)
    VALUES (@id, @name, @description, @color, @createdAt, @updatedAt, @settings, @guestOwnerId, @guestExpiresAt)
  `);
  const insertMember = database.prepare(`
    INSERT OR IGNORE INTO workspace_members (workspace_id, member_id, name, username, role, joined_at)
    VALUES (@workspaceId, @memberId, @name, @username, @role, @joinedAt)
  `);
  const insertSharedDocument = database.prepare(`
    INSERT OR IGNORE INTO shared_documents (
      id, workspace_id, name, type, size, summary, has_ai_summary, origin_id, note,
      shared_by_id, shared_by_name, shared_at, record_json
    ) VALUES (
      @id, @workspaceId, @name, @type, @size, @summary, @hasAiSummary, @originId, @note,
      @sharedById, @sharedByName, @sharedAt, @recordJson
    )
  `);
  const insertInsight = database.prepare(`
    INSERT OR IGNORE INTO insights (id, workspace_id, title, note, document_json, items_json, saved_by_id, saved_by_name, saved_at)
    VALUES (@id, @workspaceId, @title, @note, @document, @items, @savedById, @savedByName, @savedAt)
  `);

  database.transaction(() => {
    for (const user of Array.isArray(legacyUsers?.users) ? legacyUsers.users : []) {
      if (!user?.id || !user?.username || !user?.salt || !user?.passwordHash) continue;
      insertUsers.run({
        id: String(user.id),
        name: String(user.name || ""),
        username: String(user.username).toLowerCase(),
        salt: String(user.salt),
        passwordHash: String(user.passwordHash),
        createdAt: Number(user.createdAt) || Date.now(),
      });
    }

    const existingUserIds = new Set(database.prepare("SELECT id FROM users").all().map((row) => row.id));
    for (const session of Array.isArray(legacyUsers?.sessions) ? legacyUsers.sessions : []) {
      if (!session?.tokenHash || !existingUserIds.has(session.userId)) continue;
      insertSessions.run({
        tokenHash: String(session.tokenHash),
        userId: String(session.userId),
        createdAt: Number(session.createdAt) || Date.now(),
        expiresAt: Number(session.expiresAt) || Date.now(),
      });
    }

    for (const workspace of workspaceRows) {
      if (!workspace?.id || !workspace?.name) continue;
      insertWorkspace.run({
        id: String(workspace.id),
        name: String(workspace.name),
        description: String(workspace.description || ""),
        color: String(workspace.color || "forest"),
        createdAt: Number(workspace.createdAt) || Date.now(),
        updatedAt: Number(workspace.updatedAt) || Date.now(),
        settings: JSON.stringify(workspace.settings && typeof workspace.settings === "object" ? workspace.settings : {}),
        guestOwnerId: typeof workspace.guestOwnerId === "string" ? workspace.guestOwnerId : null,
        guestExpiresAt: Number.isFinite(workspace.guestExpiresAt) ? workspace.guestExpiresAt : null,
      });

      for (const member of Array.isArray(workspace.members) ? workspace.members : []) {
        if (!member?.id || !["owner", "editor", "viewer"].includes(member.role)) continue;
        insertMember.run({
          workspaceId: String(workspace.id),
          memberId: String(member.id),
          name: String(member.name || ""),
          username: String(member.username || ""),
          role: member.role,
          joinedAt: Number(member.joinedAt) || Number(workspace.createdAt) || Date.now(),
        });
      }

      for (const entry of Array.isArray(workspace.sharedDocuments) ? workspace.sharedDocuments : []) {
        if (!validSharedId(entry?.id) || !["pdf", "csv", "excel"].includes(entry.type)) continue;
        const sharedBy = entry.sharedBy && typeof entry.sharedBy === "object" ? entry.sharedBy : {};
        const record = sharedRecords.get(entry.id);
        insertSharedDocument.run({
          id: entry.id,
          workspaceId: String(workspace.id),
          name: String(entry.name || record?.name || "공유 문서"),
          type: entry.type,
          size: Number(entry.size) || 0,
          summary: String(entry.summary || ""),
          hasAiSummary: entry.hasAiSummary ? 1 : 0,
          originId: typeof entry.originId === "string" ? entry.originId : null,
          note: String(entry.note || ""),
          sharedById: String(sharedBy.id || "unknown"),
          sharedByName: String(sharedBy.name || "알 수 없음"),
          sharedAt: Number(entry.sharedAt) || Date.now(),
          recordJson: record ? JSON.stringify(record) : null,
        });
      }

      for (const insight of Array.isArray(workspace.insights) ? workspace.insights : []) {
        if (!insight?.id || !insight?.title) continue;
        const document = insight.document && typeof insight.document === "object" ? insight.document : {};
        const savedBy = insight.savedBy && typeof insight.savedBy === "object" ? insight.savedBy : {};
        insertInsight.run({
          id: String(insight.id),
          workspaceId: String(workspace.id),
          title: String(insight.title),
          note: String(insight.note || ""),
          document: JSON.stringify(document),
          items: JSON.stringify(Array.isArray(insight.items) ? insight.items : []),
          savedById: String(savedBy.id || "unknown"),
          savedByName: String(savedBy.name || "알 수 없음"),
          savedAt: Number(insight.savedAt) || Date.now(),
        });
      }
    }

    database.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(LEGACY_MIGRATION_ID, Date.now());
  }).immediate();
}

export async function openDatabase({ dataDir = path.resolve(".data"), databasePath } = {}) {
  const resolvedDataDir = path.resolve(dataDir);
  const resolvedDatabasePath = databasePath
    ? path.resolve(databasePath)
    : path.join(resolvedDataDir, "grappler.sqlite");
  await mkdir(path.dirname(resolvedDatabasePath), { recursive: true, mode: 0o700 });

  const database = new Database(resolvedDatabasePath, { timeout: 5000 });
  try {
    database.pragma("foreign_keys = ON");
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = FULL");
    database.exec(SCHEMA);
    await chmod(resolvedDatabasePath, 0o600);
    await migrateLegacyJson(database, resolvedDataDir);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function withTransaction(database, callback) {
  return database.transaction(callback).immediate();
}
