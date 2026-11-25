// 인수인계 요약: 엑셀 한 파일의 여러 시트를 함께 읽어
// "지금 상태 · 바쁜 시기 · 조심할 대상 · 반복되는 문제 · 놓치면 안 되는 정기 업무"를 계산합니다.
// AI를 쓰지 않고 원본 행에서 직접 계산하며, 모든 문장에 근거 값·계산법·행 번호를 붙입니다.
import { analyzeDrivers, formatValue, josa, profileColumns, suggestTargets } from "./driver-analysis.js";
import { parseNumber } from "./value-parsing.js";
import { sortInsightsByPriority } from "./insight-priority.js";

export const HANDOVER_SECTIONS = [
  { key: "status", title: "지금 상태", empty: "월별·주별처럼 기간마다 한 행씩 쌓인 시트가 있으면 최근 상태를 보여드려요." },
  { key: "busy", title: "바쁜 시기", empty: "기간별 시트에 접수·주문·매출 같은 물량 열이 있으면 몰리는 시기를 찾아드려요." },
  { key: "watch", title: "조심할 대상", empty: "거래처·고객 목록에 ‘이탈위험(높음/낮음)’ 같은 두 값 열이 있으면 먼저 챙길 곳을 골라드려요." },
  { key: "problem", title: "반복되는 문제", empty: "이슈·클레임 기록에 ‘재발(예/아니오)’ 같은 두 값 열이 있으면 반복되는 유형을 찾아드려요." },
  { key: "routine", title: "놓치면 안 되는 정기 업무", empty: "‘업무·주기·기준일·중요도’ 열이 있는 일정 시트가 있으면 중요한 업무를 모아드려요." },
];

const VOLUME_HINT = /접수|주문|요청|문의|물량|건수|매출|판매|출고|입고|volume|orders?|requests?|sales/i;
const PROBLEM_HINT = /재발|반복|이슈|클레임|오류|불량|장애|문제|사고|민원|issue|claim|incident|defect|repeat/i;
const WATCH_HINT = /위험|이탈|미수|연체|해지|risk|churn|overdue/i;
const MONEY_HINT = /금액|매출|거래액|미수|연체|잔액|원\)|만원|억원|amount|revenue/i;
const TASK_HINT = /업무|작업|할\s*일|항목|task/i;
const CYCLE_HINT = /주기|빈도|cycle|frequency/i;
const DUE_HINT = /기준일|마감|일정|기한|날짜|due|deadline/i;
const PRIORITY_HINT = /중요도|우선순위|priority/i;
const NOTE_HINT = /주의|비고|메모|참고|note/i;
const HIGH_PRIORITY = /^(상|높음|최상|긴급|high|critical|1)$/i;
const MONTH_PATTERN = /^\s*(\d{4})\s*[-./년]\s*(\d{1,2})\s*월?\s*$/;

function sourceIdFor(sheetIndex, sheet, rowIndex) {
  return `sheet:${sheetIndex}:row:${sheet.rowNumbers?.[rowIndex] ?? rowIndex + 1}`;
}

function getRows(sheet, sheetIndex) {
  return (sheet.rows || []).slice(1).flatMap((cells, offset) => {
    if (!cells.some((cell) => String(cell ?? "").trim())) return [];
    const rowIndex = offset + 1;
    return [{ rowNumber: sheet.rowNumbers?.[rowIndex] ?? rowIndex + 1, sourceId: sourceIdFor(sheetIndex, sheet, rowIndex), cells }];
  });
}

function cell(row, index) {
  return String(row.cells[index] ?? "").trim();
}

function summarizeRows(rowNumbers, limit = 6) {
  const sorted = [...new Set(rowNumbers)].sort((a, b) => a - b);
  const shown = sorted.slice(0, limit).join(", ");
  return sorted.length > limit ? `${shown} 외 ${sorted.length - limit}개 행` : `${shown}행`;
}

