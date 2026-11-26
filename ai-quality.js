import { hasOnlySupportedNumbers, hasSupportedNumericValue, numericValues } from "./source-evidence.js";
import { getHighlightIdentity, parseTemporal, validateHighlight, validateVisual } from "./visualization.js";

const DECISION_PATTERN = /(결정\s*사항|최종\s*결정|결정|확정|승인|반려|보류|취소|채택|합의|의결|decision|approv(?:e|ed|al)|reject(?:ed)?|on hold)/i;
const CHANGE_PATTERN = /(변경|증가|감소|상승|하락|개선|악화|전환|늘(?:었|어|어남|어납니다)|줄(?:었|어|어듦|어듭니다)|전보다|대비|증감|변동|차이|change|increase|decrease|improv|worsen|before|after)/i;
const PROCESS_PATTERN = /(업무\s*절차|처리\s*절차|승인\s*절차|업무\s*흐름|처리\s*순서|진행\s*순서|단계별|업무\s*프로세스|business\s+process|workflow|승인\s*(?:후|및)\s*(?:공유|배포))/i;
const SCHEDULE_PATTERN = /(마감|기한|제출|출시|배포|예정|일정|회의|검토일|due|deadline|submit|launch|release|scheduled|review\s+date)/i;
const RISK_PATTERN = /(위험|리스크|긴급|지연|초과|부족|장애|오류|risk|urgent|delay|overdue|issue)/i;
const PRIORITY_PATTERN = /(보안|필수|금지|주의|목표|미달|준수|중요|mandatory|prohibit|security|target|missed)/i;
const STRICT_PRIORITY_PATTERN = /(필수|반드시|금지|의무|절대\s*금지|must\s+not|required|mandatory|prohibited)/i;
const DATE_PATTERN = /(?:\d{4}\s*년\s*\d{1,2}\s*월(?:\s*\d{1,2}\s*일)?|\d{4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?|(?:[1-4]\s*분기|Q[1-4])|\d{1,2}\s*월(?:\s*\d{1,2}\s*일)?)/gi;
const PERIOD_PATTERN = /(?:\bQ[1-4]\b|[1-4]\s*분기|\d{1,2}\s*월|\d{4}[-/.]\d{1,2}(?![-/.]\d)|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b)/gi;
const COMPARE_PATTERN = /(전\s*후|변경\s*전|변경\s*후|비교|차이|대비|vs\.?|versus|compared?\s+to)/i;
const TREND_SUMMARY_PATTERN = /(증가|감소|상승|하락|높|낮|늘(?:었|어)|줄(?:었|어)|오르내|등락|추이|증감|변화|increase|decrease|rise|rose|fall|fell|trend|higher|lower|grew|declin)/i;

function unique(values) {
  return [...new Set(values)];
}

function getSourceMap(document) {
  return new Map(document.sources.map((source) => [source.source_id, source.text]));
}

function extractReferences(value, result = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => extractReferences(item, result));
    return result;
  }
  if (!value || typeof value !== "object") return result;
  for (const [key, item] of Object.entries(value)) {
    if (key === "source_ids" && Array.isArray(item)) result.push(...item.filter((id) => typeof id === "string"));
    else extractReferences(item, result);
  }
  return result;
}

function getPeriodTokens(text) {
  return (text.match(PERIOD_PATTERN) || []).map((token) => token.toLowerCase().replace(/\s+/g, ""));
}

function hasDate(text) {
  DATE_PATTERN.lastIndex = 0;
  return DATE_PATTERN.test(text);
}

function getNumericCorpus(sourceIds, sourceMap, visual) {
  const texts = sourceIds.map((id) => sourceMap.get(id) || "");
  for (const highlight of visual.highlights || []) {
    if (!highlight?.derived || !Array.isArray(highlight.source_ids)) continue;
    if (!highlight.source_ids.some((id) => sourceIds.includes(id))) continue;
    if (highlight.derived.result !== undefined) {
      texts.push(String(highlight.derived.result));
      if (typeof highlight.derived.result === "number" && Number.isFinite(highlight.derived.result)) {
        texts.push(Math.abs(highlight.derived.result).toFixed(1));
      }
    }
  }
  return texts.join("\n");
}

