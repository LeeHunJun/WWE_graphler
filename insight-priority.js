export const INSIGHT_LEVEL_LABELS = Object.freeze({
  critical: "핵심",
  important: "중요",
  info: "참고",
});

const INSIGHT_LEVEL_PRIORITY = Object.freeze({ critical: 0, important: 1, info: 2 });

export function sortInsightsByPriority(insights = []) {
  if (!Array.isArray(insights)) return [];

  return [...insights].sort((first, second) =>
    (INSIGHT_LEVEL_PRIORITY[first?.level] ?? 3) - (INSIGHT_LEVEL_PRIORITY[second?.level] ?? 3));
}
