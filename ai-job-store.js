import { randomUUID } from "node:crypto";

const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_MAX_QUEUED = 20;
const DEFAULT_MAX_STORED = 100;
const DEFAULT_TTL_MS = 10 * 60 * 1000;

export class AiJobQueueError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function createAiJobStore({
  maxConcurrent = DEFAULT_MAX_CONCURRENT,
  maxQueued = DEFAULT_MAX_QUEUED,
  maxStored = DEFAULT_MAX_STORED,
  ttlMs = DEFAULT_TTL_MS,
  now = Date.now,
} = {}) {
  const jobs = new Map();
  const queue = [];
  let active = 0;

  function prune() {
    const currentTime = now();
    for (const [id, job] of jobs) {
      if (job.status !== "queued" && job.status !== "processing" && currentTime - job.updatedAt >= ttlMs) {
        jobs.delete(id);
      }
    }

    if (jobs.size < maxStored) return;
    for (const [id, job] of jobs) {
      if (job.status === "queued" || job.status === "processing") continue;
      jobs.delete(id);
      if (jobs.size < maxStored) break;
    }
  }

  function pump() {
    while (active < maxConcurrent && queue.length > 0) {
      const job = queue.shift();
      if (!job || job.status !== "queued") continue;
      active += 1;
      job.status = "processing";
      job.updatedAt = now();

      Promise.resolve()
        .then(() => job.execute({ jobId: job.id }))
        .then((result) => {
          job.result = result;
          job.status = "completed";
          job.updatedAt = now();
        })
        .catch(() => {
          job.result = {
            statusCode: 503,
            body: { error: "잠시 후 다시 시도해 주세요", code: "AI_CALL_FAILED" },
          };
          job.status = "failed";
          job.updatedAt = now();
        })
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  }

  return {
    submit(execute) {
      if (typeof execute !== "function") throw new TypeError("AI job must be a function");
      prune();
      if (queue.length >= maxQueued || jobs.size >= maxStored) {
        throw new AiJobQueueError(429, "AI_QUEUE_FULL", "AI 분석 요청이 많아요. 잠시 후 다시 시도해 주세요.");
      }

      const createdAt = now();
      const job = {
        id: randomUUID(),
        status: "queued",
        createdAt,
        updatedAt: createdAt,
        execute,
        result: null,
      };
      jobs.set(job.id, job);
      queue.push(job);
      pump();
      return { jobId: job.id, status: job.status, pollAfterMs: 750 };
    },

    get(jobId) {
      prune();
      const job = jobs.get(jobId);
      if (!job) return null;
      return {
        jobId: job.id,
        status: job.status,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        queuePosition: job.status === "queued" ? queue.indexOf(job) + 1 : null,
        result: job.result,
      };
    },
  };
}
