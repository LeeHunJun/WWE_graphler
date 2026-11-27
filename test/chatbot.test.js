import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { locateVisual, normalizeVisualKey } from "../chatbot.js";
import { answerQuestion } from "../question-answer.js";
import { buildSpreadsheetVisualizationSpec, summarizeVisual } from "../visualization.js";
import { analyzeDrivers, buildDriverVisualSpec } from "../driver-analysis.js";

function loadCsvFixture(name) {
  const rows = readFileSync(new URL(`../public/test-fixtures/${name}`, import.meta.url), "utf8")
    .replace(/^﻿/, "").trim().split("\n").map((line) => line.replace(/\r$/, "").split(","));
  return { id: name, type: "csv", sheets: [{ name, rows, rowNumbers: rows.map((_, index) => index + 1), rowCount: rows.length, columnCount: rows[0].length }] };
}

test("챗봇은 처음 질문한 답에 없는 그래프를 부가 정보에서 찾아 준다", () => {
  const record = loadCsvFixture("monthly-sales-drivers.csv");
  const mainVisuals = answerQuestion(record, "매출 추이").spec.visuals;
  const extraVisuals = [...buildSpreadsheetVisualizationSpec(record).visuals, ...buildDriverVisualSpec(analyzeDrivers(record), record).visuals];

  const comovers = locateVisual("함께 바뀐 지표는?", answerQuestion(record, "함께 바뀐 지표는?"), { mainVisuals, extraVisuals });
  assert.equal(comovers.where, "extra");
  assert.equal(normalizeVisualKey(comovers.visual.id), "driver-comovers");

  const same = locateVisual("매출 추이", answerQuestion(record, "매출 추이"), { mainVisuals, extraVisuals });
  assert.equal(same.where, "main", "처음 질문한 그래프는 질문 답에서 찾는다");

  const promotion = locateVisual("프로모션에 따라 매출이 달라?", answerQuestion(record, "프로모션에 따라 매출이 달라?"), { mainVisuals, extraVisuals });
  assert.equal(promotion.where, "extra");
  assert.equal(normalizeVisualKey(promotion.visual.id), "driver-factor-10");
});

test("그래프 요약은 짧은 문장 몇 개이고 통계 계산 문구는 없다", () => {
  const record = loadCsvFixture("titanic-style-survival.csv");
  const visual = buildSpreadsheetVisualizationSpec(record).visuals.find((item) => item.title === "성별별 생존률");
  const lines = summarizeVisual(visual, record);
  assert.ok(lines.length >= 1 && lines.length <= 3);
  assert.ok(lines.every((line) => !/p\s*<|η²|r\s*=/.test(line)), lines.join("\n"));
});
