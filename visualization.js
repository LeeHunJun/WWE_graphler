import Chart from "chart.js/auto";
import { parseNumber, parseTemporal } from "./value-parsing.js";
import { INSIGHT_LEVEL_LABELS, sortInsightsByPriority } from "./insight-priority.js";
import { explainHighlight } from "./highlight-explain.js";
import { analyzeDrivers, buildDriverVisualSpec } from "./driver-analysis.js";

export { parseTemporal };

const VISUAL_TYPES = new Set([
  "line_chart",
  "bar_chart",
  "comparison_table",
  "flowchart",
  "timeline",
  "kpi_cards",
]);
const HIGHLIGHT_LEVELS = new Set(["critical", "important", "info"]);
const LEVEL_COLORS = { critical: "#c75850", important: "#db923f", info: "#89928b" };
const CHART_COLORS = ["#5f8d66", "#5d7dbb", "#cb8b48", "#8b78ae"];
const chartInstances = new WeakMap();

function sourceIdForRow(sheetIndex, sheet, rowIndex) {
  const rowNumber = sheet.rowNumbers?.[rowIndex] ?? rowIndex + 1;
  return `sheet:${sheetIndex}:row:${rowNumber}`;
}

function formatNumber(value, unit = "") {
  if (value === null || value === undefined) return "비어 있음";
  const formatted = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 2 }).format(value);
  return unit === "%" ? `${formatted}%` : unit ? `${formatted}${unit}` : formatted;
}

function getColumnUnit(header) {
  const match = String(header).match(/\(([^)]+)\)|\[([^\]]+)\]/);
  return match?.[1]?.trim() || match?.[2]?.trim() || "";
}

// 0/1, 1·2·3 같은 숫자 열은 머리글이 날짜·기간을 뜻할 때만 시간 축으로 본다(예: 생존 0/1을 연도로 오인하지 않게).
const TEMPORAL_HEADER_HINT = /날짜|일자|월|기간|연도|년|date|month|period|year|quarter|분기|주차|week/i;

function getAxisColumn(rows, columnCount) {
  for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
    const values = rows.slice(1).map((row) => String(row[columnIndex] ?? "").trim()).filter(Boolean);
    if (values.length === 0) continue;

    const header = String(rows[0]?.[columnIndex] ?? "").trim();
    const allNumeric = values.every((value) => parseNumber(value) !== null);
    if (values.every((value) => parseTemporal(value) !== null) && (!allNumeric || TEMPORAL_HEADER_HINT.test(header))) {
      return { index: columnIndex, temporal: true };
    }
    if (values.some((value) => parseNumber(value) === null)) return { index: columnIndex, temporal: false };
  }

  return null;
}

function getSheetRows(sheet, sheetIndex, axisIndex) {
  return sheet.rows.slice(1).flatMap((cells, rowOffset) => {
    if (!cells.some((cell) => String(cell ?? "").trim())) return [];
    const rowIndex = rowOffset + 1;
    const rawLabel = String(cells[axisIndex] ?? "").trim();
    const rowNumber = sheet.rowNumbers?.[rowIndex] ?? rowIndex + 1;
    return [{
      rowIndex,
      rowNumber,
      sourceId: sourceIdForRow(sheetIndex, sheet, rowIndex),
      label: rawLabel || `행 ${rowNumber}`,
      timeKey: parseTemporal(rawLabel),
      cells,
    }];
  });
}

function getNumericColumns(sheet, axisIndex) {
  const columnCount = sheet.columnCount || sheet.rows.reduce((maximum, row) => Math.max(maximum, row.length), 0);
  const columns = [];

  for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
    if (columnIndex === axisIndex) continue;
    const values = sheet.rows.slice(1).map((row) => parseNumber(row[columnIndex]));
    if (!values.some((value) => value !== null)) continue;
    const header = String(sheet.rows[0]?.[columnIndex] ?? `열 ${columnIndex + 1}`).trim() || `열 ${columnIndex + 1}`;
    columns.push({
      index: columnIndex,
      id: `series-${columnIndex}`,
      name: header,
      unit: getColumnUnit(header),
      values,
      weight: values.reduce((total, value) => total + Math.abs(value ?? 0), 0),
    });
  }

  return columns;
}

function getSeriesValueAtRow(series, rowOffset) {
  return series.values[rowOffset] ?? null;
}

function findExtrema(observations) {
  const values = observations.filter((item) => item.value !== null);
  if (values.length === 0) return { maximum: null, minimum: null };
  return {
    maximum: values.reduce((best, item) => item.value > best.value ? item : best),
    minimum: values.reduce((best, item) => item.value < best.value ? item : best),
  };
}

function findLargestDrop(seriesEntries, points, labels, pointIndexByRow) {
  let largestDrop = null;

  seriesEntries.forEach((series) => {
    for (let index = 1; index < points.length; index += 1) {
      const previousValue = getSeriesValueAtRow(series.column, points[index - 1].rowOffset);
      const currentValue = getSeriesValueAtRow(series.column, points[index].rowOffset);
      if (previousValue === null || currentValue === null || currentValue >= previousValue) continue;

      const visualIndex = pointIndexByRow.get(points[index].sourceId);
      if (visualIndex === undefined) continue;
      const decrease = previousValue - currentValue;
      if (!largestDrop || decrease > largestDrop.decrease) {
        largestDrop = {
          seriesId: series.id,
          seriesName: series.name,
          visualIndex,
          previousValue,
          currentValue,
          previousLabel: points[index - 1].label,
          currentLabel: points[index].label,
          previousSourceId: points[index - 1].sourceId,
          currentSourceId: points[index].sourceId,
          decrease,
          unit: series.column.unit || "",
        };
      }
    }
  });

  return largestDrop;
}

