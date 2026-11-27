import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as XLSX from "xlsx";
import { analyzeDrivers, buildDriverVisualSpec } from "../driver-analysis.js";
import { sortInsightsByPriority } from "../insight-priority.js";
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

test("인수인계 요약: 시트 역할을 나누고 다섯 항목을 모두 채웁니다", async () => {
  const { analyzeHandover } = await import("../handover-analysis.js");
  const result = analyzeHandover(record);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.roles.map((role) => role.role), ["period", "watch", "problem", "routine"]);
  const sections = Object.fromEntries(result.sections.map((section) => [section.key, section]));
  for (const key of ["status", "busy", "watch", "problem", "routine"]) assert.ok(sections[key].insights.length > 0, key);

  const lookup = new Set(record.sheets.flatMap((sheet, index) => sheet.rows.map((_, rowIndex) => `sheet:${index}:row:${rowIndex + 1}`)));
  for (const section of result.sections) {
    assert.deepEqual(section.insights, sortInsightsByPriority(section.insights), `${section.key} 항목 우선순위`);
    for (const insight of section.insights) {
      assert.ok(insight.sentence && insight.method && insight.sourceIds.length > 0, insight.id);
      assert.ok(insight.sourceIds.every((sourceId) => lookup.has(sourceId)), `${insight.id} 근거 행`);
    }
  }

  // 지금 상태: 최근 달 값이 원본과 같고, 신ERP 전환·휴직이 사건으로 잡힙니다.
  const months = record.sheets[0].rows.slice(1);
  const latest = sections.status.insights.find((insight) => insight.id === "status-latest");
  assert.ok(latest.title.includes(months.at(-1)[0]));
  const events = sections.status.insights.filter((insight) => insight.id.startsWith("status-event")).map((insight) => insight.title);
  assert.ok(events.some((title) => title.includes("2025-07") && title.includes("신ERP")));
  assert.ok(events.some((title) => title.includes("2026-02") && title.includes("휴직")));
  assert.ok(!events.some((title) => title.includes("월구분")), "매달 바뀌는 열은 사건이 아닙니다");

  // 바쁜 시기: 분기말 접수 평균을 원본에서 다시 계산해 맞춥니다.
  const quarterEnd = months.filter((row) => row[10] === "분기말").map((row) => Number(row[4]));
  const average = quarterEnd.reduce((sum, value) => sum + value, 0) / quarterEnd.length;
  const busy = sections.busy.insights.find((insight) => insight.id.startsWith("busy-category"));
  assert.ok(busy.title.includes("분기말"));
  assert.ok(busy.evidence.some((item) => item.label.startsWith("분기말") && item.value === `${new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 }).format(average)}건`));

  // 조심할 대상: 목록은 모두 이탈위험=높음인 행입니다.
  const watch = sections.watch.insights.find((insight) => insight.id === "watch-list");
  const clients = record.sheets[1].rows;
  for (const sourceId of watch.sourceIds) {
    const rowNumber = Number(sourceId.split(":").at(-1));
    assert.equal(clients[rowNumber - 1][9], "높음");
  }

  // 반복되는 문제: 재발 이슈 중 정산오류 건수가 원본과 같습니다.
  const issues = record.sheets[2].rows.slice(1).filter((row) => row[6] === "예");
  const share = sections.problem.insights.find((insight) => insight.id === "problem-share");
  assert.ok(share.title.includes("정산오류"));
  assert.ok(share.sentence.includes(`${issues.length}건 중 ${issues.filter((row) => row[3] === "정산오류").length}건`));

  // 정기 업무: 중요도 상만 고릅니다.
  const routine = sections.routine.insights[0];
  const highCount = record.sheets[3].rows.slice(1).filter((row) => row[4] === "상").length;
  assert.equal(routine.sourceIds.length, Math.min(6, highCount));
});

test("인수인계 요약: 관련 없는 데이터(생존 기록)에서는 패널을 띄우지 않습니다", async () => {
  const { analyzeHandover } = await import("../handover-analysis.js");
  const rows = readFileSync(new URL("../public/test-fixtures/titanic-style-survival.csv", import.meta.url), "utf8").replace(/^﻿/, "").trim().split("\n").map((line) => line.split(","));
  const result = analyzeHandover({ type: "csv", sheets: [{ name: "titanic", rows, rowNumbers: rows.map((_, index) => index + 1), rowCount: rows.length, columnCount: rows[0].length }] });
  assert.equal(result.status, "insufficient_data");
});

test("인수인계 샘플: '거래처별 미수금'을 물으면 거래처별 미수금 막대 그래프로 답한다", async () => {
  const { answerQuestion } = await import("../question-answer.js");
  for (const question of ["거래처별 미수금", "미수금이 가장 많은 거래처는?"]) {
    const answer = answerQuestion(record, question);
    assert.equal(answer.status, "answered", question);
    assert.equal(answer.spec.visuals[0].type, "bar_chart", question);
    assert.equal(answer.spec.visuals[0].data.series_name, "미수금(만원)", question);
    assert.ok(answer.sentences[0].text.startsWith("미수금이 가장 큰 건 해솔식품"), answer.sentences[0].text);
    assertValidSpec(answer.spec);
  }
});

test("인수인계 샘플: 같은 값이 여러 개인 막대는 강조하지 않고 사실만 알려 준다", async () => {
  const { answerQuestion } = await import("../question-answer.js");
  const spec = buildSpreadsheetVisualizationSpec(record);
  const changes = spec.visuals.find((visual) => visual.title === "거래처현황 · 담당자교체(회)");
  assert.deepEqual(changes.highlights, [], "상위 10개가 모두 3회면 '최고'를 하나만 고르지 않는다");
  assert.match(changes.caption, /최고값\(3회\)인 항목이 11개예요/);
  for (const visual of spec.visuals.filter((item) => item.type === "bar_chart")) {
    assert.ok(visual.highlights.every((highlight) => !highlight.label.startsWith("하락")), `${visual.title}: 크기순 막대에는 '하락'을 붙이지 않는다`);
  }
  const answer = answerQuestion(record, "담당자교체가 가장 많은 거래처");
  assert.match(answer.sentences[0].text, /가장 큰 값\(3회\)인 항목은 .+ 11곳/);
});