function numericClaimIsGrounded(value, sourceIds, sourceMap, visual) {
  if (typeof value !== "number" || !Number.isFinite(value)) return true;
  if (sourceIds.some((sourceId) => hasSupportedNumericValue(value, sourceMap.get(sourceId) || ""))) return true;
  return visual.highlights.some((highlight) => highlight.derived
    && highlight.source_ids.some((sourceId) => sourceIds.includes(sourceId))
    && typeof highlight.derived.result === "number"
    && Math.abs(highlight.derived.result - value) < 1e-9);
}

export function validateVisualGrounding(visual, sourceMap) {
  const sourceIds = visual.source_ids;
  const visualText = sourceIds.map((id) => sourceMap.get(id) || "").join("\n");
  if (!hasOnlySupportedNumbers(`${visual.title} ${visual.caption}`, getNumericCorpus(sourceIds, sourceMap, visual))) {
    return "제목 또는 설명에 원문·계산 근거가 없는 숫자가 있습니다.";
  }

  if (visual.type === "line_chart") {
    for (const series of visual.data.series) {
      for (let index = 0; index < series.values.length; index += 1) {
        const sourceId = series.source_ids[index];
        if (typeof sourceId !== "string" || !sourceMap.has(sourceId) || !sourceIds.includes(sourceId)) return "선 그래프의 원본 위치가 visual.source_ids와 맞지 않습니다.";
        if (!hasOnlySupportedNumbers(String(visual.data.labels[index]), sourceMap.get(sourceId))
          || !hasOnlySupportedNumbers(series.name, sourceMap.get(sourceId))) {
          return "선 그래프의 시점 또는 계열 이름을 해당 원본에서 확인할 수 없습니다.";
        }
        if (series.values[index] !== null && !numericClaimIsGrounded(series.values[index], [sourceId], sourceMap, visual)) {
          return "선 그래프의 수치가 해당 원본 시점과 맞지 않습니다.";
        }
      }
    }
  } else if (visual.type === "bar_chart") {
    for (let index = 0; index < visual.data.values.length; index += 1) {
      const sourceId = visual.data.source_ids[index];
      if (typeof sourceId !== "string" || !sourceMap.has(sourceId) || !sourceIds.includes(sourceId)) return "막대 그래프의 원본 위치가 visual.source_ids와 맞지 않습니다.";
      if (visual.data.values[index] !== null && !numericClaimIsGrounded(visual.data.values[index], [sourceId], sourceMap, visual)) {
        return "막대 그래프의 수치가 해당 항목의 원본과 맞지 않습니다.";
      }
      if (sourceId && !hasOnlySupportedNumbers(String(visual.data.labels[index]), sourceMap.get(sourceId))) {
        return "막대 그래프의 항목 이름을 해당 원본 행에서 확인할 수 없습니다.";
      }
    }
  } else if (visual.type === "comparison_table") {
    if (visual.data.columns.some((column) => !hasOnlySupportedNumbers(column.label, visualText))) {
      return "비교표 항목 이름에 원문에서 확인할 수 없는 숫자가 있습니다.";
    }
    for (const row of visual.data.rows) {
      const corpus = getNumericCorpus(row.source_ids, sourceMap, visual);
      for (const cell of Object.values(row.cells)) {
        if (typeof cell === "number" && !hasOnlySupportedNumbers(String(cell), corpus)) {
          return "비교표의 수치가 해당 원본 행 또는 계산 근거와 맞지 않습니다.";
        }
        if (typeof cell === "string" && !hasOnlySupportedNumbers(cell, corpus)) {
          return "비교표의 날짜·수치가 해당 원본 행 또는 계산 근거와 맞지 않습니다.";
        }
      }
    }
  } else if (visual.type === "timeline") {
    for (const item of visual.data.items) {
      const corpus = item.source_ids.map((id) => sourceMap.get(id) || "").join("\n");
      if (!item.source_ids.every((id) => sourceIds.includes(id)) || !hasOnlySupportedNumbers(`${item.date} ${item.label} ${item.description || ""}`, corpus)) {
        return "일정의 날짜·수치·내용이 해당 원본 위치와 맞지 않습니다.";
      }
    }
  } else if (visual.type === "flowchart") {
    for (const node of visual.data.nodes) {
      const corpus = node.source_ids.map((id) => sourceMap.get(id) || "").join("\n");
      if (!node.source_ids.every((id) => sourceIds.includes(id)) || !hasOnlySupportedNumbers(`${node.label} ${node.description || ""}`, corpus)) {
        return "업무 절차 단계의 수치 또는 원본 위치가 맞지 않습니다.";
      }
    }
    for (const edge of visual.data.edges) {
      if (edge.source_ids?.some((id) => !sourceIds.includes(id) || !sourceMap.has(id))) return "업무 절차 연결선의 원본 위치가 맞지 않습니다.";
      const edgeText = (edge.source_ids || sourceIds).map((id) => sourceMap.get(id) || "").join("\n");
      if (!hasOnlySupportedNumbers(edge.label || "", edgeText)) return "업무 절차 연결선에 원문에서 확인할 수 없는 숫자가 있습니다.";
    }
  } else if (visual.type === "kpi_cards") {
    for (const card of visual.data.cards) {
      const cardText = card.source_ids.map((id) => sourceMap.get(id) || "").join("\n");
      if (!hasOnlySupportedNumbers(`${card.label} ${card.unit || ""} ${card.note || ""}`, getNumericCorpus(card.source_ids, sourceMap, visual))) {
        return "핵심 수치 카드의 이름 또는 설명에 원문에서 확인할 수 없는 숫자가 있습니다.";
      }
      const valueIsGrounded = typeof card.value === "number"
        ? numericClaimIsGrounded(card.value, card.source_ids, sourceMap, visual)
        : hasOnlySupportedNumbers(String(card.value), `${cardText}\n${getNumericCorpus(card.source_ids, sourceMap, visual)}`);
      if (!card.source_ids.every((id) => sourceIds.includes(id)) || !valueIsGrounded) {
        return "핵심 수치가 해당 원본 위치와 맞지 않습니다.";
      }
    }
  }

  for (const highlight of visual.highlights) {
    const sourceText = highlight.source_ids.map((id) => sourceMap.get(id) || "").join("\n");
    if (["critical", "important"].includes(highlight.level)
      && !DECISION_PATTERN.test(sourceText)
      && !CHANGE_PATTERN.test(sourceText)
      && !PROCESS_PATTERN.test(sourceText)
      && !SCHEDULE_PATTERN.test(sourceText)
      && !RISK_PATTERN.test(sourceText)
      && !PRIORITY_PATTERN.test(sourceText)
      && numericValues(sourceText).length === 0) {
      return "원문에서 중요도를 확인할 수 없는 내용을 critical 또는 important로 강조했습니다.";
    }
    const derivedResult = highlight.derived
      ? [String(highlight.derived.result ?? ""), ...(typeof highlight.derived.result === "number" ? [Math.abs(highlight.derived.result).toFixed(1)] : [])].join(" ")
      : "";
    if (highlight.derived && highlight.derived.original_values.some((item) => {
      if (typeof item.value === "number") return !highlight.source_ids.some((sourceId) => hasSupportedNumericValue(item.value, sourceMap.get(sourceId) || ""));
      return typeof item.value === "string" && !hasOnlySupportedNumbers(item.value, sourceText);
    })) return "강조 계산에 사용한 원래 값이 해당 원본에 없습니다.";

    if (highlight.derived && typeof highlight.derived.result === "number") {
      const actualValues = highlight.derived.original_values.map((item) => Number(String(item.value).replace(/,/g, "")));
      const formula = highlight.derived.formula;
      if (/(?:직전|이전|before).*(?:현재|후|after)|%/.test(formula) && actualValues.length >= 2) {
        const [previous, current] = actualValues.slice(-2);
        const expected = previous === 0 ? null : ((current - previous) / Math.abs(previous)) * 100;
        if (expected === null || !Number.isFinite(expected) || Math.abs(expected - highlight.derived.result) > 0.02) {
          return "강조의 계산 결과가 원래 값과 일치하지 않습니다.";
        }
      }
    }

    const derived = derivedResult;
    if (!hasOnlySupportedNumbers(`${highlight.label} ${highlight.reason}`, `${sourceText}\n${derived}`)) {
      return "강조 설명의 숫자가 원문 또는 계산값과 맞지 않습니다.";
    }
    if (highlight.derived && typeof highlight.derived.result === "number") {
      const claimsIncrease = /(증가|상승|늘었|늘어|improv|increase|rose|grew)/i.test(`${highlight.label} ${highlight.reason}`);
      const claimsDecrease = /(감소|하락|줄었|줄어|decreas|drop|fell|declin)/i.test(`${highlight.label} ${highlight.reason}`);
      if ((highlight.derived.result < 0 && claimsIncrease && !claimsDecrease)
        || (highlight.derived.result > 0 && claimsDecrease && !claimsIncrease)) {
        return "강조의 증가·감소 방향이 계산 결과와 반대입니다.";
      }
    }
  }

  return null;
}

