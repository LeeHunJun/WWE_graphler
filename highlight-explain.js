// "중요한 부분"을 눌렀을 때 계산식 대신 보여 줄 해석 문장.
// 모든 숫자는 driver-analysis.js가 원본 행에서 직접 계산한 값이며, AI는 관여하지 않습니다.
// 문장은 "~일 수 있어요"처럼 추정으로 표현합니다(인과 확정 아님).

import { analyzeDrivers, formatValue, josa, profileColumns } from "./driver-analysis.js";

const SOURCE_PATTERN = /^sheet:(\d+):row:(\d+)$/;
const MAX_SENTENCES = 3;

function parseSourceId(sourceId) {
  const match = SOURCE_PATTERN.exec(String(sourceId || ""));
  return match ? { sheetIndex: Number(match[1]), rowNumber: Number(match[2]) } : null;
}

function findRowCells(sheet, rowNumber) {
  const rows = sheet.rows || [];
  for (let index = 1; index < rows.length; index += 1) {
    if ((sheet.rowNumbers?.[index] ?? index + 1) === rowNumber) return rows[index];
  }
  return null;
}

function seriesNameOf(visual, highlight) {
  if (visual?.type === "bar_chart") return visual.data?.series_name || "";
  if (visual?.type === "line_chart") {
    const series = visual.data?.series || [];
    return (series.find((item) => item.id === highlight?.target?.series_id) || series[0])?.name || "";
  }
  return "";
}

// 이진 목표(생존 여부 등)는 "생존률"처럼, 숫자 목표는 열 이름 그대로 부른다.
function measureName(target) {
  if (target.kind !== "binary") return target.baseName;
  const stem = target.baseName.replace(/\s*(여부|유무)$/, "");
  return /[가-힣]$/.test(stem) ? `${stem}률` : `‘${target.baseName}=${target.positiveValue}’ 비율`;
}

function valueText(target, value) {
  return target.kind === "binary" ? formatValue(value * 100, "%", 0) : formatValue(value, target.unit, 1);
}

function amountChangeText(item) {
  const diff = item.to - item.from;
  const amount = formatValue(Math.abs(diff), item.unit, Number.isInteger(diff) ? 0 : 1);
  return `${formatValue(item.from, item.unit, 1)} → ${formatValue(item.to, item.unit, 1)}, ${amount} ${diff < 0 ? "감소" : "증가"}`;
}

function explainPeriod(result, exclude = new Set()) {
  const { target, period, factors = [] } = result;
  const { change } = period;
  const sentences = [];
  if (!Number.isFinite(change.abs) || change.abs === 0) {
    sentences.push({ level: "info", text: `${change.toLabel}의 ${target.baseName}${josa(target.baseName, "은/는")} 직전 ${change.fromLabel}${josa(change.fromLabel, "과/와")} 같아요.` });
    return sentences;
  }
  const fell = change.abs < 0;
  const moved = fell ? "떨어졌을" : "올랐을";
  const subject = `${target.baseName}${josa(target.baseName, "이/가")}`;

  period.categoricalChanges.forEach((item) => {
    const from = item.from || "빈칸";
    const to = item.to || "빈칸";
    const factor = factors.find((candidate) => candidate.columnIndex === item.columnIndex);
    const toGroup = factor?.groups.find((group) => group.label === item.to);
    const fromGroup = factor?.groups.find((group) => group.label === item.from);
    // 전체 기간에서 바뀐 값('to')일 때의 평균이 실제로 같은 방향이면 원인 후보로, 아니면 참고로만 알려 준다.
    const consistent = toGroup && fromGroup ? (toGroup.value - fromGroup.value > 0) === (change.abs > 0) : true;
    sentences.push(consistent
      ? {
        level: "critical",
        text: `같은 시기에 ${item.baseName}${josa(item.baseName, "이/가")} ‘${from}’에서 ‘${to}’${josa(to, "으로/로")} 바뀌었어요. 그래서 ${subject} ${moved} 수 있어요.`,
      }
      : {
        level: "info",
        text: `같은 시기에 ${item.baseName}${josa(item.baseName, "도/도")} ‘${from}’에서 ‘${to}’${josa(to, "으로/로")} 바뀌었지만, 다른 기간을 보면 이것만으로는 설명되지 않아요.`,
      });
  });

  period.decompositions.slice(0, 1).forEach((decomposition) => {
    const main = [...decomposition.items].sort((a, b) => Math.abs(b.share ?? 0) - Math.abs(a.share ?? 0))[0];
    if (!main || main.share === null || !Number.isFinite(main.share) || main.share <= 0 || main.share > 1.05) return;
    if (exclude.has(main.columnIndex)) return;
    sentences.push({
      level: "important",
      text: `${target.baseName} ${fell ? "감소" : "증가"}분의 약 ${formatValue(Math.abs(main.share * 100), "%", 0)}는 ${main.baseName} 변화(${amountChangeText(main)}) 때문이에요.`,
    });
  });

  const decomposed = new Set(period.decompositions.flatMap((decomposition) => decomposition.items.map((item) => item.columnIndex)));
  // 평소 함께 움직이는 방향(상관 부호)과 이번 변화가 맞아떨어지는 항목만 원인 후보로 보여 준다.
  period.comovers
    .filter((item) => !item.downstream && !decomposed.has(item.columnIndex) && !exclude.has(item.columnIndex)
      && Number.isFinite(item.from) && Number.isFinite(item.to) && item.from !== item.to
      && Math.abs(item.correlation) >= 0.3
      && Math.sign(item.to - item.from) * Math.sign(change.abs) * Math.sign(item.correlation) > 0)
    .slice(0, 2)
    .forEach((item) => {
      sentences.push({
        level: Math.abs(item.correlation) >= 0.7 ? "important" : "info",
        text: `같은 시기 ${item.baseName}${josa(item.baseName, "이/가")} ${amountChangeText(item)}했어요. 이 영향으로 ${subject} ${moved} 수 있어요.`,
      });
    });

  if (sentences.length === 0) {
    sentences.push({
      level: "info",
      text: `같은 시기에 함께 크게 바뀐 다른 항목이 없어서, 이 데이터만으로는 ${subject} ${fell ? "떨어진" : "오른"} 이유를 찾기 어려워요.`,
    });
  }
  return sentences;
}

