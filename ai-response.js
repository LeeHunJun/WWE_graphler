import {
  getAllowedHighlightSourceIds,
  getHighlightTargetSourceIds,
  getVisualDataSourceIds,
  validateHighlight,
  validateVisual,
} from "./visualization.js";
import { hasOnlySupportedNumbers, hasSupportedClaimTerms, hasSupportedNumericValue, isSupportedByEvidence, numericValues } from "./source-evidence.js";

const VISUAL_TYPES = new Set([
  "line_chart",
  "bar_chart",
  "comparison_table",
  "flowchart",
  "timeline",
  "kpi_cards",
]);

function responseError(message, diagnostic = null) {
  const error = new Error(message);
  error.name = "AiServiceError";
  error.code = "AI_RESPONSE_INVALID";
  error.diagnostic = diagnostic;
  return error;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function addSourceIds(value, ids = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => addSourceIds(item, ids));
    return ids;
  }
  if (!isRecord(value)) return ids;
  for (const [key, item] of Object.entries(value)) {
    if (key === "source_ids" && Array.isArray(item)) ids.push(...item.filter((id) => typeof id === "string"));
    else addSourceIds(item, ids);
  }
  return ids;
}

function assertKnownSourceIds(value, sourceMap, context) {
  const ids = addSourceIds(value);
  const invalid = ids.find((id) => !sourceMap.has(id));
  if (invalid) throw responseError(`${context}에 원본에 없는 source_id가 있습니다.`);
}

function inferVisualType(data) {
  if (Array.isArray(data?.series)) return "line_chart";
  if (Array.isArray(data?.labels) && Array.isArray(data?.values)) return "bar_chart";
  if (Array.isArray(data?.columns) && Array.isArray(data?.rows)) return "comparison_table";
  if (Array.isArray(data?.nodes) && Array.isArray(data?.edges)) return "flowchart";
  if (Array.isArray(data?.items)) return "timeline";
  if (Array.isArray(data?.cards)) return "kpi_cards";
  return null;
}

function getExistingIds(ids, sourceMap) {
  return Array.isArray(ids) && ids.length > 0 && ids.every((id) => typeof id === "string" && sourceMap.has(id))
    ? [...new Set(ids)]
    : [];
}

