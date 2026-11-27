// 오른쪽 아래 데이터 도우미 챗봇.
// 1) 질문을 받으면 그 답에 맞는 그래프를 찾는다. 처음 질문한 답에 있으면 그곳으로, 아니면
//    '부가 정보 보기' 영역에 있는지 확인해 펼친 뒤 그 그래프로 이동하고, 짧은 요약만 알려 준다.
// 2) 화면의 그래프를 누르면 그 그래프의 짧은 요약만 알려 준다.
// 모든 내용은 원본 행에서 코드로 계산한 결과이며 AI를 호출하지 않는다.

import { answerQuestion, bestTitleMatch } from "./question-answer.js";
import { summarizeVisual } from "./visualization.js";

const OUTPUT_SELECTORS = ["#visualization-output", "#ai-visualization-output", "#extra-visualization-output", "#driver-visual-output"];

export function normalizeVisualKey(id) {
  return String(id || "").replace(/^question-/, "").replace(/^auto-/, "").replace(/^sheet-\d+-/, "");
}

function el(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

// 질문에 맞는 그래프를 고른다: 질문 답(main) → 부가 정보(extra) 순서로, 같은 그래프(id)나 제목이 비슷한 그래프.
export function locateVisual(question, answer, { mainVisuals = [], extraVisuals = [] } = {}) {
  const wanted = (answer?.spec?.visuals || []).map((visual) => normalizeVisualKey(visual.id));
  for (const key of wanted) {
    const main = mainVisuals.find((visual) => normalizeVisualKey(visual.id) === key);
    if (main) return { where: "main", visual: main };
  }
  for (const key of wanted) {
    if (key === "line") continue;
    const extra = extraVisuals.find((visual) => normalizeVisualKey(visual.id) === key);
    if (extra) return { where: "extra", visual: extra };
  }
  const byTitleMain = bestTitleMatch(question, mainVisuals);
  if (byTitleMain && wanted.length === 0) return { where: "main", visual: byTitleMain };
  const byTitleExtra = bestTitleMatch(question, extraVisuals);
  if (byTitleExtra) return { where: "extra", visual: byTitleExtra };
  if (byTitleMain) return { where: "main", visual: byTitleMain };
  return null;
}

export function initChatbot(hooks) {
  const root = el("div", "chatbot");
  const toggle = el("button", "chatbot-toggle");
  toggle.type = "button";
  toggle.setAttribute("aria-label", "데이터 도우미 열기");
  toggle.setAttribute("aria-expanded", "false");
  toggle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4A2.5 2.5 0 0 1 3 13.5v-8Z" /><path d="M8 9.5h.01M12 9.5h.01M16 9.5h.01" /></svg>';

  const panel = el("section", "chatbot-panel");
  panel.hidden = true;
  panel.setAttribute("aria-label", "데이터 도우미");
  const header = el("header", "chatbot-header");
  const titleBox = el("div");
  titleBox.append(el("strong", "", "데이터 도우미"), el("span", "", "그래프를 찾아 짧게 알려 드려요"));
  const close = el("button", "chatbot-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "데이터 도우미 닫기");
  header.append(titleBox, close);
  const log = el("div", "chatbot-log");
  log.setAttribute("role", "log");
  log.setAttribute("aria-live", "polite");
  const form = el("form", "chatbot-form");
  const input = el("input");
  input.name = "message";
  input.maxLength = 200;
  input.autocomplete = "off";
  input.placeholder = "이 데이터에서 무엇이 궁금한가요?";
  const send = el("button", "chatbot-send", "보내기");
  send.type = "submit";
  form.append(input, send);
  panel.append(header, log, form);
  root.append(panel, toggle);
  document.body.append(root);

  let greeted = false;

  function addMessage(role, lines, actions = []) {
    const bubble = el("div", `chatbot-message chatbot-${role}`);
    (Array.isArray(lines) ? lines : [lines]).filter(Boolean).forEach((line) => bubble.append(el("p", "", line)));
    if (actions.length > 0) {
      const row = el("div", "chatbot-actions");
      actions.forEach(({ label, onClick }) => {
        const button = el("button", "", label);
        button.type = "button";
        button.addEventListener("click", onClick);
        row.append(button);
      });
      bubble.append(row);
    }
    log.append(bubble);
    log.scrollTop = log.scrollHeight;
  }

  function greet() {
    if (greeted) return;
    greeted = true;
    addMessage("bot", [
      "이 데이터에서 무엇이 궁금한가요?",
      "물어보시면 맞는 그래프로 이동해 짧게 알려 드려요. 화면의 그래프를 눌러도 요약을 볼 수 있어요.",
    ]);
  }

  function open() {
    panel.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    root.classList.add("is-open");
    greet();
  }

  function hide() {
    panel.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    root.classList.remove("is-open");
  }

  function findCard(visual) {
    const key = normalizeVisualKey(visual.id);
    for (const selector of OUTPUT_SELECTORS) {
      const container = document.querySelector(selector);
      const card = [...(container?.querySelectorAll(".visual-card") || [])]
        .find((element) => element.dataset.visualId === visual.id || normalizeVisualKey(element.dataset.visualId) === key);
      if (card) return card;
    }
    return null;
  }

  function focusCard(card) {
    if (!card) return;
    card.scrollIntoView({ block: "center", behavior: "smooth" });
    card.classList.remove("chatbot-focus");
    // 다시 그려도 깜빡임 효과가 보이도록 한 프레임 뒤에 붙인다.
    requestAnimationFrame(() => card.classList.add("chatbot-focus"));
    setTimeout(() => card.classList.remove("chatbot-focus"), 2600);
  }

  async function handleQuestion(text) {
    const question = String(text || "").trim();
    if (!question) return;
    addMessage("user", question);
    const record = hooks.getRecord();
    if (!record) {
      addMessage("bot", "먼저 문서 보관함에서 문서를 선택해 주세요.");
      return;
    }
    const answer = answerQuestion(record, question);
    const located = locateVisual(question, answer, {
      mainVisuals: hooks.getMainVisuals(record),
      extraVisuals: hooks.getExtraVisuals(record),
    });

    if (located) {
      if (located.where === "extra" && !record.extrasRevealed) await hooks.revealExtras(record);
      const card = findCard(located.visual);
      focusCard(card);
      const summary = summarizeVisual(located.visual, record);
      addMessage("bot", [
        located.where === "main"
          ? `질문 답에 있는 ‘${located.visual.title}’ 그래프예요.`
          : `부가 정보의 ‘${located.visual.title}’ 그래프로 이동했어요.`,
        ...summary,
      ]);
      return;
    }

    if (answer.status === "answered" && answer.spec.visuals.length > 0) {
      addMessage("bot", [
        "부가 정보에는 이 질문에 맞는 그래프가 없어요.",
        ...answer.sentences.slice(0, 2).map((sentence) => sentence.text),
      ], [{
        label: "질문창에서 그래프로 보기",
        onClick: () => hooks.askInQuestionBar(record, question),
      }]);
      return;
    }

    addMessage("bot", answer.sentences.length > 0
      ? answer.sentences.slice(0, 2).map((sentence) => sentence.text)
      : "이 질문에 맞는 그래프를 찾지 못했어요. 표의 항목 이름을 넣어 다시 물어봐 주세요.");
  }

  toggle.addEventListener("click", () => (panel.hidden ? open() : hide()));
  close.addEventListener("click", hide);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value;
    input.value = "";
    handleQuestion(text);
  });

  // 그래프를 누르면 챗봇을 열고 그 그래프의 짧은 요약만 보여 준다.
  document.addEventListener("grappler:visual-click", (event) => {
    const { visual, sourceDocument, card } = event.detail || {};
    if (!visual) return;
    open();
    focusCard(card);
    const summary = summarizeVisual(visual, sourceDocument || hooks.getRecord());
    addMessage("bot", [`‘${visual.title}’ 그래프 요약`, ...(summary.length > 0 ? summary : ["이 그래프에 대한 요약을 만들지 못했어요."])]);
  });

  return { open, hide, ask: handleQuestion };
}
