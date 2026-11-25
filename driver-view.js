// "왜?" 원인 분석 패널 화면. 계산은 driver-analysis.js가 하고, 이 파일은 그리기만 합니다.
import { analyzeDrivers, buildDriverVisualSpec, formatValue, suggestTargets } from "./driver-analysis.js";
import { getSourceLookup, renderVisuals } from "./visualization.js";
import { INSIGHT_LEVEL_LABELS, sortInsightsByPriority } from "./insight-priority.js";

const panel = document.querySelector("#driver-panel");
const sheetField = document.querySelector("#driver-sheet-field");
const sheetSelect = document.querySelector("#driver-sheet");
const targetSelect = document.querySelector("#driver-target");
const periodField = document.querySelector("#driver-period-field");
const periodSelect = document.querySelector("#driver-period");
const output = document.querySelector("#driver-output");
const visualOutput = document.querySelector("#driver-visual-output");

const selections = new Map();
let current = { record: null, onNavigate: null };

function createElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function fillSelect(select, options, selectedValue) {
  select.replaceChildren(...options.map(({ value, label }) => {
    const option = document.createElement("option");
    option.value = String(value);
    option.textContent = label;
    option.selected = String(value) === String(selectedValue);
    return option;
  }));
}

function getSelection(record) {
  if (!selections.has(record.id)) selections.set(record.id, { sheetIndex: null, targetIndex: null, focusPeriodIndex: null });
  return selections.get(record.id);
}

function pickDefaultSheet(record) {
  const index = (record.sheets || []).findIndex((sheet) => (sheet.rows?.length || 0) >= 5 && suggestTargets(sheet).length > 0);
  return index >= 0 ? index : 0;
}

export function renderInsight(insight, lookup, onNavigate) {
  const card = createElement("article", `driver-insight driver-insight-${insight.level}`);
  const head = createElement("div", "driver-insight-head");
  head.append(
    createElement("span", `highlight-level highlight-level-${insight.level}`, INSIGHT_LEVEL_LABELS[insight.level] || "참고"),
    createElement("h3", "", insight.title),
  );
  card.append(head, createElement("p", "driver-insight-sentence", insight.sentence));

  const details = createElement("details", "driver-evidence");
  details.append(createElement("summary", "", "계산 근거 보기"));
  if (insight.evidence?.length) {
    const list = createElement("dl", "driver-evidence-values");
    insight.evidence.forEach((item) => {
      list.append(createElement("dt", "", item.label), createElement("dd", "", item.value));
    });
    details.append(list);
  }
  details.append(createElement("p", "driver-evidence-method", `계산법: ${insight.method}`));
  if (insight.rowSummary) details.append(createElement("p", "driver-evidence-rows", `근거 행: ${insight.rowSummary}`));

  const sourceIds = [...new Set(insight.sourceIds || [])].filter((sourceId) => lookup.has(sourceId)).slice(0, 6);
  if (sourceIds.length > 0) {
    const links = createElement("div", "highlight-source-links");
    sourceIds.forEach((sourceId) => {
      const button = createElement("button", "", lookup.get(sourceId).label);
      button.type = "button";
      button.addEventListener("click", () => onNavigate?.(sourceId));
      links.append(button);
    });
    details.append(links);
  }
  card.append(details);
  return card;
}

function run() {
  const { record, onNavigate } = current;
  if (!record) return;
  const selection = getSelection(record);
  const result = analyzeDrivers(record, selection);
  output.replaceChildren();

  if (result.targets?.length) {
    fillSelect(
      targetSelect,
      result.targets.map((target) => ({ value: target.index, label: `${target.name}${target.kind === "binary" ? " (두 값)" : ""}` })),
      result.target?.index,
    );
    targetSelect.disabled = false;
  } else {
    fillSelect(targetSelect, [{ value: "", label: "고를 수 있는 지표 없음" }], "");
    targetSelect.disabled = true;
  }

  periodField.hidden = !result.period;
  if (result.period) {
    const { periods } = result.period;
    fillSelect(
      periodSelect,
      periods.slice(1).map((period, offset) => {
        const previous = periods[offset];
        const pct = previous.value ? ((period.value - previous.value) / Math.abs(previous.value)) * 100 : null;
        return { value: offset + 1, label: `${period.label} (직전 대비 ${pct === null ? "계산 불가" : `${pct > 0 ? "+" : ""}${formatValue(pct, "%")}`})` };
      }),
      result.period.focusIndex,
    );
  }

  if (result.status !== "ok") {
    output.append(createElement("p", "visual-output-message is-insufficient", result.message));
    renderVisuals({ status: "ok", message: "", visuals: [] }, { container: visualOutput });
    return;
  }

  const { target } = result;
  const overall = target.kind === "binary" ? formatValue(target.overall * 100, "%") : formatValue(target.overall, target.unit);
  output.append(createElement(
    "p",
    "driver-summary-line",
    `${result.sheetName} · ${target.n}행 분석 · 전체 ${target.measureLabel} ${overall}${result.mode === "periods" ? ` · 기간 비교 모드(${result.period.temporalName} 기준)` : ""}`,
  ));

  const lookup = getSourceLookup(record);
  const list = createElement("div", "driver-insights");
  sortInsightsByPriority(result.insights).forEach((insight) => list.append(renderInsight(insight, lookup, onNavigate)));
  if (result.insights.length === 0) {
    list.append(createElement("p", "visual-output-message", "뚜렷한 차이를 보이는 요인을 찾지 못했어요. 다른 목표 지표를 골라 보세요."));
  }
  output.append(list);

  const caveats = createElement("ul", "driver-caveats");
  result.caveats.forEach((caveat) => caveats.append(createElement("li", "", caveat)));
  output.append(caveats);

  renderVisuals(buildDriverVisualSpec(result, record), { container: visualOutput, sourceDocument: record, onNavigate });
}

export function renderDriverPanel(record, { onNavigate } = {}) {
  if (!panel) return;
  const usable = record && record.type !== "pdf" && (record.sheets || []).some((sheet) => (sheet.rows?.length || 0) >= 2);
  panel.hidden = !usable;
  if (!usable) {
    current = { record: null, onNavigate: null };
    output.replaceChildren();
    renderVisuals({ status: "ok", message: "", visuals: [] }, { container: visualOutput });
    return;
  }

  current = { record, onNavigate };
  const selection = getSelection(record);
  if (selection.sheetIndex === null) selection.sheetIndex = pickDefaultSheet(record);
  sheetField.hidden = record.sheets.length < 2;
  fillSelect(sheetSelect, record.sheets.map((sheet, index) => ({ value: index, label: sheet.name })), selection.sheetIndex);
  run();
}

sheetSelect?.addEventListener("change", () => {
  if (!current.record) return;
  const selection = getSelection(current.record);
  selection.sheetIndex = Number(sheetSelect.value);
  selection.targetIndex = null;
  selection.focusPeriodIndex = null;
  run();
});

targetSelect?.addEventListener("change", () => {
  if (!current.record) return;
  const selection = getSelection(current.record);
  selection.targetIndex = Number(targetSelect.value);
  selection.focusPeriodIndex = null;
  run();
});

periodSelect?.addEventListener("change", () => {
  if (!current.record) return;
  getSelection(current.record).focusPeriodIndex = Number(periodSelect.value);
  run();
});