function getCitationDateTokens(text) {
  return String(text).match(/\d{4}\s*년\s*\d{1,2}\s*월(?:\s*\d{1,2}\s*일)?|\d{4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?|\bQ[1-4]\b|[1-4]\s*분기|\b\d{1,2}\s*월/gi) || [];
}

export function expandCitationSourceIds(item, sourceIds, sourceMap) {
  const result = new Set();
  const evidenceIds = [...sourceMap.entries()]
    .filter(([, source]) => source.text.includes(item.evidence))
    .map(([sourceId]) => sourceId);
  evidenceIds.forEach((sourceId) => result.add(sourceId));
  const dates = getCitationDateTokens(item.text);
  const numbers = numericValues(item.text);
  const isRangeClaim = /(최고|최저|highest|lowest|maximum|minimum|전반적|기간\s*전체|overall|trend|오르내|등락|마지막|최종|처음|first|last|higher|lower|증가|감소|상승|하락)/i.test(item.text);

  for (const [sourceId, source] of sourceMap) {
    const dateMatches = dates.some((date) => hasOnlySupportedNumbers(date, source.text));
    const valueMatches = numbers.some((number) => hasSupportedNumericValue(number, source.text)
      || hasSupportedNumericValue(Math.abs(number), source.text));
    const textMatches = hasSupportedClaimTerms(item.text, source.text);
    if (dateMatches || valueMatches || (evidenceIds.includes(sourceId) && textMatches)) result.add(sourceId);
  }

  const sheets = new Set([...result].flatMap((sourceId) => sourceId.match(/^sheet:(\d+):row:\d+$/)?.[1] || []));
  if (isRangeClaim && sheets.size > 0) {
    for (const [sourceId] of sourceMap) {
      const match = sourceId.match(/^sheet:(\d+):row:\d+$/);
      if (match && sheets.has(match[1])) result.add(sourceId);
    }
  }

  const referencedSheets = new Set();
  for (const sourceId of result) {
    const match = sourceId.match(/^(sheet:\d+):row:\d+$/);
    if (!match) continue;
    referencedSheets.add(match[1]);
  }
  const headerBySheet = new Map();
  for (const [sourceId] of sourceMap) {
    const match = sourceId.match(/^(sheet:\d+):row:(\d+)$/);
    if (!match) continue;
    const rowNumber = Number(match[2]);
    if (rowNumber < (headerBySheet.get(match[1])?.rowNumber ?? Infinity)) {
      headerBySheet.set(match[1], { rowNumber, sourceId });
    }
  }
  for (const sheet of referencedSheets) {
    const header = headerBySheet.get(sheet);
    if (header) result.add(header.sourceId);
  }

  return [...result];
}

function getPointSources(rawSources, visualSources, expectedLength, pointIndex, sourceMap) {
  const dataSources = getExistingIds(rawSources, sourceMap);
  if (dataSources.length === expectedLength) return dataSources[pointIndex] || null;
  const visualIds = getExistingIds(visualSources, sourceMap);
  if (visualIds.length === expectedLength) return visualIds[pointIndex] || null;
  return null;
}

function normalizeLineData(data, visualSources, sourceMap) {
  if (!Array.isArray(data.labels) || !Array.isArray(data.series)) return null;
  const labels = data.labels.map((label) => String(label ?? "").trim());
  if (labels.length === 0 || labels.some((label) => !label)) return null;

  const series = data.series.flatMap((candidate) => {
    if (!isRecord(candidate) || !Array.isArray(candidate.values) || !isText(candidate.name)) return [];
    const sourceArray = Array.isArray(candidate.source_ids) ? candidate.source_ids : visualSources;
    if (!Array.isArray(sourceArray) || sourceArray.length !== labels.length) return [];
    const pointCount = Math.min(labels.length, candidate.values.length, sourceArray.length);
    if (pointCount === 0) return [];
    const values = candidate.values.slice(0, pointCount);
    const source_ids = sourceArray.slice(0, pointCount);
    if (values.some((value) => value !== null && (typeof value !== "number" || !Number.isFinite(value)))
      || source_ids.some((sourceId) => typeof sourceId !== "string" || !sourceMap.has(sourceId))) return [];
    return [{
      ...candidate,
      id: isText(candidate.id) ? candidate.id : `series-${series.length + 1}`,
      name: candidate.name,
      values,
      source_ids,
    }];
  });
  if (series.length === 0) return null;

  const pointCount = Math.min(labels.length, ...series.map((item) => item.values.length));
  return {
    ...data,
    labels: labels.slice(0, pointCount),
    series: series.map((item) => ({
      ...item,
      values: item.values.slice(0, pointCount),
      source_ids: item.source_ids.slice(0, pointCount),
    })),
  };
}

function normalizeBarData(data, visualSources, sourceMap) {
  if (!Array.isArray(data.labels) || !Array.isArray(data.values)) return null;
  const count = Math.min(data.labels.length, data.values.length);
  const points = [];
  for (let index = 0; index < count; index += 1) {
    const label = String(data.labels[index] ?? "").trim();
    const value = data.values[index];
    const sourceId = getPointSources(data.source_ids, visualSources, data.labels.length, index, sourceMap);
    if (!label || !sourceId || (value !== null && (typeof value !== "number" || !Number.isFinite(value)))) continue;
    points.push({ label, value, sourceId });
  }
  if (points.length === 0) return null;
  return {
    ...data,
    labels: points.map((point) => point.label),
    values: points.map((point) => point.value),
    source_ids: points.map((point) => point.sourceId),
  };
}

function normalizeTableData(data, sourceMap) {
  if (!Array.isArray(data.columns) || !Array.isArray(data.rows)) return null;
  const columns = data.columns.filter((column) => isText(column?.key) && isText(column?.label));
  const keys = new Set(columns.map((column) => column.key));
  const rows = data.rows.flatMap((row, index) => {
    if (!isRecord(row?.cells) || ![...keys].every((key) => Object.hasOwn(row.cells, key))) return [];
    const source_ids = getExistingIds(row.source_ids, sourceMap);
    if (source_ids.length === 0) return [];
    return [{ ...row, id: isText(row.id) ? row.id : `row-${index + 1}`, source_ids }];
  });
  return columns.length > 0 && rows.length > 0 ? { ...data, columns, rows } : null;
}

function normalizeFlowData(data, sourceMap) {
  if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) return null;
  const nodes = data.nodes.flatMap((node, index) => {
    const source_ids = getExistingIds(node?.source_ids, sourceMap);
    if (!isText(node?.label) || source_ids.length === 0) return [];
    return [{ ...node, id: isText(node.id) ? node.id : `node-${index + 1}`, source_ids }];
  });
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = data.edges.filter((edge) => nodeIds.has(edge?.from) && nodeIds.has(edge?.to))
    .map((edge) => ({ ...edge, ...(Array.isArray(edge.source_ids) ? { source_ids: getExistingIds(edge.source_ids, sourceMap) } : {}) }))
    .filter((edge) => !Array.isArray(edge.source_ids) || edge.source_ids.length > 0);
  return nodes.length > 0 ? { ...data, nodes, edges } : null;
}

