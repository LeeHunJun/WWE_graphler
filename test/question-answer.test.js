import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { answerQuestion, detectIntents, matchColumns, suggestQuestions } from "../question-answer.js";
import { profileColumns } from "../driver-analysis.js";
import { buildSpreadsheetVisualizationSpec, validateHighlight, validateVisual } from "../visualization.js";

function loadCsvFixture(name) {
  const rows = readFileSync(new URL(`../public/test-fixtures/${name}`, import.meta.url), "utf8")
    .replace(/^﻿/, "")
    .trim()
    .split("\n")
    .map((line) => line.split(","));
  return {
    id: name,
    type: "csv",
    sheets: [{ name, rows, rowNumbers: rows.map((_, index) => index + 1), rowCount: rows.length, columnCount: rows[0].length }],
  };
}

function assertValidSpec(answer) {
  for (const visual of answer.spec.visuals) {
    assert.equal(validateVisual(visual), null, visual.id);
    for (const highlight of visual.highlights) assert.equal(validateHighlight(visual, highlight), null, `${visual.id} ${highlight.label}`);
  }
}

test("질문 속 열 이름을 찾고, 긴 이름에 포함된 짧은 이름은 겹치면 뺀다", () => {
  const profiles = profileColumns(loadCsvFixture("monthly-sales-drivers.csv").sheets[0]);
  assert.deepEqual(matchColumns(profiles, "커피매출 추이").map((profile) => profile.baseName), ["커피매출"]);
  assert.deepEqual(matchColumns(profiles, "매출이 왜 떨어졌어?").map((profile) => profile.baseName), ["매출"]);
  assert.deepEqual(detectIntents("매출이 왜 떨어졌어?"), { why: true, trend: true, extreme: false });
});

test("왜 떨어졌는지 물으면 하락 원인 그래프와 문장만 답한다", () => {
  const record = loadCsvFixture("monthly-sales-drivers.csv");
  const answer = answerQuestion(record, "매출이 왜 떨어졌어?");
  assert.equal(answer.status, "answered");
  assert.ok(answer.sentences[0].text.includes("줄었어요"));
  assert.ok(answer.sentences.some((sentence) => sentence.text.includes("주변공사")));
  assert.ok(answer.spec.visuals.length > 0 && answer.spec.visuals.length <= 3);
  assert.ok(answer.spec.visuals.every((visual) => visual.id.startsWith("question-")));
  assertValidSpec(answer);
});

test("추이를 물으면 물어본 열 하나만 선으로 그린다", () => {
  const record = loadCsvFixture("monthly-sales-drivers.csv");
  const answer = answerQuestion(record, "커피매출 추이 보여줘");
  assert.equal(answer.spec.visuals.length, 1);
  assert.equal(answer.spec.visuals[0].type, "line_chart");
  assert.deepEqual(answer.spec.visuals[0].data.series.map((series) => series.name), ["커피매출(원)"]);
  assertValidSpec(answer);
});

test("기록형 데이터에서 영향 요인을 물으면 가장 큰 요인으로 답한다", () => {
  const record = loadCsvFixture("titanic-style-survival.csv");
  const answer = answerQuestion(record, "생존률에 가장 큰 영향을 준 건?");
  assert.ok(answer.sentences[0].text.startsWith("생존률에 가장 큰 영향을 준 건 성별이에요"), answer.sentences[0].text);
  const byFactor = answerQuestion(record, "객실등급별 요금");
  assert.deepEqual(byFactor.spec.visuals.map((visual) => visual.id), ["question-driver-factor-2"]);
  assertValidSpec(answer);
  assertValidSpec(byFactor);
});

test("번호 열이나 없는 항목을 물으면 그래프 없이 이유를 알려 준다", () => {
  const record = loadCsvFixture("titanic-style-survival.csv");
  const idOnly = answerQuestion(record, "승객번호");
  assert.equal(idOnly.status, "no_match");
  assert.ok(idOnly.sentences[0].text.includes("번호라서"));
  assert.equal(answerQuestion(record, "날씨는?").status, "no_match");
  assert.equal(answerQuestion({ type: "pdf", pages: [] }, "요약해 줘").status, "unsupported");
});

test("0/1 열을 연도로 오인하지 않고, 기록형 표는 요인 비교 그래프로 자동 시각화한다", () => {
  const spec = buildSpreadsheetVisualizationSpec(loadCsvFixture("titanic-style-survival.csv"));
  assert.ok(spec.visuals.length > 0);
  assert.ok(spec.visuals.every((visual) => visual.type !== "line_chart"), "승객 목록을 선 그래프로 그리지 않는다");
  assert.ok(spec.visuals.some((visual) => visual.title === "성별별 생존률"));
  assert.ok(suggestQuestions(loadCsvFixture("titanic-style-survival.csv")).length > 0);
});