function getSignalSources(sources) {
  const signals = {
    decision: [],
    change: [],
    process: [],
    schedule: [],
    risk: [],
    strictPriority: [],
  };

  for (const source of sources) {
    const text = source.text || "";
    if (!text.trim()) continue;
    if (DECISION_PATTERN.test(text)) signals.decision.push(source.source_id);
    if (CHANGE_PATTERN.test(text) && (text.match(/\d+(?:[.,]\d+)?/g) || []).length >= 2) signals.change.push(source.source_id);
    if (PROCESS_PATTERN.test(text)) signals.process.push(source.source_id);
    if (SCHEDULE_PATTERN.test(text) && hasDate(text)) signals.schedule.push(source.source_id);
    if (RISK_PATTERN.test(text)) signals.risk.push(source.source_id);
    if (STRICT_PRIORITY_PATTERN.test(text)) signals.strictPriority.push(source.source_id);
  }

  const completeText = sources.map((source) => source.text || "").join(" ");
  const orderedWorkflow = /(?:요청|접수|수집|collect|receive|request).{0,80}(?:검토|확인|review).{0,80}(?:승인|공유|배포|approve|share)/i.test(completeText);
  if (orderedWorkflow && signals.process.length === 0) {
    signals.process = sources
      .filter((source) => /(요청|접수|수집|collect|receive|request|검토|확인|review|승인|공유|배포|approve|share)/i.test(source.text || ""))
      .map((source) => source.source_id);
  }

  const periods = unique(sources.flatMap((source) => getPeriodTokens(source.text || "")));
  const periodSources = periods.length >= 2
    ? sources.filter((source) => getPeriodTokens(source.text || "").length > 0).map((source) => source.source_id)
    : [];
  const numericSourceIds = sources
    .filter((source) => numericValues(source.text || "").length > 0)
    .map((source) => source.source_id);
  const timeSeries = periodSources.length > 0 && numericSourceIds.length >= 2;

  const comparison = sources
    .filter((source) => COMPARE_PATTERN.test(source.text || "") && /\d/.test(source.text || ""))
    .map((source) => source.source_id);

  return {
    ...Object.fromEntries(Object.entries(signals).map(([key, ids]) => [key, unique(ids)])),
    periodSources: unique(periodSources),
    timeSeries,
    comparison: unique(comparison),
  };
}

