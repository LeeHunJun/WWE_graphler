import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { extractNumbers, finalizeBrief, isGrounded, parseBriefText, streamBrief } from "../ai-brief.js";
import { buildAiDigest } from "../ai-digest.js";

function loadCsvFixture(name) {
  const rows = readFileSync(new URL(`../public/test-fixtures/${name}`, import.meta.url), "utf8")
    .replace(/^﻿/, "").trim().split("\n").map((line) => line.replace(/\r$/, "").split(","));
  return { id: name, name, type: "csv", sheets: [{ name, rows, rowNumbers: rows.map((_, index) => index + 1), rowCount: rows.length, columnCount: rows[0].length }] };
}

function sseResponse(pieces) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      pieces.forEach((piece) => controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`)));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const config = { apiKey: "k", baseUrl: "https://llm.example/v1" };

test("사실 목록은 원본 행 대신 계산한 요약만 짧게 담는다", () => {
  const digest = buildAiDigest(loadCsvFixture("monthly-sales-drivers.csv"));
  assert.ok(digest.text.length < 7000);
  assert.match(digest.text, /매출\(원\): 평균 21,663,032원/);
  assert.match(digest.text, /분석: 2025-06의 매출은 직전 2025-05보다 37.6% 감소/);
  assert.ok(!/2024-01 \| 20214268/.test(digest.text), "원본 행을 그대로 넣지 않는다");
});

test("요약 형식을 나누고, 사실에 없는 숫자가 든 문장은 뺀다", () => {
  const parsed = parseBriefText("요약: 전체 문장\n요약: 두 번째\n- 핵심 1\n- 핵심 2");
  assert.deepEqual(parsed, { summary: ["전체 문장", "두 번째"], key_points: ["핵심 1", "핵심 2"] });
  const digest = { text: "매출 평균 21,663,032원, 감소 37.6%" };
  const numbers = extractNumbers(digest.text);
  assert.ok(isGrounded("평균 21,663,032원이에요", numbers));
  assert.ok(isGrounded("37.6% 줄었어요", numbers));
  assert.ok(!isGrounded("99,999,999원이에요", numbers));
  const result = finalizeBrief("요약: 평균 21,663,032원이에요.\n- 지어낸 99,999,999원\n- 2025-06에 37.6% 줄었어요", digest);
  assert.deepEqual(result.key_points, ["2025-06에 37.6% 줄었어요"]);
  assert.equal(result.dropped, 1);
});

test("스트리밍 답을 조각마다 넘기고, 스트리밍이 아닌 답도 처리한다", async () => {
  const pieces = [];
  const text = await streamBrief({ name: "a", type: "csv", text: "사실" }, { ...config, onDelta: (piece) => pieces.push(piece), fetchImpl: async () => sseResponse(["요약: ", "안녕", "하세요"]) });
  assert.equal(text, "요약: 안녕하세요");
  assert.deepEqual(pieces, ["요약: ", "안녕", "하세요"]);
  const plain = await streamBrief({ name: "a", type: "csv", text: "사실" }, { ...config, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: "요약: 한 번에" } }] }), { status: 200, headers: { "Content-Type": "application/json" } }) });
  assert.equal(plain, "요약: 한 번에");
});

test("실패하면 이유를 구체적으로 알려 준다", async () => {
  const digest = { name: "a", type: "csv", text: "사실" };
  await assert.rejects(streamBrief(digest, { ...config, fetchImpl: async () => new Response("", { status: 404 }) }), /AI API가 없어요 \(HTTP 404\)/);
  await assert.rejects(streamBrief(digest, { ...config, fetchImpl: async () => new Response("", { status: 401 }) }), /API 키를 거부/);
  await assert.rejects(streamBrief(digest, { ...config, fetchImpl: async () => new Response("", { status: 429 }) }), /요청이 많아/);
  await assert.rejects(streamBrief(digest, { ...config, fetchImpl: async () => sseResponse([]) }), /빈 답/);
  await assert.rejects(streamBrief(digest, { ...config, fetchImpl: async () => new Response("<!doctype html>", { status: 200, headers: { "Content-Type": "text/html" } }) }), /웹 페이지 주소/);
  await assert.rejects(streamBrief({ ...digest, text: "" }, config), /요약할 내용이 없어요/);
  await assert.rejects(streamBrief(digest, {}), /연결되지 않았어요/);
});
