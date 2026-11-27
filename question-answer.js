// 사용자가 적은 질문에 맞는 그래프와 답변 문장만 골라 준다.
// 질문 속 열 이름과 "왜/추이/가장" 같은 의도 단어를 읽어, 원본 행에서 코드로 계산한다(AI 호출 없음).

import { analyzeDrivers, buildDriverVisualSpec, formatValue, josa, plainSentence, profileColumns } from "./driver-analysis.js";
import { explainPeriod, measureName, valueText } from "./highlight-explain.js";
import { buildColumnVisuals, buildSpreadsheetVisualizationSpec, getLabelColumnIndex, isRecordSheet } from "./visualization.js";

const INTENT_PATTERNS = {
  why: /왜|이유|원인|영향|요인|때문|좌우|결정|관련|상관|차이|달라/,
  trend: /추이|추세|흐름|변화|변동|월별|연도별|분기별|일별|주별|시간|늘었|줄었|늘어|줄어|증가|감소|떨어|올랐|올라|내려/,
  extreme: /가장|제일|최고|최대|최저|최소|순위|많은|적은|높은|낮은|top|best|worst/i,
};
const VALUE_KINDS = new Set(["numeric", "numeric_discrete", "binary"]);

// '부가 정보 보기'에 있는 원인 분석 그래프를 질문으로도 바로 볼 수 있게, 주제 단어로 해당 그래프를 고른다.
const TOPIC_PATTERNS = [
  { key: "decomposition", pattern: /분해|구성|기여|비중|쪼개|나눠\s*보/, ids: (id) => id.startsWith("driver-decomposition") },
  { key: "comovers", pattern: /함께\s*(바뀐|변한|움직)|같이\s*(바뀐|변한|움직)|동시에|관련\s*지표|따라\s*움직/, ids: (id) => id === "driver-comovers" },
  { key: "combination", pattern: /조합|×|교차|함께\s*보|같이\s*보/, ids: (id) => id === "driver-combination" },
  { key: "ranking", pattern: /순위|요인|무엇이\s*영향|뭐가\s*영향|영향.*(큰|많)/, ids: (id) => id === "driver-ranking" },
];
const GROUP_PATTERN = /별|따라|기준|나눠|그룹/;

export function detectTopics(question, matchedNames = []) {
  let text = String(question || "");
  // "성별"처럼 열 이름 안에 든 '별'을 그룹 질문으로 오해하지 않도록 열 이름은 지우고 본다.
  matchedNames.forEach((name) => { text = text.split(name).join(" "); });
  const topics = TOPIC_PATTERNS.filter((topic) => topic.pattern.test(text)).map((topic) => topic.key);
  if (GROUP_PATTERN.test(text)) topics.push("group");
  return topics;
}

function topicInsightSentences(result, visualIds) {
  const wanted = visualIds.map((id) => id
    .replace(/^driver-decomposition-/, "decomposition-")
    .replace(/^driver-comovers$/, "comover-")
    .replace(/^driver-combination$/, "combination")
    .replace(/^driver-factor-/, "factor-"));
  return result.insights
    .filter((insight) => wanted.some((id) => insight.id === id || insight.id.startsWith(id)))
    .slice(0, 3)
    .map((insight) => ({ level: insight.level, text: plainSentence(insight.sentence) }));
}

function normalizeTitle(text) {
  return String(text || "").toLocaleLowerCase("ko").replace(/\([^)]*\)/g, "").replace(/[\s·×,.:?!~]+/g, "");
}

// 질문 글자와 그래프 제목이 가장 많이 겹치는 그래프(2글자 이상 단어 기준)를 고른다.
export function bestTitleMatch(question, visuals) {
  const words = String(question || "").split(/[\s,.?!·]+/)
    .map((word) => word.replace(/(은|는|이|가|을|를|의|에|에서|으로|로|과|와|도|만|좀|요)$/, ""))
    .map(normalizeTitle)
    .filter((word) => word.length >= 2);
  let best = null;
  visuals.forEach((visual) => {
    const title = normalizeTitle(visual.title);
    const score = words.filter((word) => title.includes(word)).length;
    if (score > 0 && (!best || score > best.score)) best = { visual, score };
  });
  return best?.visual || null;
}
const GROUP_KINDS = new Set(["categorical", "binary", "numeric_discrete", "numeric"]);

