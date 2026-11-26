// 계정, 로그인 세션과 게스트 세션을 SQLite에 안전하게 저장한다.
// 비밀번호는 scrypt 해시, 세션은 SHA-256 해시만 DB에 보관한다.
import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { withTransaction } from "./database.js";

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

function userFromRow(row) {
  return row ? {
    id: row.id,
    name: row.name,
    username: row.username,
    passwordSalt: row.password_salt,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
  } : null;
}

export function createAuthStore({ database } = {}) {
  if (!database) throw new Error("database is required");
  const failures = new Map();
  const guestAttempts = new Map();
  const selectUserById = database.prepare("SELECT * FROM users WHERE id = ?");
  const selectUserByUsername = database.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE");
  const insertSession = database.prepare(`
    INSERT INTO sessions (token_hash, user_id, guest_user_json, created_at, expires_at)
    VALUES (?, ?, NULL, ?, ?)
  `);

  function createAccountSession(userId) {
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    const expiresAt = now + SESSION_TTL;
    database.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
    insertSession.run(hashToken(token), userId, now, expiresAt);
    return { token, expiresAt };
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
    if (!entry || now - entry.firstAt > GUEST_WINDOW) guestAttempts.set(key, { count: 1, firstAt: now });
    else {
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

    const expiresAt = now + GUEST_SESSION_TTL;
    const user = publicUser({
      id: `guest-${randomUUID()}`,
      name: "게스트",
      username: `guest_${randomBytes(5).toString("hex")}`,
      isGuest: true,
      createdAt: now,
      guestExpiresAt: expiresAt,
    });
    const token = randomBytes(32).toString("base64url");
    database.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
    database.prepare(`
      INSERT INTO sessions (token_hash, user_id, guest_user_json, created_at, expires_at)
      VALUES (?, NULL, ?, ?, ?)
    `).run(hashToken(token), JSON.stringify(user), now, expiresAt);
    return { user, session: { token, expiresAt } };
  }

  return {
    createGuestSession,

    async signup({ name, username, password }) {
      const cleanUsername = normalizeUsername(username);
      const cleanName = normalizeName(name);
      const cleanPassword = checkPassword(password);
      const { salt, hash } = await hashPassword(cleanPassword);
      return withTransaction(database, () => {
        if (selectUserByUsername.get(cleanUsername)) {
          throw new AuthError(409, "USERNAME_TAKEN", "이미 사용 중인 아이디예요. 다른 아이디를 정하거나 로그인해 주세요.");
        }
        const user = {
          id: `u-${randomUUID()}`,
          name: cleanName,
          username: cleanUsername,
          passwordSalt: salt,
          passwordHash: hash,
          createdAt: Date.now(),
        };
        database.prepare(`
          INSERT INTO users (id, name, username, password_salt, password_hash, created_at)
          VALUES (@id, @name, @username, @passwordSalt, @passwordHash, @createdAt)
        `).run(user);
        return { user: publicUser(user), session: createAccountSession(user.id) };
      });
    },

    async login({ username, password }, { clientKey = "" } = {}) {
      const cleanUsername = typeof username === "string" ? username.trim().toLowerCase() : "";
      if (!cleanUsername) throw new AuthError(400, "INVALID_USERNAME", "아이디를 입력해 주세요.");
      const key = `${clientKey}|${cleanUsername}`;
      assertNotLocked(key);
      const user = userFromRow(selectUserByUsername.get(cleanUsername));
      const { hash } = await hashPassword(typeof password === "string" ? password : "", user?.passwordSalt || "0".repeat(32));
      const matches = Boolean(user) && timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(user.passwordHash, "hex"));
      if (!matches) {
        recordFailure(key);
        throw new AuthError(401, "INVALID_CREDENTIALS", "아이디 또는 비밀번호가 맞지 않아요.");
      }
      failures.delete(key);
      return withTransaction(database, () => ({ user: publicUser(user), session: createAccountSession(user.id) }));
    },

    logout(token) {
      if (!token) return Promise.resolve();
      database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
      return Promise.resolve();
    },

    async getUserBySession(token) {
      if (!token) return null;
      const tokenHash = hashToken(token);
      const now = Date.now();
      const session = database.prepare(`
        SELECT guest_user_json, user_id FROM sessions
        WHERE token_hash = ? AND expires_at > ?
      `).get(tokenHash, now);
      if (!session) {
        database.prepare("DELETE FROM sessions WHERE token_hash = ? AND expires_at <= ?").run(tokenHash, now);
        return null;
      }
      if (session.guest_user_json) {
        try {
          return JSON.parse(session.guest_user_json);
        } catch {
          database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
          return null;
        }
      }
      const row = selectUserById.get(session.user_id);
      return row ? publicUser({ id: row.id, name: row.name, username: row.username, createdAt: row.created_at }) : null;
    },

    async updateProfile(userId, { name, currentPassword, newPassword }) {
      const row = selectUserById.get(userId);
      const current = userFromRow(row);
      if (!current) throw new AuthError(401, "UNAUTHORIZED", "다시 로그인해 주세요.");

      let nextPassword = null;
      if (newPassword) {
        const { hash } = await hashPassword(typeof currentPassword === "string" ? currentPassword : "", current.passwordSalt);
        if (!timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(current.passwordHash, "hex"))) {
          throw new AuthError(400, "INVALID_CREDENTIALS", "비밀번호를 바꾸려면 현재 비밀번호를 정확히 입력해 주세요.");
        }
        nextPassword = await hashPassword(checkPassword(newPassword));
      }

      const nextName = name === undefined ? current.name : normalizeName(name);
      const result = withTransaction(database, () => {
        if (nextPassword) {
          const updated = database.prepare(`
            UPDATE users SET name = ?, password_salt = ?, password_hash = ?
            WHERE id = ? AND password_salt = ? AND password_hash = ?
          `).run(nextName, nextPassword.salt, nextPassword.hash, userId, current.passwordSalt, current.passwordHash);
          if (updated.changes === 0) throw new AuthError(409, "PROFILE_CHANGED", "계정 정보가 바뀌었어요. 다시 시도해 주세요.");
        } else {
          database.prepare("UPDATE users SET name = ? WHERE id = ?").run(nextName, userId);
        }
        return { id: userId, name: nextName, username: current.username, createdAt: current.createdAt };
      });
      return publicUser(result);
    },
  };
}
