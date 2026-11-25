import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  analyzeDrivers,
  buildDriverVisualSpec,
  chiSquarePValue,
  fTestPValue,
  josa,
  pearson,
  profileColumns,
} from "../driver-analysis.js";
import { sortInsightsByPriority } from "../insight-priority.js";
import { validateHighlight, validateVisual } from "../visualization.js";

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

test("통계 함수가 알려진 값과 일치합니다", () => {
  assert.ok(Math.abs(chiSquarePValue(3.841, 1) - 0.05) < 0.001);
  assert.ok(Math.abs(chiSquarePValue(5.991, 2) - 0.05) < 0.001);
  assert.ok(Math.abs(fTestPValue(4.35, 1, 20) - 0.05) < 0.002);
  assert.equal(pearson([1, 2, 3, 4], [2, 4, 6, 8]), 1);
  assert.ok(Math.abs(pearson([1, 2, 3, 4], [8, 6, 4, 2]) + 1) < 1e-12);
});

test("한국어 조사를 받침에 맞게 고릅니다", () => {
  assert.equal(josa("성별", "이/가"), "이");
  assert.equal(josa("매출", "은/는"), "은");
  assert.equal(josa("프로모션", "이/가"), "이");
  assert.equal(josa("요금", "과/와"), "과");
  assert.equal(josa("객단가", "은/는"), "는");
  assert.equal(josa("있음", "으로/로"), "으로");
  assert.equal(josa("서울", "으로/로"), "로");
});

test("열 종류를 구분하고 번호 열은 비교에서 뺍니다", () => {
  const record = loadCsvFixture("titanic-style-survival.csv");
  const kinds = Object.fromEntries(profileColumns(record.sheets[0]).map((profile) => [profile.name, profile.kind]));
  assert.equal(kinds["승객번호"], "id");
  assert.equal(kinds["생존"], "binary");
  assert.equal(kinds["성별"], "binary");
  assert.equal(kinds["객실등급"], "numeric_discrete");
  assert.equal(kinds["나이"], "numeric");
  assert.equal(kinds["승선항구"], "categorical");
});

test("생존 데이터에서 성별을 가장 큰 요인으로 찾고 수치는 원본 행과 일치합니다", () => {
  const record = loadCsvFixture("titanic-style-survival.csv");
  const result = analyzeDrivers(record);
  assert.equal(result.status, "ok");
  assert.equal(result.mode, "records");
  assert.equal(result.target.name, "생존");
  assert.equal(result.target.positiveValue, "1");
  assert.equal(result.factors[0].name, "성별");

  const rows = record.sheets[0].rows.slice(1);
  const women = rows.filter((row) => row[3] === "여");
  const womenRate = women.filter((row) => row[1] === "1").length / women.length;
  const group = result.factors[0].groups.find((item) => item.label === "여");
  assert.equal(group.n, women.length);
  assert.ok(Math.abs(group.value - womenRate) < 1e-12);
  assert.ok(result.factors[0].pValue < 0.001);

  const port = result.factors.find((factor) => factor.name === "승선항구");
  assert.ok(port.eta2 < result.factors[0].eta2);
  assert.ok(result.insights.every((insight) => insight.method && insight.sentence));
  assert.ok(result.caveats.some((caveat) => caveat.includes("인과관계를 확정하지는 않습니다")));
});

test("월별 매출 하락을 방문수와 상품별 매출로 분해하고 함께 바뀐 조건을 찾습니다", () => {
  const record = loadCsvFixture("monthly-sales-drivers.csv");
  const result = analyzeDrivers(record);
  assert.equal(result.mode, "periods");
  assert.equal(result.target.name, "매출(원)");
  assert.equal(result.period.change.toLabel, "2025-06");

  const multiplicative = result.period.decompositions.find((item) => item.type === "multiplicative");
  assert.equal(multiplicative.formula, "매출 = 방문수 × 객단가");
  const shareSum = multiplicative.items.reduce((sum, item) => sum + item.share, 0);
  assert.ok(Math.abs(shareSum - 1) < 1e-9);

  const additive = result.period.decompositions.find((item) => item.type === "additive");
  const contributionSum = additive.items.reduce((sum, item) => sum + item.contribution, 0);
  assert.equal(contributionSum, result.period.change.abs);

  assert.deepEqual(
    result.period.categoricalChanges.map((item) => [item.name, item.from, item.to]),
    [["주변공사", "없음", "있음"]],
  );
  assert.deepEqual(result.insights, sortInsightsByPriority(result.insights), "원인 분석 인사이트가 우선순위 순서입니다");
  const downstream = result.period.comovers.filter((item) => item.downstream).map((item) => item.name).sort();
  assert.deepEqual(downstream, ["영업이익(원)", "원가(원)"]);
});

test("손익을 목표로 고르면 매출과 비용 항목으로 분해합니다", () => {
  const record = loadCsvFixture("monthly-sales-drivers.csv");
  const result = analyzeDrivers(record, { targetIndex: 14 });
  assert.equal(result.target.name, "영업이익(원)");
  const additive = result.period.decompositions.find((item) => item.type === "additive");
  assert.equal(additive.formula, "영업이익 = 매출 − 원가 − 인건비 − 임대료");
  assert.equal(additive.items.reduce((sum, item) => sum + item.contribution, 0), result.period.change.abs);
});

test("사용자가 고른 기간으로 분석 기준을 바꿀 수 있습니다", () => {
  const record = loadCsvFixture("monthly-sales-drivers.csv");
  const result = analyzeDrivers(record, { focusPeriodIndex: 20 });
  assert.equal(result.period.change.fromLabel, "2025-08");
  assert.equal(result.period.change.toLabel, "2025-09");
});

test("원인 분석 시각화 명세가 기존 규격 검증을 모두 통과합니다", () => {
  for (const [name, options] of [["titanic-style-survival.csv", {}], ["monthly-sales-drivers.csv", {}], ["monthly-sales-drivers.csv", { targetIndex: 14 }]]) {
    const record = loadCsvFixture(name);
    const spec = buildDriverVisualSpec(analyzeDrivers(record, options), record);
    assert.ok(spec.visuals.length > 0);
    for (const visual of spec.visuals) {
      assert.equal(validateVisual(visual), null, `${name} ${visual.id}`);
      for (const highlight of visual.highlights) {
        assert.equal(validateHighlight(visual, highlight), null, `${name} ${visual.id} ${highlight.label}`);
      }
    }
  }
});

test("데이터가 부족하면 추정하지 않고 이유를 알려줍니다", () => {
  const result = analyzeDrivers({ sheets: [{ name: "작은 표", rows: [["이름", "메모"], ["가", "나"]], columnCount: 2 }] });
  assert.equal(result.status, "insufficient_data");
  const noTarget = analyzeDrivers({ sheets: [{ name: "글", rows: [["메모"], ["가"], ["나"], ["다"], ["라"], ["마"]], columnCount: 1 }] });
  assert.equal(noTarget.status, "insufficient_data");
});
