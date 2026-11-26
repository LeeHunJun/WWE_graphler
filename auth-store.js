// 계정·로그인 저장소: 서버의 users.json 파일에 계정과 로그인 세션을 저장한다.
// 비밀번호는 scrypt 해시로만 보관하고, 세션 토큰도 SHA-256 해시로만 저장한다.
import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
export const GUEST_SESSION_TTL = 12 * 60 * 60 * 1000;
const GUEST_WINDOW = 10 * 60 * 1000;
const GUEST_MAX_SESSIONS = 10;
const PASSWORD_MIN = 6;
const PASSWORD_MAX = 128;
const LOGIN_WINDOW = 10 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;

export class AuthError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// 아이디: 영문 소문자·숫자·밑줄(_) 4~20자. 대소문자는 구분하지 않는다.
function normalizeUsername(value) {
  const username = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[a-z0-9_]{4,20}$/.test(username)) {
    throw new AuthError(400, "INVALID_USERNAME", "아이디는 영문·숫자·밑줄(_)로 4~20자 입력해 주세요.");
  }
  return username;
}

function normalizeName(value) {
  const name = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!name) throw new AuthError(400, "INVALID_NAME", "이름을 입력해 주세요.");
  if (name.length > 30) throw new AuthError(400, "INVALID_NAME", "이름은 30자 이하로 입력해 주세요.");
  return name;
}

function checkPassword(value) {
  const password = typeof value === "string" ? value : "";
  if (password.length < PASSWORD_MIN) throw new AuthError(400, "WEAK_PASSWORD", `비밀번호는 ${PASSWORD_MIN}자 이상으로 정해 주세요.`);
  if (password.length > PASSWORD_MAX) throw new AuthError(400, "WEAK_PASSWORD", `비밀번호는 ${PASSWORD_MAX}자 이하로 정해 주세요.`);
  return password;
}

async function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const derived = await scrypt(password, salt, 64);
  return { salt, hash: derived.toString("hex") };
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    createdAt: user.createdAt,
    isGuest: user.isGuest === true,
    ...(user.isGuest && Number.isFinite(user.guestExpiresAt) ? { guestExpiresAt: user.guestExpiresAt } : {}),
  };
}

