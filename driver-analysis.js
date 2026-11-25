// "왜?" 분석(원인 후보 분석) 엔진.
// 모든 숫자는 이 파일의 코드가 원본 행에서 직접 계산합니다. AI는 관여하지 않습니다.
// 결과는 "인과 확정"이 아니라 "데이터에서 확인된 차이·상관을 근거로 한 추정"입니다.

import { parseNumber, parseTemporal } from "./value-parsing.js";
import { sortInsightsByPriority } from "./insight-priority.js";

const MAX_CATEGORY_COUNT = 12;
const MIN_GROUP_SIZE = 5;
const MAX_DECOMPOSITION_COLUMNS = 14;
const POSITIVE_TOKENS = ["1", "true", "yes", "y", "o", "예", "네", "생존", "성공", "합격", "구매", "전환", "이탈", "있음", "survived"];

export const CAUSAL_DISCLAIMER = "이 결과는 데이터에서 계산한 차이와 상관을 근거로 한 추정이에요. 다른 요인이 함께 작용했을 수 있어 인과관계를 확정하지는 않습니다.";

// ---------------------------------------------------------------------------
// 통계 함수 (카이제곱, F 분포)

function logGamma(x) {
  const coefficients = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  let sum = 0.99999999999980993;
  const shifted = x - 1;
  coefficients.forEach((coefficient, index) => {
    sum += coefficient / (shifted + index + 1);
  });
  const t = shifted + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(sum);
}

function regularizedGammaQ(a, x) {
  if (x <= 0) return 1;
  if (x < a + 1) {
    let term = 1 / a;
    let sum = term;
    for (let n = 1; n < 500; n += 1) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-14) break;
    }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
  }
  let b = x + 1 - a;
  let c = 1 / 1e-300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i += 1) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-14) break;
  }
  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

function betaContinuedFraction(x, a, b) {
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < 1e-300) d = 1e-300;
  d = 1 / d;
  let h = d;
  for (let m = 1; m < 500; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-14) break;
  }
  return h;
}

function regularizedBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (front * betaContinuedFraction(x, a, b)) / a;
  return 1 - (front * betaContinuedFraction(1 - x, b, a)) / b;
}

export function chiSquarePValue(statistic, degreesOfFreedom) {
  if (!Number.isFinite(statistic) || degreesOfFreedom <= 0) return null;
  return Math.min(1, Math.max(0, regularizedGammaQ(degreesOfFreedom / 2, statistic / 2)));
}

export function fTestPValue(statistic, df1, df2) {
  if (!Number.isFinite(statistic) || df1 <= 0 || df2 <= 0) return null;
  if (statistic <= 0) return 1;
  return Math.min(1, Math.max(0, regularizedBeta(df2 / (df2 + df1 * statistic), df2 / 2, df1 / 2)));
}

export function pearson(xs, ys) {
  const pairs = xs.map((x, index) => [x, ys[index]]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (pairs.length < 3) return null;
  const meanX = pairs.reduce((sum, [x]) => sum + x, 0) / pairs.length;
  const meanY = pairs.reduce((sum, [, y]) => sum + y, 0) / pairs.length;
  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;
  pairs.forEach(([x, y]) => {
    covariance += (x - meanX) * (y - meanY);
    varianceX += (x - meanX) ** 2;
    varianceY += (y - meanY) ** 2;
  });
  if (varianceX === 0 || varianceY === 0) return null;
  return covariance / Math.sqrt(varianceX * varianceY);
}

// ---------------------------------------------------------------------------
// 포맷

export function formatValue(value, unit = "", maximumFractionDigits = 1) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "계산 불가";
  const digits = Math.abs(value) >= 1000 ? 0 : maximumFractionDigits;
  const formatted = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: digits }).format(value);
  return `${formatted}${unit}`;
}

export function formatPValue(pValue) {
  if (pValue === null || pValue === undefined) return "계산 불가";
  if (pValue < 0.001) return "p < 0.001";
  return `p = ${pValue.toFixed(3)}`;
}

function hasFinalConsonant(word) {
  const text = String(word ?? "").replace(/[\s)\]’'"]+$/g, "");
  const last = text.at(-1);
  if (!last) return false;
  const code = last.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 !== 0;
  if (/[0-9]/.test(last)) return "013678".includes(last);
  if (/[lmnLMN]/.test(last)) return true;
  return false;
}

// 한국어 조사: josa("성별", "이/가") → "이"
export function josa(word, pair) {
  const [withConsonant, withoutConsonant] = pair.split("/");
  if (pair === "으로/로") {
    const last = String(word ?? "").replace(/[\s)\]’'"]+$/g, "").at(-1) || "";
    const code = last.charCodeAt(0);
    if (code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 === 8) return withoutConsonant;
  }
  return hasFinalConsonant(word) ? withConsonant : withoutConsonant;
}

