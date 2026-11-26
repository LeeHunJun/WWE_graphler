import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkspaceStore } from "../workspace-store.js";

async function withStore(run) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grappler-ws-"));
  try {
    await run(createWorkspaceStore({ dataDir }), dataDir);
  } finally {
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

test("문서를 공유하고 다시 읽으며, File 객체는 저장하지 않는다", async () => {
  await withStore(async (store, dataDir) => {
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
    assert.deepEqual(await readdir(path.join(dataDir, "shared")), []);
  });
});

test("인사이트를 저장하고 지우며, 데이터는 파일로 남는다", async () => {
  await withStore(async (store, dataDir) => {
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

    const reopened = createWorkspaceStore({ dataDir });
    const saved = await reopened.listInsights(workspace.id);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].savedBy.name, "앨리스");
    await reopened.deleteInsight(workspace.id, insight.id, { actorId: alice.id });
    assert.equal((await reopened.listInsights(workspace.id)).length, 0);
  });
});

test("마지막 워크스페이스는 삭제할 수 없다", async () => {
  await withStore(async (store) => {
    const [workspace] = await store.listWorkspaces();
    await store.joinWorkspace(workspace.id, { actor: alice });
    await assert.rejects(store.deleteWorkspace(workspace.id, { actorId: alice.id }), { code: "LAST_WORKSPACE" });
    const second = await store.createWorkspace({ actor: alice, name: "두 번째" });
    await store.deleteWorkspace(second.id, { actorId: alice.id });
    assert.equal((await store.listWorkspaces()).length, 1);
  });
});

test("내가 속한 워크스페이스만 보이고, 처음엔 기본 워크스페이스에 참여한다", async () => {
  await withStore(async (store) => {
    const mine = await store.ensureDefaultMembership(alice);
    assert.deepEqual(mine.map((workspace) => workspace.id), ["ws-product-team"]);
    const privateTeam = await store.createWorkspace({ actor: alice, name: "비공개 팀" });
    const bobs = await store.ensureDefaultMembership(bob);
    assert.ok(!bobs.some((workspace) => workspace.id === privateTeam.id));
    await store.joinWorkspace(privateTeam.id, { actor: bob });
    assert.equal((await store.listWorkspaces(bob.id)).length, 2);
  });
});