export function createAuthStore({ dataDir } = {}) {
  if (!dataDir) throw new Error("dataDir is required");
  const statePath = path.join(dataDir, "users.json");
  const failures = new Map();
  const guestSessions = new Map();
  const guestAttempts = new Map();
  let state = null;
  let queue = Promise.resolve();

  async function load() {
    if (state) return state;
    try {
      const parsed = JSON.parse(await readFile(statePath, "utf8"));
      state = {
        users: Array.isArray(parsed?.users) ? parsed.users : [],
        sessions: Array.isArray(parsed?.sessions) ? parsed.sessions : [],
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw new AuthError(500, "STORE_UNREADABLE", "계정 저장 파일을 읽지 못했습니다.");
      state = { users: [], sessions: [] };
    }
    return state;
  }

  async function persist() {
    await mkdir(dataDir, { recursive: true });
    const temporaryPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, statePath);
  }

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

  function createSession(current, userId) {
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    current.sessions = current.sessions.filter((session) => session.expiresAt > now);
    current.sessions.push({ tokenHash: hashToken(token), userId, createdAt: now, expiresAt: now + SESSION_TTL });
    return { token, expiresAt: now + SESSION_TTL };
  }

  function recordFailure(key) {
    const now = Date.now();
    const entry = failures.get(key);
    if (!entry || now - entry.firstAt > LOGIN_WINDOW) failures.set(key, { count: 1, firstAt: now });
    else entry.count += 1;
  }

  function assertNotLocked(key) {
    const entry = failures.get(key);
    if (entry && Date.now() - entry.firstAt <= LOGIN_WINDOW && entry.count >= LOGIN_MAX_FAILURES) {
      throw new AuthError(429, "TOO_MANY_ATTEMPTS", "로그인 시도가 많아요. 10분 뒤에 다시 시도해 주세요.");
    }
  }

  function createGuestSession({ clientKey = "" } = {}) {
    const now = Date.now();
    const key = String(clientKey || "unknown").slice(0, 120);
    const entry = guestAttempts.get(key);
    if (!entry || now - entry.firstAt > GUEST_WINDOW) {
      guestAttempts.set(key, { count: 1, firstAt: now });
    } else {
      if (entry.count >= GUEST_MAX_SESSIONS) {
        throw new AuthError(429, "TOO_MANY_GUEST_SESSIONS", "게스트 체험을 여러 번 시작했어요. 잠시 후 다시 시도해 주세요.");
      }
      entry.count += 1;
    }

    if (guestAttempts.size > 1000) {
      for (const [attemptKey, attempt] of guestAttempts) {
        if (now - attempt.firstAt > GUEST_WINDOW) guestAttempts.delete(attemptKey);
      }
    }

    for (const [tokenHash, session] of guestSessions) {
      if (session.expiresAt <= now) guestSessions.delete(tokenHash);
    }

    const user = publicUser({
      id: `guest-${randomUUID()}`,
      name: "게스트",
      username: `guest_${randomBytes(5).toString("hex")}`,
      isGuest: true,
      createdAt: now,
      guestExpiresAt: now + GUEST_SESSION_TTL,
    });
    const token = randomBytes(32).toString("base64url");
    const expiresAt = now + GUEST_SESSION_TTL;
    guestSessions.set(hashToken(token), { user, expiresAt });
    return { user, session: { token, expiresAt } };
  }

  return {
    createGuestSession,

    signup({ name, username, password }) {
      return mutate(async (current) => {
        const cleanUsername = normalizeUsername(username);
        const cleanName = normalizeName(name);
        const cleanPassword = checkPassword(password);
        if (current.users.some((user) => user.username === cleanUsername)) {
          throw new AuthError(409, "USERNAME_TAKEN", "이미 사용 중인 아이디예요. 다른 아이디를 정하거나 로그인해 주세요.");
        }
        const { salt, hash } = await hashPassword(cleanPassword);
        const user = { id: `u-${randomUUID()}`, name: cleanName, username: cleanUsername, salt, passwordHash: hash, createdAt: Date.now() };
        current.users.push(user);
        return { user: publicUser(user), session: createSession(current, user.id) };
      });
    },

    login({ username, password }, { clientKey = "" } = {}) {
      return mutate(async (current) => {
        const cleanUsername = typeof username === "string" ? username.trim().toLowerCase() : "";
        if (!cleanUsername) throw new AuthError(400, "INVALID_USERNAME", "아이디를 입력해 주세요.");
        const key = `${clientKey}|${cleanUsername}`;
        assertNotLocked(key);
        const user = current.users.find((item) => item.username === cleanUsername);
        // 없는 계정이어도 같은 시간만큼 계산해 계정 존재 여부가 드러나지 않게 한다.
        const { hash } = await hashPassword(typeof password === "string" ? password : "", user?.salt || "0".repeat(32));
        const matches = Boolean(user) && timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(user.passwordHash, "hex"));
        if (!matches) {
          recordFailure(key);
          throw new AuthError(401, "INVALID_CREDENTIALS", "아이디 또는 비밀번호가 맞지 않아요.");
        }
        failures.delete(key);
        return { user: publicUser(user), session: createSession(current, user.id) };
      });
    },

    logout(token) {
      if (!token) return Promise.resolve();
      const tokenHash = hashToken(token);
      if (guestSessions.delete(tokenHash)) return Promise.resolve();
      return mutate((current) => {
        current.sessions = current.sessions.filter((session) => session.tokenHash !== tokenHash);
      });
    },

    async getUserBySession(token) {
      if (!token) return null;
      const tokenHash = hashToken(token);
      const guestSession = guestSessions.get(tokenHash);
      if (guestSession) {
        if (guestSession.expiresAt <= Date.now()) {
          guestSessions.delete(tokenHash);
          return null;
        }
        return guestSession.user;
      }
      const current = await serialize(load);
      const session = current.sessions.find((item) => item.tokenHash === tokenHash && item.expiresAt > Date.now());
      if (!session) return null;
      const user = current.users.find((item) => item.id === session.userId);
      return user ? publicUser(user) : null;
    },

    updateProfile(userId, { name, currentPassword, newPassword }) {
      return mutate(async (current) => {
        const user = current.users.find((item) => item.id === userId);
        if (!user) throw new AuthError(401, "UNAUTHORIZED", "다시 로그인해 주세요.");
        if (newPassword) {
          const { hash } = await hashPassword(typeof currentPassword === "string" ? currentPassword : "", user.salt);
          if (!timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(user.passwordHash, "hex"))) {
            throw new AuthError(400, "INVALID_CREDENTIALS", "비밀번호를 바꾸려면 현재 비밀번호를 정확히 입력해 주세요.");
          }
        }
        if (name !== undefined) user.name = normalizeName(name);
        if (newPassword) {
          const { salt, hash } = await hashPassword(checkPassword(newPassword));
          user.salt = salt;
          user.passwordHash = hash;
        }
        return publicUser(user);
      });
    },
  };
}
