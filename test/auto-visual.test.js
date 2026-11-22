import assert from "node:assert/strict";
import test from "node:test";
import { analyzeRecordQuality, describeNoNumericColumns } from "../data-quality.js";
import { getChunkComputedFacts } from "../ai-service.js";
import { buildSpreadsheetVisualizationSpec, getChangeSegments, validateHighlight } from "../visualization.js";

function csvRecord(rows, name = "data") {
  return {
    type: "csv",
    sheets: [{ name, rows, rowNumbers: rows.map((_, index) => index + 1), rowCount: rows.length, columnCount: Math.max(...rows.map((row) => row.length)) }],
  };
}

const monthlySales = csvRecord([
  ["월", "매출(억원)"],
  ["2026-01", "100"],
  ["2026-03", "120"],
  ["2026-02", "150"],
  ["2026-05", "130"],
  ["2026-04", "180"],
]);

test("월별 추이는 최대 상승 구간과 최대 하락 구간을 모두 강조합니다", () => {
  const spec = buildSpreadsheetVisualizationSpec(monthlySales);
  const [visual] = spec.visuals;
  assert.equal(visual.type, "line_chart");
  assert.deepEqual(visual.data.labels, ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05"]);

  const drop = visual.highlights.find((highlight) => highlight.label.startsWith("최대 하락"));
  const rise = visual.highlights.find((highlight) => highlight.label.startsWith("최대 상승"));
  assert.ok(drop && rise);
  assert.equal(drop.level, "critical");
  assert.equal(drop.target.point_index, 4);
  assert.equal(drop.derived.result, -27.78);
  assert.equal(rise.target.point_index, 3);
  assert.equal(rise.derived.result, 50);
  assert.match(rise.reason, /최고치/);
  // 근거 행 번호는 실제 원본 행(2026-03은 3행, 2026-04는 6행)을 가리킵니다.
  assert.deepEqual(rise.source_ids, ["sheet:0:row:6", "sheet:0:row:3"]);

  visual.highlights.forEach((highlight) => assert.equal(validateHighlight(visual, highlight), null));
  assert.deepEqual(getChangeSegments(visual, visual.highlights).map(({ startIndex, endIndex }) => [startIndex, endIndex]).sort(), [[2, 3], [3, 4]]);
});

test("빈 값을 건너뛴 두 점은 변화 구간으로 보지 않습니다", () => {
  const spec = buildSpreadsheetVisualizationSpec(csvRecord([
    ["월", "매출"],
    ["2026-01", "100"],
    ["2026-02", ""],
    ["2026-03", "10"],
    ["2026-04", "30"],
  ]));
  const labels = spec.visuals[0].highlights.map((highlight) => highlight.label);
  assert.ok(!labels.some((label) => label.startsWith("최대 하락")));
  assert.ok(labels.includes("최대 상승 2026-03→2026-04"));
});

test("숫자 열이 없으면 문제 열과 수정 방법을 안내합니다", () => {
  const spec = buildSpreadsheetVisualizationSpec(csvRecord([
    ["업무", "담당자"],
    ["요건 정의", "김민지"],
  ]));
  assert.equal(spec.visuals.length, 0);
  assert.match(spec.message, /"업무" 열은 글자로만/);
  assert.match(spec.message, /"담당자" 열은 글자로만/);
  assert.match(spec.message, /숫자만 담은 열로 추가/);
});

test("데이터 행이 없으면 행을 채우라고 안내합니다", () => {
  assert.match(describeNoNumericColumns(csvRecord([["업무", "담당자"]])), /데이터 행이 없습니다/);
});

test("빈 값 개수와 숫자에 섞인 글자를 열별로 찾습니다", () => {
  const record = csvRecord([
    ["월", "판매량"],
    ["2026-01", "100건"],
    ["2026-02", "120"],
    ["2026-03", ""],
    ["2026-04", "90"],
  ]);
  const quality = analyzeRecordQuality(record);
  assert.equal(quality.emptyCellCount, 1);
  assert.equal(quality.mixedColumns.length, 1);
  assert.deepEqual(quality.mixedColumns[0].mixedCells, [{ rowNumber: 2, value: "100건" }]);
  assert.match(buildSpreadsheetVisualizationSpec(record).message, /"판매량" 열의 2행에 숫자가 아닌 값/);
});

test("숫자 열만 있는 표도 행 번호를 항목으로 그래프를 만듭니다", () => {
  const spec = buildSpreadsheetVisualizationSpec(csvRecord([
    ["점수"],
    ["80"],
    ["95"],
  ]));
  assert.equal(spec.visuals.length, 1);
  assert.deepEqual(spec.visuals[0].data.labels, ["행 2", "행 3"]);
});

test("AI에는 이 청크에 실제로 있는 행을 가리키는 계산 결과만 넘깁니다", () => {
  const facts = getChunkComputedFacts({
    sources: [{ source_id: "sheet:0:row:1", text: "월 | 매출" }, { source_id: "sheet:0:row:2", text: "1월 | 100" }],
    computed_facts: [
      { label: "최고 100", reason: "가장 높은 값", source_ids: ["sheet:0:row:2"], derived: null },
      { label: "최대 하락", reason: "다른 청크", source_ids: ["sheet:0:row:9"], derived: null },
    ],
  });
  assert.deepEqual(facts.map((fact) => fact.label), ["최고 100"]);
});

test("날짜 열은 글자가 아니라 날짜로 표시합니다", () => {
  const quality = analyzeRecordQuality(monthlySales);
  assert.deepEqual(quality.sheets[0].columns.map((column) => column.kind), ["date", "numeric"]);
});