function createAutoHighlights(seriesEntries, points, labels, pointIndexByRow, unit = "") {
  const observations = [];
  seriesEntries.forEach((series) => {
    points.forEach((point) => {
      const visualIndex = pointIndexByRow.get(point.sourceId);
      const value = getSeriesValueAtRow(series.column, point.rowOffset);
      if (value !== null && visualIndex !== undefined) {
        observations.push({
          value,
          label: point.label,
          sourceId: point.sourceId,
          visualIndex,
          seriesId: series.id,
          seriesName: series.name,
          unit: series.column.unit || "",
        });
      }
    });
  });

  const { maximum, minimum } = findExtrema(observations);
  const drop = findLargestDrop(seriesEntries, points, labels, pointIndexByRow);
  const highlights = [];

  if (drop) {
    const percent = drop.previousValue === 0
      ? null
      : Number((((drop.currentValue - drop.previousValue) / Math.abs(drop.previousValue)) * 100).toFixed(2));
    highlights.push({
      target: { series_id: drop.seriesId, point_index: drop.visualIndex },
      level: "critical",
      label: `하락 ${formatNumber(drop.currentValue, drop.unit)}`,
      reason: `${drop.previousLabel}에서 ${drop.currentLabel}로 ${drop.seriesName}이 가장 크게 줄었습니다${percent === null ? "" : ` (${Math.abs(percent)}% 감소)`}.`,
      source_ids: [drop.currentSourceId, drop.previousSourceId],
      derived: {
        formula: "(현재 값 - 직전 값) ÷ |직전 값| × 100",
        original_values: [
          { label: `${drop.previousLabel} ${drop.seriesName}`, value: drop.previousValue },
          { label: `${drop.currentLabel} ${drop.seriesName}`, value: drop.currentValue },
        ],
        result: percent,
      },
    });
  }

  [
    { observation: maximum, label: "최고", reason: "이 시각화에서 가장 높은 수치입니다." },
    { observation: minimum, label: "최저", reason: "이 시각화에서 가장 낮은 수치입니다." },
  ].forEach(({ observation, label, reason }) => {
    if (!observation || highlights.length >= 3) return;
    const isDuplicateTarget = highlights.some((highlight) => {
      const target = highlight.target;
      return target.point_index === observation.visualIndex && (target.series_id || "") === (observation.seriesId || "");
    });
    if (isDuplicateTarget) return;

    highlights.push({
      target: { series_id: observation.seriesId, point_index: observation.visualIndex },
      level: "important",
      label: `${label} ${formatNumber(observation.value, observation.unit)}`,
      reason: `${reason} 해당 값은 ${formatNumber(observation.value, observation.unit)}입니다.`,
      source_ids: [observation.sourceId],
      derived: null,
    });
  });

  return highlights.slice(0, 3);
}

function createCaption(points, seriesEntries, unit) {
  const primary = seriesEntries[0];
  if (!primary) return "수치 데이터를 표시합니다.";

  let currentIndex = -1;
  for (let index = points.length - 1; index >= 0; index -= 1) {
    if (getSeriesValueAtRow(primary.column, points[index].rowOffset) !== null) {
      currentIndex = index;
      break;
    }
  }
  if (currentIndex < 0) return `${primary.name}에 표시할 수 있는 수치가 없습니다.`;

  const current = points[currentIndex];
  const currentValue = getSeriesValueAtRow(primary.column, current.rowOffset);
  let previousIndex = currentIndex - 1;
  while (previousIndex >= 0 && getSeriesValueAtRow(primary.column, points[previousIndex].rowOffset) === null) previousIndex -= 1;
  if (previousIndex < 0) return `${current.label} ${primary.name}은 ${formatNumber(currentValue, unit)}입니다.`;

  const previous = points[previousIndex];
  const previousValue = getSeriesValueAtRow(primary.column, previous.rowOffset);
  const difference = currentValue - previousValue;
  const percent = previousValue === 0 ? null : Math.abs((difference / Math.abs(previousValue)) * 100);
  if (difference === 0) return `${current.label} ${primary.name}은 전기와 같은 ${formatNumber(currentValue, unit)}입니다.`;
  const rate = percent === null
    ? ""
    : `${new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 }).format(percent)}% `;
  const direction = difference > 0 ? "증가" : "감소";
  return `${previous.label}보다 ${current.label} ${primary.name}이 ${rate}${direction}해 현재 ${formatNumber(currentValue, unit)}입니다.`;
}

function createAutoVisual(sheet, sheetIndex, axis, numericColumns) {
  const allPoints = getSheetRows(sheet, sheetIndex, axis.index)
    .map((point) => ({ ...point, rowOffset: point.rowIndex - 1 }));
  const points = axis.temporal
    ? [...allPoints].sort((first, second) => first.timeKey - second.timeKey)
    : allPoints;

  if (axis.temporal) {
    const selectedColumns = [...numericColumns].sort((first, second) => second.weight - first.weight).slice(0, 4);
    const series = selectedColumns.map((column) => ({
      id: column.id,
      name: column.name,
      values: points.map((point) => getSeriesValueAtRow(column, point.rowOffset)),
      source_ids: points.map((point) => point.sourceId),
      unit: column.unit,
    }));
    const labels = points.map((point) => point.label);
    const pointIndexByRow = new Map(points.map((point, index) => [point.sourceId, index]));
    const primaryUnit = selectedColumns[0]?.unit || "";
    const visual = {
      id: `auto-sheet-${sheetIndex}-line`,
      type: "line_chart",
      title: `${sheet.name} · ${selectedColumns.length > 1 ? "수치 추이" : selectedColumns[0]?.name || "수치 추이"}`,
      caption: createCaption(points, selectedColumns.map((column) => ({ id: column.id, name: column.name, column })), primaryUnit),
      source_ids: [...new Set(points.map((point) => point.sourceId))],
      data: {
        labels,
        series,
        unit: primaryUnit,
        ...(numericColumns.length > 4 ? { note: "수치 열이 많아 합계가 큰 상위 4개 선만 표시했습니다." } : {}),
      },
      highlights: createAutoHighlights(
        selectedColumns.map((column) => ({ id: column.id, name: column.name, column })),
        points,
        labels,
        pointIndexByRow,
        primaryUnit,
      ),
    };
    return [visual];
  }

  return numericColumns.map((column) => {
    let visiblePoints = points.map((point) => ({ ...point, value: getSeriesValueAtRow(column, point.rowOffset) }));
    const wasTruncated = visiblePoints.length > 10;
    if (wasTruncated) {
      visiblePoints = [...visiblePoints]
        .sort((first, second) => (second.value ?? -Infinity) - (first.value ?? -Infinity))
        .slice(0, 10);
    }

    const labels = visiblePoints.map((point) => point.label);
    const values = visiblePoints.map((point) => point.value);
    const sourceIds = visiblePoints.map((point) => point.sourceId);
    const pointIndexByRow = new Map(visiblePoints.map((point, index) => [point.sourceId, index]));
    const series = [{ id: column.id, name: column.name, column }];
    const caption = wasTruncated
      ? `상위 10개만 표시하며, 최고 항목은 ${labels[0]} (${formatNumber(values[0], column.unit)})입니다.`
      : createCaption(visiblePoints.map((point, index) => ({ ...point, rowOffset: points.find((row) => row.sourceId === point.sourceId)?.rowOffset ?? index })), series, column.unit);

    return {
      id: `auto-sheet-${sheetIndex}-bar-${column.index}`,
      type: "bar_chart",
      title: `${sheet.name} · ${column.name}`,
      caption,
      source_ids: [...new Set(sourceIds)],
      data: {
        labels,
        values,
        source_ids: sourceIds,
        series_name: column.name,
        unit: column.unit,
        ...(wasTruncated ? { note: "상위 10개만 표시했습니다." } : {}),
      },
      highlights: createAutoHighlights(
        series,
        points,
        labels,
        pointIndexByRow,
        column.unit,
      ),
    };
  });
}

