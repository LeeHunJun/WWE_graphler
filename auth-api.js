// /api/auth 경로: 회원가입(프로필 생성), 로그인, 로그아웃, 내 정보, 프로필 수정.
import { AuthError, GUEST_SESSION_TTL } from "./auth-store.js";

export const SESSION_COOKIE = "grappler_session";
const BODY_LIMIT = 64 * 1024;

export function readSessionToken(request) {
  const header = request.headers.cookie || "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return "";
}

function isSecureRequest(request) {
  return request.socket?.encrypted || String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
}

function sessionCookie(request, token, expiresAt) {
  const parts = [`${SESSION_COOKIE}=${encodeURIComponent(token)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (expiresAt) parts.push(`Max-Age=${Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))}`);
  else parts.push("Max-Age=0");
  if (isSecureRequest(request)) parts.push("Secure");
  return parts.join("; ");
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new AuthError(413, "TOO_LARGE", "요청이 너무 커요.");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AuthError(400, "INVALID_JSON", "요청 형식이 올바르지 않습니다.");
  }
}

function send(response, status, payload, headers = {}) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(JSON.stringify(payload));
}

// 다른 사이트에서 로그인 쿠키를 이용해 요청을 보내지 못하게, 브라우저가 보낸 Origin이 이 서버와 같은지 확인한다.
export function isSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

export function isAuthApiPath(pathname) {
  return pathname.startsWith("/api/auth/");
}

export async function getRequestUser(request, authStore) {
  return authStore.getUserBySession(readSessionToken(request));
}

export async function handleAuthApi(request, response, { authStore, workspaceStore }) {
  const pathname = new URL(request.url, "http://localhost").pathname;
  const action = pathname.slice("/api/auth/".length);
  try {
    if (request.method !== "GET" && !isSameOrigin(request)) {
      throw new AuthError(403, "BAD_ORIGIN", "허용되지 않은 요청이에요.");
    }

    if (action === "me" && request.method === "GET") {
      const user = await getRequestUser(request, authStore);
      return send(response, 200, { user });
    }

    if (action === "guest" && request.method === "POST") {
      const clientKey = String(request.headers["x-forwarded-for"] || request.socket?.remoteAddress || "").split(",")[0].trim();
      const { user, session } = await authStore.createGuestSession({ clientKey });
      return send(response, 201, { user }, { "Set-Cookie": sessionCookie(request, session.token, session.expiresAt) });
    }

    if (action === "signup" && request.method === "POST") {
      const body = await readJson(request);
      const { user, session } = await authStore.signup(body);
      return send(response, 201, { user }, { "Set-Cookie": sessionCookie(request, session.token, session.expiresAt) });
    }

    if (action === "login" && request.method === "POST") {
      const body = await readJson(request);
      const clientKey = String(request.headers["x-forwarded-for"] || request.socket?.remoteAddress || "").split(",")[0].trim();
      const { user, session } = await authStore.login(body, { clientKey });
      return send(response, 200, { user }, { "Set-Cookie": sessionCookie(request, session.token, session.expiresAt) });
    }

    if (action === "logout" && request.method === "POST") {
      const token = readSessionToken(request);
      const current = await getRequestUser(request, authStore);
      await authStore.logout(token);
      if (current?.isGuest) {
        await workspaceStore?.deleteGuestWorkspaces(current.id).catch((error) => {
          process.stderr.write(`[grappler-guest] 체험 공간 정리 실패: ${error?.message || error}\n`);
        });
      }
      return send(response, 200, { ok: true }, { "Set-Cookie": sessionCookie(request, "", 0) });
    }

    if (action === "me" && request.method === "PATCH") {
      const current = await getRequestUser(request, authStore);
      if (!current) throw new AuthError(401, "UNAUTHORIZED", "다시 로그인해 주세요.");
      if (current.isGuest) throw new AuthError(403, "GUEST_PROFILE_LOCKED", "게스트 프로필은 수정할 수 없어요.");
      const body = await readJson(request);
      const user = await authStore.updateProfile(current.id, body);
      await workspaceStore?.syncMemberProfile(user).catch(() => {});
      return send(response, 200, { user });
    }

    throw new AuthError(404, "NOT_FOUND", "지원하지 않는 요청이에요.");
  } catch (error) {
    if (error instanceof AuthError) return send(response, error.status, { error: error.message, code: error.code });
    process.stderr.write(`[grappler-auth] ${error?.message || error}\n`);
    return send(response, 500, { error: "로그인 요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.", code: "INTERNAL" });
  }
}
