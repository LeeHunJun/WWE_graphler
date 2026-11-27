import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createAuthStore } from "../auth-store.js";
import { openDatabase } from "../database.js";
import { createWorkspaceStore } from "../workspace-store.js";

test("기존 SQLite 파일을 보존하면서 회원별 개인 공간 표시 열을 안전하게 추가합니다", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grappler-sqlite-personal-schema-"));
  const databasePath = path.join(dataDir, "grappler.sqlite");
  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
    CREATE TABLE users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT, guest_user_json TEXT,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT 'forest', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      settings_json TEXT NOT NULL DEFAULT '{}', guest_owner_id TEXT UNIQUE, guest_expires_at INTEGER
    );
    CREATE TABLE workspace_members (
      workspace_id TEXT NOT NULL, member_id TEXT NOT NULL, name TEXT NOT NULL,
      username TEXT NOT NULL DEFAULT '', role TEXT NOT NULL, joined_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, member_id)
    );
    INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('ws-preserved-team', '기존 팀', 1, 1);
  `);
  legacy.close();

  let database;
  try {
    database = await openDatabase({ dataDir, databasePath });
    const columns = database.pragma("table_info(workspaces)").map((column) => column.name);
    assert.ok(columns.includes("personal_owner_id"));
    assert.equal(database.prepare("SELECT name FROM workspaces WHERE id = ?").get("ws-preserved-team").name, "기존 팀");
    assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get("workspaces_personal_owner_idx"));
  } finally {
    database?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("기존 JSON 계정·세션·팀·공유 문서·인사이트를 SQLite로 한 번 이전합니다", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grappler-sqlite-migrate-"));
  const sharedDir = path.join(dataDir, "shared");
  await mkdir(sharedDir);
  const token = "legacy-session-token";
  const now = Date.now();
  const user = {
    id: "u-legacy-000001",
    name: "기존 사용자",
    username: "legacy_user",
    salt: "legacy-salt",
    passwordHash: "legacy-hash",
    createdAt: now - 1000,
  };
  const document = {
    id: "shared-legacy-000001",
    name: "팀매출.csv",
    type: "csv",
    sheets: [{ name: "매출", rows: [["월", "매출"], ["1월", "120"]], rowCount: 2 }],
    aiSummary: null,
  };
  await writeFile(path.join(dataDir, "users.json"), JSON.stringify({
    users: [user],
    sessions: [{
      tokenHash: createHash("sha256").update(token).digest("hex"),
      userId: user.id,
      createdAt: now - 500,
      expiresAt: now + 60_000,
    }],
  }));
  await writeFile(path.join(sharedDir, `${document.id}.json`), JSON.stringify(document));
  await writeFile(path.join(dataDir, "workspaces.json"), JSON.stringify({
    version: 1,
    workspaces: [{
      id: "ws-legacy-000001",
      name: "기존 영업 팀",
      description: "기존 팀 설명",
      color: "blue",
      createdAt: now - 5000,
      updatedAt: now - 1000,
      settings: { allowEditorShare: false, allowViewerInsights: true },
      members: [{ id: user.id, name: user.name, username: user.username, role: "owner", joinedAt: now - 4000 }],
      sharedDocuments: [{
        id: document.id,
        name: document.name,
        type: document.type,
        size: 120,
        summary: "2행 · CSV",
        hasAiSummary: false,
        originId: "local-legacy-001",
        note: "인계 자료",
        sharedBy: { id: user.id, name: user.name },
        sharedAt: now - 2000,
      }],
      insights: [{
        id: "insight-legacy-000001",
        title: "1월 매출",
        note: "이어 확인",
        document: { id: "local-legacy-001", name: document.name, type: "csv", sharedDocumentId: document.id },
        items: [{ kind: "highlight", level: "critical", text: "120" }],
        savedBy: { id: user.id, name: user.name },
        savedAt: now - 1500,
      }],
    }],
  }));

  let database;
  try {
    database = await openDatabase({ dataDir });
    const authStore = createAuthStore({ database });
    const workspaceStore = createWorkspaceStore({ database, seed: false });

    assert.equal((await authStore.getUserBySession(token)).username, user.username);
    const migratedWorkspaces = await workspaceStore.listWorkspaces(user.id);
    const workspace = migratedWorkspaces.find((item) => item.id === "ws-legacy-000001");
    assert.ok(migratedWorkspaces.some((item) => item.isPersonal), "기존 회원에게 개인 공간이 자동 추가됩니다");
    assert.equal(workspace.name, "기존 영업 팀");
    assert.equal(workspace.sharedDocumentCount, 1);
    const [entry] = await workspaceStore.listSharedDocuments(workspace.id);
    const shared = await workspaceStore.getSharedDocument(workspace.id, entry.id, { actorId: user.id });
    assert.equal(shared.record.sheets[0].rows[1][1], "120");
    assert.equal((await workspaceStore.listInsights(workspace.id))[0].title, "1월 매출");

    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM users").get().count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM workspace_members").get().count, 2);
    assert.ok((await readFile(path.join(dataDir, "users.json"), "utf8")).includes("legacy_user"), "이전 원본은 안전하게 남겨 둡니다");
    assert.equal((await stat(path.join(dataDir, "grappler.sqlite"))).mode & 0o777, 0o600);
  } finally {
    database?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("한 SQLite 파일을 쓰는 두 서버 연결이 계정과 팀 자료를 함께 봅니다", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grappler-sqlite-shared-"));
  let firstDb;
  let secondDb;
  try {
    firstDb = await openDatabase({ dataDir });
    const firstAuth = createAuthStore({ database: firstDb });
    const firstWorkspace = createWorkspaceStore({ database: firstDb });
    const { user } = await firstAuth.signup({ name: "민지", username: "minji_team", password: "safe-pass-1" });
    const [workspace] = await firstWorkspace.ensureDefaultMembership(user);
    const owned = await firstWorkspace.createWorkspace({ actor: user, name: "공유 데이터 팀" });
    const shared = await firstWorkspace.shareDocument(workspace.id, {
      actorId: user.id,
      note: "팀원이 같이 보는 자료",
      record: {
        id: "local-team-sales",
        name: "팀매출.csv",
        type: "csv",
        sheets: [{ name: "매출", rows: [["월", "매출"], ["1월", "120"]], rowCount: 2 }],
      },
    });

    secondDb = await openDatabase({ dataDir });
    const secondAuth = createAuthStore({ database: secondDb });
    const secondWorkspace = createWorkspaceStore({ database: secondDb });
    const login = await secondAuth.login({ username: "MINJI_TEAM", password: "safe-pass-1" });
    const workspaces = await secondWorkspace.ensureDefaultMembership(login.user);

    assert.equal(login.user.id, user.id);
    assert.ok(workspaces.some((item) => item.id === workspace.id));
    assert.ok(workspaces.some((item) => item.id === owned.id));
    assert.equal((await secondWorkspace.listSharedDocuments(workspace.id))[0].id, shared.id);
    const sharedCopy = await secondWorkspace.getSharedDocument(workspace.id, shared.id, { actorId: login.user.id });
    assert.equal(sharedCopy.record.sheets[0].rows[1][1], "120");
    assert.equal(secondDb.prepare("SELECT COUNT(*) AS count FROM users").get().count, 1);
  } finally {
    secondDb?.close();
    firstDb?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DB 파일을 다시 열어도 워크스페이스·인증 계정이 유지됩니다", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grappler-sqlite-reopen-"));
  let firstDb;
  let secondDb;
  try {
    firstDb = await openDatabase({ dataDir });
    const auth = createAuthStore({ database: firstDb });
    const workspaceStore = createWorkspaceStore({ database: firstDb });
    const { user } = await auth.signup({ name: "수현", username: "suhyun_db", password: "safe-pass-2" });
    await workspaceStore.ensureDefaultMembership(user);
    firstDb.close();
    firstDb = null;

    secondDb = await openDatabase({ dataDir });
    const [workspace] = await createWorkspaceStore({ database: secondDb }).listWorkspaces(user.id);
    assert.equal(workspace.name, "수현님의 개인 공간", "신규 회원은 프로덕트 팀이 아니라 개인 공간을 받는다");
    assert.equal(await createAuthStore({ database: secondDb }).login({ username: "suhyun_db", password: "safe-pass-2" }).then(({ user: signedIn }) => signedIn.id), user.id);
  } finally {
    secondDb?.close();
    firstDb?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
