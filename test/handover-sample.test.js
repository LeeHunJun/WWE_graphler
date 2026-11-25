import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as XLSX from "xlsx";
import { analyzeDrivers, buildDriverVisualSpec } from "../driver-analysis.js";
import { buildSpreadsheetVisualizationSpec, validateHighlight, validateVisual } from "../visualization.js";

// 앱(app.js)과 같은 방식으로 셀 표시값을 문자열로 읽습니다.
function loadWorkbook(name) {
  const workbook = XLSX.read(readFileSync(new URL(`../public/test-fixtures/${name}`, import.meta.url)), { type: "buffer" });
  return {
    id: name,
    type: "xlsx",
    sheets: workbook.SheetNames.map((sheetName) => {
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: false, defval: "" })
        .map((row) => row.map((cell) => String(cell)));
      return { name: sheetName, rows, rowNumbers: rows.map((_, index) => index + 1), rowCount: rows.length, columnCount: rows[0].length };
    }),
  };
}

function assertValidSpec(spec) {
  for (const visual of spec.visuals) {
    assert.equal(validateVisual(visual), null, visual.id);
    for (const highlight of visual.highlights || []) assert.equal(validateHighlight(visual, highlight), null, `${visual.id} 강조`);
  }
}

const record = loadWorkbook("handover-sample.xlsx");
const sheetIndex = (name) => record.sheets.findIndex((sheet) => sheet.name === name);

test("인수인계 샘플: 네 시트 모두 자동 그래프와 강조가 규격을 통과합니다", () => {
  assert.deepEqual(record.sheets.map((sheet) => sheet.name), ["월별업무현황", "거래처현황", "이슈이력", "정기업무일정"]);
  const spec = buildSpreadsheetVisualizationSpec(record);
  assert.ok(spec.visuals.length >= 4);
  const line = spec.visuals.find((visual) => visual.type === "line_chart");
  assert.ok(line.data.series.some((series) => series.name === "미처리잔량(건)"), "월별 추이에 미처리잔량이 보여야 합니다");
  assertValidSpec(spec);
});

test("인수인계 샘플: 신ERP 전환 달의 처리량 하락을 1인당 처리량과 시스템 변화로 설명합니다", () => {
  const index = sheetIndex("월별업무현황");
  const months = record.sheets[index].rows.slice(1).map((row) => row[0]);
  const result = analyzeDrivers(record, { sheetIndex: index, focusPeriodIndex: months.indexOf("2025-07") });
  assert.equal(result.target.name, "처리건수(건)");
  assert.equal(result.period.change.toLabel, "2025-07");
  const decomposition = result.period.decompositions.find((item) => item.type === "multiplicative");
  assert.ok(decomposition, "처리건수 = 담당인원 × 1인당처리 관계를 찾아야 합니다");
  const perPerson = decomposition.items.find((item) => item.baseName === "1인당처리");
  assert.ok(perPerson.pct < -30);
  assert.ok(result.period.categoricalChanges.some((change) => change.baseName === "시스템" && change.to === "신ERP 안정화"));
  assertValidSpec(buildDriverVisualSpec(result, record));
});

test("인수인계 샘플: 기본 분석은 휴직 달의 인원 감소를 가장 큰 하락으로 짚습니다", () => {
  const result = analyzeDrivers(record, { sheetIndex: sheetIndex("월별업무현황") });
  assert.equal(result.period.change.toLabel, "2026-02");
  assert.ok(result.period.categoricalChanges.some((change) => change.baseName === "인원변동" && change.to === "휴직 1명"));
});

test("인수인계 샘플: 거래처 이탈위험은 담당자 교체와 최근 이슈가 상위 요인입니다", () => {
  const result = analyzeDrivers(record, { sheetIndex: sheetIndex("거래처현황") });
  assert.equal(result.target.name, "이탈위험");
  assert.equal(result.target.positiveValue, "높음");
  assert.deepEqual(result.factors.slice(0, 2).map((factor) => factor.baseName).sort(), ["담당자교체", "최근이슈"]);
  assert.ok(result.factors.slice(0, 2).every((factor) => factor.pValue < 0.01));
  assertValidSpec(buildDriverVisualSpec(result, record));
});

test("인수인계 샘플: 이슈 재발은 정산오류 유형에서 가장 잦습니다", () => {
  const index = sheetIndex("이슈이력");
  const result = analyzeDrivers(record, { sheetIndex: index });
  assert.equal(result.target.name, "재발");
  assert.equal(result.factors[0].baseName, "유형");
  const groups = result.factors[0].groups.filter((group) => !group.small).sort((a, b) => b.value - a.value);
  assert.equal(groups[0].label, "정산오류");

  const rows = record.sheets[index].rows.slice(1).filter((row) => row[3] === "정산오류");
  const rate = rows.filter((row) => row[6] === "예").length / rows.length;
  assert.ok(Math.abs(groups[0].value - rate) < 1e-12);
  assertValidSpec(buildDriverVisualSpec(result, record));
});