function explainRecords(result, rowCells, seriesProfile) {
  const { target, factors } = result;
  const sentences = [];
  const measure = measureName(target);
  const meaningful = factors.filter((factor) => factor.eta2 >= 0.01);

  if (seriesProfile?.kind === "id") {
    sentences.push({
      level: "info",
      text: `‘${seriesProfile.name}’${josa(seriesProfile.name, "은/는")} 행마다 붙인 번호라서 크고 작음에 의미가 없어요.`,
    });
  }

  const [top, second] = meaningful;
  if (top) {
    sentences.push({
      level: "critical",
      text: `${measure}에 가장 큰 영향을 준 건 ${top.baseName}이에요. ‘${top.best.label}’${josa(top.best.label, "은/는")} ${valueText(target, top.best.value)}, ‘${top.worst.label}’${josa(top.worst.label, "은/는")} ${valueText(target, top.worst.value)}예요.`,
    });
    if (rowCells && top.kind === "categorical") {
      const own = String(rowCells[top.columnIndex] ?? "").trim();
      const group = top.groups.find((item) => item.label === own);
      if (group) {
        sentences.push({
          level: "important",
          text: `이 행은 ${top.baseName}${josa(top.baseName, "이/가")} ‘${own}’인 그룹이에요. 이 그룹의 ${measure}${josa(measure, "은/는")} ${valueText(target, group.value)}예요.`,
        });
      }
    }
    if (second && sentences.length < MAX_SENTENCES) {
      sentences.push({ level: "info", text: `그다음으로 영향이 큰 요인은 ${second.baseName}이에요.` });
    }
  } else if (factors.length > 0) {
    sentences.push({ level: "info", text: `어느 요인으로 나눠 봐도 ${measure} 차이가 크지 않아요.` });
  }
  return sentences;
}

/**
 * @returns {{ sentences: {level: string, text: string}[], caveat: string } | null}
 */
export function explainHighlight(record, visual, highlight) {
  if (!record || !Array.isArray(record.sheets) || !highlight) return null;
  const location = parseSourceId(highlight.source_ids?.[0]) || parseSourceId(visual?.source_ids?.[0]);
  if (!location) return null;
  const sheet = record.sheets[location.sheetIndex];
  if (!sheet?.rows?.length) return null;

  const profiles = profileColumns(sheet);
  const seriesName = seriesNameOf(visual, highlight).trim();
  const seriesProfile = profiles.find((profile) => profile.name === seriesName) || null;
  const usableTarget = seriesProfile && ["binary", "numeric", "numeric_discrete"].includes(seriesProfile.kind);

  let result;
  try {
    result = analyzeDrivers(record, { sheetIndex: location.sheetIndex, targetIndex: usableTarget ? seriesProfile.index : null });
    if (result?.status !== "ok") return null;
    if (result.mode === "periods" && result.period) {
      const focus = result.period.periods.findIndex((item) => item.sourceId === highlight.source_ids?.[0]);
      if (focus >= 1 && focus !== result.period.focusIndex) {
        result = analyzeDrivers(record, { sheetIndex: location.sheetIndex, targetIndex: result.target.index, focusPeriodIndex: focus });
      } else if (focus === 0) {
        return {
          sentences: [{ level: "info", text: "첫 기간이라 비교할 직전 값이 없어요." }],
          caveat: "",
        };
      }
    }
  } catch {
    return null;
  }
  if (result?.status !== "ok") return null;

  // 선택한 선이 대표 목표(예: 매출)가 아니면, 대표 목표와 그 결과 열(원가·이익 등)은 원인 후보에서 뺀다.
  const exclude = new Set();
  if (result.mode === "periods" && result.period) {
    try {
      const primary = analyzeDrivers(record, { sheetIndex: location.sheetIndex });
      if (primary?.status === "ok" && primary.target.index !== result.target.index) {
        exclude.add(primary.target.index);
        primary.period?.comovers.filter((item) => item.downstream).forEach((item) => exclude.add(item.columnIndex));
      }
    } catch {
      // 대표 목표를 못 구하면 제외 없이 진행한다.
    }
  }

  const sentences = result.mode === "periods" && result.period
    ? explainPeriod(result, exclude)
    : explainRecords(result, findRowCells(sheet, location.rowNumber), seriesProfile);
  if (sentences.length === 0) return null;
  return {
    sentences: sentences.slice(0, MAX_SENTENCES),
    caveat: "데이터에서 계산한 차이를 근거로 한 추정이라, 다른 이유가 함께 있을 수 있어요.",
  };
}
