import assert from "node:assert/strict";
import test from "node:test";
import { INSIGHT_LEVEL_LABELS, sortInsightsByPriority } from "../insight-priority.js";

test("인사이트를 핵심·중요·참고 순으로 안정 정렬합니다", () => {
  const insights = [
    { id: "reference-first", level: "info" },
    { id: "important-first", level: "important" },
    { id: "core-first", level: "critical" },
    { id: "core-second", level: "critical" },
    { id: "reference-second", level: "info" },
  ];

  assert.deepEqual(
    sortInsightsByPriority(insights).map((insight) => insight.id),
    ["core-first", "core-second", "important-first", "reference-first", "reference-second"],
  );
  assert.deepEqual(insights.map((insight) => insight.id), [
    "reference-first", "important-first", "core-first", "core-second", "reference-second",
  ], "원본 배열은 바뀌지 않습니다");
});

test("그래프의 중요한 부분도 핵심·중요·참고 순으로 정렬합니다", () => {
  const highlights = [
    { label: "참고 기간", level: "info" },
    { label: "중요 최고값", level: "important" },
    { label: "핵심 하락", level: "critical" },
  ];

  assert.deepEqual(
    sortInsightsByPriority(highlights).map((highlight) => highlight.label),
    ["핵심 하락", "중요 최고값", "참고 기간"],
  );
});

test("요약과 그래프 강조의 우선순위 문구를 통일합니다", () => {
  assert.deepEqual(INSIGHT_LEVEL_LABELS, { critical: "핵심", important: "중요", info: "참고" });
});