function normalize(text) {
  return String(text || "").toLocaleLowerCase("ko").replace(/\s+/g, "");
}

export function detectIntents(question) {
  const text = String(question || "");
  return Object.fromEntries(Object.entries(INTENT_PATTERNS).map(([key, pattern]) => [key, pattern.test(text)]));
}

// 질문에 나온 열을 찾는다. "커피매출"처럼 긴 이름에 포함된 짧은 이름("매출")은 겹치면 뺀다.
export function matchColumns(profiles, question) {
  const text = normalize(question);
  const hits = [];
  profiles.forEach((profile) => {
    if (profile.kind === "empty") return;
    const names = [...new Set([normalize(profile.baseName), normalize(profile.name)])].filter((name) => name.length >= 2);
    for (const name of names) {
      const start = text.indexOf(name);
      if (start >= 0) {
        hits.push({ profile, start, end: start + name.length });
        break;
      }
    }
  });
  return hits
    .filter((hit) => !hits.some((other) => other !== hit
      && other.end - other.start > hit.end - hit.start
      && other.start <= hit.start && other.end >= hit.end))
    .sort((a, b) => a.start - b.start)
    .map((hit) => hit.profile);
}

// "성별이에요 / 주변공사예요"처럼 받침에 맞춰 문장을 끝낸다.
function ending(text) {
  return `${text}${josa(text, "이에요/예요")}`;
}

function emptySpec(message = "") {
  return { status: "ok", message, visuals: [] };
}

function insightSentences(result, ids) {
  return result.insights
    .filter((insight) => ids.some((id) => insight.id === id || insight.id.startsWith(`${id}-`)))
    .map((insight) => ({ level: insight.level, text: plainSentence(insight.sentence) }));
}

function recordSentences(result, factorIndex = null) {
  const { target } = result;
  const measure = measureName(target);
  const ranked = result.factors.filter((factor) => factor.eta2 >= 0.01);
  const sentences = [];
  const focus = factorIndex === null ? ranked[0] : result.factors.find((factor) => factor.columnIndex === factorIndex);
  if (!focus) {
    sentences.push({ level: "info", text: `어느 요인으로 나눠 봐도 ${measure} 차이가 크지 않아요.` });
    return sentences;
  }
  const rank = ranked.findIndex((factor) => factor.columnIndex === focus.columnIndex);
  const large = focus.groups.filter((group) => !group.small);
  const groups = [...(large.length >= 2 ? large : focus.groups)].sort((a, b) => b.value - a.value);
  const listed = groups.slice(0, 4)
    .map((group) => `‘${group.label}’ ${valueText(target, group.value)}`).join(", ");
  if (rank === 0) {
    sentences.push({ level: "critical", text: `${measure}에 가장 큰 영향을 준 건 ${ending(focus.baseName)}. ${ending(listed)}.` });
  } else {
    sentences.push({ level: "important", text: `${focus.baseName}에 따라 ${measure}${josa(measure, "이/가")} ${listed}${josa(listed, "으로/로")} 달라요.` });
    if (rank > 0) sentences.push({ level: "info", text: `${focus.baseName}${josa(focus.baseName, "은/는")} 영향이 ${rank + 1}번째로 큰 요인이고, 가장 큰 요인은 ${ending(ranked[0].baseName)}.` });
    else sentences.push({ level: "info", text: `${focus.baseName}${josa(focus.baseName, "은/는")} ${measure}에 주는 영향이 거의 없어요.` });
  }
  return sentences;
}

function periodTrendSentences(result) {
  const { target, period } = result;
  const values = period.periods.filter((item) => Number.isFinite(item.value));
  if (values.length < 2) return [];
  const first = values[0];
  const last = values[values.length - 1];
  const max = values.reduce((best, item) => (item.value > best.value ? item : best));
  const min = values.reduce((best, item) => (item.value < best.value ? item : best));
  const diff = last.value - first.value;
  return [
    {
      level: "important",
      text: `${target.baseName}${josa(target.baseName, "은/는")} ${first.label} ${formatValue(first.value, target.unit, 0)}에서 ${last.label} ${formatValue(last.value, target.unit, 0)}${josa(formatValue(last.value, target.unit, 0), "으로/로")} ${diff === 0 ? "같아요" : `${formatValue(Math.abs(diff), target.unit, 0)} ${diff > 0 ? "늘었어요" : "줄었어요"}`}.`,
    },
    {
      level: "info",
      text: `가장 높았던 때는 ${max.label}(${formatValue(max.value, target.unit, 0)}), 가장 낮았던 때는 ${min.label}(${formatValue(min.value, target.unit, 0)})예요.`,
    },
  ];
}

