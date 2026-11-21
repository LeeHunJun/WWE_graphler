function numericTokens(text) {
  return (String(text).match(/\d{4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?|\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g) || [])
    .map((value) => value.replace(/,/g, ""));
}

const STOP_TERMS = new Set([
  "있다", "없다", "하다", "되다", "이다", "입니다", "하는", "하여", "하고", "했다", "있는", "없는", "이며",
  "그", "및", "또는", "에서", "보다", "대해", "대한", "관련", "내용", "항목", "수치", "결과", "부분",
  "현재", "기준", "이번", "다음", "지난", "각각", "전체", "주요", "원문", "자료", "문서", "보고서", "기록", "표시", "상태", "행", "항목", "수치", "일", "제시",
  "건", "개", "명", "원", "퍼센트", "대비", "단위", "the", "and", "for", "from", "with", "that", "this",
  "are", "was", "were", "has", "have", "had", "than", "into", "after", "before", "about", "per",
]);

const TERM_SYNONYMS = new Map([
  ["매출", "revenue"], ["판매", "revenue"], ["revenue", "revenue"], ["sales", "revenue"],
  ["억원", "unit"], ["만원", "unit"], ["원", "unit"], ["units", "unit"], ["unit", "unit"],
  ["월별", "period"], ["월간", "period"], ["월", "period"], ["month", "period"], ["monthly", "period"], ["분기", "period"], ["quarter", "period"], ["연간", "period"], ["연도", "period"], ["year", "period"], ["기간", "period"], ["period", "period"],
  ["출시", "release"], ["배포", "release"], ["release", "release"], ["launch", "release"],
  ["제품", "product"], ["product", "product"], ["책임자", "lead"], ["lead", "lead"], ["공유", "share"], ["share", "share"], ["순서", "process"],
  ["검토", "review"], ["확인", "review"], ["review", "review"],
  ["감소", "change"], ["하락", "change"], ["줄어", "change"], ["decrease", "change"], ["decreased", "change"], ["decline", "change"], ["declined", "change"], ["drop", "change"], ["dropped", "change"], ["fell", "change"],
  ["증가", "change"], ["상승", "change"], ["늘어", "change"], ["increase", "change"], ["increased", "change"], ["growth", "change"], ["rose", "change"], ["rise", "change"], ["grew", "change"],
  ["변화", "change"], ["변경", "change"], ["change", "change"], ["절차", "process"], ["프로세스", "process"], ["process", "process"], ["workflow", "process"],
  ["수집", "collect"], ["모집", "collect"], ["collect", "collect"], ["요청", "request"], ["request", "request"],
  ["승인", "approve"], ["결재", "approve"], ["approve", "approve"], ["approval", "approve"],
  ["위험", "risk"], ["리스크", "risk"], ["risk", "risk"], ["일정", "schedule"], ["schedule", "schedule"],
  ["예정", "planned"], ["계획", "planned"], ["planned", "planned"], ["scheduled", "planned"],
  ["초기", "initial"], ["처음", "initial"], ["initial", "initial"], ["최종", "final"], ["final", "final"],
  ["결정", "decision"], ["decision", "decision"], ["기한", "deadline"], ["마감", "deadline"], ["deadline", "deadline"], ["due", "deadline"],
  ["완료", "complete"], ["완료함", "complete"], ["complete", "complete"], ["completed", "complete"],
  ["진행", "progress"], ["진행중", "progress"], ["progress", "progress"], ["담당자", "owner"], ["담당", "owner"], ["owner", "owner"],
  ["목표", "target"], ["target", "target"], ["실적", "actual"], ["actual", "actual"], ["목록", "list"], ["항목별", "item"], ["부서", "department"], ["department", "department"],
]);
const STATUS_GROUPS = [
  { id: "complete", pattern: /(완료(?!율)|완성|마침|complete|completed|done)/i },
  { id: "progress", pattern: /(진행(?:중)?|in progress|ongoing)/i },
  { id: "blocked", pattern: /(지연|보류|중단|차단|blocked|delayed|on hold|paused)/i },
  { id: "approved", pattern: /(승인(?!율)|허가|approved|accepted)/i },
  { id: "rejected", pattern: /(반려|거절|취소|rejected|denied|cancelled)/i },
];

function normalizeTerm(term) {
  let normalized = term.toLocaleLowerCase("ko");
  if (TERM_SYNONYMS.has(normalized)) return [TERM_SYNONYMS.get(normalized)];
  const koreanSuffixes = ["이었습니다", "하였습니다", "했습니다", "됐습니다", "되었다", "되었고", "합니다", "입니다", "으로부터", "으로", "에서", "에게", "까지", "부터", "이며", "였고", "했고", "하고", "한다", "했다", "은", "는", "이", "가", "을", "를", "의", "에", "로", "와", "과", "도", "만"];
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
    .filter((term) => term.length > 1 && !STOP_TERMS.has(term));
}

export function hasSupportedClaimTerms(claim, evidence) {
  const claimTerms = semanticTerms(claim);
  if (claimTerms.length === 0) return true;
  const claimStatuses = STATUS_GROUPS.filter((group) => group.pattern.test(claim)).map((group) => group.id);
  const evidenceStatuses = STATUS_GROUPS.filter((group) => group.pattern.test(evidence)).map((group) => group.id);
  if (claimStatuses.some((status) => evidenceStatuses.some((evidenceStatus) => evidenceStatus !== status))) return false;
  const evidenceTerms = new Set(semanticTerms(evidence));
  const matched = claimTerms.filter((term) => evidenceTerms.has(term)).length;
  return matched > 0 && matched / claimTerms.length >= 0.6;
}

function hasDirectionConflict(claim, evidence) {
  const claimIncrease = /(증가|상승|늘었|늘어|increase|increased|rose|grew)/i.test(claim);
  const claimDecrease = /(감소|하락|줄었|줄어|decrease|decreased|decline|declined|drop|dropped|fell)/i.test(claim);
  if (claimIncrease === claimDecrease) return false;

  const sourceIncrease = /(증가|상승|늘었|늘어|increase|increased|rose|grew)/i.test(evidence);
  const sourceDecrease = /(감소|하락|줄었|줄어|decrease|decreased|decline|declined|drop|dropped|fell)/i.test(evidence)
    || /(?:change|difference|변화|증감)[^\n.!?]{0,80}[-−]\s*\d+(?:[.,]\d+)?\s*(?:%|percent|퍼센트)/i.test(evidence);

  return (claimIncrease && sourceDecrease && !sourceIncrease)
    || (claimDecrease && sourceIncrease && !sourceDecrease);
}

export function numericValues(text) {
  const pattern = /(?<![\p{L}\p{N}])([+-]?\d{1,3}(?:,\d{3})*(?:\.\d+)?|[+-]?\d+(?:\.\d+)?)(?![\p{L}\p{N}])/gu;
  const numericText = String(text)
    .replace(/\d{4}\s*년\s*\d{1,2}\s*월(?:\s*\d{1,2}\s*일)?/g, " ")
    .replace(/\d{4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?/g, " ")
    .replace(/\bQ[1-4]\b/gi, " ")
    .replace(/[1-4]\s*분기/g, " ")
    .replace(/\d{1,2}\s*월(?:\s*\d{1,2}\s*일)?/g, " ");
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
  return numericTokens(claim).every((number) => evidenceNumbers.has(number));
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
    && !hasDirectionConflict(item.text, citedSources);
}
