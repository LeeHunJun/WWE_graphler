import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAuthStore } from "../auth-store.js";

async function withStore(run) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "grappler-auth-"));
  try {
    await run(createAuthStore({ dataDir }), dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("아이디·비밀번호로 가입하고 로그인한다", async () => {
  await withStore(async (store, dataDir) => {
    const { user, session } = await store.signup({ name: "김지은", username: "Jieun_01", password: "secret1" });
    assert.equal(user.username, "jieun_01");
    assert.equal(user.passwordHash, undefined);
    assert.deepEqual(await store.getUserBySession(session.token), user);

    const saved = await readFile(path.join(dataDir, "users.json"), "utf8");
    assert.ok(!saved.includes("secret1"), "비밀번호 원문은 저장하지 않는다");
    assert.ok(!saved.includes(session.token), "세션 토큰 원문은 저장하지 않는다");

    const login = await store.login({ username: "JIEUN_01", password: "secret1" });
    assert.equal(login.user.id, user.id);
    await assert.rejects(store.login({ username: "jieun_01", password: "wrong12" }), { code: "INVALID_CREDENTIALS" });
    await assert.rejects(store.login({ username: "nobody", password: "secret1" }), { code: "INVALID_CREDENTIALS" });
  });
});

test("게스트는 저장 계정 없이 임시 세션을 받고 로그아웃하면 세션이 폐기된다", async () => {
  await withStore(async (store, dataDir) => {
    const { user, session } = store.createGuestSession({ clientKey: "guest-test" });
    assert.equal(user.isGuest, true);
    assert.equal(user.name, "게스트");
    assert.match(user.id, /^guest-/);
    assert.deepEqual(await store.getUserBySession(session.token), user);
    await assert.rejects(readFile(path.join(dataDir, "users.json")), { code: "ENOENT" });

    await store.logout(session.token);
    assert.equal(await store.getUserBySession(session.token), null);
  });
});

test("같은 주소에서 게스트 체험을 짧은 시간에 과도하게 만들 수 없다", async () => {
  await withStore(async (store) => {
    for (let index = 0; index < 10; index += 1) store.createGuestSession({ clientKey: "same-ip" });
    assert.throws(() => store.createGuestSession({ clientKey: "same-ip" }), { code: "TOO_MANY_GUEST_SESSIONS" });
  });
});

test("아이디 규칙, 중복 아이디, 짧은 비밀번호를 막는다", async () => {
  await withStore(async (store) => {
    await assert.rejects(store.signup({ name: "가", username: "ab", password: "secret1" }), { code: "INVALID_USERNAME" });
    await assert.rejects(store.signup({ name: "가", username: "한글아이디", password: "secret1" }), { code: "INVALID_USERNAME" });
    await assert.rejects(store.signup({ name: "가", username: "user1", password: "12345" }), { code: "WEAK_PASSWORD" });
    await store.signup({ name: "가", username: "user1", password: "123456" });
    await assert.rejects(store.signup({ name: "나", username: "USER1", password: "123456" }), { code: "USERNAME_TAKEN" });
  });
});

test("로그인 실패가 반복되면 잠시 막는다", async () => {
  await withStore(async (store) => {
    await store.signup({ name: "가", username: "user1", password: "123456" });
    for (let index = 0; index < 5; index += 1) {
      await assert.rejects(store.login({ username: "user1", password: "bad-pass" }, { clientKey: "ip" }), { code: "INVALID_CREDENTIALS" });
    }
    await assert.rejects(store.login({ username: "user1", password: "123456" }, { clientKey: "ip" }), { code: "TOO_MANY_ATTEMPTS" });
  });
});

test("로그아웃하면 세션이 사라지고, 비밀번호 변경에는 현재 비밀번호가 필요하다", async () => {
  await withStore(async (store) => {
    const { user, session } = await store.signup({ name: "가", username: "user1", password: "123456" });
    await assert.rejects(store.updateProfile(user.id, { newPassword: "abcdef", currentPassword: "nope" }), { code: "INVALID_CREDENTIALS" });
    const updated = await store.updateProfile(user.id, { name: "새 이름", newPassword: "abcdef", currentPassword: "123456" });
    assert.equal(updated.name, "새 이름");
    await store.login({ username: "user1", password: "abcdef" });
    await store.logout(session.token);
    assert.equal(await store.getUserBySession(session.token), null);
  });
});
