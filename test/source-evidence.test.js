import assert from "node:assert/strict";
import test from "node:test";
import { hasSupportedNumericValue, isSupportedByEvidence } from "../source-evidence.js";

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

test("표 제목 행을 함께 인용하면 열 이름과 숫자 근거를 연결합니다", () => {
  assert.equal(isSupportedByEvidence({
    text: "1월 매출은 120억원입니다.",
    evidence: "1월 | 120",
    source_ids: ["sheet:0:row:1", "sheet:1:row:2"],
  }, sourceLookup), true);
});

test("차트 수치는 부호까지 원본 숫자와 맞아야 합니다", () => {
  assert.equal(hasSupportedNumericValue(-5.6, "Q3 change: -5.6 percent"), true);
  assert.equal(hasSupportedNumericValue(5.6, "Q3 change: -5.6 percent"), false);
  assert.equal(hasSupportedNumericValue(5, "Release date: 2026-05-15"), false);
});
