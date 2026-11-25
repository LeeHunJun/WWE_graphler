// Shared cell-value parsers used by the auto visualizer and the driver (why) analysis.

const ENGLISH_MONTHS = new Map([
  ["jan", 1], ["january", 1], ["feb", 2], ["february", 2], ["mar", 3], ["march", 3],
  ["apr", 4], ["april", 4], ["may", 5], ["jun", 6], ["june", 6], ["jul", 7], ["july", 7],
  ["aug", 8], ["august", 8], ["sep", 9], ["sept", 9], ["september", 9], ["oct", 10], ["october", 10],
  ["nov", 11], ["november", 11], ["dec", 12], ["december", 12],
]);
export function parseNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value === null || value === undefined) return null;

  let normalized = String(value).trim();
  if (!normalized) return null;

  const isParenthesizedNegative = /^\(.*\)$/.test(normalized);
  normalized = normalized
    .replace(/[\s\u00a0,，_]/g, "")
    .replace(/[₩$€£¥원%]/g, "")
    .replace(/[−–]/g, "-");
  if (isParenthesizedNegative) normalized = `-${normalized.slice(1, -1)}`;
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized)) return null;

  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

export function parseTemporal(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;

  let match = text.match(/^(\d{4})\s*년\s*(\d{1,2})\s*월(?:\s*(\d{1,2})\s*일)?$/);
  if (match) return Number(match[1]) * 10000 + Number(match[2]) * 100 + Number(match[3] || 1);

  match = text.match(/^(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?$/);
  if (match) return Number(match[1]) * 10000 + Number(match[2]) * 100 + Number(match[3] || 1);

  match = text.match(/^(\d{4})(\d{2})(\d{2})?$/);
  if (match) return Number(match[1]) * 10000 + Number(match[2]) * 100 + Number(match[3] || 1);

  match = text.match(/^(\d{4})\s*년\s*([1-4])\s*분기$/i)
    || text.match(/^(\d{4})\s*[-/]?\s*([1-4])\s*분기$/i)
    || text.match(/^(\d{4})\s*[-/]?\s*[Qq]([1-4])$/)
    || text.match(/^([1-4])\s*분기$/i)
    || text.match(/^[Qq]([1-4])$/);
  if (match) {
    const year = match.length === 3 ? Number(match[1]) : 2000;
    const quarter = Number(match[2] || match[1]);
    return year * 10000 + quarter * 2500;
  }
  match = text.match(/^[Qq]([1-4])\s*[-/]?\s*(\d{4})$/);
  if (match) return Number(match[2]) * 10000 + Number(match[1]) * 2500;

  match = text.match(/^(\d{1,2})\s*월$/);
  if (match && Number(match[1]) >= 1 && Number(match[1]) <= 12) return 20000000 + Number(match[1]) * 100;

  const month = ENGLISH_MONTHS.get(text.toLocaleLowerCase("en"));
  if (month) return 20000000 + month * 100;

  if (/^\d{4}$/.test(text) && Number(text) >= 1900 && Number(text) <= 2200) return Number(text) * 10000;

  const timestamp = Date.parse(text);
  return Number.isNaN(timestamp) ? null : timestamp;
}