function formatSigned(value, unit = "", digits = 1) {
  if (!Number.isFinite(value)) return "계산 불가";
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${formatValue(Math.abs(value), unit, digits)}`;
}

function percentChange(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) return null;
  return ((to - from) / Math.abs(from)) * 100;
}

function niceNumber(value) {
  if (!Number.isFinite(value) || value === 0) return value;
  const magnitude = 10 ** (Math.floor(Math.log10(Math.abs(value))) - 1);
  return Math.round(value / magnitude) * magnitude;
}

function getUnit(header) {
  const match = String(header).match(/\(([^)]+)\)|\[([^\]]+)\]/);
  return match?.[1]?.trim() || match?.[2]?.trim() || "";
}

function getBaseName(header) {
  return String(header).replace(/\s*(\([^)]*\)|\[[^\]]*\])\s*/g, "").trim() || String(header);
}

// ---------------------------------------------------------------------------
// 열 프로파일링

function sourceIdFor(sheetIndex, sheet, rowIndex) {
  const rowNumber = sheet.rowNumbers?.[rowIndex] ?? rowIndex + 1;
  return `sheet:${sheetIndex}:row:${rowNumber}`;
}

function getDataRows(sheet, sheetIndex) {
  return (sheet.rows || []).slice(1).flatMap((cells, offset) => {
    if (!cells.some((cell) => String(cell ?? "").trim())) return [];
    const rowIndex = offset + 1;
    return [{
      rowIndex,
      rowNumber: sheet.rowNumbers?.[rowIndex] ?? rowIndex + 1,
      sourceId: sourceIdFor(sheetIndex, sheet, rowIndex),
      cells,
    }];
  });
}

function isSequentialId(numbers) {
  if (numbers.length < 5) return false;
  const sorted = [...numbers].sort((a, b) => a - b);
  return sorted.every((value, index) => Number.isInteger(value) && (index === 0 || value - sorted[index - 1] === 1));
}

export function profileColumns(sheet) {
  const headers = (sheet.rows?.[0] || []).map((header, index) => String(header ?? "").trim() || `열 ${index + 1}`);
  const dataRows = (sheet.rows || []).slice(1).filter((cells) => cells.some((cell) => String(cell ?? "").trim()));
  const columnCount = sheet.columnCount || headers.length;

  return Array.from({ length: columnCount }, (_, index) => {
    const name = headers[index] || `열 ${index + 1}`;
    const texts = dataRows.map((cells) => String(cells[index] ?? "").trim());
    const nonEmpty = texts.filter(Boolean);
    const numbers = nonEmpty.map(parseNumber);
    const numericCount = numbers.filter((value) => value !== null).length;
    const uniqueValues = [...new Set(nonEmpty)];
    const isNumeric = nonEmpty.length > 0 && numericCount / nonEmpty.length >= 0.9;
    const isTemporal = nonEmpty.length > 0
      && nonEmpty.every((value) => parseTemporal(value) !== null)
      && (!isNumeric || /날짜|일자|월|기간|연도|년|date|month|period|year|quarter|분기/i.test(name));
    const idLike = /(^|[^a-z])id$|^id|번호|^no\.?$|코드$|이름|성명|name/i.test(name);

    let kind = "text";
    if (nonEmpty.length === 0) kind = "empty";
    else if (isTemporal) kind = "temporal";
    else if (uniqueValues.length === 2) kind = "binary";
    else if (isNumeric && idLike && uniqueValues.length === nonEmpty.length) kind = "id";
    else if (isNumeric && isSequentialId(numbers.filter((value) => value !== null)) && uniqueValues.length > 20) kind = "id";
    else if (isNumeric && uniqueValues.length <= 8) kind = "numeric_discrete";
    else if (isNumeric) kind = "numeric";
    else if (idLike) kind = "id";
    else if (uniqueValues.length <= MAX_CATEGORY_COUNT && uniqueValues.length < Math.max(3, nonEmpty.length * 0.6)) kind = "categorical";

    return {
      index,
      name,
      baseName: getBaseName(name),
      unit: getUnit(name),
      kind,
      isNumeric,
      uniqueCount: uniqueValues.length,
      uniqueValues: uniqueValues.length <= MAX_CATEGORY_COUNT ? uniqueValues : [],
      filledCount: nonEmpty.length,
      missingCount: texts.length - nonEmpty.length,
    };
  });
}

function getPositiveValue(values) {
  const normalized = values.map((value) => value.toLocaleLowerCase("ko"));
  for (const token of POSITIVE_TOKENS) {
    const index = normalized.indexOf(token);
    if (index >= 0) return values[index];
  }
  return [...values].sort()[1];
}

const PROFIT_HINT = /이익|손익|마진|profit|income|margin/i;
const TARGET_HINT = /생존|survived|이탈|churn|전환|구매|합격|매출|수익|손익|이익|영업이익|순이익|revenue|sales|profit|income|성과|target|결과/i;

export function suggestTargets(sheet) {
  const profiles = profileColumns(sheet);
  return profiles
    .filter((profile) => profile.kind === "binary" || profile.kind === "numeric" || profile.kind === "numeric_discrete")
    .map((profile) => ({
      index: profile.index,
      name: profile.name,
      kind: profile.kind === "binary" ? "binary" : "numeric",
      score: (TARGET_HINT.test(profile.name) ? 10 : 0) + (profile.kind === "binary" ? 2 : 0) + (profile.kind === "numeric" ? 1 : 0),
    }))
    .sort((first, second) => second.score - first.score || first.index - second.index);
}

// ---------------------------------------------------------------------------
// 그룹 비교 (기록형 데이터: 타이타닉, 고객 목록 등)

function strengthLabel(eta2) {
  if (eta2 >= 0.14) return { key: "strong", label: "강함" };
  if (eta2 >= 0.06) return { key: "medium", label: "보통" };
  if (eta2 >= 0.01) return { key: "weak", label: "약함" };
  return { key: "none", label: "거의 없음" };
}

const AGE_HINT = /나이|연령|age/i;

function makeBins(values, profile = null) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length < MIN_GROUP_SIZE * 2) return null;
  if (profile && AGE_HINT.test(profile.name)) {
    const ageCuts = [10, 20, 40, 60].filter((cut) => cut > sorted[0] && cut <= sorted[sorted.length - 1]);
    if (ageCuts.length > 0) return ageCuts;
  }
  const quantile = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
  const cuts = [...new Set([0.25, 0.5, 0.75].map((q) => niceNumber(quantile(q))))]
    .filter((cut) => cut > sorted[0] && cut <= sorted[sorted.length - 1])
    .sort((a, b) => a - b);
  if (cuts.length === 0) return null;
  return cuts;
}

function binLabel(cuts, binIndex, unit) {
  const format = (value) => formatValue(value, unit, 2);
  if (binIndex === 0) return `${format(cuts[0])} 미만`;
  if (binIndex === cuts.length) return `${format(cuts[cuts.length - 1])} 이상`;
  return `${format(cuts[binIndex - 1])}~${format(cuts[binIndex])} 미만`;
}

function binIndexFor(cuts, value) {
  let index = 0;
  while (index < cuts.length && value >= cuts[index]) index += 1;
  return index;
}

function compareGroups(observations, getGroupKey, { order = null, targetKind }) {
  const groups = new Map();
  observations.forEach((observation) => {
    const key = getGroupKey(observation);
    if (key === null) return;
    if (!groups.has(key)) groups.set(key, { label: key, n: 0, sum: 0, sumSquares: 0, rows: [] });
    const group = groups.get(key);
    group.n += 1;
    group.sum += observation.y;
    group.sumSquares += observation.y ** 2;
    group.rows.push(observation);
  });

  let list = [...groups.values()];
  if (order) list.sort((first, second) => order(first.label) - order(second.label));
  else list.sort((first, second) => second.n - first.n);
  list = list.map((group) => ({
    label: group.label,
    n: group.n,
    total: group.sum,
    value: group.sum / group.n,
    rowNumbers: group.rows.map((row) => row.rowNumber),
    sourceIds: group.rows.map((row) => row.sourceId),
    sumSquares: group.sumSquares,
  }));

  const used = list.filter((group) => group.n >= 1);
  const totalN = used.reduce((sum, group) => sum + group.n, 0);
  if (used.length < 2 || totalN < 4) return null;
  const grandMean = used.reduce((sum, group) => sum + group.total, 0) / totalN;
  const totalSS = used.reduce((sum, group) => sum + group.sumSquares, 0) - totalN * grandMean ** 2;
  const betweenSS = used.reduce((sum, group) => sum + group.n * (group.value - grandMean) ** 2, 0);
  if (totalSS <= 1e-12) return null;
  const eta2 = Math.max(0, Math.min(1, betweenSS / totalSS));
  const k = used.length;

  let statistic;
  let pValue;
  let test;
  if (targetKind === "binary") {
    statistic = totalN * eta2;
    pValue = chiSquarePValue(statistic, k - 1);
    test = "카이제곱 검정";
  } else {
    const withinSS = totalSS - betweenSS;
    const df2 = totalN - k;
    statistic = df2 > 0 && withinSS > 0 ? (betweenSS / (k - 1)) / (withinSS / df2) : Infinity;
    pValue = df2 > 0 ? (Number.isFinite(statistic) ? fTestPValue(statistic, k - 1, df2) : 0) : null;
    test = "분산분석(F 검정)";
  }

  const reliable = list.filter((group) => group.n >= MIN_GROUP_SIZE);
  const ranked = [...(reliable.length >= 2 ? reliable : list)].sort((first, second) => second.value - first.value);
  return {
    groups: list.map(({ sumSquares, ...group }) => ({ ...group, small: group.n < MIN_GROUP_SIZE })),
    grandMean,
    totalN,
    eta2,
    statistic,
    pValue,
    test,
    best: ranked[0],
    worst: ranked[ranked.length - 1],
    strength: strengthLabel(eta2),
  };
}

function buildObservations(dataRows, target) {
  return dataRows.flatMap((row) => {
    const text = String(row.cells[target.index] ?? "").trim();
    if (!text) return [];
    let y;
    if (target.kind === "binary") y = text === target.positiveValue ? 1 : 0;
    else y = parseNumber(text);
    if (y === null || !Number.isFinite(y)) return [];
    return [{ ...row, y }];
  });
}

function getFactorKey(profile, cuts) {
  return (observation) => {
    const text = String(observation.cells[profile.index] ?? "").trim();
    if (!text) return "빈칸";
    if (cuts) {
      const number = parseNumber(text);
      if (number === null) return "빈칸";
      return binLabel(cuts, binIndexFor(cuts, number), profile.unit);
    }
    return text;
  };
}

function analyzeFactor(profile, observations, target) {
  let cuts = null;
  let order = null;
  if (profile.kind === "numeric") {
    cuts = makeBins(observations.map((observation) => parseNumber(observation.cells[profile.index])).filter((value) => value !== null), profile);
    if (!cuts) return null;
    const unit = profile.unit || (AGE_HINT.test(profile.name) ? "세" : "");
    profile = { ...profile, unit };
    const labels = Array.from({ length: cuts.length + 1 }, (_, index) => binLabel(cuts, index, profile.unit));
    order = (label) => (label === "빈칸" ? Infinity : labels.indexOf(label));
  } else if (profile.kind === "numeric_discrete") {
    order = (label) => (label === "빈칸" ? Infinity : parseNumber(label) ?? Infinity);
  }
  const keyOf = getFactorKey(profile, cuts);
  const missing = observations.filter((observation) => keyOf(observation) === "빈칸").length;
  const includeMissing = missing >= MIN_GROUP_SIZE;
  const comparison = compareGroups(
    observations,
    (observation) => {
      const key = keyOf(observation);
      return key === "빈칸" && !includeMissing ? null : key;
    },
    { order, targetKind: target.kind },
  );
  if (!comparison) return null;
  return {
    columnIndex: profile.index,
    name: profile.name,
    baseName: profile.baseName,
    kind: cuts ? "binned" : "categorical",
    cuts,
    ...comparison,
  };
}

function targetValueText(target, value) {
  if (target.kind === "binary") return formatValue(value * 100, "%");
  return formatValue(value, target.unit);
}

function gapText(target, first, second) {
  if (target.kind === "binary") return `${formatValue((first - second) * 100, "%p")}`;
  const ratio = second !== 0 ? first / second : null;
  return `${formatValue(first - second, target.unit)}${ratio && ratio > 0 ? `, 약 ${formatValue(ratio, "배", 1)}` : ""}`;
}

function summarizeRows(rowNumbers, limit = 6) {
  const sorted = [...rowNumbers].sort((a, b) => a - b);
  const shown = sorted.slice(0, limit).join(", ");
  return sorted.length > limit ? `${shown} 외 ${sorted.length - limit}개 행` : `${shown}행`;
}

// ---------------------------------------------------------------------------
// 기간 변화 분석 (월별 매출, 분기 손익 등)

function findMultiplicative(targetValues, candidates) {
  const results = [];
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const ratios = targetValues.map((value, index) => {
        const product = candidates[i].values[index] * candidates[j].values[index];
        return Number.isFinite(value) && Number.isFinite(product) && product !== 0 && value !== 0 ? value / product : null;
      }).filter((ratio) => ratio !== null);
      if (ratios.length < Math.max(3, targetValues.length * 0.9)) continue;
      const mean = ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length;
      if (mean <= 0) continue;
      const maxDeviation = Math.max(...ratios.map((ratio) => Math.abs(ratio / mean - 1)));
      if (maxDeviation <= 0.01) results.push({ parts: [candidates[i], candidates[j]], scale: mean });
    }
  }
  return results;
}

function findAdditive(targetValues, candidates) {
  const usable = candidates.slice(0, MAX_DECOMPOSITION_COLUMNS);
  const matches = [];
  const n = targetValues.length;
  const check = (members) => {
    let ok = 0;
    for (let row = 0; row < n; row += 1) {
      let sum = 0;
      let valid = Number.isFinite(targetValues[row]);
      for (const { column, sign } of members) {
        const value = column.values[row];
        if (!Number.isFinite(value)) { valid = false; break; }
        sum += sign * value;
      }
      if (!valid) continue;
      if (Math.abs(sum - targetValues[row]) <= Math.max(Math.abs(targetValues[row]) * 0.005, 1e-9)) ok += 1;
      else return false;
    }
    return ok >= Math.max(3, n * 0.9);
  };

  const recurse = (start, members) => {
    if (members.length >= 2 && check(members)) {
      matches.push([...members]);
    }
    if (members.length === 4) return;
    for (let index = start; index < usable.length; index += 1) {
      for (const sign of [1, -1]) {
        if (members.length === 0 && sign === -1) continue;
        members.push({ column: usable[index], sign });
        recurse(index + 1, members);
        members.pop();
      }
    }
  };
  recurse(0, []);

  matches.sort((first, second) => {
    const firstPositive = first.every((member) => member.sign === 1) ? 0 : 1;
    const secondPositive = second.every((member) => member.sign === 1) ? 0 : 1;
    return firstPositive - secondPositive || first.length - second.length;
  });
  // 같은 열을 다시 쓰는 다른 조합은 제외해 서로 다른 관점만 남깁니다.
  const picked = [];
  matches.forEach((match) => {
    const ids = new Set(match.map((member) => member.column.index));
    if (picked.some((other) => other.some((member) => ids.has(member.column.index)))) return;
    picked.push(match);
  });
  return picked.slice(0, 1);
}

function analyzePeriods(sheet, sheetIndex, profiles, target, temporal, focusPeriodIndex) {
  const dataRows = getDataRows(sheet, sheetIndex);
  const periods = dataRows
    .map((row) => ({
      row,
      label: String(row.cells[temporal.index] ?? "").trim(),
      key: parseTemporal(row.cells[temporal.index]),
      value: parseNumber(row.cells[target.index]),
    }))
    .filter((period) => period.key !== null)
    .sort((first, second) => first.key - second.key);
  if (periods.length < 3 || new Set(periods.map((period) => period.key)).size !== periods.length) return null;

  const changes = periods.slice(1).map((period, offset) => ({
    index: offset + 1,
    abs: Number.isFinite(period.value) && Number.isFinite(periods[offset].value) ? period.value - periods[offset].value : null,
    pct: percentChange(periods[offset].value, period.value),
  }));
  let focusIndex = Number.isInteger(focusPeriodIndex) && focusPeriodIndex >= 1 && focusPeriodIndex < periods.length
    ? focusPeriodIndex
    : null;
  if (focusIndex === null) {
    const drops = changes.filter((change) => change.pct !== null && change.pct < 0).sort((first, second) => first.pct - second.pct);
    const anyChange = changes.filter((change) => change.pct !== null).sort((first, second) => Math.abs(second.pct) - Math.abs(first.pct));
    focusIndex = (drops[0] || anyChange[0])?.index ?? periods.length - 1;
  }
  const previous = periods[focusIndex - 1];
  const current = periods[focusIndex];

  const numericColumns = profiles
    .filter((profile) => profile.index !== target.index && profile.index !== temporal.index && (profile.kind === "numeric" || profile.kind === "numeric_discrete"))
    .map((profile) => ({
      ...profile,
      values: periods.map((period) => parseNumber(period.row.cells[profile.index])),
    }));
  const targetValues = periods.map((period) => period.value);

  const decompositions = [];
  findMultiplicative(targetValues, numericColumns).slice(0, 1).forEach(({ parts }) => {
    const totalLog = Math.log(current.value / previous.value);
    const totalPct = percentChange(previous.value, current.value);
    const items = parts.map((part) => {
      const from = part.values[focusIndex - 1];
      const to = part.values[focusIndex];
      const logChange = from > 0 && to > 0 ? Math.log(to / from) : null;
      const share = logChange !== null && totalLog !== 0 ? logChange / totalLog : null;
      return {
        name: part.name,
        baseName: part.baseName,
        unit: part.unit,
        columnIndex: part.index,
        from,
        to,
        pct: percentChange(from, to),
        contributionPct: share !== null && totalPct !== null ? share * totalPct : null,
        share,
      };
    });
    if (items.every((item) => item.share !== null)) {
      decompositions.push({
        type: "multiplicative",
        formula: `${target.baseName} = ${parts.map((part) => part.baseName).join(" × ")}`,
        method: "로그 분해: ln(이번/직전) = Σ ln(요소 이번/요소 직전). 각 요소의 로그 변화 비중만큼 전체 변화율을 나눴어요.",
        items,
      });
    }
  });
  findAdditive(targetValues, numericColumns).forEach((members) => {
    const totalAbs = current.value - previous.value;
    const items = members.map(({ column, sign }) => {
      const from = column.values[focusIndex - 1];
      const to = column.values[focusIndex];
      const contribution = sign * (to - from);
      return {
        name: column.name,
        baseName: column.baseName,
        unit: column.unit,
        columnIndex: column.index,
        sign,
        from,
        to,
        pct: percentChange(from, to),
        contribution,
        share: totalAbs !== 0 ? contribution / totalAbs : null,
      };
    });
    decompositions.push({
      type: "additive",
      formula: `${target.baseName} = ${members.map(({ column, sign }, index) => `${index === 0 ? (sign < 0 ? "−" : "") : sign < 0 ? " − " : " + "}${column.baseName}`).join("")}`,
      method: "덧셈 분해: 각 구성 항목의 증감(빼는 항목은 부호 반대)이 전체 증감에서 차지하는 비중을 계산했어요.",
      items,
    });
  });

  // 목표에 비례하거나(예: 원가 = 매출 × 33%) 목표를 구성 요소로 포함하는(예: 영업이익 = 매출 − 비용) 열은
  // 목표 변화의 '결과'일 가능성이 높으므로 원인 후보에서 뺍니다.
  const downstream = new Set();
  numericColumns.forEach((column) => {
    const ratios = targetValues.map((value, index) => (column.values[index] ? value / column.values[index] : null)).filter((ratio) => Number.isFinite(ratio));
    if (ratios.length >= 3) {
      const mean = ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length;
      if (mean !== 0 && Math.max(...ratios.map((ratio) => Math.abs(ratio / mean - 1))) <= 0.03) downstream.add(column.index);
    }
    // 이익·손익 열이 '목표 ± 다른 열'로 정확히 계산되면 목표의 결과로 봅니다. (비용·상품 매출 같은 구성 요소는 원인 후보로 남깁니다.)
    if (!PROFIT_HINT.test(column.name) || PROFIT_HINT.test(target.name)) return;
    const others = [{ ...profiles[target.index], values: targetValues }, ...numericColumns.filter((other) => other.index !== column.index)];
    if (findAdditive(column.values, others).some((members) => members.some((member) => member.column.index === target.index))) {
      downstream.add(column.index);
    }
  });

  const categoricalChanges = profiles
    .filter((profile) => profile.index !== target.index && profile.index !== temporal.index && (profile.kind === "binary" || profile.kind === "categorical"))
    .flatMap((profile) => {
      const from = String(previous.row.cells[profile.index] ?? "").trim();
      const to = String(current.row.cells[profile.index] ?? "").trim();
      return from !== to ? [{ columnIndex: profile.index, name: profile.name, baseName: profile.baseName, from, to }] : [];
    });

  const targetDiffs = targetValues.slice(1).map((value, index) => value - targetValues[index]);
  const comovers = numericColumns.map((column) => {
    const diffs = column.values.slice(1).map((value, index) => value - column.values[index]);
    const pairs = diffs.map((diff, index) => [diff, targetDiffs[index]]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && a !== 0 && b !== 0);
    const sameDirection = pairs.filter(([a, b]) => Math.sign(a) === Math.sign(b)).length;
    const from = column.values[focusIndex - 1];
    const to = column.values[focusIndex];
    return {
      name: column.name,
      baseName: column.baseName,
      unit: column.unit,
      columnIndex: column.index,
      from,
      to,
      pct: percentChange(from, to),
      correlation: pearson(diffs, targetDiffs),
      levelCorrelation: pearson(column.values, targetValues),
      agreement: pairs.length > 0 ? sameDirection / pairs.length : null,
      comparedPeriods: pairs.length,
      downstream: downstream.has(column.index),
    };
  }).filter((item) => item.correlation !== null)
    .sort((first, second) => Math.abs(second.correlation) - Math.abs(first.correlation));

  return {
    temporalName: temporal.name,
    periods: periods.map((period) => ({
      label: period.label,
      value: period.value,
      rowNumber: period.row.rowNumber,
      sourceId: period.row.sourceId,
    })),
    focusIndex,
    change: {
      fromLabel: previous.label,
      toLabel: current.label,
      from: previous.value,
      to: current.value,
      abs: current.value - previous.value,
      pct: percentChange(previous.value, current.value),
    },
    decompositions,
    comovers,
    categoricalChanges,
  };
}

// ---------------------------------------------------------------------------
// 공개 API

export function analyzeDrivers(record, { sheetIndex = 0, targetIndex = null, focusPeriodIndex = null } = {}) {
  const sheet = record?.sheets?.[sheetIndex];
  if (!sheet || !Array.isArray(sheet.rows) || sheet.rows.length < 5) {
    return { status: "insufficient_data", message: "원인 분석에는 머리글 1행과 데이터 4행 이상이 필요해요." };
  }
  const profiles = profileColumns(sheet);
  const targets = suggestTargets(sheet);
  if (targets.length === 0) {
    return { status: "insufficient_data", message: "목표로 삼을 숫자 열이나 두 값(예: 0/1, 생존/사망)으로 된 열이 없어요." };
  }
  const chosen = targets.find((candidate) => candidate.index === targetIndex) || targets[0];
  const targetProfile = profiles[chosen.index];
  const uniqueValues = targetProfile.uniqueValues;
  const target = {
    index: chosen.index,
    name: targetProfile.name,
    baseName: targetProfile.baseName,
    unit: targetProfile.unit,
    kind: chosen.kind,
    positiveValue: chosen.kind === "binary" ? getPositiveValue(uniqueValues) : null,
  };
  if (target.kind === "binary") {
    target.otherValue = uniqueValues.find((value) => value !== target.positiveValue);
    target.measureLabel = `${target.baseName}=${target.positiveValue} 비율`;
  } else {
    target.measureLabel = `평균 ${target.baseName}`;
  }

  const dataRows = getDataRows(sheet, sheetIndex);
  const observations = buildObservations(dataRows, target);
  if (observations.length < 4) {
    return { status: "insufficient_data", message: `‘${target.name}’ 열에 읽을 수 있는 값이 너무 적어요.`, target, targets };
  }
  target.n = observations.length;
  target.overall = observations.reduce((sum, observation) => sum + observation.y, 0) / observations.length;

  const temporal = profiles.find((profile) => profile.kind === "temporal" && profile.index !== target.index);
  const isPeriodTable = Boolean(temporal)
    && target.kind === "numeric"
    && profiles[temporal.index].uniqueCount === profiles[temporal.index].filledCount;

  const factorProfiles = profiles.filter((profile) => {
    if (profile.index === target.index) return false;
    if (["binary", "categorical", "numeric_discrete"].includes(profile.kind)) return true;
    return profile.kind === "numeric" && !isPeriodTable;
  });
  const factors = factorProfiles
    .map((profile) => analyzeFactor(profile, observations, target))
    .filter(Boolean)
    .sort((first, second) => second.eta2 - first.eta2);

  let combination = null;
  const strongFactors = factors.filter((factor) => factor.eta2 >= 0.01).slice(0, 2);
  if (!isPeriodTable && strongFactors.length === 2) {
    const [first, second] = strongFactors;
    const firstKey = getFactorKey(profiles[first.columnIndex], first.cuts);
    const secondKey = getFactorKey(profiles[second.columnIndex], second.cuts);
    const comparison = compareGroups(observations, (observation) => {
      const a = firstKey(observation);
      const b = secondKey(observation);
      return a === "빈칸" || b === "빈칸" ? null : `${a} · ${b}`;
    }, { targetKind: target.kind });
    if (comparison) {
      combination = {
        names: [first.baseName, second.baseName],
        ...comparison,
        groups: comparison.groups.filter((group) => !group.small).sort((a, b) => b.value - a.value),
      };
      if (combination.groups.length < 2) combination = null;
    }
  }

  const period = isPeriodTable ? analyzePeriods(sheet, sheetIndex, profiles, target, temporal, focusPeriodIndex) : null;
  const insights = buildInsights({ target, factors, combination, period, sheet });
  const caveats = [CAUSAL_DISCLAIMER];
  if (observations.length < 30) caveats.push(`분석에 쓴 행이 ${observations.length}개로 적어 우연에 의한 차이일 수 있어요.`);
  const top = factors.filter((factor) => factor.eta2 >= 0.01).slice(0, 3);
  for (let i = 0; i < top.length; i += 1) {
    for (let j = i + 1; j < top.length; j += 1) {
      const association = cramersV(observations, profiles, top[i], top[j]);
      if (association !== null && association >= 0.4) {
        caveats.push(`‘${top[i].baseName}’${josa(top[i].baseName, "과/와")} ‘${top[j].baseName}’${josa(top[j].baseName, "은/는")} 서로 깊이 얽혀 있어요 (크라메르 V = ${association.toFixed(2)}). 둘 중 어느 쪽의 영향인지 이 데이터만으로는 구분하기 어려워요.`);
      }
    }
  }
  const skipped = profiles.filter((profile) => profile.kind === "id" || profile.kind === "text").map((profile) => profile.name);
  if (skipped.length > 0) caveats.push(`값이 행마다 달라 비교에서 뺀 열: ${skipped.join(", ")}`);

  return {
    status: "ok",
    sheetIndex,
    sheetName: sheet.name,
    mode: isPeriodTable ? "periods" : "records",
    target,
    targets,
    factors,
    combination,
    period,
    insights,
    caveats,
  };
}

function cramersV(observations, profiles, first, second) {
  const firstKey = getFactorKey(profiles[first.columnIndex], first.cuts);
  const secondKey = getFactorKey(profiles[second.columnIndex], second.cuts);
  const counts = new Map();
  const rowTotals = new Map();
  const columnTotals = new Map();
  let total = 0;
  observations.forEach((observation) => {
    const a = firstKey(observation);
    const b = secondKey(observation);
    if (a === "빈칸" || b === "빈칸") return;
    counts.set(`${a}\u0000${b}`, (counts.get(`${a}\u0000${b}`) || 0) + 1);
    rowTotals.set(a, (rowTotals.get(a) || 0) + 1);
    columnTotals.set(b, (columnTotals.get(b) || 0) + 1);
    total += 1;
  });
  const k = Math.min(rowTotals.size, columnTotals.size);
  if (k < 2 || total === 0) return null;
  let chi = 0;
  rowTotals.forEach((rowTotal, a) => {
    columnTotals.forEach((columnTotal, b) => {
      const expected = (rowTotal * columnTotal) / total;
      chi += ((counts.get(`${a}\u0000${b}`) || 0) - expected) ** 2 / expected;
    });
  });
  return Math.sqrt(chi / (total * (k - 1)));
}

function buildInsights({ target, factors, combination, period }) {
  const insights = [];

  if (period) {
    const { change } = period;
    const direction = change.abs < 0 ? "감소" : change.abs > 0 ? "증가" : "변화 없음";
    insights.push({
      id: "period-change",
      level: change.abs < 0 ? "critical" : "info",
      title: `${change.toLabel} ${target.baseName} ${formatSigned(change.pct, "%")}`,
      sentence: `${change.toLabel}의 ${target.baseName}${josa(target.baseName, "은/는")} 직전 ${change.fromLabel}보다 ${formatValue(Math.abs(change.pct), "%")} ${direction}했어요 (${formatValue(change.from, target.unit, 0)} → ${formatValue(change.to, target.unit, 0)}).`,
      evidence: [
        { label: `${change.fromLabel} ${target.name}`, value: formatValue(change.from, "", 0) },
        { label: `${change.toLabel} ${target.name}`, value: formatValue(change.to, "", 0) },
      ],
      method: "변화율 = (이번 기간 − 직전 기간) ÷ 직전 기간 × 100",
      sourceIds: [period.periods[period.focusIndex - 1].sourceId, period.periods[period.focusIndex].sourceId],
    });

    period.decompositions.forEach((decomposition, decompositionIndex) => {
      const items = [...decomposition.items].sort((a, b) => Math.abs(b.share ?? 0) - Math.abs(a.share ?? 0));
      const main = items[0];
      const sourceIds = [period.periods[period.focusIndex - 1].sourceId, period.periods[period.focusIndex].sourceId];
      if (decomposition.type === "multiplicative") {
        insights.push({
          id: `decomposition-${decompositionIndex}`,
          level: "important",
          title: `${target.baseName} 변화의 ${formatValue(Math.abs(main.share * 100), "%", 0)}는 ${main.baseName} 때문`,
          sentence: `${decomposition.formula} 관계가 모든 행에서 성립해요. ${items.map((item) => `${item.baseName} ${formatSigned(item.pct, "%")}`).join(", ")}로, ${target.baseName} 변화(${formatSigned(change.pct, "%")})의 약 ${formatValue(Math.abs(main.share * 100), "%", 0)}가 ${main.baseName} 변화로 설명돼요.`,
          evidence: items.map((item) => ({ label: `${item.name} (직전 → 이번)`, value: `${formatValue(item.from, "", 0)} → ${formatValue(item.to, "", 0)} (${formatSigned(item.pct, "%")}, 기여 ${formatSigned(item.contributionPct, "%p")})` })),
          method: decomposition.method,
          sourceIds,
        });
      } else {
        const opposite = change.abs < 0 ? "감소" : "증가";
        insights.push({
          id: `decomposition-${decompositionIndex}`,
          level: "important",
          title: `${target.baseName} ${opposite}분의 ${formatValue(Math.abs((main.share ?? 0) * 100), "%", 0)}는 ${main.baseName}`,
          sentence: `${decomposition.formula} 관계가 모든 행에서 성립해요. ${target.baseName} 증감 ${formatSigned(change.abs, target.unit, 0)} 중 기여한 금액은 ${items.slice(0, 3).map((item) => `${item.baseName} ${formatSigned(item.contribution, target.unit, 0)}`).join(", ")} 순이에요.`,
          evidence: items.map((item) => ({ label: `${item.name}${item.sign < 0 ? " (빼는 항목)" : ""}`, value: `${formatValue(item.from, "", 0)} → ${formatValue(item.to, "", 0)}, 기여 ${formatSigned(item.contribution, "", 0)} (${formatValue((item.share ?? 0) * 100, "%", 0)})` })),
          method: decomposition.method,
          sourceIds,
        });
      }
    });

    const decomposedColumns = new Set(period.decompositions.flatMap((decomposition) => decomposition.items.map((item) => item.columnIndex)));
    period.comovers
      .filter((item) => !decomposedColumns.has(item.columnIndex) && !item.downstream && Math.abs(item.correlation) >= 0.4)
      .slice(0, 2)
      .forEach((item, index) => {
        const together = item.correlation > 0 ? "같은 방향" : "반대 방향";
        insights.push({
          id: `comover-${index}`,
          level: Math.abs(item.correlation) >= 0.7 ? "important" : "info",
          title: `${item.baseName}: ${formatValue(item.from, item.unit, 1)} → ${formatValue(item.to, item.unit, 1)}`,
          sentence: `같은 기간 ${item.baseName}${josa(item.baseName, "이/가")} ${formatSigned(item.pct, "%")} 바뀌었어요. 전체 기간에서 ${item.baseName}의 증감은 ${target.baseName} 증감과 ${together}으로 움직이는 경향이 있어요 (r = ${item.correlation.toFixed(2)}, ${item.comparedPeriods}개 구간 중 ${formatValue(item.agreement * 100, "%", 0)}에서 같은 방향).`,
          evidence: [
            { label: `${item.name} 직전 → 이번`, value: `${formatValue(item.from, "", 1)} → ${formatValue(item.to, "", 1)}` },
            { label: "증감 상관계수 r", value: item.correlation.toFixed(2) },
          ],
          method: "기간별 증감(이번 − 직전)끼리 피어슨 상관계수를 계산했어요. 1이나 −1에 가까울수록 함께 움직였다는 뜻이에요.",
          sourceIds: [period.periods[period.focusIndex - 1].sourceId, period.periods[period.focusIndex].sourceId],
        });
      });
  }

  if (period) {
    period.categoricalChanges.forEach((changeItem) => {
      const factor = factors.find((item) => item.columnIndex === changeItem.columnIndex);
      const toGroup = factor?.groups.find((group) => group.label === changeItem.to);
      const fromGroup = factor?.groups.find((group) => group.label === changeItem.from);
      const comparison = toGroup && fromGroup
        ? ` 전체 기간에서 ‘${changeItem.to}’인 기간의 평균 ${target.baseName}${josa(target.baseName, "은/는")} ${formatValue(toGroup.value, target.unit, 0)}(${toGroup.n}개), ‘${changeItem.from}’인 기간은 ${formatValue(fromGroup.value, target.unit, 0)}(${fromGroup.n}개)예요.`
        : "";
      insights.push({
        id: `category-change-${changeItem.columnIndex}`,
        level: factor && factor.eta2 >= 0.06 ? "critical" : "important",
        title: `같은 시기 ${changeItem.baseName}: ${changeItem.from || "빈칸"} → ${changeItem.to || "빈칸"}`,
        sentence: `${period.change.toLabel}에 ${changeItem.baseName}${josa(changeItem.baseName, "이/가")} ‘${changeItem.from || "빈칸"}’에서 ‘${changeItem.to || "빈칸"}’${josa(changeItem.to || "빈칸", "으로/로")} 바뀌었어요.${comparison}`,
        evidence: factor ? factor.groups.map((group) => ({ label: `${group.label} (${group.n}개 기간)`, value: formatValue(group.value, target.unit, 0) })) : [],
        method: factor
          ? `직전·이번 기간의 값을 비교하고, 그 값별 평균 ${target.baseName}${josa(target.baseName, "을/를")} 비교했어요. 설명력 η² = ${factor.eta2.toFixed(3)}, ${factor.test} ${formatPValue(factor.pValue)}.`
          : "직전·이번 기간의 값을 그대로 비교했어요.",
        sourceIds: [period.periods[period.focusIndex - 1].sourceId, period.periods[period.focusIndex].sourceId],
      });
    });
  }

  const changedColumns = new Set(period?.categoricalChanges.map((item) => item.columnIndex) || []);
  factors.filter((factor) => factor.eta2 >= 0.01 && !changedColumns.has(factor.columnIndex)).slice(0, period ? 2 : 3).forEach((factor, index) => {
    const { best, worst } = factor;
    const significant = factor.pValue !== null && factor.pValue < 0.05;
    insights.push({
      id: `factor-${factor.columnIndex}`,
      level: index === 0 && factor.strength.key !== "weak" ? "critical" : factor.strength.key === "strong" ? "important" : "info",
      title: `${factor.baseName}에 따라 ${target.measureLabel}${josa(target.measureLabel, "이/가")} 달라요`,
      sentence: `${factor.baseName}${josa(factor.baseName, "이/가")} ‘${best.label}’인 경우 ${target.measureLabel}${josa(target.measureLabel, "은/는")} ${targetValueText(target, best.value)}(${best.n}행), ‘${worst.label}’인 경우 ${targetValueText(target, worst.value)}(${worst.n}행)으로 ${gapText(target, best.value, worst.value)} 차이가 나요. 영향 강도는 ‘${factor.strength.label}’이고, ${significant ? "우연으로 생겼을 가능성은 낮아요" : "우연일 가능성을 배제하기 어려워요"} (${formatPValue(factor.pValue)}).`,
      evidence: factor.groups.slice(0, 6).map((group) => ({ label: `${group.label} (${group.n}행)`, value: targetValueText(target, group.value) })),
      method: `${target.kind === "binary" ? `그룹별 비율 = 그룹 안에서 ${target.baseName}=${target.positiveValue}인 행 수 ÷ 그룹 행 수` : `그룹별 평균 = 그룹 ${target.baseName} 합 ÷ 그룹 행 수`}. 설명력 η² = ${factor.eta2.toFixed(3)} (그룹 간 차이가 전체 변동에서 차지하는 비중), ${factor.test} ${formatPValue(factor.pValue)}.${factor.kind === "binned" ? ` 숫자 열은 ${AGE_HINT.test(factor.name) ? "10·20·40·60 기준" : "사분위 기준"}으로 구간을 나눴어요.` : ""}`,
      sourceIds: [...best.sourceIds.slice(0, 3), ...worst.sourceIds.slice(0, 3)],
      rowSummary: `‘${best.label}’ ${summarizeRows(best.rowNumbers)} / ‘${worst.label}’ ${summarizeRows(worst.rowNumbers)}`,
    });
  });

  if (combination) {
    const top = combination.groups[0];
    const bottom = combination.groups[combination.groups.length - 1];
    insights.push({
      id: "combination",
      level: "important",
      title: `가장 높은 조합: ${top.label}`,
      sentence: `${combination.names.join("·")}${josa(combination.names.at(-1), "을/를")} 함께 보면 ‘${top.label}’의 ${target.measureLabel}${josa(target.measureLabel, "이/가")} ${targetValueText(target, top.value)}(${top.n}행)으로 가장 높고, ‘${bottom.label}’${josa(bottom.label, "은/는")} ${targetValueText(target, bottom.value)}(${bottom.n}행)으로 가장 낮아요.`,
      evidence: combination.groups.slice(0, 6).map((group) => ({ label: `${group.label} (${group.n}행)`, value: targetValueText(target, group.value) })),
      method: `두 요인의 값을 묶어 그룹을 만들고 같은 방식으로 계산했어요. ${MIN_GROUP_SIZE}행 미만 그룹은 제외했어요.`,
      sourceIds: [...top.sourceIds.slice(0, 3), ...bottom.sourceIds.slice(0, 3)],
      rowSummary: `‘${top.label}’ ${summarizeRows(top.rowNumbers)} / ‘${bottom.label}’ ${summarizeRows(bottom.rowNumbers)}`,
    });
  }

  const weak = factors.filter((factor) => factor.eta2 < 0.01);
  if (weak.length > 0) {
    insights.push({
      id: "weak-factors",
      level: "info",
      title: "차이가 거의 없는 요인",
      sentence: `${weak.map((factor) => factor.baseName).join(", ")}${josa(weak.at(-1).baseName, "은/는")} 그룹 간 ${target.measureLabel} 차이가 작아 영향이 크지 않은 것으로 보여요.`,
      evidence: weak.slice(0, 4).map((factor) => ({ label: factor.name, value: `η² = ${factor.eta2.toFixed(3)}` })),
      method: "η²가 0.01 미만이면 ‘거의 없음’으로 분류해요.",
      sourceIds: [],
    });
  }

  const priority = (id) => ["period-change", "decomposition", "category-change", "comover", "factor", "combination", "weak"]
    .findIndex((prefix) => id.startsWith(prefix));
  return sortInsightsByPriority(insights
    .map((insight, index) => ({ insight, index }))
    .sort((first, second) => priority(first.insight.id) - priority(second.insight.id) || first.index - second.index)
    .map(({ insight }) => insight));
}

// ---------------------------------------------------------------------------
// 기존 시각화 명세(VISUALIZATION-SPEC.md)로 변환

function headerSourceId(sheetIndex, sheet) {
  return sourceIdFor(sheetIndex, sheet, 0);
}

function factorBarVisual(result, factor, sheet) {
  const { target, sheetIndex } = result;
  const groups = factor.groups;
  const scale = target.kind === "binary" ? 100 : 1;
  const values = groups.map((group) => Number((group.value * scale).toFixed(2)));
  const sourceIds = groups.map((group) => group.sourceIds[0]);
  const header = headerSourceId(sheetIndex, sheet);
  const highlights = [];
  [factor.best, factor.worst].forEach((group, index) => {
    if (!group || (index === 1 && group === factor.best)) return;
    const pointIndex = groups.findIndex((item) => item.label === group.label);
    if (pointIndex < 0) return;
    const positives = target.kind === "binary" ? group.total : null;
    highlights.push({
      target: { point_index: pointIndex },
      level: index === 0 ? "important" : "critical",
      label: `${index === 0 ? "가장 높음" : "가장 낮음"}: ${group.label} ${targetValueText(target, group.value)}`,
      reason: `${factor.baseName}=‘${group.label}’ 그룹 ${group.n}행을 계산했어요. 근거 행: ${summarizeRows(group.rowNumbers)}.`,
      source_ids: [...new Set([group.sourceIds[0], ...group.sourceIds.slice(1, 3), header])],
      derived: {
        formula: target.kind === "binary"
          ? `그룹 비율 = ${target.baseName}=${target.positiveValue}인 행 수 ÷ 그룹 행 수 × 100`
          : `그룹 평균 = 그룹 ${target.baseName} 합 ÷ 그룹 행 수`,
        original_values: target.kind === "binary"
          ? [{ label: "그룹 행 수", value: group.n }, { label: `${target.positiveValue} 행 수`, value: positives }]
          : [{ label: "그룹 행 수", value: group.n }, { label: `${target.baseName} 합`, value: Number(group.total.toFixed(4)) }],
        result: Number((group.value * scale).toFixed(2)),
      },
    });
  });
  return {
    id: `driver-factor-${factor.columnIndex}`,
    type: "bar_chart",
    title: `${factor.baseName}별 ${target.measureLabel}`,
    caption: `영향 강도 ${factor.strength.label} · η² ${factor.eta2.toFixed(3)} · ${factor.test} ${formatPValue(factor.pValue)} · 전체 ${targetValueText(target, target.overall)}`,
    source_ids: [...new Set([header, ...groups.flatMap((group) => group.sourceIds.slice(0, 3))])],
    data: {
      labels: groups.map((group) => `${group.label}${group.small ? " (표본 적음)" : ""}`),
      values,
      source_ids: sourceIds,
      series_name: target.measureLabel,
      unit: target.kind === "binary" ? "%" : target.unit,
      note: `막대를 누르면 해당 그룹의 첫 행으로 이동해요. ${MIN_GROUP_SIZE}행 미만 그룹은 ‘표본 적음’으로 표시했어요.`,
    },
    highlights,
  };
}

function rankingTableVisual(result, sheet) {
  const { target, factors, sheetIndex } = result;
  const header = headerSourceId(sheetIndex, sheet);
  const rows = factors.map((factor, index) => ({
    id: `factor-${factor.columnIndex}`,
    cells: {
      rank: String(index + 1),
      factor: factor.name,
      strength: factor.strength.label,
      eta2: factor.eta2.toFixed(3),
      p: formatPValue(factor.pValue),
      gap: `${factor.best.label} ${targetValueText(target, factor.best.value)} vs ${factor.worst.label} ${targetValueText(target, factor.worst.value)}`,
    },
    source_ids: [header],
  }));
  return {
    id: "driver-ranking",
    type: "comparison_table",
    title: `${target.measureLabel}에 영향이 큰 요인 순위`,
    caption: "η²(설명력)가 클수록 그 요인으로 나눴을 때 그룹 간 차이가 커요. p값이 0.05보다 작으면 우연일 가능성이 낮아요.",
    source_ids: [header],
    data: {
      columns: [
        { key: "rank", label: "순위" },
        { key: "factor", label: "요인" },
        { key: "strength", label: "영향 강도" },
        { key: "eta2", label: "η²" },
        { key: "p", label: "p값" },
        { key: "gap", label: "가장 높은 vs 낮은 그룹" },
      ],
      rows,
    },
    highlights: [],
  };
}

function combinationTableVisual(result, sheet) {
  const { target, combination, sheetIndex } = result;
  const header = headerSourceId(sheetIndex, sheet);
  const groups = combination.groups.slice(0, 12);
  const rows = groups.map((group, index) => ({
    id: `combo-${index}`,
    cells: {
      group: group.label,
      n: String(group.n),
      value: targetValueText(target, group.value),
      rows: summarizeRows(group.rowNumbers, 4),
    },
    source_ids: group.sourceIds.slice(0, 3),
  }));
  const highlightFor = (index, level, label) => ({
    target: { row_id: rows[index].id, column_key: "value" },
    level,
    label,
    reason: `${groups[index].n}행 기준 ${target.measureLabel}: ${targetValueText(target, groups[index].value)}.`,
    source_ids: rows[index].source_ids,
    derived: null,
  });
  return {
    id: "driver-combination",
    type: "comparison_table",
    title: `${combination.names.join(" × ")} 조합별 ${target.measureLabel}`,
    caption: `두 요인을 함께 봤을 때의 결과예요. ${MIN_GROUP_SIZE}행 미만 조합은 뺐어요.`,
    source_ids: [...new Set([header, ...rows.flatMap((row) => row.source_ids)])],
    data: {
      columns: [
        { key: "group", label: "조합" },
        { key: "n", label: "행 수" },
        { key: "value", label: target.measureLabel },
        { key: "rows", label: "근거 행" },
      ],
      rows,
    },
    highlights: [
      highlightFor(0, "important", `가장 높음: ${groups[0].label}`),
      highlightFor(groups.length - 1, "critical", `가장 낮음: ${groups[groups.length - 1].label}`),
    ],
  };
}

function periodLineVisual(result) {
  const { target, period } = result;
  const { periods, focusIndex, change } = period;
  const seriesId = "target";
  const sourceIds = periods.map((item) => item.sourceId);
  return {
    id: "driver-period-line",
    type: "line_chart",
    title: `${period.temporalName}별 ${target.name}`,
    caption: `${change.toLabel}에 직전보다 ${formatSigned(change.pct, "%")} 변했어요. 이 구간을 아래에서 분해해 봤어요.`,
    source_ids: [...new Set(sourceIds)],
    data: {
      labels: periods.map((item) => item.label),
      series: [{ id: seriesId, name: target.baseName, values: periods.map((item) => item.value), source_ids: sourceIds, unit: target.unit }],
      unit: target.unit,
    },
    highlights: [{
      target: { series_id: seriesId, point_index: focusIndex },
      level: change.abs < 0 ? "critical" : "important",
      label: `${change.toLabel} ${formatSigned(change.pct, "%")}`,
      reason: `${change.fromLabel} ${formatValue(change.from, target.unit, 0)}에서 ${change.toLabel} ${formatValue(change.to, target.unit, 0)}로 바뀌었어요.`,
      source_ids: [sourceIds[focusIndex - 1], sourceIds[focusIndex]],
      derived: {
        formula: "(현재 − 직전) ÷ 직전 × 100",
        original_values: [
          { label: `${change.fromLabel} ${target.baseName}`, value: change.from },
          { label: `${change.toLabel} ${target.baseName}`, value: change.to },
        ],
        result: Number(change.pct.toFixed(4)),
      },
    }],
  };
}

function decompositionVisual(result, decomposition, index) {
  const { target, period } = result;
  const focusSource = period.periods[period.focusIndex].sourceId;
  const previousSource = period.periods[period.focusIndex - 1].sourceId;
  const items = decomposition.items;
  const values = items.map((item) => Number((decomposition.type === "multiplicative" ? item.contributionPct : item.contribution).toFixed(2)));
  const strongest = values.reduce((best, value, valueIndex) => (Math.abs(value) > Math.abs(values[best]) ? valueIndex : best), 0);
  return {
    id: `driver-decomposition-${index}`,
    type: "bar_chart",
    title: `${period.change.toLabel} ${target.baseName} 변화 분해 (${decomposition.formula})`,
    caption: decomposition.type === "multiplicative"
      ? `각 요소가 전체 변화율 ${formatSigned(period.change.pct, "%")}에 기여한 정도(%p)예요.`
      : `각 항목이 전체 증감 ${formatSigned(period.change.abs, target.unit, 0)}에 기여한 금액이에요. 빼는 항목은 줄어들면 플러스로 기여해요.`,
    source_ids: [previousSource, focusSource],
    data: {
      labels: items.map((item) => `${item.baseName}${item.sign < 0 ? " (−)" : ""}`),
      values,
      source_ids: items.map(() => focusSource),
      series_name: decomposition.type === "multiplicative" ? "기여도(%p)" : "기여 금액",
      unit: decomposition.type === "multiplicative" ? "%p" : target.unit,
    },
    highlights: [{
      target: { point_index: strongest },
      level: "important",
      label: `가장 큰 기여: ${items[strongest].baseName}`,
      reason: `${items[strongest].name}: ${formatValue(items[strongest].from, "", 0)} → ${formatValue(items[strongest].to, "", 0)}. ${decomposition.method}`,
      source_ids: [focusSource],
      derived: null,
    }],
  };
}

function comoverTableVisual(result) {
  const { target, period } = result;
  const sourceIds = [period.periods[period.focusIndex - 1].sourceId, period.periods[period.focusIndex].sourceId];
  const rows = period.comovers.slice(0, 10).map((item) => ({
    id: `comover-${item.columnIndex}`,
    cells: {
      name: item.name,
      change: `${formatValue(item.from, "", 1)} → ${formatValue(item.to, "", 1)} (${formatSigned(item.pct, "%")})`,
      r: item.correlation.toFixed(2),
      agreement: item.agreement === null ? "-" : formatValue(item.agreement * 100, "%", 0),
    },
    source_ids: sourceIds,
  }));
  return {
    id: "driver-comovers",
    type: "comparison_table",
    title: `${period.change.toLabel}에 함께 바뀐 지표`,
    caption: `전체 기간에서 ${target.baseName} 증감과 함께 움직인 정도(r) 순서예요. r이 음수면 반대로 움직였다는 뜻이에요.`,
    source_ids: sourceIds,
    data: {
      columns: [
        { key: "name", label: "지표" },
        { key: "change", label: `${period.change.fromLabel} → ${period.change.toLabel}` },
        { key: "r", label: "증감 상관 r" },
        { key: "agreement", label: "같은 방향 비율" },
      ],
      rows,
    },
    highlights: [],
  };
}

export function buildDriverVisualSpec(result, record) {
  if (!result || result.status !== "ok") {
    return { status: "ok", message: "", visuals: [] };
  }
  const sheet = record.sheets[result.sheetIndex];
  const visuals = [];
  if (result.period) {
    visuals.push(periodLineVisual(result));
    result.period.decompositions.forEach((decomposition, index) => visuals.push(decompositionVisual(result, decomposition, index)));
    if (result.period.comovers.length > 0) visuals.push(comoverTableVisual(result));
  }
  if (result.factors.length > 0) {
    if (!result.period) visuals.push(rankingTableVisual(result, sheet));
    result.factors.filter((factor) => factor.eta2 >= 0.01).slice(0, 3).forEach((factor) => visuals.push(factorBarVisual(result, factor, sheet)));
    if (result.combination) visuals.push(combinationTableVisual(result, sheet));
  }
  return { status: "ok", message: "", visuals };
}
