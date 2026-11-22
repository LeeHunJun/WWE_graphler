// 업로드한 표의 열별 상태(빈 값, 숫자/문자 섞임)를 코드로 직접 계산합니다.
// 미리보기, "그래프를 만들 수 없음" 안내, AI 설명에 같은 결과를 씁니다.

export function parseNumericCell(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value === null || value === undefined) return null;

  let normalized = String(value).trim();
  if (!normalized) return null;

  const isParenthesizedNegative = /^\(.*\)$/.test(normalized);
  normalized = normalized
    .replace(/[\s ,，_]/g, "")
    .replace(/[₩$€£¥원%]/g, "")
    .replace(/[−–]/g, "-");
  if (isParenthesizedNegative) normalized = `-${normalized.slice(1, -1)}`;
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized)) return null;

  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

const DATE_LIKE = /^(?:\d{4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?|\d{4}\s*년(?:\s*\d{1,2}\s*월)?(?:\s*\d{1,2}\s*일)?|\d{1,2}\s*월|\d{4}\s*[-/]?\s*[Qq][1-4]|[Qq][1-4]|[1-4]\s*분기|\d{4}\s*년?\s*[1-4]\s*분기)$/;

function isDateLike(value) {
  return DATE_LIKE.test(String(value ?? "").trim());
}

function isBlank(value) {
  return String(value ?? "").trim() === "";
}

function getRowNumber(sheet, rowIndex) {
  return sheet.rowNumbers?.[rowIndex] ?? rowIndex + 1;
}

// 숫자 칸이 절반 이상인 열에 섞인 문자 칸은 "숫자에 문자 섞임"으로 봅니다.
const MIXED_NUMERIC_RATIO = 0.5;

export function analyzeSheetQuality(sheet) {
  const rows = Array.isArray(sheet?.rows) ? sheet.rows : [];
  const columnCount = sheet?.columnCount || rows.reduce((maximum, row) => Math.max(maximum, row.length), 0);
  const header = rows[0] || [];
  const dataRows = rows.slice(1)
    .map((cells, offset) => ({ cells, rowIndex: offset + 1 }))
    .filter(({ cells }) => cells.some((cell) => !isBlank(cell)));

  const columns = [];
  for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
    const name = String(header[columnIndex] ?? "").trim() || `열 ${columnIndex + 1}`;
    const emptyRows = [];
    const numericRows = [];
    const textCells = [];

    dataRows.forEach(({ cells, rowIndex }) => {
      const value = cells[columnIndex];
      const rowNumber = getRowNumber(sheet, rowIndex);
      if (isBlank(value)) emptyRows.push(rowNumber);
      else if (parseNumericCell(value) !== null) numericRows.push(rowNumber);
      else textCells.push({ rowNumber, value: String(value).trim() });
    });

    const filled = numericRows.length + textCells.length;
    const isMostlyNumeric = filled > 0 && numericRows.length / filled >= MIXED_NUMERIC_RATIO;
    columns.push({
      index: columnIndex,
      name,
      emptyCount: emptyRows.length,
      emptyRows,
      numericCount: numericRows.length,
      textCount: textCells.length,
      kind: filled === 0 ? "empty"
        : numericRows.length === 0 ? (textCells.every((cell) => isDateLike(cell.value)) ? "date" : "text") : textCells.length === 0 ? "numeric" : isMostlyNumeric ? "mixed" : "text",
      mixedCells: isMostlyNumeric ? textCells : [],
    });
  }

  return {
    name: sheet?.name || "시트",
    dataRowCount: dataRows.length,
    columnCount,
    emptyCellCount: columns.reduce((total, column) => total + column.emptyCount, 0),
    columns,
  };
}

export function analyzeRecordQuality(record) {
  const sheets = (record?.sheets || []).map((sheet) => analyzeSheetQuality(sheet));
  return {
    sheets,
    emptyCellCount: sheets.reduce((total, sheet) => total + sheet.emptyCellCount, 0),
    mixedColumns: sheets.flatMap((sheet) => sheet.columns
      .filter((column) => column.kind === "mixed")
      .map((column) => ({ sheetName: sheet.name, ...column }))),
  };
}

function formatRowList(rowNumbers, limit = 3) {
  const shown = rowNumbers.slice(0, limit).map((rowNumber) => `${rowNumber}행`).join(", ");
  return rowNumbers.length > limit ? `${shown} 외 ${rowNumbers.length - limit}곳` : shown;
}

export function describeMixedColumn(column) {
  const example = column.mixedCells[0];
  return `"${column.name}" 열의 ${formatRowList(column.mixedCells.map((cell) => cell.rowNumber))}에 숫자가 아닌 값(예: "${example.value}")이 있어 그 칸은 빈 값으로 처리했어요. 숫자만 남기면 그래프에 포함돼요.`;
}

// 숫자 열이 없어 그래프를 만들 수 없을 때, 어느 열이 왜 문제인지와 고치는 방법을 문장으로 만듭니다.
export function describeNoNumericColumns(record) {
  const quality = analyzeRecordQuality(record);
  const sheets = quality.sheets.filter((sheet) => sheet.columnCount > 0);
  if (sheets.length === 0 || sheets.every((sheet) => sheet.dataRowCount === 0)) {
    return "그래프를 만들 수 없어요. 제목 행 아래에 데이터 행이 없습니다. 2행부터 값을 채운 뒤 다시 올려 주세요.";
  }

  const problems = sheets.flatMap((sheet) => sheet.columns.map((column) => {
    const prefix = quality.sheets.length > 1 ? `${sheet.name} 시트 ` : "";
    if (column.kind === "empty") return `${prefix}"${column.name}" 열은 값이 모두 비어 있어요`;
    if (column.kind === "date") return `${prefix}"${column.name}" 열은 날짜라 가로축으로만 쓸 수 있어요`;
    return `${prefix}"${column.name}" 열은 글자로만 되어 있어요`;
  }));
  const shown = problems.slice(0, 4).join(", ");
  const more = problems.length > 4 ? ` 외 ${problems.length - 4}개 열` : "";
  return `숫자 열이 없어 그래프를 만들 수 없어요. ${shown}${more}. 그래프로 볼 값(예: 매출, 건수, 점수)을 숫자만 담은 열로 추가하거나, "100건"처럼 단위가 붙은 값은 숫자만 남겨 다시 올려 주세요.`;
}