function normalizeTimelineData(data, sourceMap) {
  if (!Array.isArray(data.items)) return null;
  const items = data.items.flatMap((item, index) => {
    const source_ids = getExistingIds(item?.source_ids, sourceMap);
    if (item?.date === undefined || !isText(item?.label) || source_ids.length === 0) return [];
    return [{ ...item, id: isText(item.id) ? item.id : `item-${index + 1}`, source_ids }];
  });
  return items.length > 0 ? { ...data, items } : null;
}

function addDeterministicChangeDerived(visual, highlight) {
  if (highlight.derived || visual.type !== "line_chart" || !Number.isInteger(highlight.target.point_index)) return highlight;
  if (!/(증가|감소|상승|하락|변경|변화|증감|increase|decrease|decline|drop|rise|fell)/i.test(`${highlight.label} ${highlight.reason}`)) return highlight;
  const pointIndex = highlight.target.point_index;
  if (pointIndex <= 0) return highlight;
  const series = visual.data.series.find((item) => item.id === highlight.target.series_id);
  const current = series?.values[pointIndex];
  const previous = series?.values[pointIndex - 1];
  const currentSource = series?.source_ids[pointIndex];
  const previousSource = series?.source_ids[pointIndex - 1];
  if (typeof current !== "number" || typeof previous !== "number" || !currentSource || !previousSource) return highlight;

  const result = previous === 0 ? null : Number((((current - previous) / Math.abs(previous)) * 100).toFixed(2));
  return {
    ...highlight,
    source_ids: [...new Set([currentSource, previousSource, ...highlight.source_ids])],
    derived: {
      formula: "(현재 값 - 직전 값) ÷ |직전 값| × 100",
      original_values: [
        { label: `${visual.data.labels[pointIndex - 1]} ${series.name}`, value: previous },
        { label: `${visual.data.labels[pointIndex]} ${series.name}`, value: current },
      ],
      result,
    },
  };
}

function normalizeKpiData(data, sourceMap) {
  if (!Array.isArray(data.cards)) return null;
  const cards = data.cards.flatMap((card, index) => {
    const source_ids = getExistingIds(card?.source_ids, sourceMap);
    if (!isText(card?.label) || !["string", "number"].includes(typeof card?.value) || source_ids.length === 0) return [];
    return [{ ...card, id: isText(card.id) ? card.id : `card-${index + 1}`, source_ids }];
  });
  return cards.length > 0 ? { ...data, cards } : null;
}

