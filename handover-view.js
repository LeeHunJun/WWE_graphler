// 인수인계 요약 패널 화면. 계산은 handover-analysis.js가 하고, 이 파일은 그리기만 합니다.
import { analyzeHandover } from "./handover-analysis.js";
import { renderInsight } from "./driver-view.js";
import { getSourceLookup } from "./visualization.js";

const panel = document.querySelector("#handover-panel");
const summary = document.querySelector("#handover-summary");
const output = document.querySelector("#handover-output");

function createElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function renderHandoverPanel(record, { onNavigate } = {}) {
  if (!panel) return;
  const result = record && record.type !== "pdf" ? analyzeHandover(record) : null;
  panel.hidden = !result || result.status !== "ok";
  output.replaceChildren();
  summary.textContent = "";
  if (panel.hidden) return;

  summary.textContent = `${result.message} ${result.roles.map((role) => `${role.sheetName}(${{ period: "기간별 기록", watch: "목록", problem: "이슈 기록", routine: "정기 업무" }[role.role]})`).join(" · ")}`;
  const lookup = getSourceLookup(record);
  const nav = createElement("nav", "handover-nav");
  nav.setAttribute("aria-label", "인수인계 요약 항목");

  result.sections.forEach((section) => {
    const block = createElement("section", `handover-section${section.insights.length ? "" : " is-empty"}`);
    block.id = `handover-${section.key}`;
    const head = createElement("div", "handover-section-head");
    head.append(createElement("h3", "", section.title));
    if (section.sheetNames.length) head.append(createElement("span", "handover-sheet", section.sheetNames.join(", ")));
    block.append(head);
    if (section.insights.length === 0) {
      block.append(createElement("p", "handover-empty", section.empty));
    } else {
      const list = createElement("div", "driver-insights");
      section.insights.forEach((insight) => list.append(renderInsight(insight, lookup, onNavigate)));
      block.append(list);
    }
    output.append(block);

    const link = createElement("a", section.insights.length ? "" : "is-empty", `${section.title}${section.insights.length ? ` ${section.insights.length}` : ""}`);
    link.href = `#handover-${section.key}`;
    nav.append(link);
  });
  output.prepend(nav);
}