function getCategoricalNumericGroups(sources) {
  const sheetRows = new Map();
  for (const source of sources) {
    const match = source.source_id.match(/^sheet:(\d+):row:(\d+)$/);
    if (!match) continue;
    const sheetIndex = Number(match[1]);
    const rowNumber = Number(match[2]);
    const cells = source.text.split("|").map((cell) => cell.trim());
    if (!sheetRows.has(sheetIndex)) sheetRows.set(sheetIndex, []);
    sheetRows.get(sheetIndex).push({ sourceId: source.source_id, rowNumber, cells });
  }

  const groups = [];
  for (const rows of sheetRows.values()) {
    rows.sort((first, second) => first.rowNumber - second.rowNumber);
    const header = rows.find((row) => row.cells.some(Boolean));
    if (!header) continue;
    const dataRows = rows.filter((row) => row !== header && row.cells.some(Boolean));
    if (dataRows.length < 2) continue;

    const columnCount = Math.max(header.cells.length, ...dataRows.map((row) => row.cells.length));
    let categoryColumn = -1;
    let temporalAxis = false;
    for (let column = 0; column < columnCount; column += 1) {
      const values = dataRows.map((row) => row.cells[column] || "").filter(Boolean);
      if (values.length < 2) continue;
      if (values.every((value) => parseTemporal(value) !== null)) {
        temporalAxis = true;
        break;
      }
      if (values.some((value) => numericValues(value).length === 0)) {
        categoryColumn = column;
        break;
      }
    }
    if (temporalAxis || categoryColumn < 0) continue;

    const numericColumns = [];
    for (let column = 0; column < columnCount; column += 1) {
      if (column === categoryColumn) continue;
      if (dataRows.filter((row) => numericValues(row.cells[column] || "").length > 0).length >= 2) numericColumns.push(column);
    }
    if (numericColumns.length > 0) groups.push(unique(dataRows.map((row) => row.sourceId)));
  }
  return groups;
}