function normalizeVisual(candidate, index, sourceMap) {
  if (!isRecord(candidate) || !isRecord(candidate.data)) return null;
  assertKnownSourceIds(candidate, sourceMap, "visual");
  const type = VISUAL_TYPES.has(candidate.type) ? candidate.type : inferVisualType(candidate.data);
  if (!type) return null;

  let data;
  if (type === "line_chart") data = normalizeLineData(candidate.data, candidate.source_ids, sourceMap);
  else if (type === "bar_chart") data = normalizeBarData(candidate.data, candidate.source_ids, sourceMap);
  else if (type === "comparison_table") data = normalizeTableData(candidate.data, sourceMap);
  else if (type === "flowchart") data = normalizeFlowData(candidate.data, sourceMap);
  else if (type === "timeline") data = normalizeTimelineData(candidate.data, sourceMap);
  else data = normalizeKpiData(candidate.data, sourceMap);
  if (!data) return null;

  const normalized = {
    ...candidate,
    id: isText(candidate.id) ? candidate.id : `ai-visual-${index + 1}`,
    type,
    title: isText(candidate.title) ? candidate.title : `문서 시각화 ${index + 1}`,
    caption: isText(candidate.caption) ? candidate.caption : "원문에서 확인된 항목을 표시합니다.",
    data,
    highlights: [],
  };
  const nestedSources = getVisualDataSourceIds(normalized);
  const originalSources = getExistingIds(candidate.source_ids, sourceMap);
  normalized.source_ids = [...new Set([...originalSources, ...nestedSources])];
  if (normalized.source_ids.length === 0) return null;

  const rawHighlights = Array.isArray(candidate.highlights) ? candidate.highlights.slice(0, 3) : [];
  normalized.highlights = rawHighlights.flatMap((highlight) => {
    if (!isRecord(highlight)) return [];
    const target = isRecord(highlight.target) ? highlight.target : null;
    if (!target) return [];
    if (Array.isArray(highlight.source_ids) && highlight.source_ids.some((id) => typeof id !== "string" || !sourceMap.has(id))) {
      throw responseError("강조 source_ids가 실제 원본 위치와 다릅니다.");
    }
    let source_ids = getExistingIds(highlight.source_ids, sourceMap);
    if (source_ids.length === 0) {
      source_ids = getHighlightTargetSourceIds(normalized, target).filter((id) => sourceMap.has(id));
      if (type === "line_chart" && highlight.derived && target.point_index > 0) {
        const series = normalized.data.series.find((item) => item.id === target.series_id);
        const previousId = series?.source_ids[target.point_index - 1];
        if (previousId && sourceMap.has(previousId)) source_ids.push(previousId);
      }
    } else {
      const targetSourceIds = getHighlightTargetSourceIds(normalized, target);
      if (targetSourceIds.some((sourceId) => !source_ids.includes(sourceId))) {
        throw responseError("강조 source_ids가 강조 대상의 원본 위치와 일치하지 않습니다.");
      }
      const allowed = new Set(getAllowedHighlightSourceIds(normalized, target, highlight.derived));
      source_ids = [...allowed].filter((sourceId) => source_ids.includes(sourceId));
    }
    const normalizedHighlight = addDeterministicChangeDerived(normalized, {
      ...highlight,
      target,
      source_ids: [...new Set(source_ids)],
      level: ["critical", "important", "info"].includes(highlight.level) ? highlight.level : "info",
      label: isText(highlight.label) ? highlight.label : "원문에서 확인된 항목",
      reason: isText(highlight.reason) ? highlight.reason : "원문에서 확인할 수 있는 내용입니다.",
      derived: Object.hasOwn(highlight, "derived") ? highlight.derived : null,
    });
    const highlightIssue = validateHighlight(normalized, normalizedHighlight);
    if (highlightIssue && Array.isArray(highlight.source_ids) && highlight.source_ids.length > 0) {
      throw responseError(highlightIssue);
    }
    return highlightIssue ? [] : [normalizedHighlight];
  });

  return validateVisual(normalized) ? null : normalized;
}

function findBalancedJsonCandidates(text) {
  const candidates = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          candidates.push(text.slice(start, index + 1));
          start = index;
          break;
        }
      }
    }
  }
  return candidates;
}

