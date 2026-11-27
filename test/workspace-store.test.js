import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase } from "../database.js";
import { createWorkspaceStore } from "../workspace-store.js";

async function withStore(run) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grappler-ws-"));
  const database = await openDatabase({ dataDir });
  try {
    await run(createWorkspaceStore({ database }), dataDir, database);
  } finally {
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

const alice = { id: "user-alice", name: "앨리스" };
const bob = { id: "user-bob", name: "밥" };
const csvRecord = {
  id: "local-1",
  name: "매출.csv",
  type: "csv",
  size: 120,
  file: { shouldNotBeStored: true },
  sheets: [{ name: "매출", rowCount: 3, columnCount: 2, rows: [["월", "매출"], ["1월", "10"], ["2월", "12"]] }],
  visualSpec: { status: "ok", message: "", visuals: [] },
};

test("기본 워크스페이스가 있고 처음 참여한 사람이 관리자가 된다", async () => {
  await withStore(async (store) => {
    const [first] = await store.listWorkspaces();
    assert.equal(first.name, "프로덕트 팀");
    const joined = await store.joinWorkspace(first.id, { actor: alice });
    assert.equal(joined.members[0].role, "owner");
    const second = await store.joinWorkspace(first.id, { actor: bob });
    assert.equal(second.members.find((member) => member.id === bob.id).role, "editor");
  });
});

test("워크스페이스를 만들고 설정을 바꾸며, 관리자만 바꿀 수 있다", async () => {
  await withStore(async (store) => {
    const created = await store.createWorkspace({ actor: alice, name: "  영업   1팀 ", description: "영업 자료" });
    assert.equal(created.name, "영업 1팀");
    await store.joinWorkspace(created.id, { actor: bob });
    await assert.rejects(store.updateWorkspace(created.id, { actorId: bob.id, name: "바뀜" }), { code: "FORBIDDEN" });
    const updated = await store.updateWorkspace(created.id, { actorId: alice.id, name: "영업팀", color: "blue", settings: { allowEditorShare: false } });
    assert.equal(updated.name, "영업팀");
    assert.equal(updated.color, "blue");
    assert.equal(updated.settings.allowEditorShare, false);
    await assert.rejects(store.shareDocument(created.id, { actorId: bob.id, record: csvRecord }), { code: "FORBIDDEN" });
  });
});

test("마지막 관리자는 강등하거나 내보낼 수 없다", async () => {
  await withStore(async (store) => {
    const created = await store.createWorkspace({ actor: alice, name: "팀" });
    await store.joinWorkspace(created.id, { actor: bob });
    await assert.rejects(store.updateMember(created.id, alice.id, { actorId: alice.id, role: "editor" }), { code: "LAST_OWNER" });
    await assert.rejects(store.removeMember(created.id, alice.id, { actorId: alice.id }), { code: "LAST_OWNER" });
    await store.updateMember(created.id, bob.id, { actorId: alice.id, role: "owner" });
    const afterLeave = await store.removeMember(created.id, alice.id, { actorId: alice.id });
    assert.deepEqual(afterLeave.members.map((member) => member.id), [bob.id]);
  });
});

test("문서를 공유하고 다시 읽으며, 본문과 인덱스를 SQLite에 저장한다", async () => {
  await withStore(async (store, _dataDir, database) => {
    const [workspace] = await store.listWorkspaces();
    await store.joinWorkspace(workspace.id, { actor: alice });
    await store.joinWorkspace(workspace.id, { actor: bob });
    const entry = await store.shareDocument(workspace.id, { actorId: alice.id, note: "같이 봐 주세요", record: csvRecord });
    assert.equal(entry.summary, "3행 · CSV");
    assert.equal(entry.originId, "local-1");

    const { record } = await store.getSharedDocument(workspace.id, entry.id, { actorId: bob.id });
    assert.equal(record.name, "매출.csv");
    assert.equal(record.file, undefined);
    assert.equal(record.id, entry.id);

    await assert.rejects(store.getSharedDocument(workspace.id, entry.id, { actorId: "user-stranger" }), { code: "NOT_A_MEMBER" });
    await assert.rejects(store.unshareDocument(workspace.id, entry.id, { actorId: bob.id }), { code: "FORBIDDEN" });
    await store.unshareDocument(workspace.id, entry.id, { actorId: alice.id });
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM shared_documents").get().count, 0);
  });
});

test("인사이트를 저장하고 지우며, DB를 다시 열어도 내용이 유지된다", async () => {
  await withStore(async (store, _dataDir, database) => {
    const [workspace] = await store.listWorkspaces();
    await store.joinWorkspace(workspace.id, { actor: alice });
    await assert.rejects(store.saveInsight(workspace.id, { actorId: alice.id, title: "빈 인사이트", items: [] }), { code: "INVALID_INPUT" });
    const insight = await store.saveInsight(workspace.id, {
      actorId: alice.id,
      title: "3월 매출 하락",
      items: [{ kind: "highlight", level: "critical", visualTitle: "월별 매출", text: "3월 매출 12.5% 감소" }, { kind: "evil", level: "x", text: "기타" }],
      document: { id: "local-1", name: "매출.csv", type: "csv" },
    });
    assert.equal(insight.items[1].kind, "caption");
    assert.equal(insight.items[1].level, "info");

    const reopened = createWorkspaceStore({ database });
    const saved = await reopened.listInsights(workspace.id);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].savedBy.name, "앨리스");
    await reopened.deleteInsight(workspace.id, insight.id, { actorId: alice.id });
    assert.equal((await reopened.listInsights(workspace.id)).length, 0);
  });
});

