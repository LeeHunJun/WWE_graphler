const NUMBER_WORDS = new Map([
  ["zero", 0], ["one", 1], ["two", 2], ["three", 3], ["four", 4], ["five", 5], ["six", 6],
  ["seven", 7], ["eight", 8], ["nine", 9], ["ten", 10], ["eleven", 11], ["twelve", 12],
  ["thirteen", 13], ["fourteen", 14], ["fifteen", 15], ["sixteen", 16], ["seventeen", 17],
  ["eighteen", 18], ["nineteen", 19], ["twenty", 20], ["thirty", 30], ["forty", 40],
  ["fifty", 50], ["sixty", 60], ["seventy", 70], ["eighty", 80], ["ninety", 90], ["hundred", 100],
]);

function numericTokens(text) {
  const numericText = String(text)
    .replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)\b/gi, (word) => String(NUMBER_WORDS.get(word.toLocaleLowerCase("en"))))
    .replace(/\d{4}[ \t]*년[ \t]*\d{1,2}[ \t]*월(?:[ \t]*\d{1,2}[ \t]*일)?/g, " ")
    .replace(/\d{4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?/g, " ")
    .replace(/\bQ[1-4]\b/gi, " ")
    .replace(/[1-4]\s*분기/g, " ")
    .replace(/(?<![\p{L}\p{N}])\d{1,2}[ \t]*월(?:[ \t]*\d{1,2}[ \t]*일)?/gu, " ");
  return (numericText.match(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g) || [])
    .map((value) => value.replace(/,/g, ""));
}

