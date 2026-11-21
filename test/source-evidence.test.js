import assert from "node:assert/strict";
import test from "node:test";
import { hasOnlySupportedNumbers, hasSupportedNumericValue, isSupportedByEvidence } from "../source-evidence.js";

const sourceLookup = new Map([
  ["sheet:0:row:1", { text: "월 | 매출(억원)" }],
  ["sheet:0:row:2", { text: "개발 | 12 | 진행" }],
  ["sheet:1:row:2", { text: "1월 | 120" }],
  ["pdf:page:1", { text: "Q2 revenue: 125 units. Q3 revenue: 118 units. Q3 change from Q2: -5.6 percent." }],
]);

test("요약은 원문 근거의 핵심 어휘와 일치해야 합니다", () => {
  assert.equal(isSupportedByEvidence({
    text: "개발팀은 12건을 완료했습니다.",
    evidence: "개발 | 12 | 진행",
    source_ids: ["sheet:0:row:2"],
  }, sourceLookup), false);

  assert.equal(isSupportedByEvidence({
    text: "개발팀의 이익은 12입니다.",
    evidence: "개발 | 12 | 진행",
    source_ids: ["sheet:0:row:2"],
  }, sourceLookup), false);

  assert.equal(isSupportedByEvidence({
    text: "개발은 12이며 진행 중입니다.",
    evidence: "개발 | 12 | 진행",
    source_ids: ["sheet:0:row:2"],
  }, sourceLookup), true);
});

test("한글 요약과 영어 원문의 같은 의미 단어를 허용합니다", () => {
  assert.equal(isSupportedByEvidence({
    text: "Q3 매출은 Q2보다 5.6 percent 감소했습니다.",
    evidence: "Q2 revenue: 125 units. Q3 revenue: 118 units. Q3 change from Q2: -5.6 percent.",
    source_ids: ["pdf:page:1"],
  }, sourceLookup), true);

  assert.equal(isSupportedByEvidence({
    text: "Q3 매출은 Q2보다 5.6 percent 증가했습니다.",
    evidence: "Q2 revenue: 125 units. Q3 revenue: 118 units. Q3 change from Q2: -5.6 percent.",
    source_ids: ["pdf:page:1"],
  }, sourceLookup), false);
});

test("한글 PDF 요약은 영어 월 이름·숫자 단어와 문서 용어를 검증합니다", () => {
  const meeting = "Decision: Move the release from 2026-04-16 to 2026-04-23. Decision: Keep the first release scope to the three agreed core workflows. Completed work increased from 18 items in February to 24 items in March. Open customer issues decreased from 12 in February to 8 in March. Design to deliver the revised onboarding flow by 2026-04-08. Engineering to complete release checks by 2026-04-18. Product lead to review and approve the release checklist on 2026-04-20.";
  const pdfSources = new Map([["pdf:page:1", { text: meeting }]]);

  assert.equal(isSupportedByEvidence({
    text: "첫 출시 범위는 합의된 핵심 워크플로 3개로 유지합니다.",
    evidence: "Decision: Keep the first release scope to the three agreed core workflows.",
    source_ids: ["pdf:page:1"],
  }, pdfSources), true);
  assert.equal(isSupportedByEvidence({
    text: "완료 업무는 2월 18건에서 3월 24건으로 증가했고, 미해결 고객 이슈는 12건에서 8건으로 감소했습니다.",
    evidence: "Completed work increased from 18 items in February to 24 items in March. Open customer issues decreased from 12 in February to 8 in March.",
    source_ids: ["pdf:page:1"],
  }, pdfSources), true);
  assert.equal(isSupportedByEvidence({
    text: "Design은 2026-04-08까지 온보딩 흐름을 전달하고, Engineering은 2026-04-18까지 출시 점검을 완료하며, Product lead는 2026-04-20 체크리스트를 검토·승인합니다.",
    evidence: "Design to deliver the revised onboarding flow by 2026-04-08. Engineering to complete release checks by 2026-04-18. Product lead to review and approve the release checklist on 2026-04-20.",
    source_ids: ["pdf:page:1"],
  }, pdfSources), true);
  assert.equal(isSupportedByEvidence({
    text: "Completed work increased from February 18 items to March 24 items.",
    evidence: "Completed work increased from 18 items in February to 24 items in March.",
    source_ids: ["pdf:page:1"],
  }, pdfSources), true);
  assert.equal(hasOnlySupportedNumbers("February to March: four workflows", "2월부터 3월까지: three workflows"), false);
});

test("표 제목 행을 함께 인용하면 열 이름과 숫자 근거를 연결합니다", () => {
  assert.equal(isSupportedByEvidence({
    text: "1월 매출은 120억원입니다.",
    evidence: "1월 | 120",
    source_ids: ["sheet:0:row:1", "sheet:1:row:2"],
  }, sourceLookup), true);
});

test("최고·최저 주장은 인용된 표의 실제 최댓값·최솟값 행과 일치해야 합니다", () => {
  const tableSources = new Map([
    ["sheet:0:row:1", { text: "월 | 매출(억원)" }],
    ["sheet:0:row:2", { text: "1월 | 100" }],
    ["sheet:0:row:3", { text: "2월 | 150" }],
    ["sheet:0:row:4", { text: "3월 | 120" }],
  ]);
  const allRows = [...tableSources.keys()];
  assert.equal(isSupportedByEvidence({
    text: "1월 매출 100은 최고 실적입니다.",
    evidence: "1월 | 100",
    source_ids: allRows,
  }, tableSources), false);
  assert.equal(isSupportedByEvidence({
    text: "2월 매출 150은 최고 실적입니다.",
    evidence: "2월 | 150",
    source_ids: allRows,
  }, tableSources), true);
});

test("시계열 요약은 실제 기간별 변화 흐름을 반영해야 합니다", () => {
  const rows = [
    "월 | 매출(억원)",
    "2026-01 | 100",
    "2026-02 | 150",
    "2026-03 | 120",
    "2026-04 | 180",
    "2026-05 | 130",
  ];
  const sourceMap = new Map(rows.map((text, index) => [`sheet:0:row:${index + 1}`, { text }]));
  const source_ids = [...sourceMap.keys()];
  assert.equal(isSupportedByEvidence({
    text: "월별 매출은 오르내렸지만 전체 기간으로 증가했습니다.",
    evidence: rows[0],
    source_ids,
  }, sourceMap), true);
  assert.equal(isSupportedByEvidence({
    text: "월별 매출은 전체적으로 감소했습니다.",
    evidence: rows[0],
    source_ids,
  }, sourceMap), false);

  assert.equal(isSupportedByEvidence({
    text: "관측 기간의 마지막 매출은 첫 매출보다 높았으며, 중간에 등락했습니다.",
    evidence: "2026-01 | 100",
    source_ids: source_ids,
  }, sourceMap), true);
});

test("차트 수치는 부호까지 원본 숫자와 맞아야 합니다", () => {
  assert.equal(hasSupportedNumericValue(-5.6, "Q3 change: -5.6 percent"), true);
  assert.equal(hasSupportedNumericValue(5.6, "Q3 change: -5.6 percent"), false);
  assert.equal(hasSupportedNumericValue(5, "Release date: 2026-05-15"), false);
  assert.equal(hasOnlySupportedNumbers("출시일은 2026-05-16입니다.", "Planned release: 2026-05-15"), false);
  assert.equal(hasOnlySupportedNumbers("출시는 2026년 5월 15일입니다.", "Planned release: 2026-05-15"), true);
});