test("개인 공간은 삭제할 수 없고 팀을 삭제해도 유지됩니다", async () => {
  await withStore(async (store) => {
    const [workspace] = await store.listWorkspaces();
    await store.joinWorkspace(workspace.id, { actor: alice });
    const mine = await store.listWorkspaces(alice.id);
    const personal = mine.find((item) => item.isPersonal);
    assert.ok(personal, "계정에는 보존되는 개인 공간이 있습니다");
    await assert.rejects(store.deleteWorkspace(personal.id, { actorId: alice.id }), { code: "PERSONAL_WORKSPACE" });
    await store.deleteWorkspace(workspace.id, { actorId: alice.id });
    assert.deepEqual((await store.listWorkspaces(alice.id)).map((item) => item.id), [personal.id]);
  });
});

test("신규 회원은 다른 팀에 자동으로 들어가지 않고 자기 개인 공간만 생긴다", async () => {
  await withStore(async (store) => {
    const mine = await store.ensureDefaultMembership(alice);
    assert.equal(mine.length, 1);
    assert.notEqual(mine[0].id, "ws-product-team", "프로덕트 팀에 자동 가입하지 않는다");
    assert.equal(mine[0].name, "앨리스님의 개인 공간");
    assert.equal(mine[0].isPersonal, true);
    assert.deepEqual(mine[0].members.map((member) => [member.id, member.role]), [[alice.id, "owner"]]);
    assert.deepEqual((await store.ensureDefaultMembership(alice)).map((workspace) => workspace.id), [mine[0].id], "다시 들어와도 개인 공간이 늘지 않는다");
    const privateTeam = await store.createWorkspace({ actor: alice, name: "비공개 팀" });
    const bobs = await store.ensureDefaultMembership(bob);
    assert.ok(!bobs.some((workspace) => workspace.id === privateTeam.id));
    await store.joinWorkspace(privateTeam.id, { actor: bob });
    const bobWorkspaces = await store.listWorkspaces(bob.id);
    assert.equal(bobWorkspaces.length, 2);
    assert.equal(bobWorkspaces[0].id, bobs[0].id, "팀에 참여해도 개인 공간이 첫 번째로 유지됩니다");
    assert.ok(bobWorkspaces[0].isPersonal);
    assert.ok(bobWorkspaces.some((item) => item.id === privateTeam.id));
    await assert.rejects(store.joinWorkspace(bobs[0].id, { actor: alice }), { code: "PERSONAL_WORKSPACE_PRIVATE" });
  });
});

