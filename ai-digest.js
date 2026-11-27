// AI 핵심 요약에 보낼 '사실 목록'을 만든다.
// 원본 행을 통째로 보내면 AI가 길게 읽고 길게 써야 해서 느리고 자주 틀린다.
// 대신 코드로 미리 계산한 열 요약·변화·원인 분석 결과만 짧게 보내, AI는 문장으로 정리만 하게 한다.

import { analyzeDrivers, formatValue, plainSentence, profileColumns } from "./driver-analysis.js";
import { parseNumber } from "./value-parsing.js";

const MAX_SHEET_FACTS_CHARS = 7000;
const MAX_PDF_CHARS = 12000;

function round(value) {
  if (!Number.isFinite(value)) return null;
  return Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
}

function describeColumn(profile, values, labels) {
  const unit = profile.unit || "";
  if (profile.kind === "numeric" || profile.kind === "numeric_discrete") {
    const numbers = values.map(parseNumber).filter((value) => value !== null);
    if (numbers.length === 0) return null;
    const total = numbers.reduce((sum, value) => sum + value, 0);
    const maxIndex = values.findIndex((value) => parseNumber(value) === Math.max(...numbers));
    const minIndex = values.findIndex((value) => parseNumber(value) === Math.min(...numbers));
    const at = (index) => (labels && labels[index] ? ` (${labels[index]})` : "");
    return `${profile.name}: 평균 ${formatValue(round(total / numbers.length), unit, 1)}, 최고 ${formatValue(Math.max(...numbers), unit, 1)}${at(maxIndex)}, 최저 ${formatValue(Math.min(...numbers), unit, 1)}${at(minIndex)}`;
  }
  if (profile.kind === "binary" || profile.kind === "categorical") {
    const counts = new Map();
    values.map((value) => String(value ?? "").trim()).filter(Boolean).forEach((value) => counts.set(value, (counts.get(value) || 0) + 1));
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([value, count]) => `${value} ${count}행`);
    return top.length > 0 ? `${profile.name}: ${top.join(", ")}` : null;
  }
  if (profile.kind === "temporal") {
    const filled = values.map((value) => String(value ?? "").trim()).filter(Boolean);
    return filled.length > 0 ? `${profile.name}: ${filled[0]} ~ ${filled[filled.length - 1]}` : null;
  }
  return null;
}

function sheetFacts(record, sheet, sheetIndex) {
  const rows = (sheet.rows || []).slice(1).filter((cells) => cells.some((cell) => String(cell ?? "").trim()));
  if (rows.length === 0) return [];
  const profiles = profileColumns(sheet);
  const labelProfile = profiles.find((profile) => profile.kind === "temporal")
    || profiles.find((profile) => profile.kind === "text");
  const labels = labelProfile ? rows.map((cells) => String(cells[labelProfile.index] ?? "").trim()) : null;
  const facts = [`[시트 ${sheet.name}] ${rows.length}행 × ${profiles.length}열`];
  profiles.forEach((profile) => {
    if (profile.kind === "empty" || profile.kind === "id" || profile.kind === "text") return;
    const line = describeColumn(profile, rows.map((cells) => cells[profile.index]), labels);
    if (line) facts.push(`- ${line}`);
  });
  try {
    const result = analyzeDrivers(record, { sheetIndex });
    if (result?.status === "ok") {
      facts.push(`- 분석 대상 결과 열: ${result.target.name}`);
      result.insights.slice(0, 5).forEach((insight) => facts.push(`- 분석: ${plainSentence(insight.sentence)}`));
    }
  } catch {
    // 원인 분석을 못 하는 시트는 열 요약만 보낸다.
  }
  return facts;
}

/** @returns {{ name: string, type: string, text: string }} */
export function buildAiDigest(record) {
  if (!record) return { name: "", type: "", text: "" };
  if (record.type === "pdf") {
    let text = "";
    for (const page of record.pages || []) {
      const chunk = `[${page.pageNumber}쪽] ${String(page.text || "").replace(/\s+/g, " ").trim()}\n`;
      if (text.length + chunk.length > MAX_PDF_CHARS) {
        text += chunk.slice(0, Math.max(0, MAX_PDF_CHARS - text.length));
        text += "\n(문서가 길어 앞부분만 보냈어요)";
        break;
      }
      text += chunk;
    }
    return { name: record.name, type: "pdf", text };
  }
  const lines = [];
  (record.sheets || []).forEach((sheet, sheetIndex) => {
    if (lines.join("\n").length > MAX_SHEET_FACTS_CHARS) return;
    lines.push(...sheetFacts(record, sheet, sheetIndex));
  });
  return { name: record.name, type: record.type, text: lines.join("\n").slice(0, MAX_SHEET_FACTS_CHARS) };
}