// 기록형 표(승객·고객 목록처럼 같은 항목 값이 여러 행에 반복되는 표)는 행마다 선을 긋지 않고 요인 비교 그래프로 보여 준다.
function isRecordTable(sheet, axis) {
  if (axis.temporal) return false;
  const labels = sheet.rows.slice(1).map((row) => String(row[axis.index] ?? "").trim()).filter(Boolean);
  return labels.length >= 20 && new Set(labels).size < labels.length * 0.5;
}

function createRecordVisuals(record, sheetIndex) {
  try {
    const result = analyzeDrivers(record, { sheetIndex });
    if (result?.status !== "ok") return [];
    return buildDriverVisualSpec(result, record).visuals.map((visual) => ({ ...visual, id: `auto-sheet-${sheetIndex}-${visual.id}` }));
  } catch {
    return [];
  }
}

// 자동 그래프가 '항목별 막대'가 아니라 '요인 비교'로 그려지는 기록형 표인지(같은 항목 이름이 여러 행에 반복되는 표).
export function isRecordSheet(sheet) {
  if (!sheet || !Array.isArray(sheet.rows) || sheet.rows.length < 2) return false;
  const axis = getAxisColumn(sheet.rows, sheet.columnCount);
  return Boolean(axis) && isRecordTable(sheet, axis);
}

// 표의 항목 이름 열(가로축으로 쓰는 열) 위치. 없으면 -1.
export function getLabelColumnIndex(sheet) {
  if (!sheet || !Array.isArray(sheet.rows) || sheet.rows.length < 2) return -1;
  return getAxisColumn(sheet.rows, sheet.columnCount)?.index ?? -1;
}

// 질문에 답할 때 쓰는, 고른 숫자 열만 담은 그래프(시간 축이면 선, 아니면 막대).
export function buildColumnVisuals(record, sheetIndex, columnIndexes) {
  const sheet = record?.sheets?.[sheetIndex];
  if (!sheet || !Array.isArray(sheet.rows) || sheet.rows.length < 2) return [];
  const axis = getAxisColumn(sheet.rows, sheet.columnCount);
  if (!axis) return [];
  const wanted = new Set(columnIndexes);
  const columns = getNumericColumns(sheet, axis.index).filter((column) => wanted.has(column.index));
  if (columns.length === 0) return [];
  return createAutoVisual(sheet, sheetIndex, axis, columns.slice(0, 4))
    .map((visual) => ({ ...visual, id: visual.id.replace(/^auto-/, "question-") }));
}

