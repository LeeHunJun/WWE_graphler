import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { openDatabase } from "../database.js";
import { handleWorkspaceApi } from "../workspace-api.js";
import { createWorkspaceStore } from "../workspace-store.js";

const guest = { id: "guest-user-test-1234", name: "게스트", username: "guest_test", isGuest: true };

function createRequest(url, { method = "GET", body = "", cookie = "grappler_session=guest-token" } = {}) {
  const request = Readable.from(body ? [Buffer.from(body)] : []);
  Object.assign(request, {
    url,
    method,
    headers: { cookie, host: "localhost", origin: "http://localhost" },
    socket: { remoteAddress: "127.0.0.1" },
  });
  return request;
}

function createResponse() {
  return {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
}

async function requestWorkspace(url, options, context) {
  const response = createResponse();
  await handleWorkspaceApi(createRequest(url, options), response, context);
  return { ...response, json: JSON.parse(response.body) };
}

test("게스트는 자기 체험 공간만 보고 다른 팀 참여·생성은 할 수 없습니다", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grappler-guest-api-"));
  const database = await openDatabase({ dataDir });
  try {
    const workspaceStore = createWorkspaceStore({ database });
    const authStore = { getUserBySession: async (token) => (token === "guest-token" ? guest : null) };
    const context = { workspaceStore, authStore };
    const home = await requestWorkspace("/api/workspaces", {}, context);

    assert.equal(home.status, 200);
    assert.equal(home.json.workspaces.length, 1);
    const ownWorkspaceId = home.json.workspaces[0].id;
    assert.equal(home.json.workspaces[0].name, "게스트 개인 공간");

    const ownWorkspace = await requestWorkspace(`/api/workspaces/${ownWorkspaceId}`, {}, context);
    assert.equal(ownWorkspace.status, 200);
    const rejoinOwnSpace = await requestWorkspace(`/api/workspaces/${ownWorkspaceId}/join`, { method: "POST", body: "{}" }, context);
    assert.equal(rejoinOwnSpace.status, 200);

    const otherWorkspace = await requestWorkspace("/api/workspaces/ws-product-team", {}, context);
    assert.equal(otherWorkspace.status, 403);
    assert.equal(otherWorkspace.json.code, "GUEST_RESTRICTED");

    const join = await requestWorkspace("/api/workspaces/ws-product-team/join", { method: "POST", body: "{}" }, context);
    assert.equal(join.status, 403);
    const create = await requestWorkspace("/api/workspaces", { method: "POST", body: "{}" }, context);
    assert.equal(create.status, 403);
  } finally {
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("로그인 계정도 멤버가 아닌 팀의 공유 자료를 읽을 수 없습니다", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grappler-workspace-private-"));
  const database = await openDatabase({ dataDir });
  try {
    const workspaceStore = createWorkspaceStore({ database });
    const stranger = { id: "user-stranger-123", name: "외부 사용자", username: "stranger_1" };
    const authStore = { getUserBySession: async (token) => (token === "stranger-token" ? stranger : null) };
    const response = createResponse();
    await handleWorkspaceApi(
      createRequest("/api/workspaces/ws-product-team/shared-documents", { cookie: "grappler_session=stranger-token" }),
      response,
      { workspaceStore, authStore },
    );

    assert.equal(response.status, 403);
    assert.equal(JSON.parse(response.body).code, "NOT_A_MEMBER");
  } finally {
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
