// 그래프 위 한 줄 결론, 이해 확인 퀴즈, 보고서용 요약 문장을 만듭니다.
// 모든 숫자는 시각화 data 배열에서 코드로 다시 계산하며, AI가 쓴 문장은 쓰지 않습니다.

const numberFormat = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 });

function formatValue(value, unit = "") {
  if (value === null || value === undefined) return "비어 있음";
  const text = numberFormat.format(value);
  return unit === "%" ? `${text}%` : unit ? `${text}${unit}` : text;
}

function getSeries(visual, target) {
  if (visual.type === "line_chart") {
    const series = visual.data.series.find((item) => item.id === target.series_id);
    return series ? { name: series.name, unit: series.unit || visual.data.unit || "", values: series.values, sourceIds: series.source_ids } : null;
  }
  if (visual.type === "bar_chart") {
    return { name: visual.data.series_name || visual.title, unit: visual.data.unit || "", values: visual.data.values, sourceIds: visual.data.source_ids };
  }
  return null;
}

// 직전 점과 비교한 변화(상승·하락) 강조를 실제 data 값으로 다시 계산합니다.
export function getChangeFacts(visual, highlights) {
  if (visual.type !== "line_chart") return [];
  return highlights.flatMap((highlight, highlightIndex) => {
    const index = highlight.target?.point_index;
    if (!highlight.derived || !Number.isInteger(index) || index < 1) return [];
    const series = getSeries(visual, highlight.target);
    const previous = series?.values[index - 1];
    const current = series?.values[index];
    if (typeof previous !== "number" || typeof current !== "number" || previous === current) return [];
    const percent = previous === 0 ? null : ((current - previous) / Math.abs(previous)) * 100;
    const finiteValues = series.values.filter((value) => typeof value === "number");
    return [{
      highlightIndex,
      seriesName: series.name,
      unit: series.unit,
      direction: current > previous ? "up" : "down",
      fromLabel: String(visual.data.labels[index - 1]),
      toLabel: String(visual.data.labels[index]),
      fromIndex: index - 1,
      toIndex: index,
      previous,
      current,
      percent,
      isMaximum: current === Math.max(...finiteValues),
      isMinimum: current === Math.min(...finiteValues),
      sourceIds: [series.sourceIds[index - 1], series.sourceIds[index]].filter(Boolean),
    }];
  });
}

function getExtremeFacts(visual) {
  if (visual.type !== "bar_chart") return null;
  const entries = visual.data.values
    .map((value, index) => ({ value, index, label: String(visual.data.labels[index]) }))
    .filter((entry) => typeof entry.value === "number");
  if (entries.length < 2) return null;
  const maximum = entries.reduce((best, entry) => entry.value > best.value ? entry : best);
  const minimum = entries.reduce((best, entry) => entry.value < best.value ? entry : best);
  if (maximum.value === minimum.value) return null;
  return { maximum, minimum, entries, unit: visual.data.unit || "", name: visual.data.series_name || visual.title };
}

function changeWord(fact) {
  const size = Math.abs(fact.percent ?? 0);
  if (fact.direction === "up") return size >= 20 ? "급증" : "증가";
  return size >= 20 ? "급감" : "감소";
}

function describeChange(fact) {
  const rate = fact.percent === null ? "" : `${numberFormat.format(Math.abs(fact.percent))}% `;
  return `${fact.toLabel} ${fact.seriesName} ${rate}${changeWord(fact)}`;
}

export function buildHeadline(visual, highlights) {
  const changes = getChangeFacts(visual, highlights);
  if (changes.length > 0) {
    const biggest = changes.reduce((best, fact) => Math.abs(fact.percent ?? 0) > Math.abs(best.percent ?? 0) ? fact : best);
    const extra = biggest.isMaximum ? ", 기간 중 최고" : biggest.isMinimum ? ", 기간 중 최저" : "";
    return `${describeChange(biggest)}${extra}`;
  }

  const extremes = getExtremeFacts(visual);
  if (extremes) {
    const { maximum, minimum, unit, name } = extremes;
    return `${name} 최고는 ${maximum.label}(${formatValue(maximum.value, unit)}), 최저는 ${minimum.label}(${formatValue(minimum.value, unit)})`;
  }
  return null;
}

// 퀴즈 보기는 정답 1개와 다른 구간·항목 최대 3개입니다. 같은 자료에는 항상 같은 보기를 만듭니다.
function pickDistractors(candidates, correctKey, count = 3) {
  const others = candidates.filter((candidate) => candidate.key !== correctKey);
  const step = Math.max(1, Math.floor(others.length / count));
  const picked = [];
  for (let index = 0; index < others.length && picked.length < count; index += step) picked.push(others[index]);
  return picked;
}

