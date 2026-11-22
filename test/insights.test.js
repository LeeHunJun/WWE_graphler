import assert from "node:assert/strict";
import test from "node:test";
import { buildHeadline, buildQuiz, buildReportText } from "../insights.js";
import { buildSpreadsheetVisualizationSpec, getSourceLookup } from "../visualization.js";

function csvRecord(rows, name = "data") {
  return {
    type: "csv",
    sheets: [{ name, rows, rowNumbers: rows.map((_, index) => index + 1), rowCount: rows.length, columnCount: Math.max(...rows.map((row) => row.length)) }],
  };
}

const record = csvRecord([
  ["월", "매출(만원)"],
  ["2026-09", "1490"],
  ["2026-10", "1120"],
  ["2026-11", "1710"],
  ["2026-12", "2450"],
], "월별매출");
const [lineVisual] = buildSpreadsheetVisualizationSpec(record).visuals;

test("한 줄 결론은 가장 큰 변화와 최고치 여부를 코드 계산값으로 말합니다", () => {
  assert.equal(buildHeadline(lineVisual, lineVisual.highlights), "2026-12 매출(만원) 43.3% 급증, 기간 중 최고");
});

test("이해 확인 퀴즈는 가장 크게 떨어진 구간을 정답으로 합니다", () => {
  const quiz = buildQuiz(lineVisual, lineVisual.highlights);
  assert.match(quiz.question, /가장 크게 떨어진 구간/);
  const correct = quiz.options.filter((option) => option.correct);
  assert.equal(correct.length, 1);
  assert.equal(correct[0].label, "2026-09 → 2026-10");
  assert.ok(quiz.options.length >= 2 && quiz.options.length <= 4);
  assert.equal(new Set(quiz.options.map((option) => option.label)).size, quiz.options.length);
  assert.match(quiz.explanation, /1,490만원에서 2026-10 1,120만원까지/);
  assert.equal(lineVisual.highlights[quiz.highlightIndex].label.startsWith("최대 하락"), true);
});

test("보고서 요약에는 근거 값과 실제 원본 행 번호가 붙습니다", () => {
  const text = buildReportText(lineVisual, lineVisual.highlights, getSourceLookup(record));
  assert.match(text, /2026-09→2026-10 매출\(만원\): 1,490만원 → 1,120만원 \(-24\.8%\) \[근거: 2행·3행/);
  assert.match(text, /2026-11→2026-12/);
});

test("항목 비교 막대는 최고·최저 결론과 최고 항목 퀴즈를 만듭니다", () => {
  const barRecord = csvRecord([["부서", "실적"], ["기획", "8"], ["개발", "12"], ["영업", "5"]]);
  const [bar] = buildSpreadsheetVisualizationSpec(barRecord).visuals;
  assert.equal(buildHeadline(bar, bar.highlights), "실적 최고는 개발(12), 최저는 영업(5)");
  const quiz = buildQuiz(bar, bar.highlights);
  assert.equal(quiz.options.find((option) => option.correct).label, "개발");
});
