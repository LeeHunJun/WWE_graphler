import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { explainHighlight } from "../highlight-explain.js";
import { buildColumnVisuals, buildSpreadsheetVisualizationSpec } from "../visualization.js";

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

function texts(record, visual, highlight) {
  return explainHighlight(record, visual, highlight)?.sentences.map((sentence) => sentence.text) || [];
}

test("기록형 데이터는 계산식 대신 가장 큰 영향 요인을 문장으로 알려 준다", () => {
  const record = loadCsvFixture("titanic-style-survival.csv");
  const [visual] = buildColumnVisuals(record, 0, [0]);
  const sentences = texts(record, visual, visual.highlights[0]);
  assert.ok(sentences.some((text) => text.startsWith("생존률에 가장 큰 영향을 준 건 성별이에요")), sentences.join("\n"));
  assert.ok(sentences.some((text) => text.includes("번호라서 크고 작음에 의미가 없어요")), "번호 열은 의미 없다고 알려 준다");
  assert.ok(sentences.every((text) => !text.includes("÷")), "계산식은 문장에 넣지 않는다");
});

test("기간형 데이터의 하락은 같은 시기에 바뀐 조건과 구성 요소로 설명한다", () => {
  const record = loadCsvFixture("monthly-sales-drivers.csv");
  const [visual] = buildSpreadsheetVisualizationSpec(record).visuals;
  const drop = visual.highlights.find((highlight) => highlight.label.startsWith("하락"));
  const sentences = texts(record, visual, drop);
  assert.ok(sentences.some((text) => text.includes("주변공사가 ‘없음’에서 ‘있음’으로 바뀌었어요") && text.includes("매출이 떨어졌을 수 있어요")), sentences.join("\n"));
  assert.ok(sentences.some((text) => text.includes("방문수 변화")), sentences.join("\n"));
  assert.ok(sentences.length <= 3);
});

test("대표 목표가 아닌 선을 고르면 대표 목표나 그 결과 열을 원인으로 들지 않는다", () => {
  const record = loadCsvFixture("monthly-sales-drivers.csv");
  const [visual] = buildSpreadsheetVisualizationSpec(record).visuals;
  for (const highlight of visual.highlights) {
    const series = visual.data.series.find((item) => item.id === highlight.target.series_id);
    if (!series || series.name === "매출(원)") continue;
    const sentences = texts(record, visual, highlight);
    assert.ok(sentences.every((text) => !/(^|\s)(매출|원가|영업이익) 변화|같은 시기 (매출|원가|영업이익)이/.test(text)), sentences.join("\n"));
  }
});

test("원본 표가 없는 문서(PDF 등)는 해석을 만들지 않는다", () => {
  assert.equal(explainHighlight({ type: "pdf", pages: [] }, { type: "line_chart", data: {} }, { source_ids: ["page:1"] }), null);
  assert.equal(explainHighlight(null, null, null), null);
});

test("요인별 막대의 중요한 부분은 그 요인과 그룹 기준으로 설명한다", () => {
  const record = loadCsvFixture("titanic-style-survival.csv");
  const visual = buildSpreadsheetVisualizationSpec(record).visuals.find((item) => item.id.endsWith("driver-factor-3"));
  const sentences = texts(record, visual, visual.highlights[0]);
  assert.ok(sentences.some((text) => text.startsWith("성별이 ‘여’인 경우 생존률은")), sentences.join("\n"));
  assert.ok(sentences.some((text) => text.includes("가장 큰 영향을 주는 요인")), sentences.join("\n"));
});
