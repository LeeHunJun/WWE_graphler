import { createServer as createHttpServer } from "node:http";
import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AiJobQueueError, createAiJobStore } from "./ai-job-store.js";
import { AiServiceError, requestAiSummary } from "./ai-service.js";
import { handleAuthApi, isAuthApiPath } from "./auth-api.js";
import { createAuthStore } from "./auth-store.js";
import { openDatabase } from "./database.js";
import { handleWorkspaceApi, isWorkspaceApiPath } from "./workspace-api.js";
import { createWorkspaceStore } from "./workspace-store.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, "dist");
const DIAGNOSTIC_LOG = path.join(ROOT, ".opencode", "ai-response-diagnostics.jsonl");
const DIAGNOSTIC_LOG_LIMIT = 4 * 1024 * 1024;
const BODY_LIMIT = 16 * 1024 * 1024;
let database;
let workspaceStore;
let authStore;
const aiJobStore = createAiJobStore({ maxConcurrent: 1, maxQueued: 1, maxStored: 100, ttlMs: 10 * 60 * 1000 });
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

const isProduction = process.argv.includes("--production") || process.env.NODE_ENV === "production";
let vite;
let viteModule;
let localEnv = {};

async function readJsonBody(request) {
  const chunks = [];
  let byteLength = 0;

  for await (const chunk of request) {
    byteLength += chunk.length;
    if (byteLength > BODY_LIMIT) {
      throw new AiServiceError("INVALID_DOCUMENT", "문서 텍스트가 요청 한도를 넘었습니다.");
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AiServiceError("INVALID_DOCUMENT", "요청 형식이 올바르지 않습니다.");
  }
}

function getServiceConfig() {
  return {
    apiKey: process.env.LLM_API_KEY || localEnv.LLM_API_KEY,
    baseUrl: process.env.LLM_BASE_URL || localEnv.LLM_BASE_URL,
  };
}

async function getContractAssets() {
  try {
    const [contractText, dataContractText, sampleText] = await Promise.all([
      readFile(path.join(ROOT, "VISUALIZATION-SPEC.md"), "utf8"),
      readFile(path.join(ROOT, "docs", "data-contract.md"), "utf8"),
      readFile(path.join(ROOT, "public", "test-fixtures", "sample-visual-spec.json"), "utf8"),
    ]);
    return { contractText, dataContractText, sampleSpec: JSON.parse(sampleText) };
  } catch {
    throw new AiServiceError("AI_NOT_CONFIGURED", "시각화 규격 자료를 불러오지 못했습니다.");
  }
}

async function logAiResponseDiagnostic(entry) {
  await mkdir(path.dirname(DIAGNOSTIC_LOG), { recursive: true, mode: 0o700 });
  try {
    const info = await stat(DIAGNOSTIC_LOG);
    if (info.size > DIAGNOSTIC_LOG_LIMIT) {
      await rename(DIAGNOSTIC_LOG, `${DIAGNOSTIC_LOG}.previous`).catch(() => {});
    }
  } catch {
    // The first diagnostic entry creates the log.
  }

  const line = `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`;
  await appendFile(DIAGNOSTIC_LOG, line, { encoding: "utf8", mode: 0o600 });
}

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  response.end(JSON.stringify(payload));
}

function getAiErrorResponse(error) {
  const code = error instanceof AiServiceError || error instanceof AiJobQueueError ? error.code : "AI_CALL_FAILED";
  const message = error instanceof AiJobQueueError
    ? error.message
    : error instanceof AiServiceError && ["AI_RESPONSE_INVALID", "AI_CALL_FAILED"].includes(error.code)
      ? "잠시 후 다시 시도해 주세요"
      : error instanceof AiServiceError
        ? error.message
        : "AI 서비스 요청에 실패했습니다. 다시 시도해 주세요.";
  const status = error instanceof AiJobQueueError ? error.status
    : code === "INVALID_DOCUMENT" ? 400
      : code === "NO_ANALYZABLE_CONTENT" ? 422
        : code === "AI_NOT_CONFIGURED" || code === "AI_RESPONSE_INVALID" || code === "AI_CALL_FAILED" ? 503
          : 502;
  return { statusCode: status, body: { error: message, code } };
}

async function executeAiJob(payload, requestId, startedAt) {
  try {
    const assets = await getContractAssets();
    const result = await requestAiSummary(payload.document, {
      ...getServiceConfig(),
      ...assets,
      onDiagnostic: async (entry) => {
        try {
          await logAiResponseDiagnostic({
            request_id: requestId,
            request_elapsed_ms: Date.now() - startedAt,
            model: "jitda-chat",
            document_type: payload.document?.type || "unknown",
            ...entry,
          });
        } catch {
          process.stderr.write("[grappler-ai] 진단 로그를 저장하지 못했습니다.\n");
        }
      },
    });
    return { statusCode: 200, body: result };
  } catch (error) {
    return getAiErrorResponse(error);
  }
}