function mean(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

function pct(from, to) {
  return Number.isFinite(from) && Number.isFinite(to) && from !== 0 ? ((to - from) / Math.abs(from)) * 100 : null;
}

function signedPct(value) {
  if (value === null) return "계산 불가";
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${formatValue(Math.abs(value), "%")}`;
}

function value(number, profile) {
  return formatValue(number, profile.unit);
}

// ---------------------------------------------------------------------------
// 시트 역할 나누기

function findColumn(profiles, pattern, kinds = null) {
  return profiles.find((profile) => pattern.test(profile.name) && (!kinds || kinds.includes(profile.kind)));
}

function classifySheet(sheet, sheetIndex) {
  if (!Array.isArray(sheet.rows) || sheet.rows.length < 3) return null;
  const profiles = profileColumns(sheet);
  const filled = (profile) => profile.filledCount > 0;

  const task = findColumn(profiles, TASK_HINT, ["text", "categorical", "id"]);
  const cycle = findColumn(profiles, CYCLE_HINT);
  if (task && cycle) return { role: "routine", sheet, sheetIndex, profiles };

  const temporal = profiles.find((profile) => profile.kind === "temporal");
  if (temporal && temporal.uniqueCount === temporal.filledCount && temporal.filledCount >= 4
    && profiles.some((profile) => profile.isNumeric && profile.index !== temporal.index && filled(profile))) {
    return { role: "period", sheet, sheetIndex, profiles, temporal };
  }

  const binaries = profiles.filter((profile) => profile.kind === "binary");
  if (binaries.length === 0 || sheet.rows.length < 6) return null;
  const targets = suggestTargets(sheet).filter((target) => target.kind === "binary");
  const problemTarget = targets.find((target) => PROBLEM_HINT.test(target.name));
  const watchTarget = targets.find((target) => WATCH_HINT.test(target.name));
  if (problemTarget && !watchTarget) return { role: "problem", sheet, sheetIndex, profiles, targetIndex: problemTarget.index };
  if (watchTarget) return { role: "watch", sheet, sheetIndex, profiles, targetIndex: watchTarget.index };
  // 열 이름으로 알 수 없으면 시트 이름으로 판단하고, 그래도 모르면 인수인계 요약에서 뺍니다. (예: 생존 데이터)
  if (PROBLEM_HINT.test(sheet.name)) return { role: "problem", sheet, sheetIndex, profiles, targetIndex: targets[0].index };
  if (WATCH_HINT.test(sheet.name) || /거래처|고객|협력사|client|customer|account/i.test(sheet.name)) {
    return { role: "watch", sheet, sheetIndex, profiles, targetIndex: targets[0].index };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1. 지금 상태 (기간형 시트)

function getPeriods(info) {
  return getRows(info.sheet, info.sheetIndex)
    .map((row) => ({ row, label: cell(row, info.temporal.index) }))
    .sort((a, b) => a.label.localeCompare(b.label, "ko", { numeric: true }));
}

function analyzeStatus(info) {
  const periods = getPeriods(info);
  if (periods.length < 3) return [];
  const latest = periods.at(-1);
  const previous = periods.at(-2);
  const numeric = info.profiles.filter((profile) => profile.index !== info.temporal.index && profile.isNumeric && profile.filledCount > 0);
  const insights = [];

  const rows = numeric.map((profile) => {
    const series = periods.map((period) => parseNumber(cell(period.row, profile.index)));
    const now = series.at(-1);
    const before = series.at(-2);
    const average = mean(series);
    return { profile, now, before, average, vsAverage: pct(average, now), vsPrevious: pct(before, now) };
  }).filter((item) => Number.isFinite(item.now) && item.vsAverage !== null)
    .sort((a, b) => Math.abs(b.vsAverage) - Math.abs(a.vsAverage));

  if (rows.length > 0) {
    const shown = rows.slice(0, 4);
    const notable = shown.filter((item) => Math.abs(item.vsAverage) >= 15);
    const parts = shown.map((item) => `${item.profile.baseName} ${value(item.now, item.profile)}(평균 대비 ${signedPct(item.vsAverage)})`);
    insights.push({
      id: "status-latest",
      level: notable.length > 0 ? "critical" : "info",
      title: `최근 ${latest.label} 기준 주요 수치`,
      sentence: `${latest.label}에는 ${parts.join(", ")}예요.${notable.length > 0 ? ` 특히 ${notable.map((item) => item.profile.baseName).join("·")}${josa(notable.at(-1).profile.baseName, "은/는")} 전체 ${periods.length}개 기간 평균과 15% 넘게 달라요.` : " 전체 기간 평균과 크게 다르지 않아요."}`,
      evidence: shown.flatMap((item) => [
        { label: `${latest.label} ${item.profile.baseName}`, value: value(item.now, item.profile) },
        { label: `${item.profile.baseName} ${periods.length}개 기간 평균`, value: value(item.average, item.profile) },
      ]).slice(0, 8),
      method: `최근 기간 값과 전체 기간 평균을 비교했어요. 평균 대비 = (최근 값 − 평균) ÷ 평균. 평균에서 가장 많이 벗어난 순서로 ${shown.length}개 열을 골랐어요.`,
      sourceIds: [latest.row.sourceId],
      rowSummary: `${latest.row.rowNumber}행 (평균은 ${periods.length}개 기간 전체)`,
    });
  }

  // 지금 조건(범주 열의 최근 값)
  const categories = info.profiles.filter((profile) => ["categorical", "binary"].includes(profile.kind) && profile.index !== info.temporal.index);
  if (categories.length > 0) {
    insights.push({
      id: "status-conditions",
      level: "info",
      title: "최근 기간의 조건",
      sentence: `${latest.label} 기준 ${categories.map((profile) => `${profile.baseName} ‘${cell(latest.row, profile.index) || "빈칸"}’`).join(", ")}이에요.`,
      evidence: categories.map((profile) => ({ label: profile.baseName, value: `${cell(previous.row, profile.index) || "빈칸"} → ${cell(latest.row, profile.index) || "빈칸"}` })),
      method: "최근 기간 행의 범주 값을 그대로 옮겼어요. 근거 값은 ‘직전 기간 → 최근 기간’이에요.",
      sourceIds: [previous.row.sourceId, latest.row.sourceId],
      rowSummary: `${previous.row.rowNumber}, ${latest.row.rowNumber}행`,
    });
  }

  // 지난 큰 변화: 드물게 바뀌는 범주 열이 바뀐 시점
  const main = analyzeDrivers({ sheets: replaceSheet(info) }, { sheetIndex: info.sheetIndex });
  const mainProfile = main.status === "ok" && main.target.kind === "numeric" ? info.profiles[main.target.index] : null;
  if (mainProfile) {
    const events = [];
    categories.forEach((profile) => {
      const changes = [];
      for (let index = 1; index < periods.length; index += 1) {
        const from = cell(periods[index - 1].row, profile.index);
        const to = cell(periods[index].row, profile.index);
        if (from !== to) changes.push({ index, from, to });
      }
      if (changes.length === 0 || changes.length > Math.max(2, periods.length / 4)) return; // 매달 바뀌는 열(예: 월구분)은 사건이 아님
      changes.forEach(({ index, from, to }) => {
        const before = parseNumber(cell(periods[index - 1].row, mainProfile.index));
        const after = parseNumber(cell(periods[index].row, mainProfile.index));
        events.push({ profile, index, from, to, before, after, change: pct(before, after) });
      });
    });
    events.filter((event) => event.change !== null)
      .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
      .slice(0, 3)
      .map((event, order) => ({ ...event, order }))
      .sort((a, b) => a.index - b.index)
      .forEach((event) => {
        const { order } = event;
        const prev = periods[event.index - 1];
        const curr = periods[event.index];
        insights.push({
          id: `status-event-${event.profile.index}-${event.index}`,
          level: order === 0 && Math.abs(event.change) >= 10 ? "critical" : "important",
          title: `${curr.label} ${event.profile.baseName}: ${event.from} → ${event.to}`,
          sentence: `${curr.label}에 ${event.profile.baseName}${josa(event.profile.baseName, "이/가")} ‘${event.from}’에서 ‘${event.to}’${josa(event.to, "으로/로")} 바뀌었고, 같은 달 ${mainProfile.baseName}${josa(mainProfile.baseName, "은/는")} ${value(event.before, mainProfile)}에서 ${value(event.after, mainProfile)}${josa(value(event.after, mainProfile), "으로/로")} ${signedPct(event.change)} 변했어요. 비슷한 일이 생기면 이 시기를 참고하세요.`,
          evidence: [
            { label: `${prev.label} ${mainProfile.baseName}`, value: value(event.before, mainProfile) },
            { label: `${curr.label} ${mainProfile.baseName}`, value: value(event.after, mainProfile) },
            { label: event.profile.baseName, value: `${event.from} → ${event.to}` },
          ],
          method: `전체 기간에서 ${Math.max(2, Math.floor(periods.length / 4))}번 이하로만 바뀐 범주 열을 ‘사건’으로 보고, 바뀐 기간의 ${mainProfile.baseName} 변화율 = (이번 − 직전) ÷ 직전을 계산했어요. 변화가 큰 순서로 최대 3개를 보여줘요.`,
          sourceIds: [prev.row.sourceId, curr.row.sourceId],
          rowSummary: `${prev.row.rowNumber}, ${curr.row.rowNumber}행`,
        });
      });
  }
  return insights;
}

function replaceSheet(info) {
  const sheets = [];
  sheets[info.sheetIndex] = info.sheet;
  return sheets;
}

// ---------------------------------------------------------------------------
// 2. 바쁜 시기 (기간형 시트)

function pickVolumeColumn(info) {
  const numeric = info.profiles.filter((profile) => profile.index !== info.temporal.index && profile.kind === "numeric");
  return numeric.find((profile) => /접수|주문|요청|물량/.test(profile.name))
    || numeric.find((profile) => VOLUME_HINT.test(profile.name))
    || numeric[0]
    || null;
}

function analyzeBusy(info) {
  const volume = pickVolumeColumn(info);
  if (!volume) return [];
  const periods = getPeriods(info)
    .map((period) => ({ ...period, y: parseNumber(cell(period.row, volume.index)) }))
    .filter((period) => Number.isFinite(period.y));
  if (periods.length < 4) return [];
  const overall = mean(periods.map((period) => period.y));
  const insights = [];

  // 달력 월별 평균 (YYYY-MM 형식일 때)
  const monthly = new Map();
  periods.forEach((period) => {
    const month = Number(period.label.match(MONTH_PATTERN)?.[2]);
    if (!month) return;
    if (!monthly.has(month)) monthly.set(month, []);
    monthly.get(month).push(period);
  });
  if (monthly.size >= 6) {
    const repeated = [...monthly.values()].some((list) => list.length >= 2);
    const ranked = [...monthly.entries()]
      .map(([month, list]) => ({ month, list, average: mean(list.map((period) => period.y)) }))
      .map((item) => ({ ...item, lift: pct(overall, item.average) }))
      .sort((a, b) => b.average - a.average);
    const busy = ranked.filter((item) => item.lift >= 10).slice(0, 4);
    if (busy.length > 0) {
      const busyRows = busy.flatMap((item) => item.list);
      insights.push({
        id: "busy-months",
        level: "critical",
        title: `${busy.map((item) => `${item.month}월`).join("·")}에 ${volume.baseName}${josa(volume.baseName, "이/가")} 몰려요`,
        sentence: `${volume.baseName} 전체 평균은 ${value(overall, volume)}인데, ${busy.map((item) => `${item.month}월 평균 ${value(item.average, volume)}(${signedPct(item.lift)})`).join(", ")}이에요.${repeated ? " 해마다 같은 달에 반복돼요." : " 아직 한 해 자료라 반복 여부는 더 지켜봐야 해요."}`,
        evidence: ranked.slice(0, 6).map((item) => ({ label: `${item.month}월 (${item.list.length}개 기간)`, value: value(item.average, volume) })),
        method: `같은 달력 월끼리 ${volume.baseName} 평균을 내고 전체 평균과 비교했어요. 10% 이상 많은 달만 골랐어요.`,
        sourceIds: busyRows.map((period) => period.row.sourceId).slice(0, 6),
        rowSummary: summarizeRows(busyRows.map((period) => period.row.rowNumber)),
      });
    }
  }

  // 범주 열(예: 월구분 = 분기말/일반)별 평균
  info.profiles
    .filter((profile) => ["categorical", "binary"].includes(profile.kind) && profile.uniqueCount <= 6)
    .map((profile) => {
      const groups = new Map();
      periods.forEach((period) => {
        const key = cell(period.row, profile.index);
        if (!key) return;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(period);
      });
      const list = [...groups.entries()].map(([label, items]) => ({ label, items, average: mean(items.map((period) => period.y)) }))
        .sort((a, b) => b.average - a.average);
      const top = list[0];
      const base = list.reduce((best, item) => (item.items.length > best.items.length ? item : best), list[0]);
      return { profile, list, top, base, lift: top && base && top !== base ? pct(base.average, top.average) : null };
    })
    .filter((item) => item.lift !== null && item.lift >= 10 && item.top.items.length >= 2)
    .sort((a, b) => b.lift - a.lift)
    .slice(0, 2)
    .forEach((item) => {
      insights.push({
        id: `busy-category-${item.profile.index}`,
        level: "important",
        title: `${item.profile.baseName} ‘${item.top.label}’일 때 ${volume.baseName}${josa(volume.baseName, "이/가")} 많아요`,
        sentence: `${item.profile.baseName}${josa(item.profile.baseName, "이/가")} ‘${item.top.label}’인 기간의 평균 ${volume.baseName}${josa(volume.baseName, "은/는")} ${value(item.top.average, volume)}(${item.top.items.length}개 기간)로, 가장 흔한 ‘${item.base.label}’ ${value(item.base.average, volume)}보다 ${signedPct(item.lift)} 많아요.`,
        evidence: item.list.map((group) => ({ label: `${group.label} (${group.items.length}개 기간)`, value: value(group.average, volume) })),
        method: `${item.profile.baseName} 값별로 ${volume.baseName} 평균을 내고, 가장 많은 그룹을 가장 흔한 그룹과 비교했어요.`,
        sourceIds: item.top.items.map((period) => period.row.sourceId).slice(0, 6),
        rowSummary: summarizeRows(item.top.items.map((period) => period.row.rowNumber)),
      });
    });

  // 가장 많았던 기간
  const peak = periods.reduce((best, period) => (period.y > best.y ? period : best), periods[0]);
  insights.push({
    id: "busy-peak",
    level: "info",
    title: `가장 많았던 기간: ${peak.label}`,
    sentence: `${volume.baseName}${josa(volume.baseName, "이/가")} 가장 많았던 기간은 ${peak.label}(${value(peak.y, volume)})로, 전체 평균 ${value(overall, volume)}보다 ${signedPct(pct(overall, peak.y))} 많았어요.`,
    evidence: [{ label: `${peak.label} ${volume.baseName}`, value: value(peak.y, volume) }, { label: "전체 평균", value: value(overall, volume) }],
    method: `${periods.length}개 기간 중 ${volume.baseName} 최댓값을 골랐어요.`,
    sourceIds: [peak.row.sourceId],
    rowSummary: `${peak.row.rowNumber}행`,
  });
  return insights;
}

// ---------------------------------------------------------------------------
// 3. 조심할 대상 / 4. 반복되는 문제 (기록형 시트)

function getNameColumn(profiles, targetIndex) {
  return profiles.find((profile) => profile.index !== targetIndex && ["text", "id"].includes(profile.kind) && !profile.isNumeric && !NOTE_HINT.test(profile.name))
    || profiles.find((profile) => profile.index !== targetIndex && ["text", "id"].includes(profile.kind));
}

// 원인 분석 결과 중 우연이 아닐 가능성이 높은 요인(p < 0.05)과 조합만 가져옵니다.
function pickDriverInsights(result, limit) {
  const significant = new Set(result.factors.filter((factor) => factor.pValue !== null && factor.pValue < 0.05).map((factor) => `factor-${factor.columnIndex}`));
  return (result.insights || []).filter((insight) => significant.has(insight.id) || insight.id === "combination").slice(0, limit);
}

function analyzeWatch(info) {
  const result = analyzeDrivers({ sheets: replaceSheet(info) }, { sheetIndex: info.sheetIndex, targetIndex: info.targetIndex });
  if (result.status !== "ok" || result.target.kind !== "binary") return [];
  const { target } = result;
  const rows = getRows(info.sheet, info.sheetIndex);
  const flagged = rows.filter((row) => cell(row, target.index) === target.positiveValue);
  const insights = [];
  if (flagged.length === 0) return insights;

  // 상위 요인에서 비율이 전체보다 1.5배 이상 높은 그룹을 ‘위험 조건’으로 봅니다.
  const conditions = result.factors
    .filter((factor) => factor.eta2 >= 0.06 && factor.pValue !== null && factor.pValue < 0.05)
    .slice(0, 3)
    .flatMap((factor) => factor.groups
      .filter((group) => !group.small && group.value >= target.overall * 1.5)
      .map((group) => ({ label: `${factor.baseName} ${group.label}`, sourceIds: new Set(group.sourceIds) })));
  const nameColumn = getNameColumn(info.profiles, target.index);
  const moneyColumn = info.profiles
    .filter((profile) => profile.kind === "numeric" && MONEY_HINT.test(profile.name))
    .sort((a, b) => (WATCH_HINT.test(b.name) ? 1 : 0) - (WATCH_HINT.test(a.name) ? 1 : 0))[0];

  const ranked = flagged.map((row) => ({
    row,
    name: nameColumn ? cell(row, nameColumn.index) : `${row.rowNumber}행`,
    matched: conditions.filter((condition) => condition.sourceIds.has(row.sourceId)).map((condition) => condition.label),
    money: moneyColumn ? parseNumber(cell(row, moneyColumn.index)) : null,
  })).sort((a, b) => b.matched.length - a.matched.length || (b.money ?? -Infinity) - (a.money ?? -Infinity));
  const top = ranked.slice(0, 5);

  insights.push({
    id: "watch-list",
    level: "critical",
    title: `먼저 챙길 ${top.length}곳`,
    sentence: `${target.baseName}=${target.positiveValue}인 ${flagged.length}곳(전체 ${rows.length}곳 중 ${formatValue((flagged.length / rows.length) * 100, "%")}) 가운데 ${[conditions.length > 0 ? "위험 조건에 많이 해당하는" : "", moneyColumn ? `${moneyColumn.baseName}${josa(moneyColumn.baseName, "이/가")} 큰` : ""].filter(Boolean).join(" 순, ") || "원본"} 순서로 ${top.map((item) => item.name).join(", ")}부터 챙기세요.`,
    evidence: top.map((item) => ({
      label: item.name,
      value: [item.matched.join(" · "), moneyColumn && Number.isFinite(item.money) ? `${moneyColumn.baseName} ${value(item.money, moneyColumn)}` : ""].filter(Boolean).join(" / ") || `${target.baseName} ${target.positiveValue}`,
    })),
    method: `${target.baseName}=${target.positiveValue}인 행만 골랐어요. ${conditions.length > 0 ? `위험 조건(${conditions.map((condition) => condition.label).join(", ")})은 영향이 보통 이상(η² ≥ 0.06, p < 0.05)인 요인에서 ${target.baseName}=${target.positiveValue} 비율이 전체(${formatValue(target.overall * 100, "%")})의 1.5배 이상인 그룹이에요. 해당 조건 수가 많은 순, ` : ""}${moneyColumn ? `같으면 ${moneyColumn.baseName}${josa(moneyColumn.baseName, "이/가")} 큰 순으로 ` : ""}정렬했어요.`,
    sourceIds: top.map((item) => item.row.sourceId),
    rowSummary: summarizeRows(top.map((item) => item.row.rowNumber)),
  });
  insights.push(...pickDriverInsights(result, 2).map((insight) => ({ ...insight, id: `watch-${insight.id}` })));
  return insights;
}

function analyzeProblem(info) {
  const result = analyzeDrivers({ sheets: replaceSheet(info) }, { sheetIndex: info.sheetIndex, targetIndex: info.targetIndex });
  if (result.status !== "ok" || result.target.kind !== "binary") return [];
  const { target } = result;
  const rows = getRows(info.sheet, info.sheetIndex);
  const flagged = rows.filter((row) => cell(row, target.index) === target.positiveValue);
  const insights = [];

  // 해당 행 안에서 가장 흔한 범주 값 (예: 재발 이슈 중 정산오류)
  const category = result.factors.find((factor) => factor.kind === "categorical");
  if (category && flagged.length > 0) {
    const counts = new Map();
    flagged.forEach((row) => {
      const key = cell(row, category.columnIndex) || "빈칸";
      if (!counts.has(key)) counts.set(key, []);
      counts.get(key).push(row);
    });
    const list = [...counts.entries()].sort((a, b) => b[1].length - a[1].length);
    const [label, items] = list[0];
    insights.push({
      id: "problem-share",
      level: "critical",
      title: `${target.baseName} 기록의 ${formatValue((items.length / flagged.length) * 100, "%")}가 ‘${label}’`,
      sentence: `${target.baseName}=${target.positiveValue}인 ${flagged.length}건 중 ${items.length}건이 ${category.baseName} ‘${label}’${josa(label, "이에요/예요")}. ${list.slice(1, 3).map(([other, otherItems]) => `‘${other}’ ${otherItems.length}건`).join(", ")}${list.length > 1 ? "보다 훨씬 많아요." : ""}`,
      evidence: list.slice(0, 6).map(([key, keyItems]) => ({ label: key, value: `${keyItems.length}건` })),
      method: `${target.baseName}=${target.positiveValue}인 행만 모아 ${category.baseName} 값별로 셌어요.`,
      sourceIds: items.map((row) => row.sourceId).slice(0, 6),
      rowSummary: summarizeRows(items.map((row) => row.rowNumber)),
    });
  }
  insights.push(...pickDriverInsights(result, 3).map((insight) => ({ ...insight, id: `problem-${insight.id}` })));
  return insights;
}

// ---------------------------------------------------------------------------
// 5. 정기 업무 (일정 시트)

function analyzeRoutine(info) {
  const { profiles } = info;
  const task = findColumn(profiles, TASK_HINT, ["text", "categorical", "id"]);
  const cycle = findColumn(profiles, CYCLE_HINT);
  const due = findColumn(profiles, DUE_HINT);
  const priority = findColumn(profiles, PRIORITY_HINT);
  const note = findColumn(profiles, NOTE_HINT);
  const rows = getRows(info.sheet, info.sheetIndex);
  const important = priority ? rows.filter((row) => HIGH_PRIORITY.test(cell(row, priority.index))) : rows;
  const chosen = (important.length > 0 ? important : rows).slice(0, 6);
  if (chosen.length === 0) return [];
  return [{
    id: "routine-important",
    level: "important",
    title: priority ? `중요도 ‘${cell(chosen[0], priority.index)}’ 업무 ${important.length}개` : `정기 업무 ${rows.length}개`,
    sentence: `꼭 챙길 업무: ${chosen.map((row) => `${cell(row, task.index)}(${[cycle && cell(row, cycle.index), due && cell(row, due.index)].filter(Boolean).join(", ")})`).join(", ")}${important.length > chosen.length ? ` 외 ${important.length - chosen.length}개` : ""}.`,
    evidence: chosen.map((row) => ({ label: cell(row, task.index), value: note ? cell(row, note.index) || "-" : [cycle && cell(row, cycle.index), due && cell(row, due.index)].filter(Boolean).join(" · ") })),
    method: priority ? `${priority.baseName}${josa(priority.baseName, "이/가")} 가장 높은 값(상·높음·긴급 등)인 행을 원본 순서대로 골랐어요.${note ? ` 근거 값은 ${note.baseName} 열이에요.` : ""}` : "일정 시트의 행을 원본 순서대로 옮겼어요.",
    sourceIds: chosen.map((row) => row.sourceId),
    rowSummary: summarizeRows(chosen.map((row) => row.rowNumber)),
  }];
}

// ---------------------------------------------------------------------------
// 공개 API

const ANALYZERS = {
  status: { role: "period", run: analyzeStatus },
  busy: { role: "period", run: analyzeBusy },
  watch: { role: "watch", run: analyzeWatch },
  problem: { role: "problem", run: analyzeProblem },
  routine: { role: "routine", run: analyzeRoutine },
};

export function analyzeHandover(record) {
  if (!record || record.type === "pdf" || !Array.isArray(record.sheets)) {
    return { status: "insufficient_data", message: "인수인계 요약은 엑셀·CSV 파일에서 만들 수 있어요.", sections: [] };
  }
  const infos = record.sheets.map((sheet, index) => classifySheet(sheet, index)).filter(Boolean);
  const sections = HANDOVER_SECTIONS.map((section) => {
    const { role, run } = ANALYZERS[section.key];
    const sources = infos.filter((info) => info.role === role);
    const insights = sortInsightsByPriority(sources.flatMap((info) => run(info).map((insight) => ({ ...insight, sheetName: info.sheet.name }))));
    return { ...section, sheetNames: sources.map((info) => info.sheet.name), insights };
  });
  const found = sections.filter((section) => section.insights.length > 0).length;
  return {
    status: found > 0 ? "ok" : "insufficient_data",
    message: found > 0
      ? `${record.sheets.length}개 시트에서 ${found}개 항목을 찾았어요.`
      : "인수인계 요약에 쓸 만한 시트(기간별 기록, 거래처 목록, 이슈 기록, 정기 업무 일정)를 찾지 못했어요.",
    roles: infos.map((info) => ({ sheetIndex: info.sheetIndex, sheetName: info.sheet.name, role: info.role })),
    sections,
  };
}