test("기존 팀 가입 회원도 다음 서버 초기화 때 개인 공간을 자동으로 받습니다", async () => {
  await withStore(async (store, _dataDir, database) => {
    const existing = { id: "user-existing-team", name: "기존 회원", username: "existing_team" };
    const now = Date.now();
    database.prepare(`
      INSERT INTO users (id, name, username, password_salt, password_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(existing.id, existing.name, existing.username, "salt", "hash", now);
    database.prepare(`
      INSERT INTO workspace_members (workspace_id, member_id, name, username, role, joined_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("ws-product-team", existing.id, existing.name, existing.username, "editor", now);

    const restartedStore = createWorkspaceStore({ database });
    const afterRestart = await restartedStore.listWorkspaces(existing.id);
    assert.equal(afterRestart.filter((item) => item.isPersonal).length, 1);
    assert.equal(afterRestart.find((item) => item.isPersonal).name, "기존 회원님의 개인 공간");
    assert.ok(afterRestart.some((item) => item.id === "ws-product-team"));
  });
});

test("기존 ‘이름님의 개인 공간’은 표시만 보충하고 새 공간을 중복 생성하지 않습니다", async () => {
  await withStore(async (_store, _dataDir, database) => {
    const existing = { id: "user-legacy-personal", name: "옛 회원", username: "legacy_personal" };
    const now = Date.now();
    database.prepare(`
      INSERT INTO users (id, name, username, password_salt, password_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(existing.id, existing.name, existing.username, "salt", "hash", now);
    database.prepare(`
      INSERT INTO workspaces (id, name, description, color, created_at, updated_at, settings_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      "ws-legacy-personal",
      "옛 회원님의 개인 공간",
      "기존 자료가 있는 개인 공간",
      "forest",
      now,
      now,
      JSON.stringify({ allowEditorShare: true, allowViewerInsights: true }),
    );
    database.prepare(`
      INSERT INTO workspace_members (workspace_id, member_id, name, username, role, joined_at)
      VALUES (?, ?, ?, ?, 'owner', ?)
    `).run("ws-legacy-personal", existing.id, existing.name, existing.username, now);

    const migrated = createWorkspaceStore({ database });
    const mine = await migrated.listWorkspaces(existing.id);
    assert.equal(mine.filter((workspace) => workspace.isPersonal).length, 1);
    assert.equal(mine.find((workspace) => workspace.isPersonal).id, "ws-legacy-personal");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM workspaces WHERE personal_owner_id = ?").get(existing.id).count, 1);
  });
});

test("게스트마다 비공개 체험 공간을 만들고 로그아웃 정리 시 서버 자료를 지운다", async () => {
  await withStore(async (store, _dataDir, database) => {
    const guestA = { id: "guest-user-aaaaaa", name: "게스트", username: "guest_aaaa", isGuest: true };
    const guestB = { id: "guest-user-bbbbbb", name: "게스트", username: "guest_bbbb", isGuest: true };
    const [spaceA] = await store.ensureDefaultMembership(guestA);
    const [spaceAAgain] = await store.ensureDefaultMembership(guestA);
    const [spaceB] = await store.ensureDefaultMembership(guestB);

    assert.equal(spaceA.name, "게스트 개인 공간");
    assert.equal(spaceA.id, spaceAAgain.id, "한 게스트는 하나의 개인 공간만 사용합니다");
    assert.notEqual(spaceA.id, spaceB.id, "게스트끼리 공간을 공유하지 않습니다");
    assert.deepEqual((await store.listWorkspaces(guestA.id)).map((workspace) => workspace.id), [spaceA.id]);
    assert.ok(!((await store.ensureDefaultMembership(alice)).map((workspace) => workspace.id)).includes(spaceA.id));

    const shared = await store.shareDocument(spaceA.id, { actorId: guestA.id, record: csvRecord });
    assert.equal((await store.deleteGuestWorkspaces(guestA.id)).count, 1);
    assert.deepEqual(await store.listWorkspaces(guestA.id), []);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM shared_documents WHERE workspace_id = ?").get(spaceA.id).count, 0);
    assert.ok((await store.listWorkspaces(guestB.id)).some((workspace) => workspace.id === spaceB.id));
    assert.ok(shared.id);
  });
});

test("내가 공유한 문서가 어느 워크스페이스에 있는지 원본 id로 알려 준다", async () => {
  await withStore(async (store) => {
    const [workspace] = await store.listWorkspaces();
    await store.joinWorkspace(workspace.id, { actor: alice });
    await store.joinWorkspace(workspace.id, { actor: bob });
    const second = await store.createWorkspace({ actor: alice, name: "영업 팀" });
    await store.shareDocument(workspace.id, { actorId: alice.id, note: "", record: csvRecord });
    const other = await store.shareDocument(second.id, { actorId: alice.id, note: "", record: csvRecord });
    await store.shareDocument(workspace.id, { actorId: bob.id, note: "", record: { ...csvRecord, id: "bob-local" } });

    const mine = await store.listMySharedDocuments(alice.id);
    assert.deepEqual(mine.map((item) => [item.originId, item.workspaceName]).sort(), [["local-1", "영업 팀"], ["local-1", workspace.name]].sort());
    assert.equal((await store.listMySharedDocuments(bob.id)).length, 1);

    await store.unshareDocument(second.id, other.id, { actorId: alice.id });
    assert.deepEqual((await store.listMySharedDocuments(alice.id)).map((item) => item.workspaceId), [workspace.id]);
  });
});