function getVisualSources(visual) {
  return unique(extractReferences(visual));
}

function hasVisualTypeForSources(visuals, types, sourceIds) {
  return visuals.some((visual) => types.includes(visual.type)
    && visual.source_ids.some((sourceId) => sourceIds.includes(sourceId)));
}

function hasTemporalLineChart(visuals, periodSources) {
  return visuals.some((visual) => visual.type === "line_chart"
    && visual.source_ids.some((sourceId) => periodSources.includes(sourceId))
    && visual.data.labels.length >= 2
    && visual.data.labels.every((label) => getPeriodTokens(String(label)).length > 0)
    && visual.data.labels.map(parseTemporal).every((key, index, keys) => Number.isFinite(key) && (index === 0 || keys[index - 1] < key))
    && visual.data.series.some((series) => series.values.some((value) => value !== null)));
}

function normalizeText(text) {
  return text.toLocaleLowerCase("ko").replace(/[\s\p{P}\p{S}]+/gu, "");
}

function hasDirectionMismatch(text, change) {
  if (typeof change !== "number" || !Number.isFinite(change)) return false;
  const saysIncrease = /(증가|상승|늘었|늘어|improv|increase|rose|grew)/i.test(text);
  const saysDecrease = /(감소|하락|줄었|줄어|decreas|drop|fell|declin)/i.test(text);
  return (change < 0 && saysIncrease && !saysDecrease)
    || (change > 0 && saysDecrease && !saysIncrease);
}

function summaryCoversChangeRange(item, highlight, document, sourceMap) {
  if (document.type === "pdf") {
    const periods = (highlight.derived?.original_values || [])
      .map((value) => getPeriodTokens(String(value.label || ""))[0])
      .filter(Boolean);
    const summaryPeriods = getPeriodTokens(item.text).map((period) => period.toLocaleLowerCase("en"));
    return periods.length >= 2 && periods.every((period) => summaryPeriods.includes(period.toLocaleLowerCase("en")));
  }

  const getNumericSources = (ids) => unique(ids.filter((sourceId) => numericValues(sourceMap.get(sourceId) || "").length > 0)).sort();
  const summarySources = getNumericSources(item.source_ids);
  const changeSources = getNumericSources(highlight.source_ids);
  return summarySources.length > 0
    && summarySources.length === changeSources.length
    && summarySources.every((sourceId, index) => sourceId === changeSources[index]);
}

function hasDuplicateKeyPoints(keyPoints) {
  const normalized = keyPoints.map((point) => normalizeText(point.text));
  return normalized.some((text, index) => text.length > 0 && normalized.slice(index + 1).includes(text));
}