function orderOptions(options, seed) {
  // 정답 위치가 항상 첫 번째가 되지 않도록 자료 길이에 따라 회전합니다.
  const shift = seed % options.length;
  return [...options.slice(shift), ...options.slice(0, shift)];
}

export function buildQuiz(visual, highlights) {
  const changes = getChangeFacts(visual, highlights);
  const target = changes.find((fact) => fact.direction === "down") || changes[0];
  if (target) {
    const series = getSeries(visual, highlights[target.highlightIndex].target);
    const intervals = [];
    for (let index = 1; index < series.values.length; index += 1) {
      const previous = series.values[index - 1];
      const current = series.values[index];
      if (typeof previous !== "number" || typeof current !== "number") continue;
      intervals.push({ key: index, label: `${visual.data.labels[index - 1]} → ${visual.data.labels[index]}` });
    }
    const correct = intervals.find((interval) => interval.key === target.toIndex);
    if (!correct || intervals.length < 2) return null;
    const options = orderOptions([correct, ...pickDistractors(intervals, correct.key)], series.values.length + target.toIndex)
      .map((option) => ({ label: option.label, correct: option.key === correct.key }));
    const isDrop = target.direction === "down";
    return {
      question: `${target.seriesName}이 가장 크게 ${isDrop ? "떨어진" : "오른"} 구간은 어디일까요?`,
      options,
      highlightIndex: target.highlightIndex,
      explanation: `${target.fromLabel} ${formatValue(target.previous, target.unit)}에서 ${target.toLabel} ${formatValue(target.current, target.unit)}까지 ${target.percent === null ? "" : `${numberFormat.format(Math.abs(target.percent))}% `}${isDrop ? "줄어" : "늘어"} 가장 큰 ${isDrop ? "하락" : "상승"}이에요.`,
    };
  }

  const extremes = getExtremeFacts(visual);
  if (extremes) {
    const candidates = extremes.entries.map((entry) => ({ key: entry.index, label: entry.label }));
    const correct = candidates.find((candidate) => candidate.key === extremes.maximum.index);
    const options = orderOptions([correct, ...pickDistractors(candidates, correct.key)], candidates.length + extremes.maximum.index)
      .map((option) => ({ label: option.label, correct: option.key === correct.key }));
    const highlightIndex = highlights.findIndex((highlight) => highlight.target?.point_index === extremes.maximum.index);
    return {
      question: `${extremes.name}이 가장 높은 항목은 무엇일까요?`,
      options,
      highlightIndex: highlightIndex >= 0 ? highlightIndex : null,
      explanation: `${extremes.maximum.label}이 ${formatValue(extremes.maximum.value, extremes.unit)}로 가장 높아요.`,
    };
  }
  return null;
}

function rowLabel(sourceId, sourceLookup) {
  const location = sourceLookup?.get(sourceId);
  if (location?.rowNumber) return `${location.rowNumber}행`;
  if (location?.pageNumber) return `${location.pageNumber}페이지`;
  return sourceId;
}

// 보고서에 붙여 넣을 2~3문장 요약입니다. 각 문장 끝에 근거 값과 원본 행 번호를 붙입니다.
export function buildReportText(visual, highlights, sourceLookup) {
  const lines = [visual.title];
  const headline = buildHeadline(visual, highlights);
  if (headline) lines.push(`핵심: ${headline}.`);

  getChangeFacts(visual, highlights).slice(0, 2).forEach((fact) => {
    const rate = fact.percent === null ? "" : ` (${fact.percent > 0 ? "+" : ""}${numberFormat.format(fact.percent)}%)`;
    const rows = fact.sourceIds.map((sourceId) => rowLabel(sourceId, sourceLookup)).join("·");
    lines.push(`- ${fact.fromLabel}→${fact.toLabel} ${fact.seriesName}: ${formatValue(fact.previous, fact.unit)} → ${formatValue(fact.current, fact.unit)}${rate} [근거: ${rows}, 계산: (현재-직전)÷|직전|×100]`);
  });

  const extremes = getExtremeFacts(visual);
  if (extremes) {
    const rows = [extremes.maximum, extremes.minimum]
      .map((entry) => rowLabel(visual.data.source_ids[entry.index], sourceLookup)).join("·");
    lines.push(`- 최고 ${extremes.maximum.label} ${formatValue(extremes.maximum.value, extremes.unit)}, 최저 ${extremes.minimum.label} ${formatValue(extremes.minimum.value, extremes.unit)} [근거: ${rows}]`);
  }

  if (lines.length === 1) lines.push(visual.caption);
  return lines.join("\n");
}