function extremeRowSentences(sheet, profiles, columnIndex, labelIndex = -1) {
  const column = profiles[columnIndex];
  const idProfile = profiles.find((profile) => profile.kind === "id");
  const rows = (sheet.rows || []).slice(1)
    .map((cells, offset) => ({ cells, rowNumber: sheet.rowNumbers?.[offset + 1] ?? offset + 2, value: Number(String(cells[columnIndex] ?? "").replace(/[^0-9.+-]/g, "")) }))
    .filter((row) => String(row.cells[columnIndex] ?? "").trim() && Number.isFinite(row.value));
  if (rows.length === 0) return [];
  const max = rows.reduce((best, row) => (row.value > best.value ? row : best));
  const min = rows.reduce((best, row) => (row.value < best.value ? row : best));
  const tiedMax = rows.filter((row) => row.value === max.value);
  const tiedMin = rows.filter((row) => row.value === min.value);
  // 항목 이름 열(예: 거래처명)이 있으면 그 이름으로, 없으면 번호 열·행 번호로 부른다.
  const who = (row) => (labelIndex >= 0 && String(row.cells[labelIndex] ?? "").trim()
    ? String(row.cells[labelIndex]).trim()
    : idProfile ? `${idProfile.baseName} ${row.cells[idProfile.index]}` : `${row.rowNumber}행`);
  const value = (row) => formatValue(row.value, column.unit, 1);
  // 같은 값이 여러 항목이면 한 곳만 '가장 크다'고 하지 않고 몇 곳인지 사실대로 알려 준다.
  const describe = (row, tied, word) => (tied.length > 1
    ? `가장 ${word} 값(${value(row)})인 항목은 ${tied.slice(0, 3).map(who).join(", ")}${tied.length > 3 ? " 등" : ""} ${tied.length}곳`
    : `가장 ${word} 건 ${who(row)}(${value(row)})`);
  if (max.value === min.value) {
    return [{ level: "info", text: `${column.baseName}${josa(column.baseName, "은/는")} 모든 항목이 ${value(max)}로 같아서 따로 강조할 부분이 없어요.` }];
  }
  return [{
    level: "important",
    text: `${column.baseName}${josa(column.baseName, "이/가")} ${describe(max, tiedMax, "큰")}, ${describe(min, tiedMin, "작은")}이에요.`,
  }];
}

function pickSheet(record, question) {
  const sheets = record.sheets || [];
  let best = { sheetIndex: 0, profiles: sheets[0] ? profileColumns(sheets[0]) : [], matched: [] };
  sheets.forEach((sheet, sheetIndex) => {
    if (!Array.isArray(sheet.rows) || sheet.rows.length < 2) return;
    const profiles = profileColumns(sheet);
    const matched = matchColumns(profiles, question);
    if (matched.length > best.matched.length) best = { sheetIndex, profiles, matched };
  });
  return best;
}

/**
 * 질문에 대한 답.
 * @returns {{ status: "answered"|"no_match"|"unsupported"|"empty", question: string, sentences: {level,text}[], spec: object, visualIds: string[], suggestions: string[] }}
 */