export function buildSpreadsheetVisualizationSpec(record) {
  const visuals = [];
  let hasNumericColumn = false;

  (record.sheets || []).forEach((sheet, sheetIndex) => {
    if (!Array.isArray(sheet.rows) || sheet.rows.length < 2) return;
    const axis = getAxisColumn(sheet.rows, sheet.columnCount);
    if (!axis) return;
    const numericColumns = getNumericColumns(sheet, axis.index);
    if (numericColumns.length === 0) return;
    hasNumericColumn = true;
    if (isRecordTable(sheet, axis)) {
      const recordVisuals = createRecordVisuals(record, sheetIndex);
      if (recordVisuals.length > 0) {
        visuals.push(...recordVisuals);
        return;
      }
    }
    visuals.push(...createAutoVisual(sheet, sheetIndex, axis, numericColumns));
  });

  if (!hasNumericColumn) {
    return {
      status: "ok",
      message: "수치 데이터가 없어 그래프를 만들 수 없습니다",
      visuals: [],
    };
  }

  return {
    status: "ok",
    message: "표의 첫 번째 항목 열과 숫자 열을 바탕으로 시각화를 만들었습니다.",
    visuals,
  };
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isSourceIdArray(value, { allowEmpty = true } = {}) {
  return Array.isArray(value)
    && (allowEmpty || value.length > 0)
    && value.every((sourceId) => isText(sourceId));
}

function isNumberOrNull(value) {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

export function validateVisual(visual) {
  if (!isRecord(visual)) return "시각화 항목이 객체가 아닙니다.";
  if (!isText(visual.id)) return "시각화 id가 없습니다.";
  if (!VISUAL_TYPES.has(visual.type)) return `지원하지 않는 유형입니다: ${String(visual.type)}`;
  if (!isText(visual.title)) return "시각화 제목이 없습니다.";
  if (!isText(visual.caption)) return "한 문장 설명(caption)이 없습니다.";
  if (!isSourceIdArray(visual.source_ids)) return "visual.source_ids는 문자열 배열이어야 합니다.";
  if (!Array.isArray(visual.highlights)) return "highlights 배열이 없습니다.";
  if (visual.highlights.length > 3) return "highlights는 시각화 하나에 최대 3개입니다.";
  if (!isRecord(visual.data)) return "data 객체가 없습니다.";

  const data = visual.data;
  if (visual.type === "line_chart") {
    if (!Array.isArray(data.labels) || data.labels.length === 0) return "line_chart labels가 비어 있습니다.";
    if (!Array.isArray(data.series) || data.series.length === 0 || data.series.length > 4) return "line_chart는 1~4개 series가 필요합니다.";
    if (data.labels.some((label) => label === null || label === undefined || !isText(String(label)))) return "line_chart labels에 빈 항목이 있습니다.";
    for (const series of data.series) {
      if (!isText(series?.id) || !isText(series?.name)) return "line_chart series id 또는 name이 없습니다.";
      if (!Array.isArray(series.values) || series.values.length !== data.labels.length) return "line_chart 값 개수와 항목 개수가 다릅니다.";
      if (!series.values.every(isNumberOrNull)) return "line_chart 값은 숫자 또는 null이어야 합니다.";
      if (!Array.isArray(series.source_ids) || series.source_ids.length !== data.labels.length) return "line_chart source_ids 개수와 항목 개수가 다릅니다.";
      if (!series.source_ids.every((sourceId) => sourceId === null || isText(sourceId))) return "line_chart source_ids 형식이 올바르지 않습니다.";
    }
    return null;
  }

  if (visual.type === "bar_chart") {
    if (!Array.isArray(data.labels) || data.labels.length === 0) return "bar_chart labels가 비어 있습니다.";
    if (data.labels.some((label) => label === null || label === undefined || !isText(String(label)))) return "bar_chart labels에 빈 항목이 있습니다.";
    if (!Array.isArray(data.values) || data.values.length !== data.labels.length) return "bar_chart 값 개수와 항목 개수가 다릅니다.";
    if (!data.values.every(isNumberOrNull)) return "bar_chart 값은 숫자 또는 null이어야 합니다.";
    if (!Array.isArray(data.source_ids) || data.source_ids.length !== data.labels.length) return "bar_chart source_ids 개수와 항목 개수가 다릅니다.";
    if (!data.source_ids.every((sourceId) => sourceId === null || isText(sourceId))) return "bar_chart source_ids 형식이 올바르지 않습니다.";
    return null;
  }

  if (visual.type === "comparison_table") {
    if (!Array.isArray(data.columns) || data.columns.length === 0) return "comparison_table columns가 비어 있습니다.";
    if (!Array.isArray(data.rows) || data.rows.length === 0) return "comparison_table rows가 비어 있습니다.";
    const keys = new Set();
    for (const column of data.columns) {
      if (!isText(column?.key) || !isText(column?.label) || keys.has(column.key)) return "comparison_table column key 또는 label이 올바르지 않습니다.";
      keys.add(column.key);
    }
    for (const row of data.rows) {
      if (!isText(row?.id) || !isRecord(row.cells) || !isSourceIdArray(row.source_ids)) return "comparison_table row에 id, cells 또는 source_ids가 없습니다.";
      if ([...keys].some((key) => !Object.hasOwn(row.cells, key))) return "comparison_table 행에 필수 셀이 없습니다.";
    }
    return null;
  }

  if (visual.type === "flowchart") {
    if (!Array.isArray(data.nodes) || data.nodes.length === 0) return "flowchart nodes가 비어 있습니다.";
    if (!Array.isArray(data.edges)) return "flowchart edges 배열이 없습니다.";
    const ids = new Set();
    for (const node of data.nodes) {
      if (!isText(node?.id) || !isText(node?.label) || !isSourceIdArray(node.source_ids)) return "flowchart node에 id, label 또는 source_ids가 없습니다.";
      if (ids.has(node.id)) return "flowchart node id가 중복되었습니다.";
      ids.add(node.id);
    }
    if (data.edges.some((edge) => !ids.has(edge?.from)
      || !ids.has(edge?.to)
      || (edge.label !== undefined && typeof edge.label !== "string")
      || (edge.source_ids !== undefined && !isSourceIdArray(edge.source_ids)))) {
      return "flowchart edge가 존재하지 않는 node를 가리키거나 값 형식이 올바르지 않습니다.";
    }
    return null;
  }

  if (visual.type === "timeline") {
    if (!Array.isArray(data.items) || data.items.length === 0) return "timeline items가 비어 있습니다.";
    if (data.items.some((item) => !isText(item?.id) || !isText(item?.label) || !isText(String(item?.date ?? "")) || !isSourceIdArray(item.source_ids))) {
      return "timeline item에 id, date, label 또는 source_ids가 없습니다.";
    }
    if (new Set(data.items.map((item) => item.id)).size !== data.items.length) return "timeline item id가 중복되었습니다.";
    return null;
  }

  if (!Array.isArray(data.cards) || data.cards.length === 0) return "kpi_cards cards가 비어 있습니다.";
  if (data.cards.some((card) => !isText(card?.id) || !isText(card?.label) || !["string", "number"].includes(typeof card?.value) || !isSourceIdArray(card.source_ids))) {
    return "kpi_cards 항목에 id, label, value 또는 source_ids가 없습니다.";
  }
  return null;
}

export function getSourceLookup(sourceDocument) {
  const lookup = new Map();
  if (!sourceDocument) return lookup;

  if (sourceDocument.type === "pdf") {
    (sourceDocument.pages || []).forEach((page) => {
      lookup.set(`pdf:page:${page.pageNumber}`, {
        type: "pdf",
        pageNumber: page.pageNumber,
        label: `PDF ${page.pageNumber}페이지`,
        text: page.text,
      });
    });
    return lookup;
  }

  (sourceDocument.sheets || []).forEach((sheet, sheetIndex) => {
    (sheet.rows || []).forEach((_, rowIndex) => {
      const rowNumber = sheet.rowNumbers?.[rowIndex] ?? rowIndex + 1;
      lookup.set(`sheet:${sheetIndex}:row:${rowNumber}`, {
        type: "sheet",
        sheetIndex,
        rowIndex,
        rowNumber,
        sheetName: sheet.name,
        label: `${sheet.name} ${rowNumber}행`,
        text: (sheet.rows[rowIndex] || []).join(" | "),
      });
    });
  });
  return lookup;
}

function hasHighlightTarget(visual, target) {
  const data = visual.data;
  if (visual.type === "line_chart") {
    return Number.isInteger(target.point_index)
      && target.point_index >= 0
      && target.point_index < data.labels.length
      && data.series.some((series) => series.id === target.series_id);
  }
  if (visual.type === "bar_chart") {
    return Number.isInteger(target.point_index)
      && target.point_index >= 0
      && target.point_index < data.labels.length;
  }
  if (visual.type === "comparison_table") {
    return data.rows.some((row) => row.id === target.row_id)
      && (target.column_key === undefined || data.columns.some((column) => column.key === target.column_key));
  }
  if (visual.type === "flowchart") {
    if (target.node_id) return data.nodes.some((node) => node.id === target.node_id);
    return data.edges.some((edge) => edge.from === target.edge_from && edge.to === target.edge_to);
  }
  if (visual.type === "timeline") return data.items.some((item) => item.id === target.item_id);
  return data.cards.some((card) => card.id === target.card_id);
}

function validateDerived(derived) {
  if (derived === null) return true;
  return isRecord(derived)
    && isText(derived.formula)
    && Array.isArray(derived.original_values)
    && derived.original_values.every((item) => isText(item?.label) && (isNumberOrNull(item.value) || typeof item.value === "string"))
    && (derived.result === null || (typeof derived.result === "number" && Number.isFinite(derived.result)));
}

export function getHighlightTargetSourceIds(visual, target) {
  const data = visual.data;
  if (visual.type === "line_chart") {
    const series = data.series.find((item) => item.id === target.series_id);
    if (!series || series.values[target.point_index] === null) return [];
    return [series.source_ids[target.point_index]].filter(isText);
  }
  if (visual.type === "bar_chart") {
    if (data.values[target.point_index] === null) return [];
    return [data.source_ids[target.point_index]].filter(isText);
  }
  if (visual.type === "comparison_table") {
    return data.rows.find((row) => row.id === target.row_id)?.source_ids || [];
  }
  if (visual.type === "flowchart") {
    if (target.node_id) return data.nodes.find((node) => node.id === target.node_id)?.source_ids || [];
    return data.edges.find((edge) => edge.from === target.edge_from && edge.to === target.edge_to)?.source_ids || [];
  }
  if (visual.type === "timeline") return data.items.find((item) => item.id === target.item_id)?.source_ids || [];
  return data.cards.find((card) => card.id === target.card_id)?.source_ids || [];
}

export function getAllowedHighlightSourceIds(visual, target, derived) {
  const targetSourceIds = getHighlightTargetSourceIds(visual, target);
  const allowed = new Set(targetSourceIds);
  if (visual.type === "line_chart" && derived && target.point_index > 0) {
    const series = visual.data.series.find((item) => item.id === target.series_id);
    const previousSourceId = series?.source_ids[target.point_index - 1];
    if (isText(previousSourceId)) allowed.add(previousSourceId);
  }
  getVisualHeaderSourceIds(visual).forEach((sourceId) => allowed.add(sourceId));
  if (visual.type === "bar_chart" && derived) {
    const targetSheet = targetSourceIds[0]?.match(/^(sheet:\d+):row:\d+$/)?.[1];
    visual.source_ids.forEach((sourceId) => {
      if (targetSheet && sourceId.startsWith(`${targetSheet}:row:`)) allowed.add(sourceId);
    });
  }
  return [...allowed];
}

export function getVisualDataSourceIds(visual) {
  const data = visual.data;
  if (visual.type === "line_chart") return data.series.flatMap((series) => series.source_ids.filter(isText));
  if (visual.type === "bar_chart") return data.source_ids.filter(isText);
  if (visual.type === "comparison_table") return data.rows.flatMap((row) => row.source_ids);
  if (visual.type === "flowchart") return [
    ...data.nodes.flatMap((node) => node.source_ids),
    ...data.edges.flatMap((edge) => edge.source_ids || []),
  ];
  if (visual.type === "timeline") return data.items.flatMap((item) => item.source_ids);
  return data.cards.flatMap((card) => card.source_ids);
}

function getVisualHeaderSourceIds(visual) {
  const dataSourceIds = new Set(getVisualDataSourceIds(visual));
  const minimumRows = new Map();
  for (const sourceId of dataSourceIds) {
    const match = sourceId.match(/^sheet:(\d+):row:(\d+)$/);
    if (!match) continue;
    const sheetIndex = Number(match[1]);
    const rowNumber = Number(match[2]);
    minimumRows.set(sheetIndex, Math.min(minimumRows.get(sheetIndex) ?? Infinity, rowNumber));
  }

  return visual.source_ids.filter((sourceId) => {
    if (dataSourceIds.has(sourceId)) return false;
    const match = sourceId.match(/^sheet:(\d+):row:(\d+)$/);
    if (!match) return false;
    const firstDataRow = minimumRows.get(Number(match[1]));
    return firstDataRow !== undefined && Number(match[2]) < firstDataRow;
  });
}

export function getHighlightIdentity(visual, target) {
  if (visual.type === "line_chart") return `line:${target.series_id}:${target.point_index}`;
  if (visual.type === "bar_chart") return `bar:${target.point_index}`;
  if (visual.type === "comparison_table") return `table:${target.row_id}:${target.column_key || ""}`;
  if (visual.type === "flowchart") return target.node_id
    ? `flow-node:${target.node_id}`
    : `flow-edge:${target.edge_from}:${target.edge_to}`;
  if (visual.type === "timeline") return `timeline:${target.item_id}`;
  return `kpi:${target.card_id}`;
}

export function validateHighlight(visual, highlight) {
  if (!isRecord(highlight)
    || !isRecord(highlight.target)
    || !HIGHLIGHT_LEVELS.has(highlight.level)
    || !isText(highlight.label)
    || !isText(highlight.reason)
    || !isSourceIdArray(highlight.source_ids, { allowEmpty: false })
    || !Object.hasOwn(highlight, "derived")
    || !validateDerived(highlight.derived)) {
    return "강조 명세에 필수 값이 없습니다.";
  }
  if (!hasHighlightTarget(visual, highlight.target)) return "강조 대상이 시각화 자료와 맞지 않습니다.";

  const targetSourceIds = getHighlightTargetSourceIds(visual, highlight.target);
  const allowedSourceIds = new Set(getAllowedHighlightSourceIds(visual, highlight.target, highlight.derived));
  if (targetSourceIds.length === 0
    || targetSourceIds.some((sourceId) => !highlight.source_ids.includes(sourceId))
    || highlight.source_ids.some((sourceId) => !allowedSourceIds.has(sourceId))) {
    return "강조 source_ids가 대상 점·행·일정·노드와 맞지 않습니다.";
  }

  if (highlight.derived) {
    const originalValues = highlight.derived.original_values.map((item) => item.value);
    const isPercentChange = /(?:직전|이전|before).*(?:현재|후|after)|%/.test(highlight.derived.formula);
    if (isPercentChange && originalValues.length >= 2) {
      const [previous, current] = originalValues.slice(-2).map((value) => Number(String(value).replace(/,/g, "")));
      if (!Number.isFinite(previous) || !Number.isFinite(current)) return "계산 원래 값이 숫자가 아닙니다.";
      const expected = previous === 0 ? null : ((current - previous) / Math.abs(previous)) * 100;
      if (expected === null ? highlight.derived.result !== null : Math.abs(expected - highlight.derived.result) > 0.02) {
        return "계산 결과가 derived의 원래 값과 일치하지 않습니다.";
      }
    }
  }

  return null;
}

function prepareHighlights(visual, sourceLookup, warnings) {
  const accepted = [];
  const candidates = visual.highlights.slice(0, 3);
  if (visual.highlights.length > 3) warnings.push(`${visual.title}: 강조는 최대 3개까지만 표시합니다.`);

  candidates.forEach((highlight, index) => {
    const reason = validateHighlight(visual, highlight);
    if (reason) {
      warnings.push(`${visual.title}: ${index + 1}번째 강조를 건너뛰었습니다. ${reason}`);
      return;
    }

    if (!highlight.source_ids.every((sourceId) => sourceLookup.has(sourceId))) {
      warnings.push(`${visual.title}: 원본 위치를 찾을 수 없는 강조를 숨겼습니다.`);
      return;
    }
    if (!hasHighlightTarget(visual, highlight.target)) {
      warnings.push(`${visual.title}: 강조 대상이 시각화 자료와 맞지 않아 건너뛰었습니다.`);
      return;
    }
    accepted.push(highlight);
  });

  return accepted;
}

function createElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function createCard(visual) {
  const card = createElement("article", "visual-card");
  card.dataset.visualId = visual.id;
  const header = createElement("header", "visual-card-header");
  const titleRow = createElement("div", "visual-card-title-row");
  const title = createElement("h3", "", visual.title);
  const type = createElement("span", "visual-type-label", visual.type.replaceAll("_", " "));
  titleRow.append(title, type);
  const caption = createElement("p", "visual-caption", visual.caption);
  header.append(titleRow, caption);
  const content = createElement("div", "visual-card-content");
  const highlights = createElement("div", "visual-highlights");
  card.append(header, content, highlights);
  return { card, content, highlights };
}

function getTargetHighlightMap(visual, highlights) {
  const targetMap = new Map();
  highlights.forEach((highlight) => {
    const target = highlight.target;
    const key = visual.type === "line_chart"
      ? `${target.series_id}:${target.point_index}`
      : visual.type === "bar_chart"
        ? String(target.point_index)
        : null;
    if (!key) return;
    const current = targetMap.get(key);
    const levels = ["critical", "important", "info"];
    if (!current || levels.indexOf(highlight.level) < levels.indexOf(current)) targetMap.set(key, highlight.level);
  });
  return targetMap;
}

function getChartColor(level, fallback) {
  return level ? LEVEL_COLORS[level] : fallback;
}

const CHART_FONT_SIZE = 10;
const CHART_LEGEND_FONT_SIZE = 11;
const MAX_ROTATED_LABELS = 60;
const MAX_LABEL_CHARACTERS = 30;

function estimateTextWidth(text, fontSize) {
  return [...String(text ?? "")].reduce((width, character) => width + (/[\u3131-\uD7A3]/.test(character) ? fontSize : fontSize * 0.6), 0);
}

// x축 이름이 길어서 가로로는 다 못 보여 줄 때만 대각선(45°)으로 눕혀 모두 표시한다.
// 짧은 이름(예: 남/여)은 지금처럼 가로로 둔다.
export function getXAxisLayout(labels, availableWidth, fontSize = CHART_FONT_SIZE) {
  const list = (labels || []).map((label) => String(label ?? ""));
  const longest = list.reduce((max, label) => Math.max(max, estimateTextWidth(label.slice(0, MAX_LABEL_CHARACTERS), fontSize)), 0);
  const width = Number.isFinite(availableWidth) && availableWidth > 0 ? availableWidth : 600;
  const slot = (width - 40) / Math.max(1, list.length);
  const rotate = list.length > 0 && list.length <= MAX_ROTATED_LABELS && longest + 6 > slot;
  return {
    rotate,
    // 눕힌 글자가 차지하는 높이만큼 그래프 영역을 늘려 막대·선이 납작해지지 않게 한다.
    extraHeight: rotate ? Math.min(150, Math.round(longest * Math.SQRT1_2) + 8) : 0,
    ticks: rotate
      ? {
        autoSkip: false,
        maxRotation: 45,
        minRotation: 45,
        font: { size: fontSize },
        callback(value) {
          const label = String(this.getLabelForValue(value) ?? "");
          return label.length > MAX_LABEL_CHARACTERS ? `${label.slice(0, MAX_LABEL_CHARACTERS - 1)}…` : label;
        },
      }
      : { maxRotation: 0, autoSkip: true, font: { size: fontSize } },
  };
}

function applyXAxisLayout(wrap, content, labels) {
  const layout = getXAxisLayout(labels, content.clientWidth || wrap.clientWidth);
  if (layout.extraHeight > 0) wrap.style.height = `${205 + layout.extraHeight}px`;
  return layout.ticks;
}

function createChartCanvas(content, label) {
  const wrap = createElement("div", "visual-chart-wrap");
  const canvas = document.createElement("canvas");
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", label);
  wrap.append(canvas);
  content.append(wrap);
  return { wrap, canvas };
}

function drawLineChart(visual, content, highlights, sourceLookup, onNavigate, chartList) {
  const targetLevels = getTargetHighlightMap(visual, highlights);
  const accessibleDescription = visual.data.series
    .map((series) => `${series.name}: ${series.values.map((value) => value === null ? "결측" : value).join(", ")}`)
    .join(". ");
  const { wrap, canvas } = createChartCanvas(content, accessibleDescription);
  const xTicks = applyXAxisLayout(wrap, content, visual.data.labels);

  const datasets = visual.data.series.map((series, seriesIndex) => ({
    label: series.name,
    data: series.values,
    borderColor: CHART_COLORS[seriesIndex % CHART_COLORS.length],
    backgroundColor: "rgba(95, 141, 102, 0.11)",
    pointBackgroundColor: series.values.map((_, pointIndex) => {
      const level = targetLevels.get(`${series.id}:${pointIndex}`);
      return getChartColor(level, CHART_COLORS[seriesIndex % CHART_COLORS.length]);
    }),
    pointBorderColor: series.values.map((_, pointIndex) => {
      const level = targetLevels.get(`${series.id}:${pointIndex}`);
      return getChartColor(level, CHART_COLORS[seriesIndex % CHART_COLORS.length]);
    }),
    pointRadius: series.values.map((_, pointIndex) => targetLevels.has(`${series.id}:${pointIndex}`) ? 5 : 3),
    pointHoverRadius: 6,
    borderWidth: 2,
    tension: 0.25,
    spanGaps: false,
  }));

  const chart = new Chart(canvas, {
    type: "line",
    data: { labels: visual.data.labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "nearest", intersect: true },
      plugins: {
        legend: { display: datasets.length > 1, labels: { boxWidth: 8, boxHeight: 8, usePointStyle: true, font: { size: CHART_LEGEND_FONT_SIZE } } },
        tooltip: {
          callbacks: {
            label(context) {
              const unit = visual.data.series[context.datasetIndex]?.unit || visual.data.unit || "";
              return `${context.dataset.label}: ${formatNumber(context.parsed.y, unit)}`;
            },
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: xTicks },
        y: { beginAtZero: false, grid: { color: "#edf0ed" }, ticks: { font: { size: CHART_FONT_SIZE }, maxTicksLimit: 5 } },
      },
      onClick(_event, activeElements) {
        const active = activeElements[0];
        if (!active) return;
        // 점을 눌러도 미리보기로 이동하지 않는다. 카드 클릭으로 챗봇 요약이 열린다.
      },
    },
  });
  chartList.push(chart);
}

function drawBarChart(visual, content, highlights, sourceLookup, onNavigate, chartList) {
  const targetLevels = getTargetHighlightMap(visual, highlights);
  const accessibleDescription = visual.data.labels
    .map((label, index) => `${label}: ${visual.data.values[index] === null ? "결측" : visual.data.values[index]}`)
    .join(". ");
  const { wrap, canvas } = createChartCanvas(content, accessibleDescription);
  const xTicks = applyXAxisLayout(wrap, content, visual.data.labels);
  const chart = new Chart(canvas, {
    type: "bar",
    data: {
      labels: visual.data.labels,
      datasets: [{
        label: visual.data.series_name || visual.title,
        data: visual.data.values,
        backgroundColor: visual.data.values.map((_, index) => getChartColor(targetLevels.get(String(index)), "#90b493")),
        borderColor: visual.data.values.map((_, index) => getChartColor(targetLevels.get(String(index)), "#739878")),
        borderWidth: 1,
        borderRadius: 4,
        maxBarThickness: 28,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(context) { return formatNumber(context.parsed.y, visual.data.unit || ""); },
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: xTicks },
        y: { beginAtZero: true, grid: { color: "#edf0ed" }, ticks: { font: { size: CHART_FONT_SIZE }, maxTicksLimit: 5 } },
      },
      onClick(_event, activeElements) {
        const active = activeElements[0];
        if (!active) return;
        // 막대를 눌러도 미리보기로 이동하지 않는다. 카드 클릭으로 챗봇 요약이 열린다.
      },
    },
  });
  chartList.push(chart);

  if (visual.data.note) content.append(createElement("p", "visual-chart-legend-note", visual.data.note));
}

function appendSourceIds(record, sourceIds) {
  return sourceIds.map((sourceId) => ({ sourceId, location: record.get(sourceId) }));
}

// 표 행·카드를 눌러도 미리보기로 이동하지 않는다(그래프 카드 클릭은 챗봇 요약으로 연결).
function addSourceClick() {}

function markTarget(element, id) {
  if (id) element.dataset.targetId = id;
}

function drawComparisonTable(visual, content, highlights, sourceLookup, onNavigate) {
  const wrap = createElement("div", "visual-table-wrap");
  const table = createElement("table", "visual-table");
  const head = document.createElement("thead");
  const headerRow = document.createElement("tr");
  visual.data.columns.forEach((column) => headerRow.append(createElement("th", "", column.label)));
  head.append(headerRow);
  const body = document.createElement("tbody");
  const targetHighlights = new Map(highlights.map((highlight) => [highlight.target.row_id, highlight]));

  visual.data.rows.forEach((row) => {
    const tableRow = document.createElement("tr");
    markTarget(tableRow, row.id);
    const targetHighlight = targetHighlights.get(row.id);
    if (targetHighlight) tableRow.classList.add("visual-data-highlighted");
    visual.data.columns.forEach((column) => {
      const cell = createElement("td", "", row.cells[column.key] === null ? "" : String(row.cells[column.key] ?? ""));
      if (targetHighlight?.target.column_key === column.key) cell.classList.add("visual-data-highlighted");
      tableRow.append(cell);
    });
    addSourceClick(tableRow, row.source_ids, sourceLookup, onNavigate);
    body.append(tableRow);
  });

  table.append(head, body);
  wrap.append(table);
  content.append(wrap);
}

function drawFlowchart(visual, content, sourceLookup, onNavigate) {
  const nodes = createElement("div", "flow-nodes");
  const nodesById = new Map(visual.data.nodes.map((node) => [node.id, node]));

  visual.data.nodes.forEach((node) => {
    const nodeButton = createElement("button", "flow-node");
    nodeButton.type = "button";
    nodeButton.dataset.nodeId = node.id;
    markTarget(nodeButton, node.id);
    nodeButton.append(createElement("strong", "", node.label));
    if (node.description) nodeButton.append(createElement("span", "", node.description));
    addSourceClick(nodeButton, node.source_ids, sourceLookup, onNavigate);
    nodes.append(nodeButton);
  });

  const connections = createElement("div", "flow-connections");
  visual.data.edges.forEach((edge) => {
    const edgeButton = createElement("button", "flow-edge");
    edgeButton.type = "button";
    edgeButton.dataset.edgeFrom = edge.from;
    edgeButton.dataset.edgeTo = edge.to;
    markTarget(edgeButton, `${edge.from}:${edge.to}`);
    const arrow = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    arrow.setAttribute("viewBox", "0 0 16 16");
    arrow.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M2 8h11m-4-4 4 4-4 4");
    arrow.append(path);
    const from = nodesById.get(edge.from).label;
    const to = nodesById.get(edge.to).label;
    const edgeText = `${from} → ${to}${edge.label ? ` · ${edge.label}` : ""}`;
    edgeButton.append(arrow, createElement("span", "", edgeText));
    addSourceClick(edgeButton, edge.source_ids || [], sourceLookup, onNavigate);
    connections.append(edgeButton);
  });

  content.append(nodes, connections);
}

function drawTimeline(visual, content, sourceLookup, onNavigate) {
  const list = createElement("div", "timeline-list");
  visual.data.items.forEach((item) => {
    const row = createElement("button", "timeline-item");
    row.type = "button";
    row.dataset.itemId = item.id;
    markTarget(row, item.id);
    row.append(createElement("span", "timeline-date", String(item.date)));
    row.append(createElement("span", "timeline-marker"));
    const copy = createElement("span", "timeline-copy");
    copy.append(createElement("strong", "", item.label));
    if (item.description) copy.append(createElement("span", "", item.description));
    row.append(copy);
    addSourceClick(row, item.source_ids, sourceLookup, onNavigate);
    list.append(row);
  });
  content.append(list);
}

function drawKpiCards(visual, content, sourceLookup, onNavigate) {
  const grid = createElement("div", "kpi-grid");
  visual.data.cards.forEach((card) => {
    const button = createElement("button", "kpi-card");
    button.type = "button";
    button.dataset.cardId = card.id;
    markTarget(button, card.id);
    button.append(createElement("span", "", card.label));
    const value = createElement("span", "kpi-value");
    value.append(document.createTextNode(String(card.value)));
    if (card.unit) value.append(createElement("small", "", card.unit));
    button.append(value);
    if (card.note) button.append(createElement("span", "", card.note));
    addSourceClick(button, card.source_ids, sourceLookup, onNavigate);
    grid.append(button);
  });
  content.append(grid);
}

function appendExplanation(detail, explanation) {
  if (!explanation?.sentences?.length) return;
  const box = createElement("div", "highlight-explanation");
  box.append(createElement("strong", "", "이렇게 볼 수 있어요"));
  const list = createElement("ul", "highlight-explanation-list");
  explanation.sentences.forEach((sentence) => {
    list.append(createElement("li", `highlight-explanation-item level-${sentence.level}`, sentence.text));
  });
  box.append(list);
  if (explanation.caveat) box.append(createElement("p", "highlight-explanation-caveat", explanation.caveat));
  detail.append(box);
}

function showHighlightDetail(card, visual, highlight, sourceLookup, onNavigate, sourceDocument) {
  card.querySelector(".highlight-detail")?.remove();
  card.querySelectorAll(".visual-data-highlighted").forEach((element) => element.classList.remove("visual-data-highlighted"));
  const detail = createElement("div", "highlight-detail");
  detail.append(createElement("strong", "", highlight.label));
  detail.append(createElement("p", "", highlight.reason));

  let explanation = null;
  try {
    explanation = explainHighlight(sourceDocument, visual, highlight);
  } catch {
    explanation = null;
  }
  appendExplanation(detail, explanation);

  card.append(detail);

  const targetKey = highlight.target.row_id
    || highlight.target.node_id
    || highlight.target.item_id
    || highlight.target.card_id
    || (highlight.target.edge_from ? `${highlight.target.edge_from}:${highlight.target.edge_to}` : null);
  if (targetKey) {
    const target = [...card.querySelectorAll("[data-target-id]")].find((element) => element.dataset.targetId === targetKey);
    target?.classList.add("visual-data-highlighted");
  }

  // 중요한 부분을 누르면 화면을 옮기지 않고 그 자리에서 해석만 보여 준다.
  // (계산식·원문 근거·원본 위치 이동 버튼은 두지 않는다.)
  detail.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
}

function renderHighlights(card, visual, highlights, sourceLookup, onNavigate, sourceDocument = null) {
  const list = card.querySelector(".visual-highlights");
  if (highlights.length === 0) return;
  list.append(createElement("h4", "visual-highlights-heading", "중요한 부분"));

  sortInsightsByPriority(highlights).forEach((highlight) => {
    const button = createElement("button", "visual-highlight-button");
    button.type = "button";
    button.dataset.highlightLabel = highlight.label;
    const level = createElement("span", `highlight-level highlight-level-${highlight.level}`, INSIGHT_LEVEL_LABELS[highlight.level]);
    const label = createElement("span", "visual-highlight-label", highlight.label);
    const arrow = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    arrow.setAttribute("viewBox", "0 0 16 16");
    arrow.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M3 8h10M9 4l4 4-4 4");
    arrow.append(path);
    button.append(level, label, arrow);
    button.addEventListener("click", () => showHighlightDetail(card, visual, highlight, sourceLookup, onNavigate, sourceDocument));
    list.append(button);
  });
}

function displayWarnings(container, warnings) {
  if (warnings.length === 0) return;
  const warning = createElement("div", "visual-output-warning");
  warning.setAttribute("role", "status");
  warning.textContent = warnings.join(" ");
  container.append(warning);
}

function renderVisualContent(visual, content, highlights, sourceLookup, onNavigate, chartList) {
  if (visual.type === "line_chart") return drawLineChart(visual, content, highlights, sourceLookup, onNavigate, chartList);
  if (visual.type === "bar_chart") return drawBarChart(visual, content, highlights, sourceLookup, onNavigate, chartList);
  if (visual.type === "comparison_table") return drawComparisonTable(visual, content, highlights, sourceLookup, onNavigate);
  if (visual.type === "flowchart") return drawFlowchart(visual, content, sourceLookup, onNavigate);
  if (visual.type === "timeline") return drawTimeline(visual, content, sourceLookup, onNavigate);
  return drawKpiCards(visual, content, sourceLookup, onNavigate);
}

// 챗봇용 짧은 그래프 요약: 한 줄 설명 + 가장 중요한 강조점의 해석 한두 문장.
export function summarizeVisual(visual, sourceDocument = null) {
  if (!visual) return [];
  const lines = [];
  if (visual.caption) lines.push(String(visual.caption).replace(/\s*\((?:[^()]*?)(?:p\s*[<=>]|r\s*=|η²|설명력|구간 중)[^()]*\)/g, ""));
  const highlights = sortInsightsByPriority([...(visual.highlights || [])]);
  const top = highlights[0];
  if (top) {
    let explanation = null;
    try {
      explanation = explainHighlight(sourceDocument, visual, top);
    } catch {
      explanation = null;
    }
    const first = explanation?.sentences?.[0]?.text;
    if (first) lines.push(first);
    else if (top.reason) lines.push(`${top.label}: ${top.reason}`);
  }
  // 강조점이 없는 표는 위쪽 두 행을 "항목: 값"으로 짧게 보여 준다.
  if (lines.length < 2 && visual.type === "comparison_table" && Array.isArray(visual.data?.rows) && Array.isArray(visual.data?.columns)) {
    const [first, second] = visual.data.columns;
    visual.data.rows.slice(0, 2).forEach((row) => {
      const name = row.cells?.[first?.key];
      const value = row.cells?.[second?.key];
      if (name !== undefined && value !== undefined) lines.push(`${name}: ${value}`);
    });
  }
  return [...new Set(lines.filter(Boolean))].slice(0, 3);
}

export function renderVisuals(spec, { container, sourceDocument = null, onNavigate } = {}) {
  if (!container) return { renderedCount: 0, warnings: ["시각화를 표시할 영역이 없습니다."] };
  chartInstances.get(container)?.forEach((chart) => {
    try {
      chart.destroy();
    } catch {
      // A stale chart instance must not prevent the next render attempt.
    }
  });
  const chartList = [];
  chartInstances.set(container, chartList);
  container.replaceChildren();

  if (!isRecord(spec)) {
    const error = createElement("p", "visual-output-error", "시각화 명세가 객체가 아닙니다.");
    container.append(error);
    return { renderedCount: 0, warnings: [error.textContent] };
  }

  if (spec.status === "insufficient_data") {
    const message = createElement("p", "visual-output-message is-insufficient", "제공된 자료만으로는 알 수 없어요.");
    container.append(message);
    return { renderedCount: 0, warnings: [] };
  }

  if (spec.status !== "ok") {
    const error = createElement("p", "visual-output-error", "명세 status는 ok 또는 insufficient_data여야 합니다.");
    container.append(error);
    return { renderedCount: 0, warnings: [error.textContent] };
  }

  if (typeof spec.message !== "string" || !Array.isArray(spec.visuals)) {
    const error = createElement("p", "visual-output-error", "필수 값이 없거나 visuals가 배열이 아닙니다.");
    container.append(error);
    return { renderedCount: 0, warnings: [error.textContent] };
  }

  if (spec.message.trim()) container.append(createElement("p", "visual-output-message", spec.message));
  const sourceLookup = getSourceLookup(sourceDocument);
  const warnings = [];
  const prepared = [];

  spec.visuals.forEach((visual, index) => {
    const reason = validateVisual(visual);
    if (reason) {
      warnings.push(`${visual?.title || visual?.id || `시각화 ${index + 1}`}: ${reason}`);
      return;
    }
    prepared.push({ visual, highlights: prepareHighlights(visual, sourceLookup, warnings) });
  });

  displayWarnings(container, warnings);
  let renderedCount = 0;
  let drawFailed = false;

  prepared.forEach(({ visual, highlights }) => {
    const { card, content } = createCard(visual);
    container.append(card);
    // 그래프를 누르면 챗봇이 이 그래프의 짧은 요약을 보여 준다('중요한 부분' 버튼은 제외).
    card.classList.add("is-clickable");
    card.addEventListener("click", (event) => {
      if (event.target.closest(".visual-highlights, button, a, summary")) return;
      document.dispatchEvent(new CustomEvent("grappler:visual-click", { detail: { visual, sourceDocument, card } }));
    });
    try {
      renderVisualContent(visual, content, highlights, sourceLookup, onNavigate, chartList);
      renderHighlights(card, visual, highlights, sourceLookup, onNavigate, sourceDocument);
      renderedCount += 1;
    } catch (error) {
      card.remove();
      drawFailed = true;
      warnings.push(`${visual.title}: 그리는 중 오류가 발생했습니다.`);
    }
  });

  if (drawFailed) {
    const errorBox = createElement("div", "visual-output-error");
    errorBox.setAttribute("role", "alert");
    const errorText = createElement("p", "", "일부 시각화를 그리지 못했습니다. 이미 그려진 결과는 그대로 유지됩니다.");
    const retry = createElement("button", "", "다시 시도");
    retry.type = "button";
    retry.addEventListener("click", () => renderVisuals(spec, { container, sourceDocument, onNavigate }));
    errorBox.append(errorText, retry);
    container.append(errorBox);
  }

  if (renderedCount === 0 && warnings.length === 0 && spec.visuals.length === 0 && !spec.message.trim()) {
    container.append(createElement("p", "visual-output-message", "표시할 시각화가 없습니다."));
  }

  return { renderedCount, warnings: [...new Set(warnings)] };
}
