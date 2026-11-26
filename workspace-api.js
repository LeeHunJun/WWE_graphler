// /api/workspaces 경로를 처리하는 작은 라우터. 로그인한 계정만 쓸 수 있다.
import { getRequestUser, isSameOrigin } from "./auth-api.js";
import { WorkspaceError } from "./workspace-store.js";

const BODY_LIMIT = 16 * 1024 * 1024;

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new WorkspaceError(413, "TOO_LARGE", "요청이 너무 커요. 10MB 이하 문서만 공유할 수 있어요.");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new WorkspaceError(400, "INVALID_JSON", "요청 형식이 올바르지 않습니다.");
  }
}

function send(response, status, payload) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

export function isWorkspaceApiPath(pathname) {
  return pathname === "/api/workspaces" || pathname.startsWith("/api/workspaces/");
}

export async function handleWorkspaceApi(request, response, { workspaceStore: store, authStore }) {
  const url = new URL(request.url, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean).slice(2).map(decodeURIComponent);
  const method = request.method;

  try {
    if (method !== "GET" && !isSameOrigin(request)) throw new WorkspaceError(403, "BAD_ORIGIN", "허용되지 않은 요청이에요.");
    const user = await getRequestUser(request, authStore);
    if (!user) throw new WorkspaceError(401, "UNAUTHORIZED", "로그인이 필요해요. 다시 로그인해 주세요.");
    const actorId = user.id;
    const actor = { id: user.id, name: user.name, username: user.username, isGuest: user.isGuest === true };

    const [workspaceId, collection, itemId, ...rest] = parts;
    if (rest.length > 0) throw new WorkspaceError(404, "NOT_FOUND", "지원하지 않는 주소예요.");

    if (user.isGuest) {
      if (!workspaceId && method !== "GET") {
        throw new WorkspaceError(403, "GUEST_RESTRICTED", "게스트는 새 팀 워크스페이스를 만들 수 없어요.");
      }
      if (workspaceId) {
        if (collection === "members" || (!collection && method !== "GET")) {
          throw new WorkspaceError(403, "GUEST_RESTRICTED", "게스트는 다른 팀에 참여하거나 팀 설정을 바꿀 수 없어요.");
        }
        const guestWorkspaces = await store.listWorkspaces(actorId);
        if (!guestWorkspaces.some((workspace) => workspace.id === workspaceId)) {
          throw new WorkspaceError(403, "GUEST_RESTRICTED", "게스트 개인 공간에서만 사용할 수 있어요.");
        }
      }
    }

    if (workspaceId && collection !== "join") {
      const memberships = await store.listWorkspaces(actorId);
      if (!memberships.some((workspace) => workspace.id === workspaceId)) {
        throw new WorkspaceError(403, "NOT_A_MEMBER", "이 워크스페이스의 멤버만 내용을 볼 수 있어요.");
      }
    }

    if (!workspaceId) {
      if (method === "GET") return send(response, 200, { workspaces: await store.ensureDefaultMembership(actor) });
      if (method === "POST") {
        const body = await readJson(request);
        return send(response, 201, { workspace: await store.createWorkspace({ ...body, actor }) });
      }
    } else if (!collection) {
      if (method === "GET") return send(response, 200, { workspace: await store.getWorkspace(workspaceId) });
      if (method === "PATCH") {
        const body = await readJson(request);
        return send(response, 200, { workspace: await store.updateWorkspace(workspaceId, { ...body, actorId }) });
      }
      if (method === "DELETE") return send(response, 200, await store.deleteWorkspace(workspaceId, { actorId }));
    } else if (collection === "join" && !itemId && method === "POST") {
      return send(response, 200, { workspace: await store.joinWorkspace(workspaceId, { actor }) });
    } else if (collection === "members" && itemId) {
      if (method === "PATCH") {
        const body = await readJson(request);
        return send(response, 200, { workspace: await store.updateMember(workspaceId, itemId, { ...body, actorId }) });
      }
      if (method === "DELETE") return send(response, 200, { workspace: await store.removeMember(workspaceId, itemId, { actorId }) });
    } else if (collection === "shared-documents") {
      if (!itemId && method === "GET") return send(response, 200, { documents: await store.listSharedDocuments(workspaceId) });
      if (!itemId && method === "POST") {
        const body = await readJson(request);
        return send(response, 201, { document: await store.shareDocument(workspaceId, { ...body, actorId }) });
      }
      if (itemId && method === "GET") return send(response, 200, await store.getSharedDocument(workspaceId, itemId, { actorId }));
      if (itemId && method === "DELETE") return send(response, 200, await store.unshareDocument(workspaceId, itemId, { actorId }));
    } else if (collection === "insights") {
      if (!itemId && method === "GET") return send(response, 200, { insights: await store.listInsights(workspaceId) });
      if (!itemId && method === "POST") {
        const body = await readJson(request);
        return send(response, 201, { insight: await store.saveInsight(workspaceId, { ...body, actorId }) });
      }
      if (itemId && method === "DELETE") return send(response, 200, await store.deleteInsight(workspaceId, itemId, { actorId }));
    }

    throw new WorkspaceError(404, "NOT_FOUND", "지원하지 않는 요청이에요.");
  } catch (error) {
    if (error instanceof WorkspaceError) return send(response, error.status, { error: error.message, code: error.code });
    process.stderr.write(`[grappler-workspace] ${error?.message || error}\n`);
    return send(response, 500, { error: "워크스페이스 요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.", code: "INTERNAL" });
  }
}