export function answerQuestion(record, question) {
  const text = String(question || "").trim();
  const base = { question: text, sentences: [], spec: emptySpec(), visualIds: [], suggestions: suggestQuestions(record) };
  if (!text) return { ...base, status: "empty" };
  if (!record || !Array.isArray(record.sheets) || record.sheets.length === 0) {
    return {
      ...base,
      status: "unsupported",
      sentences: [{ level: "info", text: "PDF처럼 표가 없는 문서는 질문에 바로 계산해 답할 수 없어요. ‘AI 핵심 요약’을 누르면 AI가 쓴 문서 요약을 볼 수 있어요." }],
    };
  }

  const intents = detectIntents(text);
  const { sheetIndex, profiles, matched } = pickSheet(record, text);
  const usable = matched.filter((profile) => profile.kind !== "id" && profile.kind !== "text");
  const idOnly = matched.filter((profile) => profile.kind === "id");

  let defaultResult = null;
  try {
    defaultResult = analyzeDrivers(record, { sheetIndex });
  } catch {
    defaultResult = null;
  }
  const targetIndexes = new Set((defaultResult?.targets || []).map((target) => target.index));
  const targetScore = new Map((defaultResult?.targets || []).map((target, index) => [target.index, index]));

  // 목표(결과) 열: 질문에 나온 값 열 중 목표 후보 순위가 가장 높은 것. 없으면 기본 목표.
  const valueColumns = usable.filter((profile) => VALUE_KINDS.has(profile.kind) && targetIndexes.has(profile.index))
    .sort((a, b) => (targetScore.get(a.index) ?? 99) - (targetScore.get(b.index) ?? 99));
  const targetProfile = valueColumns[0] || null;
  const factorProfile = usable.find((profile) => profile !== targetProfile && GROUP_KINDS.has(profile.kind)) || null;

  const topics = detectTopics(text, matched.flatMap((profile) => [profile.name, profile.baseName]));
  if (usable.length === 0 && !intents.why && !intents.trend && !intents.extreme && topics.length === 0) {
    const available = profiles.filter((profile) => profile.kind !== "empty" && profile.kind !== "id").map((profile) => profile.baseName).slice(0, 8);
    return {
      ...base,
      status: "no_match",
      sentences: [{
        level: "info",
        text: idOnly.length > 0
          ? `‘${idOnly[0].name}’${josa(idOnly[0].name, "은/는")} 행마다 붙인 번호라서 분석할 의미가 없어요. ${available.join(", ")} 중에서 물어봐 주세요.`
          : `질문에서 데이터의 항목 이름을 찾지 못했어요. ${available.join(", ")} 같은 이름을 넣어 물어봐 주세요.`,
      }],
    };
  }

  let result = null;
  try {
    result = analyzeDrivers(record, { sheetIndex, targetIndex: targetProfile?.index ?? null });
  } catch {
    result = null;
  }
  const isPeriods = result?.status === "ok" && result.mode === "periods" && result.period;
  const visuals = [];
  let sentences = [];

  if (result?.status === "ok" && (intents.why || (factorProfile && targetProfile && !isPeriods))) {
    // "왜/영향" 질문, 또는 "객실등급별 요금"처럼 그룹과 값이 함께 나온 질문 → 원인 분석 결과 중 해당 부분만.
    const driverVisuals = buildDriverVisualSpec(result, record).visuals;
    const periodFactor = isPeriods && factorProfile && result.factors.some((factor) => factor.columnIndex === factorProfile.index)
      ? factorProfile.index
      : null;
    if (periodFactor !== null) {
      // "주변공사가 매출에 영향?" → 그 조건별 평균 비교만.
      sentences = recordSentences(result, periodFactor);
      const bar = driverVisuals.find((visual) => visual.id === `driver-factor-${periodFactor}`);
      visuals.push(...driverVisuals.filter((visual) => visual.id === "driver-period-line"));
      if (bar) visuals.push(bar);
    } else if (isPeriods) {
      sentences = explainPeriod(result);
      const changeId = result.period.change;
      sentences.unshift({
        level: "critical",
        text: `${changeId.toLabel}의 ${result.target.baseName}${josa(result.target.baseName, "은/는")} 직전 ${changeId.fromLabel}보다 ${formatValue(Math.abs(changeId.pct ?? 0), "%")} ${changeId.abs < 0 ? "줄었어요" : changeId.abs > 0 ? "늘었어요" : "같아요"} (${formatValue(changeId.from, result.target.unit, 0)} → ${formatValue(changeId.to, result.target.unit, 0)}).`,
      });
      visuals.push(...driverVisuals.filter((visual) => visual.id === "driver-period-line" || visual.id.startsWith("driver-decomposition") || visual.id === "driver-comovers").slice(0, 3));
    } else {
      const focusIndex = factorProfile && result.factors.some((factor) => factor.columnIndex === factorProfile.index) ? factorProfile.index : null;
      sentences = recordSentences(result, focusIndex);
      if (focusIndex !== null) {
        const bar = driverVisuals.find((visual) => visual.id === `driver-factor-${focusIndex}`);
        if (bar) visuals.push(bar);
        else visuals.push(...driverVisuals.filter((visual) => visual.id === "driver-ranking"));
      } else {
        visuals.push(...driverVisuals.filter((visual) => visual.id === "driver-ranking"));
        const topBar = driverVisuals.find((visual) => visual.id.startsWith("driver-factor-"));
        if (topBar) visuals.push(topBar);
      }
    }
  } else {
    // 추이·최고/최저·단순 조회 → 질문에 나온 숫자 열만 그린다.
    const columns = usable.filter((profile) => profile.isNumeric && profile.kind !== "binary").map((profile) => profile.index);
    const fallback = targetProfile ? [targetProfile.index] : defaultResult?.target ? [defaultResult.target.index] : [];
    const chosen = columns.length > 0 ? columns : fallback;
    // 같은 항목이 여러 행에 반복되는 기록형 표(승객 목록 등)만 요인 비교로 답하고,
    // 거래처 목록처럼 항목마다 한 행인 표는 '항목별 막대'(상위 10개)로 바로 보여 준다.
    const recordTable = result?.status === "ok" && result.mode === "records" && isRecordSheet(record.sheets[sheetIndex]);
    if (recordTable && chosen.length > 0) {
      // 기록형 표(승객 목록 등)는 행마다 막대를 그리지 않고, 최고·최저 행을 문장으로 알려 준 뒤 구간별 비교를 보여 준다.
      sentences = extremeRowSentences(record.sheets[sheetIndex], profiles, chosen[0]);
      const column = profiles[chosen[0]];
      // 비교 기준은 이 표의 대표 결과 열(예: 생존). 질문한 열이 곧 대표 결과면 그 열 자체의 요인을 본다.
      const outcomeIndex = defaultResult?.status === "ok" && defaultResult.target.index !== column.index ? defaultResult.target.index : result.target.index;
      const columnResult = analyzeDrivers(record, { sheetIndex, targetIndex: outcomeIndex });
      const bar = buildDriverVisualSpec(columnResult, record).visuals.find((visual) => visual.id === `driver-factor-${column.index}`);
      if (bar) {
        visuals.push(bar);
        const factor = columnResult.factors.find((item) => item.columnIndex === column.index);
        if (factor) sentences.push(...recordSentences(columnResult, column.index).slice(0, 1));
      } else {
        sentences.push({ level: "info", text: `${column.baseName}${josa(column.baseName, "은/는")} ${measureName(columnResult.target)}에 주는 영향이 거의 없어요.` });
        visuals.push(...buildDriverVisualSpec(columnResult, record).visuals.filter((visual) => visual.id === "driver-ranking"));
      }
    } else {
      visuals.push(...buildColumnVisuals(record, sheetIndex, chosen));
      const sheet = record.sheets[sheetIndex];
      const labelIndex = getLabelColumnIndex(sheet);
      const isBar = visuals[0]?.type === "bar_chart";
      if (isBar && chosen.length > 0) sentences = extremeRowSentences(sheet, profiles, chosen[0], labelIndex);
    }
    if (isPeriods && (columns.length <= 1)) {
      sentences = periodTrendSentences(result);
      if (intents.extreme && !intents.trend) sentences.reverse();
    }
    if (sentences.length === 0 && visuals[0]?.caption) sentences = [{ level: "important", text: visuals[0].caption }];
    if (visuals.length === 0 && factorProfile && result?.status === "ok") {
      sentences = recordSentences(result, factorProfile.index);
      const bar = buildDriverVisualSpec(result, record).visuals.find((visual) => visual.id === `driver-factor-${factorProfile.index}`);
      if (bar) visuals.push(bar);
    }
  }

  // 부가 정보에만 있던 그래프(변화 분해·함께 바뀐 지표·조합·요인 순위·그룹별 비교)를 질문에 맞으면 앞에 둔다.
  if (topics.length > 0 || visuals.length === 0) {
    try {
      // 조합·요인 순위는 질문에 열이 여럿 나와도 표의 대표 결과(예: 생존) 기준으로 본다.
      const useDefault = topics.includes("combination") || (topics.includes("ranking") && !targetProfile);
      const topicResult = !useDefault && result?.status === "ok" ? result : defaultResult;
      const driverVisuals = topicResult?.status === "ok" ? buildDriverVisualSpec(topicResult, record).visuals : [];
      const picked = [];
      TOPIC_PATTERNS.filter((topic) => topics.includes(topic.key)).forEach((topic) => {
        picked.push(...driverVisuals.filter((visual) => topic.ids(visual.id)));
      });
      if (topics.includes("group") && factorProfile) {
        const bar = driverVisuals.find((visual) => visual.id === `driver-factor-${factorProfile.index}`);
        if (bar) picked.push(bar);
      }
      if (picked.length === 0 && visuals.length === 0) {
        const fallback = bestTitleMatch(text, [...driverVisuals, ...(buildSpreadsheetVisualizationSpec(record).visuals || [])]);
        if (fallback) picked.push(fallback);
      }
      if (picked.length > 0) {
        const pickedIds = new Set(picked.map((visual) => visual.id));
        const detailTopics = topics.filter((topic) => ["decomposition", "comovers", "combination"].includes(topic));
        // 분해·함께 바뀐 지표·조합을 물으면 그 그래프만, 그 밖에는 고른 그래프를 맨 앞에 둔다.
        visuals.splice(0, visuals.length, ...picked, ...(detailTopics.length > 0 ? [] : visuals.filter((visual) => !pickedIds.has(visual.id))));
        if (detailTopics.length > 0 && topicResult?.status === "ok") {
          // 분해·함께 바뀐 지표·조합은 그 그래프의 해석 문장을 답으로 쓴다.
          const detailIds = [...pickedIds].filter((id) => !id.startsWith("driver-factor-") && id !== "driver-ranking");
          const topicSentences = topicInsightSentences(topicResult, detailIds);
          if (topicSentences.length > 0) sentences = topicSentences;
        } else if (topics.includes("group") && factorProfile && topicResult?.status === "ok"
          && topicResult.factors.some((factor) => factor.columnIndex === factorProfile.index)) {
          // "○○별/○○에 따라" 질문은 그룹별 값 비교 문장으로 답한다.
          sentences = recordSentences(topicResult, factorProfile.index);
        } else if (sentences.length === 0 && topicResult?.status === "ok") {
          sentences = topicInsightSentences(topicResult, [...pickedIds]);
        }
      }
    } catch {
      // 주제 그래프를 못 고르면 기존 답만 보여 준다.
    }
  }

  if (idOnly.length > 0) {
    sentences.unshift({ level: "info", text: `‘${idOnly[0].name}’${josa(idOnly[0].name, "은/는")} 행마다 붙인 번호라 답에서 뺐어요.` });
  }

  const unique = [];
  const seen = new Set();
  visuals.forEach((visual) => {
    if (!visual || seen.has(visual.id)) return;
    seen.add(visual.id);
    unique.push({ ...visual, id: visual.id.startsWith("question-") ? visual.id : `question-${visual.id}` });
  });

  if (unique.length === 0 && sentences.length === 0) {
    return {
      ...base,
      status: "no_match",
      sentences: [{ level: "info", text: "이 질문에 맞는 그래프를 만들 수 있는 숫자 데이터가 없어요. 다른 항목으로 물어봐 주세요." }],
    };
  }

  return {
    ...base,
    status: "answered",
    sentences: sentences.slice(0, 4),
    spec: { status: "ok", message: "", visuals: unique },
    visualIds: unique.map((visual) => visual.id),
  };
}

