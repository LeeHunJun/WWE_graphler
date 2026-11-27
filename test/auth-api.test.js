import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { handleAuthApi } from "../auth-api.js";
import { createAuthStore } from "../auth-store.js";
import { openDatabase } from "../database.js";
import { createWorkspaceStore } from "../workspace-store.js";

function createRequest(url, { method = "GET", body = "", cookie = "" } = {}) {
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

test("회원가입이 끝나면 새 계정의 개인 공간도 즉시 준비됩니다", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grappler-personal-signup-"));
  const database = await openDatabase({ dataDir });
  try {
    const authStore = createAuthStore({ database });
    const workspaceStore = createWorkspaceStore({ database });
    const response = await requestAuth("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ name: "민서", username: "minseo_personal", password: "safe-pass-3" }),
    }, { authStore, workspaceStore });

    assert.equal(response.status, 201);
    const workspaces = await workspaceStore.listWorkspaces(response.json.user.id);
    assert.equal(workspaces.length, 1);
    assert.equal(workspaces[0].name, "민서님의 개인 공간");
    assert.equal(workspaces[0].isPersonal, true);
  } finally {
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

async function requestAuth(url, options, context) {
  const response = createResponse();
  await handleAuthApi(createRequest(url, options), response, context);
  return { ...response, json: JSON.parse(response.body) };
}

test("게스트 API는 짧은 HttpOnly 세션을 발급하고 로그아웃 시 체험 공간을 삭제합니다", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grappler-guest-auth-"));
  const database = await openDatabase({ dataDir });
  try {
    const authStore = createAuthStore({ database });
    const workspaceStore = createWorkspaceStore({ database });
    const context = { authStore, workspaceStore };
    const login = await requestAuth("/api/auth/guest", { method: "POST", body: "{}" }, context);

    assert.equal(login.status, 201);
    assert.equal(login.json.user.isGuest, true);
    const cookie = login.headers["Set-Cookie"];
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    const maxAge = Number(cookie.match(/Max-Age=(\d+)/)?.[1]);
    assert.ok(maxAge <= 43200 && maxAge > 42000, "게스트 세션은 약 12시간 동안만 유지됩니다");
    const token = decodeURIComponent(cookie.match(/^grappler_session=([^;]+)/)[1]);
    assert.deepEqual(await authStore.getUserBySession(token), login.json.user);

    const [workspace] = await workspaceStore.ensureDefaultMembership(login.json.user);
    assert.equal(workspace.name, "게스트 개인 공간");
    const logout = await requestAuth("/api/auth/logout", { method: "POST", body: "{}", cookie: `grappler_session=${token}` }, context);

    assert.equal(logout.status, 200);
    assert.match(logout.headers["Set-Cookie"], /Max-Age=0/);
    assert.equal(await authStore.getUserBySession(token), null);
    assert.deepEqual(await workspaceStore.listWorkspaces(login.json.user.id), []);
  } finally {
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
