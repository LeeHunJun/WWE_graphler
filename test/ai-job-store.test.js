import assert from "node:assert/strict";
import test from "node:test";
import { AiJobQueueError, createAiJobStore } from "../ai-job-store.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("AI job store queues work, limits concurrent jobs, and returns completed results", async () => {
  const store = createAiJobStore({ maxConcurrent: 2, maxQueued: 3 });
  let active = 0;
  let peak = 0;
  const jobs = Array.from({ length: 5 }, (_, index) => store.submit(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await wait(15);
    active -= 1;
    return { statusCode: 200, body: { index } };
  }));

  assert.equal(jobs.length, 5);
  assert.ok(jobs.some((job) => job.status === "processing"));
  assert.ok(jobs.some((job) => job.status === "queued"));
  await wait(100);

  const completed = jobs.map((job) => store.get(job.jobId));
  assert.ok(completed.every((job) => job.status === "completed"));
  assert.deepEqual(completed.map((job) => job.result.body.index), [0, 1, 2, 3, 4]);
  assert.equal(peak, 2);
});

test("queue capacity is bounded and expired results stop being available", async () => {
  let now = 1000;
  const store = createAiJobStore({ maxConcurrent: 1, maxQueued: 1, ttlMs: 20, now: () => now });
  let finishFirst;
  const first = store.submit(() => new Promise((resolve) => { finishFirst = resolve; }));
  await Promise.resolve();
  const second = store.submit(async () => ({ statusCode: 200, body: { ok: true } }));
  assert.throws(() => store.submit(async () => ({})), { code: "AI_QUEUE_FULL" });

  finishFirst({ statusCode: 200, body: { ok: true } });
  await wait(0);
  await wait(0);
  now += 21;
  assert.equal(store.get(first.jobId), null);
  assert.equal(store.get(second.jobId), null);
});

test("queue saturation returns a safe retryable client error", () => {
  const store = createAiJobStore({ maxConcurrent: 0, maxQueued: 0 });
  assert.throws(() => store.submit(async () => ({})), AiJobQueueError);
});