export function parseJsonObject(content) {
  const raw = String(content || "").replace(/^\uFEFF/, "").trim();
  const candidates = [raw, ...findBalancedJsonCandidates(raw)];
  let fallback = null;
  for (const candidate of new Set(candidates)) {
    try {
      const parsed = JSON.parse(candidate.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
      if (!isRecord(parsed)) continue;
      if (isRecord(parsed.spec) || Array.isArray(parsed.summary) || Array.isArray(parsed.key_points)) return parsed;
      fallback ||= parsed;
    } catch {
      // Try the next balanced object, which may be the JSON after a prose prefix.
    }
  }
  if (fallback) return fallback;
  throw responseError(raw ? "AI 응답에서 완전한 JSON 객체를 찾지 못했습니다." : "AI 응답이 비어 있습니다.", {
    stage: raw ? "json_extract" : "empty_content",
    raw_response: raw,
    response_length: raw.length,
  });
}

function normalizeEvidenceSpacing(value) {
  return String(value).normalize("NFKC").replace(/\s*\|\s*/g, "|").replace(/\s+/g, " ").trim().toLocaleLowerCase("ko");
}

function findEvidenceSource(fragment, sourceMap) {
  const exact = [...sourceMap.entries()].find(([, source]) => source.text.includes(fragment));
  if (exact) return exact;
  const normalizedFragment = normalizeEvidenceSpacing(fragment);
  return [...sourceMap.entries()].find(([, source]) => normalizeEvidenceSpacing(source.text).includes(normalizedFragment));
}

function resolveExactEvidence(evidence, sourceMap) {
  const direct = findEvidenceSource(evidence, sourceMap);
  if (direct) return { evidence: evidence === direct[1].text ? evidence : direct[1].text, source_ids: [direct[0]] };

  const fragments = evidence.split(/\r?\n|;\s*/).map((fragment) => fragment.trim()).filter(Boolean);
  if (fragments.length < 2) return null;
  const matches = fragments.map((fragment) => findEvidenceSource(fragment, sourceMap));
  if (matches.some((match) => !match)) return null;
  return {
    evidence: matches[0][1].text,
    source_ids: [...new Set(matches.map(([sourceId]) => sourceId))],
  };
}

function normalizeCitationItems(candidate, maximum, sourceMap, maxTextLength = Infinity) {
  if (!Array.isArray(candidate)) return [];
  return candidate.slice(0, maximum).flatMap((item) => {
    if (!isRecord(item) || !isText(item.text) || [...item.text].length > maxTextLength || !isText(item.evidence)) return [];
    if (Array.isArray(item.source_ids) && item.source_ids.some((id) => typeof id !== "string" || !sourceMap.has(id))) {
      throw responseError("summary 또는 key_points가 실제 원본에 없는 source_id를 참조합니다.");
    }
    const exactEvidence = resolveExactEvidence(item.evidence, sourceMap);
    if (!exactEvidence) throw responseError("summary 또는 key_points의 evidence가 원문에서 그대로 확인되지 않습니다.");
    let source_ids = getExistingIds(item.source_ids, sourceMap);
    if (!Array.isArray(item.source_ids) || item.source_ids.length === 0) {
      source_ids = exactEvidence.source_ids;
    }
    source_ids = expandCitationSourceIds(item, [...new Set([...source_ids, ...exactEvidence.source_ids])], sourceMap);
    source_ids = [...new Set(source_ids)];
    if (source_ids.length === 0) return [];
    const normalized = { text: item.text, evidence: exactEvidence.evidence, source_ids };
    if (!isSupportedByEvidence(normalized, sourceMap)) {
      throw responseError("summary 또는 key_points의 원문 근거·숫자·방향이 일치하지 않습니다.");
    }
    return [normalized];
  });
}

export function normalizeAiEnvelope(parsed, sourceMap) {
  if (!isRecord(parsed)) throw responseError("최상위 응답이 JSON 객체가 아닙니다.");
  const summary = normalizeCitationItems(parsed.summary, 2, sourceMap);
  const key_points = normalizeCitationItems(parsed.key_points, 5, sourceMap, 60);
  const rawSpec = isRecord(parsed.spec) ? parsed.spec : null;
  const rawStatus = rawSpec?.status;
  if (!rawSpec) throw responseError("spec 객체가 없습니다.");

  if (!new Set(["ok", "insufficient_data"]).has(rawStatus)) {
    return {
      summary: [],
      key_points: [],
      spec: {
        status: "insufficient_data",
        message: "AI 응답에서 분석 상태를 확인할 수 없어 결과를 보류했습니다.",
        visuals: [],
      },
    };
  }

  if (rawStatus === "insufficient_data") {
    return {
      summary: [],
      key_points: [],
      spec: {
        status: "insufficient_data",
        message: isText(rawSpec.message) ? rawSpec.message : "제공된 자료만으로는 알 수 없어요.",
        visuals: [],
      },
    };
  }

  const rawVisuals = Array.isArray(rawSpec.visuals) ? rawSpec.visuals : [];
  const visuals = rawVisuals.map((visual, index) => normalizeVisual(visual, index, sourceMap)).filter(Boolean);
  const normalizedSummary = summary.length > 0 ? summary : [];
  const status = normalizedSummary.length === 0 && visuals.length === 0 ? "insufficient_data" : "ok";

  return {
    summary: status === "ok" ? normalizedSummary : [],
    key_points: status === "ok" ? key_points : [],
    spec: {
      status,
      message: isText(rawSpec.message) ? rawSpec.message : status === "ok" ? "원문에서 확인된 내용을 정리했습니다." : "제공된 자료만으로는 알 수 없어요.",
      visuals: status === "ok" ? visuals : [],
    },
  };
}