export function validateAiQuality(result, document, { partialCoverage = false } = {}) {
  const issues = [];
  const sourceMap = getSourceMap(document);
  const visuals = result.spec.visuals;

  if (result.spec.status === "insufficient_data") {
    if (result.summary.length > 0 || result.key_points.length > 0 || visuals.length > 0) {
      issues.push("자료가 부족하다고 했지만 요약·핵심 내용·시각화를 함께 반환했습니다.");
    }
    return issues;
  }

  if (hasDuplicateKeyPoints(result.key_points)) issues.push("핵심 내용에 같은 항목이 중복되었습니다.");

  const visualIds = new Set();
  for (const visual of visuals) {
    const shapeError = validateVisual(visual);
    if (shapeError) {
      issues.push(`${visual?.title || "시각화"}: ${shapeError}`);
      continue;
    }
    if (visualIds.has(visual.id)) issues.push(`시각화 id ${visual.id}가 중복되었습니다.`);
    visualIds.add(visual.id);

    if (!Array.isArray(visual.source_ids) || visual.source_ids.length === 0
      || visual.source_ids.some((sourceId) => !sourceMap.has(sourceId))) {
      issues.push(`${visual.title}: visual.source_ids가 실제 원본 위치와 맞지 않습니다.`);
      continue;
    }

    const itemsHaveSources = visual.type === "line_chart"
      ? visual.data.series.every((series) => series.source_ids.every((sourceId) => typeof sourceId === "string"))
      : visual.type === "bar_chart"
        ? visual.data.source_ids.every((sourceId) => typeof sourceId === "string")
        : visual.type === "comparison_table"
          ? visual.data.rows.every((row) => row.source_ids.length > 0)
          : visual.type === "flowchart"
            ? visual.data.nodes.every((node) => node.source_ids.length > 0)
              && visual.data.edges.every((edge) => edge.source_ids === undefined || edge.source_ids.length > 0)
            : visual.type === "timeline"
              ? visual.data.items.every((item) => item.source_ids.length > 0)
              : visual.data.cards.every((card) => card.source_ids.length > 0);
    if (!itemsHaveSources) {
      issues.push(`${visual.title}: 시각화 항목 중 원본 위치가 연결되지 않은 것이 있습니다.`);
      continue;
    }

    const nestedIds = getVisualSources(visual);
    if (nestedIds.some((sourceId) => !sourceMap.has(sourceId) || !visual.source_ids.includes(sourceId))) {
      issues.push(`${visual.title}: data 또는 highlight의 source_ids가 실제 원본 위치 또는 visual.source_ids와 맞지 않습니다.`);
      continue;
    }

    const shapeTargets = new Set();
    for (const highlight of visual.highlights) {
      const highlightError = validateHighlight(visual, highlight);
      if (highlightError) {
        issues.push(`${visual.title}: ${highlightError}`);
        continue;
      }
      if (highlight.source_ids.some((sourceId) => !sourceMap.has(sourceId))) {
        issues.push(`${visual.title}: highlight.source_ids가 실제 원본 위치와 맞지 않습니다.`);
        continue;
      }
      const identity = getHighlightIdentity(visual, highlight.target);
      if (shapeTargets.has(identity)) issues.push(`${visual.title}: 같은 대상을 중복 강조했습니다.`);
      shapeTargets.add(identity);
    }

    const groundingError = validateVisualGrounding(visual, sourceMap);
    if (groundingError) issues.push(`${visual.title}: ${groundingError}`);

  }

  for (const item of [...result.summary, ...result.key_points]) {
    const mismatchedChange = visuals.some((visual) => visual.highlights.some((highlight) =>
      highlight.derived
      && summaryCoversChangeRange(item, highlight, document, sourceMap)
      && hasDirectionMismatch(item.text, highlight.derived.result)));
    if (mismatchedChange) issues.push("요약의 증가·감소 표현이 원문 수치 변화와 반대입니다.");
  }

  const signals = getSignalSources(document.sources);
  const allSourceText = document.sources.map((source) => source.text || "").join("\n");
  const derivedValues = visuals.flatMap((visual) => visual.highlights
    .filter((highlight) => highlight.derived && typeof highlight.derived.result === "number")
    .map((highlight) => String(highlight.derived.result)));
  if (!hasOnlySupportedNumbers(result.spec.message, `${allSourceText}\n${derivedValues.join(" ")}`)) {
    issues.push("spec.message에 원문 또는 계산 근거가 없는 숫자가 있습니다.");
  }
  const topLevelReferences = unique([
    ...result.summary.flatMap((item) => item.source_ids),
    ...result.key_points.flatMap((item) => item.source_ids),
  ]);
  const importantGroups = [
    ["결정·승인", unique(signals.decision)],
    ["수치 변경", unique(signals.change)],
    ["업무 절차", unique(signals.process)],
    ["일정·마감", unique(signals.schedule)],
    ["위험·필수", unique([...signals.risk, ...signals.strictPriority])],
  ].filter(([, sourceIds]) => sourceIds.length > 0);
  const importantSourceIds = unique([
    ...signals.decision,
    ...signals.change,
    ...signals.process,
    ...signals.schedule,
    ...signals.risk,
    ...signals.strictPriority,
  ]);

  if (partialCoverage) {
    for (const [label, sourceIds] of importantGroups) {
      if (!topLevelReferences.some((sourceId) => sourceIds.includes(sourceId))) {
        issues.push(`${label} 관련 핵심 원본이 전체 요약이나 핵심 내용에서 빠졌습니다.`);
      }
    }
  } else {
    for (const sourceId of importantSourceIds) {
      if (!topLevelReferences.includes(sourceId)) {
        issues.push(`중요한 원본 위치 ${sourceId}가 전체 요약이나 핵심 내용에서 빠졌습니다.`);
      }
    }
  }

  if (signals.process.length > 0
    && !hasVisualTypeForSources(visuals, ["flowchart"], signals.process)) {
    issues.push("원문에 명시된 업무 절차를 flowchart로 표현하지 않았습니다.");
  }

  if (signals.schedule.length > 0) {
    const scheduleVisuals = visuals.filter((visual) => visual.type === "timeline"
      && visual.source_ids.some((sourceId) => signals.schedule.includes(sourceId)));
    if (scheduleVisuals.length === 0) {
      issues.push("원문에 날짜가 있는 일정·마감이 있지만 timeline으로 표현하지 않았습니다.");
    } else if (!scheduleVisuals.some((visual) => visual.data.items.some((item) =>
      item.source_ids.some((sourceId) => signals.schedule.includes(sourceId))
      && visual.highlights.some((highlight) => highlight.target.item_id === item.id
        && ["critical", "important"].includes(highlight.level)
        && item.source_ids.some((sourceId) => highlight.source_ids.includes(sourceId)))))) {
      issues.push("timeline에서 핵심 일정에 critical 또는 important 강조가 없습니다.");
    }
  }

  if (signals.timeSeries && !hasTemporalLineChart(visuals, signals.periodSources)) {
    issues.push("원문에 시간 순서 수치 변화가 있지만 line_chart로 표현하지 않았습니다.");
  }
  if ((document.type === "csv" || document.type === "excel") && signals.timeSeries) {
    const hasNarrativeTrend = result.summary.some((item) => {
      const referencedPeriods = unique(item.source_ids.filter((sourceId) => {
        const sourceText = sourceMap.get(sourceId) || "";
        return getPeriodTokens(sourceText).length > 0 && numericValues(sourceText).length > 0;
      }));
      return referencedPeriods.length >= 2 && TREND_SUMMARY_PATTERN.test(item.text);
    });
    if (!hasNarrativeTrend) issues.push("시계열 수치의 전체 요약에 기간 간 변화 방향이 없습니다. 숫자 나열 대신 무엇이 어떻게 변했는지 한 문장으로 설명하세요.");
  }

  if (signals.comparison.length > 0 && !signals.timeSeries
    && !hasVisualTypeForSources(visuals, ["bar_chart", "comparison_table"], signals.comparison)) {
    issues.push("원문에 항목 간 수치 비교가 있지만 bar_chart 또는 comparison_table로 표현하지 않았습니다.");
  }

  if (document.type === "csv" || document.type === "excel") {
    for (const groupSourceIds of getCategoricalNumericGroups(document.sources)) {
      if (!hasVisualTypeForSources(visuals, ["bar_chart", "comparison_table"], groupSourceIds)) {
        issues.push("범주별 숫자 자료는 bar_chart 또는 comparison_table로 표현해야 합니다.");
      }
    }
  }

  if (signals.change.length > 0) {
    const changeVisuals = visuals.filter((visual) => ["line_chart", "bar_chart", "comparison_table"].includes(visual.type)
      && visual.source_ids.some((sourceId) => signals.change.includes(sourceId)));
    if (changeVisuals.length === 0) {
      issues.push("원문에 수치 변경이 있지만 변화에 맞는 line_chart, bar_chart 또는 comparison_table이 없습니다.");
    } else if (partialCoverage) {
      const representedChanges = signals.change.filter((sourceId) => changeVisuals.some((visual) =>
        visual.highlights.some((highlight) => ["critical", "important"].includes(highlight.level)
          && highlight.source_ids.includes(sourceId))));
      if (representedChanges.length === 0) {
        issues.push("구간의 수치 변경 중 핵심 항목을 critical 또는 important로 강조하지 않았습니다.");
      } else if (!representedChanges.some((sourceId) => changeVisuals.some((visual) =>
        visual.highlights.some((highlight) => highlight.derived && highlight.source_ids.includes(sourceId))))) {
        issues.push("강조한 수치 변경에 계산식과 원래 값이 없습니다.");
      }
    } else {
      for (const sourceId of signals.change) {
        const changeHighlights = changeVisuals.flatMap((visual) => visual.highlights.filter((highlight) =>
          ["critical", "important"].includes(highlight.level)
          && highlight.source_ids.includes(sourceId)));
        if (changeHighlights.length === 0) issues.push(`수치 변경 원본 ${sourceId}에 critical 또는 important 강조가 없습니다.`);
        else if (!changeHighlights.some((highlight) => highlight.derived)) issues.push(`수치 변경 원본 ${sourceId}에 계산식과 원래 값을 담은 derived가 없습니다.`);
      }
    }
  }

  const riskAndPrioritySources = unique([...signals.risk, ...signals.strictPriority]);
  if (partialCoverage && riskAndPrioritySources.length > 0) {
    const anyHighlighted = visuals.some((visual) => visual.highlights.some((highlight) =>
      highlight.source_ids.some((sourceId) => riskAndPrioritySources.includes(sourceId))
      && ["critical", "important"].includes(highlight.level)));
    if (!anyHighlighted) issues.push("구간의 위험·필수 항목 중 핵심 내용을 critical 또는 important로 강조하지 않았습니다.");
  } else {
    for (const sourceId of riskAndPrioritySources) {
      const highlighted = visuals.some((visual) => visual.highlights.some((highlight) =>
        highlight.source_ids.includes(sourceId) && ["critical", "important"].includes(highlight.level)));
      if (!highlighted) issues.push(`위험·필수 원본 ${sourceId}에 critical 또는 important 강조가 없습니다.`);
    }
  }

  for (const visual of visuals) {
    if (visual.type === "bar_chart" && visual.data.labels.length > 10) {
      issues.push(`${visual.title}: bar_chart는 상위 10개 항목까지만 표시해야 합니다.`);
    }
    if (visual.type === "flowchart" && !signals.process.some((sourceId) => visual.source_ids.includes(sourceId))) {
      issues.push(`${visual.title}: 원문에서 확인되지 않는 업무 절차 도식입니다.`);
    }
    if (visual.type === "timeline" && !visual.data.items.some((item) => item.source_ids.some((id) => hasDate(sourceMap.get(id) || "")))) {
      issues.push(`${visual.title}: 원문 날짜에 연결되지 않은 일정 도식입니다.`);
    }
    if (visual.type === "line_chart" && !visual.data.labels.every((label) => getPeriodTokens(String(label)).length > 0)) {
      issues.push(`${visual.title}: line_chart 축이 시간 순서를 나타내지 않습니다.`);
    }
    if (visual.type === "line_chart") {
      const temporalKeys = visual.data.labels.map(parseTemporal);
      if (temporalKeys.some((key, index) => !Number.isFinite(key) || (index > 0 && temporalKeys[index - 1] >= key))) {
        issues.push(`${visual.title}: line_chart 항목이 실제 시간순으로 정렬되지 않았습니다.`);
      }
    }
    if (visual.type === "bar_chart" && visual.data.labels.length > 1
      && visual.data.labels.every((label) => getPeriodTokens(String(label)).length > 0)) {
      issues.push(`${visual.title}: 시간 순서 자료에 bar_chart를 사용했습니다. line_chart가 필요합니다.`);
    }
  }

  return unique(issues);
}