// 데이터에 맞춘 예시 질문(최대 3개).
export function suggestQuestions(record) {
  if (!record || !Array.isArray(record.sheets) || record.sheets.length === 0) return [];
  let result = null;
  try {
    result = analyzeDrivers(record, { sheetIndex: 0 });
  } catch {
    result = null;
  }
  if (result?.status !== "ok") {
    const profiles = record.sheets[0]?.rows ? profileColumns(record.sheets[0]) : [];
    const numeric = profiles.find((profile) => profile.kind === "numeric" || profile.kind === "numeric_discrete");
    return numeric ? [`${numeric.baseName}${josa(numeric.baseName, "이/가")} 가장 높은 항목은?`] : [];
  }
  const name = result.target.baseName;
  if (result.mode === "periods") {
    return [
      `${name}${josa(name, "이/가")} 왜 ${result.period?.change?.abs < 0 ? "떨어졌어?" : "바뀌었어?"}`,
      `${name} 추이 보여줘`,
      `${name}${josa(name, "이/가")} 가장 높았던 때는?`,
    ];
  }
  const measure = measureName(result.target);
  const second = result.factors[1];
  return [
    `${measure}에 가장 큰 영향을 준 건?`,
    ...(second ? [`${second.baseName}에 따라 ${measure}${josa(measure, "이/가")} 달라?`] : []),
  ];
}