async function handleAiRequest(request, response) {
  const url = new URL(request.url, "http://localhost");
  const requestId = randomUUID();

  if (url.pathname === "/api/ai-summarize" && request.method === "POST") {
    try {
      const payload = await readJsonBody(request);
      const startedAt = Date.now();
      const job = aiJobStore.submit(({ jobId }) => executeAiJob(payload, jobId, startedAt));
      sendJson(response, 202, { ...job, message: "AI 분석을 시작했습니다." }, {
        "Retry-After": "1",
        "X-Request-Id": job.jobId,
      });
    } catch (error) {
      const failure = getAiErrorResponse(error);
      sendJson(response, failure.statusCode, failure.body, { "X-Request-Id": requestId });
    }
    return;
  }

  const match = url.pathname.match(/^\/api\/ai-summarize\/([^/]+)$/);
  if (match && request.method === "GET") {
    let jobId;
    try {
      jobId = decodeURIComponent(match[1]);
    } catch {
      sendJson(response, 404, { error: "분석 작업을 찾을 수 없습니다.", code: "AI_JOB_NOT_FOUND" });
      return;
    }
    const job = aiJobStore.get(jobId);
    if (!job) {
      sendJson(response, 404, { error: "분석 작업을 찾을 수 없습니다. 새로 분석해 주세요.", code: "AI_JOB_NOT_FOUND" }, { "X-Request-Id": jobId });
      return;
    }
    if (job.status !== "completed" && job.status !== "failed") {
      sendJson(response, 202, {
        jobId: job.jobId,
        status: job.status,
        queuePosition: job.queuePosition,
        pollAfterMs: 1000,
      }, { "Retry-After": "1", "X-Request-Id": job.jobId });
      return;
    }
    const result = job.result || { statusCode: 503, body: { error: "잠시 후 다시 시도해 주세요", code: "AI_CALL_FAILED" } };
    sendJson(response, result.statusCode, result.body, { "X-Request-Id": job.jobId });
    return;
  }

  if (url.pathname === "/api/ai-summarize" || url.pathname.startsWith("/api/ai-summarize/")) {
    sendJson(response, 405, { error: "분석 요청은 POST, 작업 확인은 GET을 사용해 주세요.", code: "METHOD_NOT_ALLOWED" }, { "X-Request-Id": requestId });
    return;
  }

  sendJson(response, 404, { error: "분석 API 주소를 찾을 수 없습니다.", code: "NOT_FOUND" }, { "X-Request-Id": requestId });
}

async function serveStatic(request, response) {
  let requestPath;
  try {
    requestPath = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  } catch {
    response.writeHead(400).end("잘못된 주소입니다.");
    return;
  }

  const candidate = path.resolve(DIST, `.${requestPath}`);
  if (candidate !== DIST && !candidate.startsWith(`${DIST}${path.sep}`)) {
    response.writeHead(403).end("접근할 수 없습니다.");
    return;
  }

  let filePath = candidate;
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = path.join(filePath, "index.html");
    await stat(filePath);
  } catch {
    filePath = path.join(DIST, "index.html");
  }

  const extension = path.extname(filePath).toLowerCase();
  response.writeHead(200, {
    "Cache-Control": extension === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
    "Content-Type": MIME_TYPES[extension] || "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
  });
  createReadStream(filePath).pipe(response);
}

async function main() {
  const portArgument = process.argv.indexOf("--port");
  const port = Number(process.env.PORT || (portArgument >= 0 ? process.argv[portArgument + 1] : 3000));

  if (!isProduction) {
    viteModule = await import("vite");
    localEnv = viteModule.loadEnv("development", ROOT, ["LLM_API_KEY", "LLM_BASE_URL", "GRAPPLER_DATA_DIR", "GRAPPLER_DB_PATH"]);
  }
  // 개발 때는 .env.local 설정도 읽고, 배포 때는 플랫폼 환경변수를 사용한다.
  const dataDir = path.resolve(process.env.GRAPPLER_DATA_DIR || localEnv.GRAPPLER_DATA_DIR || path.join(ROOT, ".data"));
  const databasePath = path.resolve(process.env.GRAPPLER_DB_PATH || localEnv.GRAPPLER_DB_PATH || path.join(dataDir, "grappler.sqlite"));
  database = await openDatabase({ dataDir, databasePath });
  workspaceStore = createWorkspaceStore({ database });
  authStore = createAuthStore({ database });

  const server = createHttpServer(async (request, response) => {
    const requestPath = new URL(request.url, "http://localhost").pathname;
    if (requestPath === "/api/ai-summarize" || requestPath.startsWith("/api/ai-summarize/")) {
      await handleAiRequest(request, response);
      return;
    }

    if (isAuthApiPath(requestPath)) {
      await handleAuthApi(request, response, { authStore, workspaceStore });
      return;
    }

    if (isWorkspaceApiPath(requestPath)) {
      await handleWorkspaceApi(request, response, { workspaceStore, authStore });
      return;
    }

    if (isProduction) {
      await serveStatic(request, response);
      return;
    }

    vite.middlewares(request, response);
  });

  if (!isProduction) {
    vite = await viteModule.createServer({
      root: ROOT,
      appType: "spa",
      server: {
        hmr: { server },
        middlewareMode: true,
      },
    });
  }

  server.listen(port, "0.0.0.0");
}

main().catch(() => {
  process.stderr.write("서버를 시작하지 못했습니다. 설정과 포트를 확인해 주세요.\n");
  process.exitCode = 1;
});