export function dateParts(text) {
  const pattern = /(\d{4})[ \t]*년[ \t]*(\d{1,2})[ \t]*월(?:[ \t]*(\d{1,2})[ \t]*일)?|(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?|(\d{4})[ \t]*년|[Qq]([1-4])|([1-4])[ \t]*분기|(?<![\p{L}\p{N}])(\d{1,2})[ \t]*월(?:[ \t]*(\d{1,2})[ \t]*일)?/giu;
  const matches = [...String(text).matchAll(pattern)].map((match) => ({ index: match.index, part: (() => {
    if (match[1]) return { kind: "month", year: Number(match[1]), month: Number(match[2]), day: match[3] ? Number(match[3]) : null };
    if (match[4]) return { kind: "month", year: Number(match[4]), month: Number(match[5]), day: match[6] ? Number(match[6]) : null };
    if (match[7]) return { kind: "year", year: Number(match[7]) };
    if (match[8] || match[9]) return { kind: "quarter", quarter: Number(match[8] || match[9]) };
    return { kind: "month", year: null, month: Number(match[10]), day: match[11] ? Number(match[11]) : null };
  })() }));
  const monthNumbers = new Map([
    ["jan", 1], ["january", 1], ["feb", 2], ["february", 2], ["mar", 3], ["march", 3],
    ["apr", 4], ["april", 4], ["may", 5], ["jun", 6], ["june", 6], ["jul", 7], ["july", 7],
    ["aug", 8], ["august", 8], ["sep", 9], ["sept", 9], ["september", 9], ["oct", 10], ["october", 10],
    ["nov", 11], ["november", 11], ["dec", 12], ["december", 12],
  ]);
  const monthPattern = /\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\b/giu;
  for (const match of String(text).matchAll(monthPattern)) {
    matches.push({
      index: match.index,
      part: { kind: "month", year: null, month: monthNumbers.get(match[1].toLocaleLowerCase("en")), day: null },
    });
  }
  return matches.sort((first, second) => first.index - second.index).map(({ part }) => part);
}

export function datePartIsSupported(claimDate, sourceDate) {
  if (claimDate.kind !== sourceDate.kind && !(claimDate.kind === "year" && sourceDate.year === claimDate.year)) return false;
  if (claimDate.kind === "year") return sourceDate.year === claimDate.year;
  if (claimDate.kind === "quarter") return sourceDate.quarter === claimDate.quarter;
  if (claimDate.month !== sourceDate.month) return false;
  if (claimDate.year !== null && sourceDate.year !== null && claimDate.year !== sourceDate.year) return false;
  return claimDate.day === null || sourceDate.day === claimDate.day;
}

const STOP_TERMS = new Set([
  "있다", "없다", "하다", "되다", "이다", "입니다", "하는", "하여", "하고", "했다", "있는", "없는", "이며",
  "그", "및", "또는", "에서", "보다", "대해", "대한", "관련", "내용", "항목", "수치", "결과", "부분",
  "현재", "기준", "이번", "다음", "지난", "각각", "전체", "주요", "원문", "자료", "문서", "보고서", "기록", "표시", "상태", "행", "항목", "수치", "일", "제시", "있습니다", "합니다", "되었습니다", "기록되어", "입니다", "뒤", "전반적으로", "관측", "관측된", "흐름", "경향", "보였고", "보였으며", "기간", "동안", "overall", "throughout", "trend", "fluctuate", "fluctuated", "마지막", "처음", "최종", "first", "last", "latest",
  "건", "개", "명", "원", "퍼센트", "대비", "단위", "the", "and", "for", "from", "with", "that", "this",
  "are", "was", "were", "has", "have", "had", "than", "into", "after", "before", "about", "per", "unit", "units", "data", "report", "metric", "value", "values", "item", "items", "record", "recorded",
]);
const CANONICAL_STOP_TERMS = new Set(["unit", "period", "extrema", "change"]);

const TERM_SYNONYMS = new Map([
  ["매출", "revenue"], ["판매", "revenue"], ["revenue", "revenue"], ["sales", "revenue"],
  ["억원", "unit"], ["만원", "unit"], ["원", "unit"], ["units", "unit"], ["unit", "unit"],
  ["월별", "period"], ["월간", "period"], ["월", "period"], ["month", "period"], ["monthly", "period"], ["분기", "period"], ["quarter", "period"], ["연간", "period"], ["연도", "period"], ["year", "period"], ["기간", "period"], ["period", "period"],
  ["업무", "work"], ["작업", "work"], ["work", "work"], ["고객", "customer"], ["customer", "customer"], ["이슈", "issue"], ["문제", "issue"], ["issue", "issue"], ["미해결", "open"], ["open", "open"],
  ["범위", "scope"], ["scope", "scope"], ["유지", "keep"], ["keep", "keep"], ["합의", "agree"], ["agreed", "agree"], ["동의", "agree"], ["핵심", "core"], ["core", "core"], ["첫", "initial"], ["first", "initial"],
  ["워크플로", "workflow"], ["workflow", "workflow"], ["흐름", "flow"], ["flow", "flow"], ["디자인", "design"], ["design", "design"], ["엔지니어링", "engineering"], ["engineering", "engineering"], ["온보딩", "onboarding"], ["onboarding", "onboarding"], ["수정", "revise"], ["revised", "revise"],
  ["점검", "check"], ["check", "check"], ["체크리스트", "checklist"], ["checklist", "checklist"], ["전달", "deliver"], ["deliver", "deliver"], ["delivered", "deliver"], ["피드백", "feedback"], ["feedback", "feedback"], ["공지", "notice"], ["안내", "notice"], ["notice", "notice"], ["order", "order"],
  ["출시", "release"], ["배포", "release"], ["release", "release"], ["launch", "release"],
  ["제품", "product"], ["product", "product"], ["책임자", "lead"], ["lead", "lead"], ["공유", "share"], ["share", "share"], ["순서", "process"],
  ["검토", "review"], ["확인", "review"], ["review", "review"],
  ["감소", "change"], ["하락", "change"], ["줄어", "change"], ["decrease", "change"], ["decreased", "change"], ["decline", "change"], ["declined", "change"], ["drop", "change"], ["dropped", "change"], ["fell", "change"],
  ["감소했습니다", "change"], ["줄었", "change"], ["줄었습니다", "change"], ["증가", "change"], ["상승", "change"], ["늘어", "change"], ["늘었", "change"], ["늘었습니다", "change"], ["increase", "change"], ["increased", "change"], ["growth", "change"], ["rose", "change"], ["rise", "change"], ["grew", "change"],
  ["변화", "change"], ["변경", "change"], ["change", "change"], ["절차", "process"], ["프로세스", "process"], ["process", "process"], ["workflow", "process"],
  ["수집", "collect"], ["모집", "collect"], ["collect", "collect"], ["요청", "request"], ["request", "request"],
  ["승인", "approve"], ["결재", "approve"], ["approve", "approve"], ["approval", "approve"],
  ["위험", "risk"], ["리스크", "risk"], ["risk", "risk"], ["일정", "schedule"], ["schedule", "schedule"],
  ["예정", "planned"], ["계획", "planned"], ["planned", "planned"], ["scheduled", "planned"],
  ["초기", "initial"], ["처음", "initial"], ["initial", "initial"], ["최종", "final"], ["final", "final"],
  ["결정", "decision"], ["decision", "decision"], ["기한", "deadline"], ["마감", "deadline"], ["deadline", "deadline"], ["due", "deadline"],
  ["최고", "extrema"], ["최대", "extrema"], ["높", "extrema"], ["highest", "extrema"], ["maximum", "extrema"], ["최저", "extrema"], ["최소", "extrema"], ["낮", "extrema"], ["lowest", "extrema"], ["minimum", "extrema"],
  ["등락", "change"], ["오르내", "change"], ["fluctuate", "change"], ["oscillate", "change"],
  ["완료", "complete"], ["완료함", "complete"], ["complete", "complete"], ["completed", "complete"],
  ["진행", "progress"], ["진행중", "progress"], ["progress", "progress"], ["담당자", "owner"], ["담당", "owner"], ["owner", "owner"],
  ["목표", "target"], ["target", "target"], ["실적", "actual"], ["actual", "actual"], ["목록", "list"], ["항목별", "item"], ["부서", "department"], ["department", "department"],
]);
const STATUS_GROUPS = [
  { id: "complete", pattern: /(완료(?!율)|완성|마침|complete|completed|done)/i },
  { id: "progress", pattern: /(진행(?:중)?|in progress|ongoing)/i },
  { id: "blocked", pattern: /(지연|보류|중단|차단|blocked|delayed|on hold|paused)/i },
  { id: "approved", pattern: /(승인(?!율)|허가|approv(?:e|ed|al)|accepted)/i },
  { id: "rejected", pattern: /(반려|거절|취소|rejected|denied|cancelled)/i },
];

function normalizeText(text) {
  return String(text).toLocaleLowerCase("ko").replace(/[\s\p{P}\p{S}]+/gu, "");
}

function normalizeTerm(term) {
  let normalized = term.toLocaleLowerCase("ko");
  if (TERM_SYNONYMS.has(normalized)) return [TERM_SYNONYMS.get(normalized)];
  const koreanSuffixes = ["이었습니다", "하였습니다", "했습니다", "되었습니다", "되었다", "되었고", "기록되어", "자료에는", "있습니다", "합니다", "입니다", "으로부터", "으로는", "으로", "에서는", "에서", "에게", "까지", "부터", "이며", "였고", "했고", "하고", "한다", "했다", "에는", "은", "는", "이", "가", "을", "를", "의", "에", "로", "와", "과", "도", "만"];
  if (/[가-힣]/.test(normalized)) {
    for (const suffix of koreanSuffixes) {
      if (normalized.endsWith(suffix)) {
        if (normalized.length - suffix.length < 2) return "";
        normalized = normalized.slice(0, -suffix.length);
        break;
      }
    }
  }
  if (/^[a-z]+s$/.test(normalized) && !normalized.endsWith("ss")) normalized = normalized.slice(0, -1);
  if (TERM_SYNONYMS.has(normalized)) return [TERM_SYNONYMS.get(normalized)];
  if (/[가-힣]/.test(normalized) && !normalized.includes("완료율")) {
    const parts = [...TERM_SYNONYMS.entries()]
      .filter(([alias]) => /[가-힣]/.test(alias) && alias.length >= 2 && normalized.includes(alias))
      .sort((first, second) => second[0].length - first[0].length);
    const canonical = [];
    for (const [alias, meaning] of parts) {
      if (!canonical.includes(meaning)) canonical.push(meaning);
      normalized = normalized.replace(alias, " ");
    }
    return canonical.length > 0 ? canonical : [normalized];
  }
  return [normalized];
}

function semanticTerms(text) {
  return [...String(text).matchAll(/[가-힣]+|[a-z]{3,}/giu)]
    .flatMap((match) => normalizeTerm(match[0]))
    .filter((term) => term.length > 1 && !STOP_TERMS.has(term) && !CANONICAL_STOP_TERMS.has(term));
}

export function hasSupportedClaimTerms(claim, evidence) {
  const claimTerms = semanticTerms(claim);
  if (claimTerms.length === 0) return true;
  const claimStatuses = STATUS_GROUPS.filter((group) => group.pattern.test(claim)).map((group) => group.id);
  const evidenceStatuses = STATUS_GROUPS.filter((group) => group.pattern.test(evidence)).map((group) => group.id);
  if (claimStatuses.some((status) => evidenceStatuses.length > 0 && !evidenceStatuses.includes(status))) return false;
  const evidenceTerms = new Set(semanticTerms(evidence));
  const matched = claimTerms.filter((term) => evidenceTerms.has(term)).length;
  if (matched > 0 && matched / claimTerms.length >= 0.5) return true;
  const hasSubjectMatch = claimTerms.some((term) => !CANONICAL_STOP_TERMS.has(term) && evidenceTerms.has(term));
  const describesTrend = /(증가|감소|상승|하락|오르내|등락|증가와\s*감소|상승과\s*하락|fluctuat|oscillat|increase|decrease|rise|fall|trend)/i.test(claim);
  return hasSubjectMatch && describesTrend && compareTrendDirection(claim, evidence) === true;
}

function parsePeriodKey(text) {
  const normalized = String(text).toLocaleLowerCase("ko");
  let match = normalized.match(/(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?/)
    || normalized.match(/(\d{4})\s*년\s*(\d{1,2})\s*월/);
  if (match) return Number(match[1]) * 10000 + Number(match[2]) * 100 + Number(match[3] || 1);
  match = normalized.match(/(\d{4})\s*(?:년\s*)?([1-4])\s*분기|\b(\d{4})\s*q([1-4])\b/);
  if (match) return Number(match[1] || match[3]) * 10000 + Number(match[2] || match[4]) * 2500;
  match = normalized.match(/(?:\bq([1-4])\b|([1-4])\s*분기)/);
  if (match) return 20000000 + Number(match[1] || match[2]) * 2500;
  match = normalized.match(/(?:\b(\d{1,2})\s*월|\b(\d{1,2})\s*월)/);
  if (match) return 20000000 + Number(match[1] || match[2]) * 100;
  return null;
}

function numericPeriodPairs(evidence) {
  const pattern = /\d{4}\s*년\s*\d{1,2}\s*월(?:\s*\d{1,2}\s*일)?|\d{4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?|\bQ[1-4]\b|[1-4]\s*분기|\b\d{1,2}\s*월/gi;
  const pairs = [];
  for (const line of String(evidence).split(/\r?\n/)) {
    const matches = [...line.matchAll(pattern)];
    matches.forEach((match, index) => {
      const prefix = line.slice(Math.max(0, match.index - 12), match.index);
      if (/(?:from|since|than|versus|vs\.?|보다|대비|에서)\s*$/i.test(prefix)) return;
      const nextPeriodPosition = matches[index + 1]?.index ?? line.length;
      const value = numericValues(line.slice(match.index + match[0].length, nextPeriodPosition))[0];
      const period = parsePeriodKey(match[0]);
      if (period === null || value === undefined) return;
      pairs.push({ period, component: getPeriodMonth(match[0]), value });
    });
  }
  return pairs.sort((first, second) => first.period - second.period);
}

function getPeriodMonth(text) {
  const value = String(text).toLocaleLowerCase("ko");
  let match = value.match(/\d{4}[-/.](\d{1,2})/)
    || value.match(/\d{4}\s*년\s*(\d{1,2})\s*월/);
  if (match) return { kind: "month", value: Number(match[1]) };
  match = value.match(/\bq([1-4])\b|([1-4])\s*분기/);
  if (match) return { kind: "quarter", value: Number(match[1] || match[2]) };
  match = value.match(/\b(\d{1,2})\s*월/);
  if (match) return { kind: "month", value: Number(match[1]) };
  return null;
}

function getClaimPeriods(text) {
  const pattern = /\d{4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?|\d{4}\s*년\s*\d{1,2}\s*월(?:\s*\d{1,2}\s*일)?|\bQ[1-4]\b|[1-4]\s*분기|\b\d{1,2}\s*월/gi;
  return [...String(text).matchAll(pattern)].map((match) => ({
    position: match.index,
    end: match.index + match[0].length,
    period: parsePeriodKey(match[0]),
    component: getPeriodMonth(match[0]),
  })).filter((item) => item.period !== null);
}

export function compareTrendDirection(claim, evidence) {
  const changePattern = /(증가|상승|늘었|늘어|감소|하락|줄었|줄어|오르내|등락|fluctuat|oscillat|increase|increased|rise|rose|grew|decrease|decreased|decline|declined|drop|dropped|fell)/gi;
  const periodMentions = getClaimPeriods(claim);
  const pairs = numericPeriodPairs(evidence);
  if (pairs.length < 2) return null;

  const words = [...String(claim).matchAll(changePattern)];
  if (words.length === 0) return null;
  const saysIncreaseOverall = words.some((word) => /(증가|상승|늘었|늘어|increase|increased|rise|rose|grew)/i.test(word[0]));
  const saysDecreaseOverall = words.some((word) => /(감소|하락|줄었|줄어|decrease|decreased|decline|declined|drop|dropped|fell)/i.test(word[0]));
  const saysFluctuation = /(오르내|등락|증가와\s*감소|상승과\s*하락|fluctuat|oscillat|ups?\s+and\s+downs?)/i.test(claim);
  if (saysFluctuation && ((saysIncreaseOverall && saysDecreaseOverall) || (!saysIncreaseOverall && !saysDecreaseOverall))) {
    let hasIncrease = false;
    let hasDecrease = false;
    for (let index = 1; index < pairs.length; index += 1) {
      const delta = pairs[index].value - pairs[index - 1].value;
      if (delta > 0) hasIncrease = true;
      if (delta < 0) hasDecrease = true;
    }
    if (hasIncrease && hasDecrease) return true;
    return false;
  }
  let comparedChanges = 0;
  for (const word of words) {
    const preceding = periodMentions.filter((period) => period.end <= word.index);
    if (preceding.length < 2) continue;
    const mentioned = preceding.slice(-2).map((period) => period.component);
    let selected = mentioned.map((component) => pairs.find((pair) => pair.component?.kind === component?.kind
      && pair.component.value === component.value));
    selected = selected.filter(Boolean);
    if (selected.length < 2) continue;
    comparedChanges += 1;
    selected.sort((first, second) => first.period - second.period);
    const delta = selected.at(-1).value - selected[0].value;
    const saysIncrease = /(증가|상승|늘었|늘어|increase|increased|rise|rose|grew)/i.test(word[0]);
    const saysDecrease = /(감소|하락|줄었|줄어|decrease|decreased|decline|declined|drop|dropped|fell)/i.test(word[0]);
    if ((saysIncrease && delta < 0) || (saysDecrease && delta > 0)) return false;
  }

  if (comparedChanges > 0) return true;
  if (periodMentions.length >= 2) return null;
  const delta = pairs.at(-1).value - pairs[0].value;
  const saysIncrease = /(증가|상승|늘었|늘어|increase|increased|rise|rose|grew)/i.test(claim);
  const saysDecrease = /(감소|하락|줄었|줄어|decrease|decreased|decline|declined|drop|dropped|fell)/i.test(claim);
  if ((saysIncrease && delta < 0) || (saysDecrease && delta > 0)) return false;
  return true;
}

export function hasDirectionConflict(claim, evidence) {
  const claimIncrease = /(증가|상승|늘었|늘어|increase|increased|rose|grew)/i.test(claim);
  const claimDecrease = /(감소|하락|줄었|줄어|decrease|decreased|decline|declined|drop|dropped|fell)/i.test(claim);
  if (!claimIncrease && !claimDecrease) return false;
  const numericTrend = compareTrendDirection(claim, evidence);
  if (numericTrend !== null) return !numericTrend;

  const sourceIncrease = /(증가|상승|늘었|늘어|increase|increased|rose|grew)/i.test(evidence);
  const sourceDecrease = /(감소|하락|줄었|줄어|decrease|decreased|decline|declined|drop|dropped|fell)/i.test(evidence)
    || /(?:change|difference|변화|증감)[^\n.!?]{0,80}[-−]\s*\d+(?:[.,]\d+)?\s*(?:%|percent|퍼센트)/i.test(evidence);
  if ((claimIncrease && sourceDecrease && !sourceIncrease) || (claimDecrease && sourceIncrease && !sourceDecrease)) return true;
  return false;
}

function hasSupportedExtremaClaim(claim, sourceTexts) {
  const asksMaximum = /(최고|가장\s*높|최대|highest|maximum|\bmax\b)/i.test(claim);
  const asksMinimum = /(최저|가장\s*낮|최소|lowest|minimum|\bmin\b)/i.test(claim);
  const asksLastHigher = /(마지막|최종|last|latest).{0,30}(?:높|많|크|higher|greater|more)/i.test(claim)
    || /(first|처음).{0,30}(?:낮|적|작|lower|less).{0,30}(last|마지막|최종)/i.test(claim);
  const asksLastLower = /(마지막|최종|last|latest).{0,30}(?:낮|적|작|lower|less)/i.test(claim)
    || /(first|처음).{0,30}(?:높|많|크|higher|greater|more).{0,30}(last|마지막|최종)/i.test(claim);
  if (!asksMaximum && !asksMinimum && !asksLastHigher && !asksLastLower) return true;

  const rows = sourceTexts.map((text) => String(text).split("|").map((cell) => cell.trim())).filter((cells) => cells.length >= 2);
  const headers = rows.filter((cells) => cells.slice(1).every((cell) => numericValues(cell).length === 0));
  if (headers.length === 0) return false;
  const header = headers[0];
  const dataRows = rows.filter((cells) => cells !== header);
  const claimTerms = new Set(semanticTerms(claim));
  const numericColumns = [];

  for (let columnIndex = 1; columnIndex < header.length; columnIndex += 1) {
    const values = dataRows.map((cells) => numericValues(cells[columnIndex] || "").at(-1) ?? null);
    if (values.filter((value) => value !== null).length < 2) continue;
    const headerTerms = semanticTerms(header[columnIndex] || "");
    const matchScore = headerTerms.filter((term) => claimTerms.has(term)).length;
    numericColumns.push({ columnIndex, values, matchScore });
  }

  if (numericColumns.length === 0) return false;
  numericColumns.sort((first, second) => second.matchScore - first.matchScore);
  if (numericColumns.length > 1 && numericColumns[0].matchScore === 0) return false;
  if (numericColumns.length > 1 && numericColumns[0].matchScore === numericColumns[1].matchScore) return false;

  const selected = numericColumns[0];
  const records = dataRows.flatMap((cells, rowIndex) => {
    const value = selected.values[rowIndex];
    return value === null ? [] : [{ label: normalizeText(cells[0] || ""), value }];
  });
  if (records.length < 2) return false;

  const maximum = records.reduce((best, item) => item.value > best.value ? item : best);
  const minimum = records.reduce((best, item) => item.value < best.value ? item : best);
  if (asksLastHigher && records.at(-1).value <= records[0].value) return false;
  if (asksLastLower && records.at(-1).value >= records[0].value) return false;
  const normalizedClaim = String(claim).toLocaleLowerCase("ko").replace(/[\s\p{P}\p{S}]+/gu, "");
  const mentionedRecords = records.filter((item) => item.label && normalizedClaim.includes(item.label));
  if (mentionedRecords.length === 0) return true;

  if (asksMaximum && !mentionedRecords.some((item) => item.label === maximum.label)) return false;
  if (asksMinimum && !mentionedRecords.some((item) => item.label === minimum.label)) return false;
  return true;
}

export function numericValues(text) {
  const pattern = /(?<![\p{L}\p{N}])([+-]?\d{1,3}(?:,\d{3})*(?:\.\d+)?|[+-]?\d+(?:\.\d+)?)(?![\p{L}\p{N}])/gu;
  const numericText = String(text)
    .replace(/\d{4}[ \t]*년[ \t]*\d{1,2}[ \t]*월(?:[ \t]*\d{1,2}[ \t]*일)?/g, " ")
    .replace(/\d{4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?/g, " ")
    .replace(/\bQ[1-4]\b/gi, " ")
    .replace(/[1-4][ \t]*분기/g, " ")
    .replace(/(?<![\p{L}\p{N}])\d{1,2}[ \t]*월(?:[ \t]*\d{1,2}[ \t]*일)?/gu, " ");
  return [...numericText.matchAll(pattern)]
    .map((match) => Number(match[1].replace(/,/g, "")))
    .filter(Number.isFinite);
}

export function hasSupportedNumericValue(value, sourceText) {
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  return numericValues(sourceText).some((candidate) => Math.abs(candidate - value) < 1e-9);
}

export function hasOnlySupportedNumbers(claim, evidence) {
  const evidenceNumbers = new Set(numericTokens(evidence));
  const sourceDates = dateParts(evidence);
  return numericTokens(claim).every((number) => evidenceNumbers.has(number))
    && dateParts(claim).every((claimDate) => sourceDates.some((sourceDate) => datePartIsSupported(claimDate, sourceDate)));
}

export function isSupportedByEvidence(item, sourceLookup) {
  if (typeof item?.text !== "string" || typeof item.evidence !== "string" || !item.evidence.trim()) return false;
  const sourceTexts = (item.source_ids || [])
    .map((sourceId) => sourceLookup.get(sourceId)?.text || "")
    .filter(Boolean);
  if (!sourceTexts.some((sourceText) => sourceText.includes(item.evidence))) return false;
  const citedSources = [...sourceTexts, item.evidence].join("\n");
  return hasOnlySupportedNumbers(item.text, citedSources)
    && hasSupportedClaimTerms(item.text, citedSources)
    && hasSupportedExtremaClaim(item.text, sourceTexts)
    && !hasDirectionConflict(item.text, citedSources);
}
