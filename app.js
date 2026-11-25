import { buildSpreadsheetVisualizationSpec, getHighlightIdentity, getSourceLookup, renderVisuals, validateHighlight, validateVisual } from "./visualization.js";
import { hasOnlySupportedNumbers, hasSupportedNumericValue, isSupportedByEvidence } from "./source-evidence.js";
import { validateAiQuality } from "./ai-quality.js";
import { renderDriverPanel } from "./driver-view.js";
import { renderHandoverPanel } from "./handover-view.js";

const DATABASE_NAME = "grappler-local-documents";
const DATABASE_VERSION = 1;
const STORE_NAME = "documents";
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const SAMPLE_DOCUMENT_ID = "grappler-sample-work-report";
const UNREADABLE_MESSAGE = "파일의 내용을 읽을 수 없습니다. 파일을 확인한 후 다시 업로드해 주세요";
const AI_RETRY_MESSAGE = "잠시 후 다시 시도해 주세요";
const FILE_TYPES = {
  pdf: { label: "PDF", icon: "P", className: "pdf" },
  csv: { label: "CSV", icon: "C", className: "csv" },
  excel: { label: "Excel", icon: "X", className: "xls" },
};

const fileInput = document.querySelector("#file-input");
const dropZone = document.querySelector("#drop-zone");
const uploadStatus = document.querySelector("#upload-status");
const uploadButtons = [...document.querySelectorAll("#start-upload, #select-file, #empty-upload")];
const searchInput = document.querySelector("#search-input");
const filterButtons = [...document.querySelectorAll("[data-filter]")];
const documentList = document.querySelector("#document-list");
const documentCount = document.querySelector("#document-count");
const sidebarDocumentCount = document.querySelector("#sidebar-document-count");
const emptyState = document.querySelector("#empty-state");
const emptyTitle = document.querySelector("#empty-title");
const emptyDescription = document.querySelector("#empty-description");
const previewEmpty = document.querySelector("#preview-empty");
const previewContent = document.querySelector("#preview-content");
const previewBadge = document.querySelector("#preview-badge");
const previewFileName = document.querySelector("#preview-file-name");
const previewFileType = document.querySelector("#preview-file-type");
const previewFileIcon = document.querySelector("#preview-file-icon");
const previewMeta = document.querySelector("#preview-meta");
const previewData = document.querySelector("#preview-data");
const visualizationOutput = document.querySelector("#visualization-output");
const aiSummarizeButton = document.querySelector("#ai-summarize-button");
const aiSummarizeLabel = document.querySelector("#ai-summarize-label");
const aiSummaryCard = document.querySelector("#ai-summary-card");
const aiSummarySentences = document.querySelector("#ai-summary-sentences");
const aiKeyPoints = document.querySelector("#ai-key-points");
const aiSummarySaved = document.querySelector("#ai-summary-saved");
const aiInsufficientMessage = document.querySelector("#ai-insufficient-message");
const aiSummaryLoading = document.querySelector("#ai-summary-loading");
const aiSummaryError = document.querySelector("#ai-summary-error");
const aiSummaryErrorText = document.querySelector("#ai-summary-error-text");
const aiSummaryRetryButton = document.querySelector("#ai-summary-retry");
const loadSampleSpecButton = document.querySelector("#load-sample-spec");
const developerTools = document.querySelector("#developer-tools");
const toast = document.querySelector("#toast");
const deleteDocumentDialog = document.querySelector("#delete-document-dialog");
const deleteDocumentFileName = document.querySelector("#delete-document-file-name");
const cancelDeleteDocumentButton = document.querySelector("#cancel-delete-document");
const confirmDeleteDocumentButton = document.querySelector("#confirm-delete-document");

let activeFilter = "all";
let documents = [];
let selectedDocumentId = null;
let databasePromise;
let isLoadingDocuments = true;
let isUploading = false;
let isLoadingSample = false;
let pendingDeleteDocumentId = null;
let isDeletingDocument = false;
let toastTimer;
const searchCache = new Map();
const aiLoadingDocuments = new Set();
const aiErrors = new Map();
const deletingDocuments = new Set();

class FileProcessingError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("is-visible");
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 3200);
}

function setUploadStatus(message, state = "") {
  uploadStatus.textContent = message;
  uploadStatus.classList.toggle("is-success", state === "success");
  uploadStatus.classList.toggle("is-error", state === "error");
}

function openDatabase() {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) {
        reject(new Error("이 브라우저에서는 문서를 저장할 수 없습니다."));
        return;
      }

      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("문서 저장소를 열지 못했습니다."));
      request.onblocked = () => reject(new Error("다른 탭에서 문서 저장소를 사용 중입니다. 탭을 새로고침해 주세요."));
    });
  }

  return databasePromise;
}

async function getStoredDocuments() {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result.sort((a, b) => b.createdAt - a.createdAt));
    request.onerror = () => reject(request.error || new Error("저장된 문서를 불러오지 못했습니다."));
  });
}

async function saveDocument(record) {
  const database = await openDatabase();
  if (deletingDocuments.has(record.id)) throw new Error("문서 삭제 중에는 저장할 수 없습니다.");
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(record);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("브라우저 저장 공간에 문서를 보관하지 못했습니다."));
    transaction.onabort = () => reject(transaction.error || new Error("브라우저 저장 공간에 문서를 보관하지 못했습니다."));
  });
}

async function deleteStoredDocument(id) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("문서를 삭제하지 못했습니다."));
    transaction.onabort = () => reject(transaction.error || new Error("문서를 삭제하지 못했습니다."));
  });
}

function getFileType(fileName) {
  const extension = fileName.split(".").pop().toLowerCase();
  if (extension === "pdf") return "pdf";
  if (extension === "csv") return "csv";
  if (extension === "xlsx") return "excel";
  throw new FileProcessingError("unsupported");
}

function getCellText(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\u0000/g, "");
}

async function readPdf(file) {
  const pdfjsLib = await import("pdfjs-dist");
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  const data = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjsLib.getDocument({ data, isEvalSupported: false, enableXfa: false });

  try {
    const pdf = await loadingTask.promise;
    const pages = [];
    let hasReadableText = false;

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const parts = [];

      content.items.forEach((item) => {
        if (typeof item.str !== "string" || item.str.length === 0) return;
        parts.push(item.str, item.hasEOL ? "\n" : " ");
      });

      const text = parts.join("").replace(/[ \t]+\n/g, "\n").replace(/ {2,}/g, " ").trim();
      if (text.replace(/\s/g, "").length > 0) hasReadableText = true;
      pages.push({ pageNumber, text });
      page.cleanup();
    }

    if (pages.length === 0 || !hasReadableText) throw new FileProcessingError("unreadable");
    return { pageCount: pdf.numPages, pages, sheets: [] };
  } finally {
    await loadingTask.destroy();
  }
}

function decodeCsv(buffer) {
  const bytes = new Uint8Array(buffer);
  const hasBom = bytes.length >= 2 && (
    (bytes[0] === 0xff && bytes[1] === 0xfe) ||
    (bytes[0] === 0xfe && bytes[1] === 0xff)
  );
  const decode = (encoding) => new TextDecoder(encoding, { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");

  if (hasBom) return decode(bytes[0] === 0xff ? "utf-16le" : "utf-16be");
  try {
    return decode("utf-8");
  } catch {
    return decode("euc-kr");
  }
}

function detectDelimiter(text) {
  const counts = new Map([[",", 0], [";", 0], ["\t", 0]]);
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (inQuotes && text[index + 1] === '"') index += 1;
      else inQuotes = !inQuotes;
    } else if (!inQuotes && (character === "\n" || character === "\r")) {
      break;
    } else if (!inQuotes && counts.has(character)) {
      counts.set(character, counts.get(character) + 1);
    }
  }

  return [...counts.entries()].sort((first, second) => second[1] - first[1])[0][0];
}

function parseCsv(text) {
  const delimiter = detectDelimiter(text);
  const rows = [];
  const rowNumbers = [];
  let row = [];
  let value = "";
  let inQuotes = false;
  let rowNumber = 1;

  function finishRow() {
    row.push(value.trim());
    rows.push(row);
    rowNumbers.push(rowNumber);
    rowNumber += 1;
    row = [];
    value = "";
  }

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (inQuotes) {
      if (character === '"' && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        inQuotes = false;
      } else {
        value += character;
      }
    } else if (character === '"' && value.length === 0) {
      inQuotes = true;
    } else if (character === delimiter) {
      row.push(value.trim());
      value = "";
    } else if (character === "\n" || character === "\r") {
      finishRow();
      if (character === "\r" && text[index + 1] === "\n") index += 1;
    } else {
      value += character;
    }
  }

  if (inQuotes) throw new FileProcessingError("unreadable");
  if (value.length > 0 || row.length > 0) finishRow();

  if (rows.length === 0 || !rows.some((cells) => cells.some((cell) => cell.trim().length > 0))) {
    throw new FileProcessingError("unreadable");
  }
  if (!rows.slice(1).some((cells) => cells.some((cell) => cell.trim().length > 0))) {
    throw new FileProcessingError("no-content");
  }

  return { rows, rowNumbers };
}

async function readCsv(file) {
  const text = decodeCsv(await file.arrayBuffer());
  const { rows, rowNumbers } = parseCsv(text);
  const sheetName = file.name.replace(/\.csv$/i, "") || "CSV";
  const columnCount = rows.reduce((maximum, row) => Math.max(maximum, row.length), 0);

  return {
    pageCount: 0,
    pages: [],
    sheets: [{ name: sheetName, rows, rowNumbers, rowCount: rows.length, columnCount }],
  };
}

async function readExcel(file) {
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(new Uint8Array(await file.arrayBuffer()), {
    type: "array",
    cellDates: true,
    cellFormula: false,
  });

  const sheets = workbook.SheetNames.map((name) => {
    const worksheet = workbook.Sheets[name];
    const range = worksheet["!ref"] ? XLSX.utils.decode_range(worksheet["!ref"]) : null;
    const rows = [];
    const rowNumbers = [];

    if (range) {
      for (let rowIndex = range.s.r; rowIndex <= range.e.r; rowIndex += 1) {
        const row = [];
        for (let columnIndex = range.s.c; columnIndex <= range.e.c; columnIndex += 1) {
          const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
          const cell = worksheet[address];
          row.push(getCellText(cell?.w ?? cell?.v));
        }
        rows.push(row);
        rowNumbers.push(rowIndex + 1);
      }
    }

    return {
      name,
      rows,
      rowNumbers,
      rowCount: rows.length,
      columnCount: range ? range.e.c - range.s.c + 1 : 0,
    };
  });

  const hasReadableText = sheets.some((sheet) => sheet.rows.some((row) => row.some((cell) => cell.trim().length > 0)));
  if (sheets.length === 0 || !hasReadableText) throw new FileProcessingError("unreadable");
  if (!sheets.some((sheet) => sheet.rows.slice(1).some((row) => row.some((cell) => cell.trim().length > 0)))) {
    throw new FileProcessingError("no-content");
  }

  return { pageCount: 0, pages: [], sheets };
}

async function extractDocument(file) {
  const type = getFileType(file.name);
  if (file.size > MAX_FILE_SIZE) throw new FileProcessingError("too-large");
  if (file.size === 0) throw new FileProcessingError("unreadable");

  try {
    const extracted = type === "pdf"
      ? await readPdf(file)
      : type === "csv"
        ? await readCsv(file)
        : await readExcel(file);

    const record = {
      id: crypto.randomUUID(),
      name: file.name,
      type,
      size: file.size,
      createdAt: Date.now(),
      file,
      ...extracted,
    };

    record.visualSpec = type === "pdf"
      ? { status: "ok", message: "AI 요약 연결 후 시각화가 표시됩니다", visuals: [] }
      : buildSpreadsheetVisualizationSpec(record);
    return record;
  } catch (error) {
    if (error instanceof FileProcessingError) throw error;
    throw new FileProcessingError("unreadable");
  }
}

function getErrorMessage(error) {
  switch (error.reason) {
    case "unsupported":
      return "지원하지 않는 파일 형식입니다. PDF, CSV, Excel(.xlsx) 파일을 선택해 주세요.";
    case "too-large":
      return "파일 크기 제한은 10MB입니다. 더 작은 파일을 선택해 주세요.";
    case "unreadable":
      return UNREADABLE_MESSAGE;
    case "no-content":
      return "분석할 내용이 없습니다. 표에 제목 행 외에 데이터가 있는지 확인해 주세요.";
    case "storage":
      return "브라우저 저장 공간이 부족해 문서를 보관하지 못했어요. 저장 공간을 확보한 후 다시 시도해 주세요.";
    default:
      return error.message || "문서를 처리하지 못했습니다. 다시 시도해 주세요.";
  }
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getTotalRows(record) {
  return record.sheets.reduce((total, sheet) => total + sheet.rowCount, 0);
}

function getContentUnitCount(record) {
  return record.type === "pdf" ? record.pageCount : getTotalRows(record);
}

function getSheetSourceId(sheetIndex, sheet, rowIndex) {
  const rowNumber = sheet.rowNumbers?.[rowIndex] ?? rowIndex + 1;
  return `sheet:${sheetIndex}:row:${rowNumber}`;
}

function getDocumentSearchText(record) {
  if (!searchCache.has(record.id)) {
    const extractedText = record.type === "pdf"
      ? record.pages.map((page) => page.text).join(" ")
      : record.sheets.map((sheet) => `${sheet.name} ${sheet.rows.map((row) => row.join(" ")).join(" ")}`).join(" ");
    searchCache.set(record.id, `${record.name} ${extractedText}`.toLocaleLowerCase("ko"));
  }
  return searchCache.get(record.id);
}

function updateMetrics() {
  const readableUnits = documents.reduce((total, record) => total + getContentUnitCount(record), 0);
  document.querySelector("#metric-documents").textContent = new Intl.NumberFormat("ko-KR").format(documents.length);
  document.querySelector("#metric-content").textContent = new Intl.NumberFormat("ko-KR").format(readableUnits);
  sidebarDocumentCount.textContent = String(documents.length);
}

function getDocumentSummary(record) {
  if (record.type === "pdf") return `${record.pageCount}페이지 · 텍스트 추출 완료`;
  if (record.type === "csv") {
    const sheet = record.sheets[0];
    return `${sheet.rowCount}행 × ${sheet.columnCount}열 · CSV`;
  }
  return `${record.sheets.length}개 시트 · 총 ${getTotalRows(record)}행`;
}

function createDocumentRow(record) {
  const typeInfo = FILE_TYPES[record.type];
  const row = document.createElement("div");
  row.className = "document-row";
  row.classList.toggle("is-selected", record.id === selectedDocumentId);
  row.dataset.documentId = record.id;

  const selectButton = document.createElement("button");
  selectButton.type = "button";
  selectButton.className = "document-row-select";
  selectButton.classList.toggle("is-selected", record.id === selectedDocumentId);
  selectButton.setAttribute("aria-pressed", String(record.id === selectedDocumentId));

  const fileIcon = document.createElement("span");
  fileIcon.className = `file-icon file-icon-${typeInfo.className}`;
  fileIcon.setAttribute("aria-hidden", "true");
  fileIcon.innerHTML = '<svg viewBox="0 0 22 22"><path d="M5.5 2.5h7l4 4v13h-11V2.5Z"/><path d="M12.5 2.8v4h3.8M7.5 11h7M7.5 14h7M7.5 17h4"/></svg>';
  const fileLetter = document.createElement("span");
  fileLetter.textContent = typeInfo.icon;
  fileIcon.append(fileLetter);

  const info = document.createElement("span");
  info.className = "document-info";
  const nameLine = document.createElement("span");
  nameLine.className = "document-name-line";
  const name = document.createElement("strong");
  name.textContent = record.name;
  const typeBadge = document.createElement("span");
  typeBadge.className = "file-type";
  typeBadge.textContent = typeInfo.label;
  nameLine.append(name, typeBadge);
  const summary = document.createElement("span");
  summary.className = "document-summary";
  summary.textContent = getDocumentSummary(record);
  info.append(nameLine, summary);

  const date = new Date(record.createdAt);
  const dateLabel = document.createElement("span");
  dateLabel.className = "document-date";
  const dateText = document.createElement("span");
  dateText.textContent = new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric" }).format(date);
  const timeText = document.createElement("span");
  timeText.textContent = new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit" }).format(date);
  dateLabel.append(dateText, timeText);

  const arrow = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  arrow.setAttribute("viewBox", "0 0 16 16");
  arrow.setAttribute("class", "row-chevron");
  arrow.setAttribute("aria-hidden", "true");
  const arrowPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  arrowPath.setAttribute("d", "m6 3 5 5-5 5");
  arrow.append(arrowPath);

  selectButton.append(fileIcon, info, dateLabel, arrow);
  selectButton.addEventListener("click", () => selectDocument(record.id));

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "document-delete-button";
  deleteButton.setAttribute("aria-label", `${record.name} 삭제`);
  deleteButton.title = "문서 삭제";
  deleteButton.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h12M8 6V4h4v2m3 0-.7 10H5.7L5 6m3 3v4m4-4v4" /></svg>';
  deleteButton.addEventListener("click", () => openDeleteDocumentDialog(record));

  row.append(selectButton, deleteButton);
  return row;
}

function getFilteredDocuments() {
  const query = searchInput.value.trim().toLocaleLowerCase("ko");
  return documents.filter((record) => {
    const matchesType = activeFilter === "all" || record.type === activeFilter;
    return matchesType && (!query || getDocumentSearchText(record).includes(query));
  });
}

function renderDocuments() {
  const query = searchInput.value.trim();
  const filteredDocuments = getFilteredDocuments();

  documentList.replaceChildren(...filteredDocuments.map(createDocumentRow));
  documentCount.textContent = String(filteredDocuments.length);
  emptyState.hidden = filteredDocuments.length > 0;

  if (isLoadingDocuments) {
    emptyTitle.textContent = "저장된 문서를 불러오고 있어요.";
    emptyDescription.textContent = "이 브라우저의 문서함을 확인하는 중입니다.";
  } else if (documents.length === 0) {
    emptyTitle.textContent = "아직 문서가 없어요.";
    emptyDescription.textContent = "PDF, CSV, Excel(.xlsx) 파일을 올려 시작해 보세요.";
  } else if (query) {
    emptyTitle.textContent = "검색 결과가 없어요.";
    emptyDescription.textContent = "파일 이름이나 문서 내용으로 다시 검색해 보세요.";
  } else {
    emptyTitle.textContent = "이 형식의 문서가 없어요.";
    emptyDescription.textContent = "다른 파일 종류를 선택하거나 새 문서를 추가해 보세요.";
  }

  document.querySelector("#empty-upload").hidden = documents.length > 0 || isLoadingDocuments;
  updateMetrics();
}

function addPreviewMeta(label, value) {
  const item = document.createElement("span");
  item.className = "preview-meta-item";
  const name = document.createElement("span");
  name.textContent = label;
  const content = document.createElement("strong");
  content.textContent = value;
  item.append(name, content);
  previewMeta.append(item);
}

function createPreviewHeading(title, detail) {
  const heading = document.createElement("div");
  heading.className = "preview-data-heading";
  const name = document.createElement("strong");
  name.textContent = title;
  const description = document.createElement("span");
  description.textContent = detail;
  heading.append(name, description);
  return heading;
}

function renderPdfPreview(record, focusSourceId) {
  const focusedPage = Number(focusSourceId?.match(/^pdf:page:(\d+)$/)?.[1]);
  const visiblePages = new Set(record.pages.slice(0, 5).map((page) => page.pageNumber));
  if (Number.isInteger(focusedPage) && focusedPage > 0) visiblePages.add(focusedPage);

  previewData.append(createPreviewHeading("추출된 텍스트", `앞 ${Math.min(record.pages.length, 5)}페이지 표시`));

  record.pages.filter((page) => visiblePages.has(page.pageNumber)).forEach((page) => {
    const section = document.createElement("section");
    section.className = "pdf-page-preview";
    section.dataset.sourceId = `pdf:page:${page.pageNumber}`;
    const title = document.createElement("h3");
    title.textContent = `페이지 ${page.pageNumber}`;
    const text = document.createElement("pre");
    text.textContent = page.text.slice(0, 4000) || "이 페이지에서 추출된 텍스트가 없습니다.";
    if (page.text.length > 4000) text.textContent += "\n…";
    section.append(title, text);
    previewData.append(section);
  });

  if (record.pages.length > visiblePages.size) {
    const note = document.createElement("p");
    note.className = "preview-truncation-note";
    note.textContent = `전체 ${record.pageCount}페이지 중 일부를 표시하고 있어요.`;
    previewData.append(note);
  }
}

function renderSheetPreview(sheet, sheetIndex, focusSourceId) {
  const section = document.createElement("section");
  section.className = "sheet-preview";
  section.append(createPreviewHeading(sheet.name, `${sheet.rowCount}행 × ${sheet.columnCount}열`));

  const tableWrap = document.createElement("div");
  tableWrap.className = "sheet-table-wrap";
  const table = document.createElement("table");
  table.className = "sheet-table";
  const body = document.createElement("tbody");
  const visibleRowIndexes = new Set(sheet.rows.slice(0, 12).map((_, index) => index));
  const focusedRowNumber = Number(focusSourceId?.match(new RegExp(`^sheet:${sheetIndex}:row:(\\d+)$`))?.[1]);
  const focusedRowIndex = sheet.rowNumbers
    ? sheet.rowNumbers.indexOf(focusedRowNumber)
    : focusedRowNumber - 1;
  if (Number.isInteger(focusedRowIndex) && focusedRowIndex >= 0 && focusedRowIndex < sheet.rows.length) {
    visibleRowIndexes.add(focusedRowIndex);
  }
  const visibleColumns = Math.min(sheet.columnCount, 8);

  [...visibleRowIndexes].sort((first, second) => first - second).forEach((rowIndex) => {
    const cells = sheet.rows[rowIndex];
    const row = document.createElement("tr");
    row.dataset.sourceId = getSheetSourceId(sheetIndex, sheet, rowIndex);
    row.dataset.rowNumber = String(sheet.rowNumbers?.[rowIndex] ?? rowIndex + 1);
    const rowNumber = document.createElement("th");
    rowNumber.scope = "row";
    rowNumber.textContent = row.dataset.rowNumber;
    row.append(rowNumber);

    for (let columnIndex = 0; columnIndex < visibleColumns; columnIndex += 1) {
      const cell = document.createElement("td");
      cell.textContent = cells[columnIndex] || "";
      row.append(cell);
    }

    body.append(row);
  });

  table.append(body);
  tableWrap.append(table);
  section.append(tableWrap);

  if (sheet.rowCount > visibleRowIndexes.size || sheet.columnCount > visibleColumns) {
    const note = document.createElement("p");
    note.className = "preview-truncation-note";
    note.textContent = `앞 12행과 선택한 원본 행 · ${visibleColumns}열을 표시하고 있어요.`;
    section.append(note);
  }

  return section;
}

function renderSpreadsheetPreview(record, focusSourceId) {
  const title = record.type === "csv" ? "CSV 내용" : "시트 내용";
  const shownSheets = record.sheets.slice(0, 3);
  previewData.append(createPreviewHeading(title, `${record.sheets.length}개 시트 저장됨`));
  shownSheets.forEach((sheet, sheetIndex) => {
    previewData.append(renderSheetPreview(sheet, sheetIndex, focusSourceId));
  });

  if (record.sheets.length > shownSheets.length) {
    const note = document.createElement("p");
    note.className = "preview-truncation-note";
    note.textContent = `나머지 ${record.sheets.length - shownSheets.length}개 시트도 브라우저에 저장했어요.`;
    previewData.append(note);
  }
}

function focusPreviewSource(sourceId) {
  if (!sourceId) return;
  requestAnimationFrame(() => {
    const target = [...previewData.querySelectorAll("[data-source-id]")]
      .find((element) => element.dataset.sourceId === sourceId);
    if (!target) return;
    target.classList.add("is-source-highlighted");
    target.scrollIntoView({ block: "center", behavior: "smooth" });
  });
}

function renderPreview(record, focusSourceId = null) {
  if (!record) {
    previewEmpty.hidden = false;
    previewContent.hidden = true;
    previewBadge.textContent = "대기 중";
    return;
  }

  const typeInfo = FILE_TYPES[record.type];
  previewEmpty.hidden = true;
  previewContent.hidden = false;
  previewBadge.textContent = typeInfo.label;
  previewBadge.title = "브라우저에 저장된 파일";
  previewFileName.textContent = record.name;
  previewFileType.textContent = typeInfo.label;
  previewFileIcon.className = `mini-file-icon mini-file-icon-${record.type}`;
  previewMeta.replaceChildren();
  previewData.replaceChildren();

  addPreviewMeta("파일 크기", formatFileSize(record.size));
  if (record.type === "pdf") {
    addPreviewMeta("페이지", `${record.pageCount}페이지`);
    renderPdfPreview(record, focusSourceId);
  } else if (record.type === "csv") {
    const sheet = record.sheets[0];
    addPreviewMeta("행", `${sheet.rowCount}행`);
    addPreviewMeta("열", `${sheet.columnCount}열`);
    renderSpreadsheetPreview(record, focusSourceId);
  } else {
    addPreviewMeta("시트", `${record.sheets.length}개`);
    addPreviewMeta("총 행", `${getTotalRows(record)}행`);
    renderSpreadsheetPreview(record, focusSourceId);
  }
  focusPreviewSource(focusSourceId);
}

function createAiSourcePayload(record) {
  if (record.type === "pdf") {
    return {
      id: record.id,
      name: record.name,
      type: record.type,
      sources: record.pages.map((page) => ({
        source_id: `pdf:page:${page.pageNumber}`,
        text: page.text,
      })),
    };
  }

  return {
    id: record.id,
    name: record.name,
    type: record.type,
    sources: record.sheets.flatMap((sheet, sheetIndex) => sheet.rows.map((row, rowIndex) => ({
      source_id: getSheetSourceId(sheetIndex, sheet, rowIndex),
      text: row.join(" | "),
    }))),
  };
}

function isPlainRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasRealSourceIds(value, sourceLookup) {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((sourceId) => typeof sourceId === "string" && sourceLookup.has(sourceId));
}

function hasOnlyRealDataSources(value, sourceLookup) {
  if (Array.isArray(value)) return value.every((item) => hasOnlyRealDataSources(item, sourceLookup));
  if (!isPlainRecord(value)) return true;

  for (const [key, item] of Object.entries(value)) {
    if (key === "source_ids" && Array.isArray(item)) {
      if (item.some((sourceId) => typeof sourceId !== "string" || !sourceLookup.has(sourceId))) return false;
    } else if (key !== "highlights" && !hasOnlyRealDataSources(item, sourceLookup)) {
      return false;
    }
  }
  return true;
}

function hasGroundedVisualNumbers(visual, sourceLookup) {
  const visualSourceText = [
    ...visual.source_ids.map((sourceId) => sourceLookup.get(sourceId)?.text || ""),
    ...visual.highlights.flatMap((highlight) => {
      const result = highlight.derived?.result;
      if (typeof result !== "number" || !Number.isFinite(result)) return [String(result ?? "")];
      return [String(result), Math.abs(result).toFixed(1)];
    }),
  ].join("\n");
  if (!hasOnlySupportedNumbers(`${visual.title} ${visual.caption}`, visualSourceText)) return false;

  function valueIsGrounded(value, sourceIds, target) {
    if (value === null) return true;
    const directMatch = sourceIds.some((sourceId) => hasSupportedNumericValue(value, sourceLookup.get(sourceId)?.text || ""));
    if (directMatch) return true;
    return visual.highlights.some((highlight) => {
      const matchesTarget = Object.entries(target).every(([key, targetValue]) => highlight.target?.[key] === targetValue);
      return matchesTarget
        && typeof highlight.derived?.result === "number"
        && Math.abs(highlight.derived.result - value) < 1e-9;
    });
  }

  if (visual.type === "line_chart") {
    return visual.data.series.every((series) => series.values.every((value, index) =>
      valueIsGrounded(value, series.source_ids[index] ? [series.source_ids[index]] : [], {
        series_id: series.id,
        point_index: index,
      })));
  }

  if (visual.type === "bar_chart") {
    return visual.data.values.every((value, index) => valueIsGrounded(
      value,
      visual.data.source_ids[index] ? [visual.data.source_ids[index]] : [],
      { point_index: index },
    ));
  }

  if (visual.type === "kpi_cards") {
    return visual.data.cards.every((card) => typeof card.value !== "number" || valueIsGrounded(
      card.value,
      card.source_ids,
      { card_id: card.id },
    ));
  }

  if (visual.type === "comparison_table") {
    return visual.data.rows.every((row) => {
      const rowText = [
        ...row.source_ids.map((sourceId) => sourceLookup.get(sourceId)?.text || ""),
        ...visual.highlights
          .filter((highlight) => highlight.target?.row_id === row.id)
          .map((highlight) => String(highlight.derived?.result ?? "")),
      ].join("\n");
      return Object.values(row.cells).every((cell) => typeof cell === "number"
        ? hasSupportedNumericValue(cell, rowText)
          || visual.highlights.some((highlight) => highlight.target?.row_id === row.id
            && typeof highlight.derived?.result === "number"
            && Math.abs(highlight.derived.result - cell) < 1e-9)
        : typeof cell !== "string" || hasOnlySupportedNumbers(cell, rowText));
    });
  }

  if (visual.type === "timeline") {
    return visual.data.items.every((item) => {
      const itemText = item.source_ids.map((sourceId) => sourceLookup.get(sourceId)?.text || "").join("\n");
      return hasOnlySupportedNumbers(`${item.date} ${item.label} ${item.description || ""}`, itemText);
    });
  }

  if (visual.type === "flowchart") {
    return visual.data.nodes.every((node) => {
      const nodeText = node.source_ids.map((sourceId) => sourceLookup.get(sourceId)?.text || "").join("\n");
      return hasOnlySupportedNumbers(`${node.label} ${node.description || ""}`, nodeText);
    });
  }

  return true;
}

function normalizeAiSummary(result, record) {
  if (!isPlainRecord(result) || !isPlainRecord(result.spec)) throw new Error(AI_RETRY_MESSAGE);
  const { summary, key_points: keyPoints, spec } = result;
  if (!new Set(["ok", "insufficient_data"]).has(spec.status)
    || typeof spec.message !== "string"
    || !Array.isArray(spec.visuals)
    || !Array.isArray(summary)
    || summary.length > 2
    || !Array.isArray(keyPoints)
    || keyPoints.length > 5) {
    throw new Error(AI_RETRY_MESSAGE);
  }

  const sourceLookup = getSourceLookup(record);
  const invalidSummary = summary.some((sentence) => !isPlainRecord(sentence)
    || typeof sentence.text !== "string"
    || !sentence.text.trim()
    || !hasRealSourceIds(sentence.source_ids, sourceLookup)
    || !isSupportedByEvidence(sentence, sourceLookup));
  const invalidKeyPoint = keyPoints.some((point) => !isPlainRecord(point)
    || typeof point.text !== "string"
    || !point.text.trim()
    || [...point.text].length > 60
    || !hasRealSourceIds(point.source_ids, sourceLookup)
    || !isSupportedByEvidence(point, sourceLookup));

  if (invalidSummary || invalidKeyPoint || (spec.status === "ok" && summary.length === 0)) {
    throw new Error(AI_RETRY_MESSAGE);
  }

  if (spec.status === "insufficient_data" && (summary.length > 0 || keyPoints.length > 0 || spec.visuals.length > 0)) {
    throw new Error(AI_RETRY_MESSAGE);
  }

  const invalidVisual = spec.visuals.some((visual) => {
    if (!isPlainRecord(visual)
      || validateVisual(visual)
      || !hasRealSourceIds(visual.source_ids, sourceLookup)
      || !hasOnlyRealDataSources(visual.data, sourceLookup)
      || !hasGroundedVisualNumbers(visual, sourceLookup)) return true;
    const highlightTargets = new Set();
    return visual.highlights.some((highlight) => {
      if (validateHighlight(visual, highlight) || !hasRealSourceIds(highlight.source_ids, sourceLookup)) return true;
      const target = getHighlightIdentity(visual, highlight.target);
      if (highlightTargets.has(target)) return true;
      highlightTargets.add(target);
      return false;
    });
  });
  if (invalidVisual) throw new Error(AI_RETRY_MESSAGE);

  const visualSpec = {
    ...spec,
    visuals: spec.visuals,
  };

  const qualityIssues = validateAiQuality({ summary, key_points: keyPoints, spec: visualSpec }, createAiSourcePayload(record));
  if (qualityIssues.length > 0) throw new Error(AI_RETRY_MESSAGE);

  return {
    summary,
    key_points: keyPoints,
    spec: visualSpec,
    completedAt: Date.now(),
  };
}

function createAiEvidenceItem(record, item, index, kind) {
  const sourceLookup = getSourceLookup(record);
  const sourceIds = item.source_ids.filter((sourceId) => sourceLookup.has(sourceId));
  if (sourceIds.length === 0) return null;

  const wrapper = document.createElement("article");
  wrapper.className = `ai-evidence-item ai-evidence-${kind}`;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "ai-evidence-toggle";
  toggle.setAttribute("aria-expanded", "false");
  toggle.append(createTextElement("span", "ai-evidence-index", String(index + 1)));
  toggle.append(createTextElement("span", "ai-evidence-text", item.text));
  toggle.append(createTextElement("span", "ai-evidence-count", `${sourceIds.length}개 근거`));

  const detail = document.createElement("div");
  detail.className = "ai-evidence-detail";
  detail.hidden = true;
  sourceIds.forEach((sourceId) => {
    const location = sourceLookup.get(sourceId);
    if (location.text?.trim()) {
      const figure = document.createElement("figure");
      figure.className = "ai-source-quote";
      figure.append(createTextElement("figcaption", "", `원문 근거 · ${location.label}`));
      const exactQuote = item.evidence && location.text.includes(item.evidence) ? item.evidence : "";
      const sourceQuote = exactQuote || location.text.slice(0, 500);
      figure.append(createTextElement("blockquote", "", sourceQuote));
      if (!exactQuote && location.text.length > 500) {
        figure.append(createTextElement("span", "ai-source-truncated", "원문 일부를 표시합니다."));
      }
      detail.append(figure);
    }

    const openSource = createTextElement("button", "ai-source-open", `${location.label} 원본 위치로 이동`);
    openSource.type = "button";
    openSource.addEventListener("click", () => selectDocument(record.id, sourceId));
    detail.append(openSource);
  });

  toggle.addEventListener("click", () => {
    detail.hidden = !detail.hidden;
    toggle.setAttribute("aria-expanded", String(!detail.hidden));
    selectDocument(record.id, sourceIds[0]);
  });

  wrapper.append(toggle, detail);
  return wrapper;
}

function createTextElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function renderAiSummary(record) {
  const isLoading = Boolean(record && aiLoadingDocuments.has(record.id));
  const error = record ? aiErrors.get(record.id) : null;
  const summary = record?.aiSummary;

  aiSummarizeButton.disabled = !record || isLoading;
  aiSummarizeButton.classList.toggle("is-loading", isLoading);
  aiSummarizeLabel.textContent = isLoading
    ? "요약 중"
    : error
      ? "다시 시도"
      : summary
        ? "다시 요약"
        : "AI 요약";
  aiSummaryLoading.hidden = !isLoading;
  aiSummaryError.hidden = !error;
  aiSummaryErrorText.textContent = error || "";
  aiSummaryCard.hidden = !summary;
  aiSummarySentences.replaceChildren();
  aiKeyPoints.replaceChildren();
  aiInsufficientMessage.hidden = !summary || summary.spec.status !== "insufficient_data";

  if (!summary) return;
  const sourceLookup = getSourceLookup(record);
  const savedDate = summary.completedAt ? new Date(summary.completedAt) : null;
  aiSummarySaved.textContent = savedDate
    ? `저장됨 · ${new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(savedDate)}`
    : "이 브라우저에 저장됨";

  if (summary.spec.status === "ok") {
    summary.summary.slice(0, 2).forEach((sentence, index) => {
      const item = createAiEvidenceItem(record, sentence, index, "sentence");
      if (item) aiSummarySentences.append(item);
    });
    if (summary.key_points.length > 0) {
      aiKeyPoints.append(createTextElement("h4", "ai-key-points-heading", "핵심 내용"));
      summary.key_points.slice(0, 5).forEach((point, index) => {
        const item = createAiEvidenceItem(record, point, index, "point");
        if (item) aiKeyPoints.append(item);
      });
    }
  }

  for (const sentence of summary.summary.slice(0, 2)) {
    if (sentence.source_ids.some((sourceId) => !sourceLookup.has(sourceId))) {
      aiSummarySentences.replaceChildren(createTextElement("p", "ai-evidence-warning", "근거 위치를 확인할 수 없는 요약은 표시하지 않았습니다."));
      break;
    }
  }
}

function getCombinedVisualSpec(record) {
  const automaticSpec = record.visualSpec || { status: "ok", message: "", visuals: [] };
  const aiSummary = record.aiSummary;
  if (!aiSummary) return automaticSpec;

  const aiSpec = aiSummary.spec;
  if (record.type === "pdf") return aiSpec;

  if (aiSpec.status === "insufficient_data") {
    return {
      status: "ok",
      message: [automaticSpec.message, "제공된 자료만으로는 알 수 없어요."].filter(Boolean).join(" "),
      visuals: automaticSpec.visuals,
    };
  }

  return {
    status: "ok",
    message: [automaticSpec.message, aiSpec.message].filter(Boolean).join(" "),
    visuals: [...automaticSpec.visuals, ...aiSpec.visuals],
  };
}

async function runAiSummary(record) {
  if (!record || aiLoadingDocuments.has(record.id)) return;

  aiErrors.delete(record.id);
  aiLoadingDocuments.add(record.id);
  renderAiSummary(record);

  try {
    const response = await fetch("/api/ai-summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ document: createAiSourcePayload(record) }),
      signal: AbortSignal.timeout(150000),
    });

    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error(AI_RETRY_MESSAGE);
    }

    if (!response.ok) {
      if (result.code === "AI_RESPONSE_INVALID") {
        throw new Error(result.error || AI_RETRY_MESSAGE);
      }
      throw new Error(result.error || "AI 호출 실패. 서버 연결을 확인한 뒤 다시 시도해 주세요.");
    }

    if (deletingDocuments.has(record.id) || !documents.some((item) => item.id === record.id)) return;

    const nextSummary = normalizeAiSummary(result, record);
    const previousSummary = record.aiSummary;
    record.aiSummary = nextSummary;
    try {
      await saveDocument(record);
    } catch {
      record.aiSummary = previousSummary;
      throw new Error("요약은 만들었지만 브라우저에 저장하지 못했습니다. 저장 공간을 확인한 뒤 다시 시도해 주세요.");
    }
    aiErrors.delete(record.id);
    if (selectedDocumentId === record.id) {
      renderAiSummary(record);
      renderSelectedVisuals(record);
    }
  } catch (error) {
    const message = error.name === "AbortError" || error.name === "TimeoutError"
      ? "AI 요청 시간이 초과되었습니다. 다시 시도해 주세요."
      : error instanceof TypeError && /fetch|network/i.test(error.message)
        ? "AI 호출 실패. 서버 연결과 LLM_BASE_URL을 확인한 뒤 다시 시도해 주세요."
        : error.message || "AI 호출 실패. 다시 시도해 주세요.";
    if (!deletingDocuments.has(record.id) && documents.some((item) => item.id === record.id)) {
      aiErrors.set(record.id, message);
      if (selectedDocumentId === record.id) renderAiSummary(record);
    }
  } finally {
    aiLoadingDocuments.delete(record.id);
    if (selectedDocumentId === record.id && documents.some((item) => item.id === record.id)) renderAiSummary(record);
  }
}

function renderSelectedVisuals(record) {
  const fallbackSpec = {
    status: "ok",
    message: "목록에서 문서를 선택하면 저장된 시각화가 표시됩니다.",
    visuals: [],
  };
  if (!record) {
    renderVisuals(fallbackSpec, { container: visualizationOutput });
    renderAiSummary(null);
    renderDriverPanel(null);
    renderHandoverPanel(null);
    return;
  }

  const spec = record.aiSummary
    ? getCombinedVisualSpec(record)
    : record.visualSpec || {
      status: "ok",
      message: record.type === "pdf"
        ? "AI 요약 연결 후 시각화가 표시됩니다"
        : "시각화 명세를 준비하지 못했습니다. 다시 계산해 주세요.",
      visuals: [],
    };

  renderAiSummary(record);
  renderVisuals(spec, {
    container: visualizationOutput,
    sourceDocument: record,
    onNavigate: (sourceId) => selectDocument(record.id, sourceId),
  });
  renderHandoverPanel(record, { onNavigate: (sourceId) => selectDocument(record.id, sourceId) });
  renderDriverPanel(record, { onNavigate: (sourceId) => selectDocument(record.id, sourceId) });
}

function selectDocument(id, sourceId = null) {
  const record = documents.find((item) => item.id === id);
  if (!record) return;
  const selectionChanged = selectedDocumentId !== id;
  selectedDocumentId = id;
  renderDocuments();
  renderPreview(record, sourceId);
  if (selectionChanged) renderSelectedVisuals(record);
}

function openDeleteDocumentDialog(record) {
  if (!record || isDeletingDocument || deleteDocumentDialog.open) return;
  pendingDeleteDocumentId = record.id;
  deleteDocumentFileName.textContent = record.name;
  deleteDocumentDialog.showModal();
}

async function deleteDocument(id) {
  const record = documents.find((item) => item.id === id);
  if (!record) return;

  deletingDocuments.add(id);
  try {
    await deleteStoredDocument(id);
  } catch (error) {
    deletingDocuments.delete(id);
    throw error;
  }

  documents = documents.filter((item) => item.id !== id);
  searchCache.delete(id);
  aiErrors.delete(id);
  deletingDocuments.delete(id);

  const wasSelected = selectedDocumentId === id;
  if (wasSelected) selectedDocumentId = null;
  renderDocuments();

  if (wasSelected) {
    const nextVisibleDocument = getFilteredDocuments()[0];
    if (nextVisibleDocument) selectDocument(nextVisibleDocument.id);
    else {
      renderPreview(null);
      renderSelectedVisuals(null);
    }
  }

  showToast(`“${record.name}” 문서를 삭제했어요.`);
}

function setUploading(value) {
  isUploading = value;
  fileInput.disabled = value;
  uploadButtons.forEach((button) => { button.disabled = value; });
  loadSampleSpecButton.disabled = value || isLoadingSample;
  dropZone.classList.toggle("is-uploading", value);
}

async function handleFiles(fileList) {
  const files = [...fileList];
  if (files.length === 0 || isUploading) return;

  setUploading(true);
  setUploadStatus(`${files.length}개 파일을 확인하고 있어요.`);
  const failures = [];
  let savedCount = 0;

  for (const file of files) {
    try {
      const record = await extractDocument(file);
      try {
        await saveDocument(record);
      } catch {
        throw new FileProcessingError("storage");
      }
      documents.unshift(record);
      searchCache.delete(record.id);
      savedCount += 1;
    } catch (error) {
      failures.push({ fileName: file.name, message: getErrorMessage(error) });
    }
  }

  setUploading(false);
  renderDocuments();

  if (savedCount > 0) {
    activeFilter = "all";
    searchInput.value = "";
    filterButtons.forEach((button) => {
      const isSelected = button.dataset.filter === "all";
      button.classList.toggle("is-selected", isSelected);
      button.setAttribute("aria-pressed", String(isSelected));
    });
    selectDocument(documents[0].id);
  }

  if (failures.length > 0) {
    const firstFailure = failures[0];
    setUploadStatus(firstFailure.message, "error");
    showToast(firstFailure.message);
    if (savedCount > 0) {
      uploadStatus.textContent = `${savedCount}개 저장 완료 · ${firstFailure.message}`;
    }
  } else {
    const message = `${savedCount}개 파일을 이 브라우저에 저장했어요.`;
    setUploadStatus(message, "success");
    showToast(message);
  }

  fileInput.value = "";
}

function syncFilters(selectedButton) {
  filterButtons.forEach((button) => {
    const isSelected = selectedButton ? button === selectedButton : button.dataset.filter === "all";
    button.classList.toggle("is-selected", isSelected);
    button.setAttribute("aria-pressed", String(isSelected));
  });
}

async function loadSampleVisualization() {
  if (isLoadingSample || isUploading) return;
  isLoadingSample = true;
  setUploading(true);
  setUploadStatus("6종 샘플 명세를 불러오는 중이에요.");

  try {
    const [specResponse, workbookResponse] = await Promise.all([
      fetch("/test-fixtures/sample-visual-spec.json", { cache: "no-store" }),
      fetch("/test-fixtures/visual-demo.xlsx", { cache: "no-store" }),
    ]);
    if (!specResponse.ok || !workbookResponse.ok) throw new Error("샘플 자료를 불러오지 못했습니다.");

    const [sampleSpec, workbookBuffer] = await Promise.all([
      specResponse.json(),
      workbookResponse.arrayBuffer(),
    ]);
    let record = documents.find((item) => item.id === SAMPLE_DOCUMENT_ID);

    if (!record) {
      const file = new File([workbookBuffer], "업무 보고서 시각화 샘플.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      record = await extractDocument(file);
      record.id = SAMPLE_DOCUMENT_ID;
      record.isSample = true;
      documents.unshift(record);
    }

    record.visualSpec = sampleSpec;
    record.isSample = true;
    await saveDocument(record);
    selectDocument(record.id);
    renderSelectedVisuals(record);
    setUploadStatus("6가지 시각화 샘플을 불러왔어요.", "success");
    showToast("6가지 유형과 강조 표시 샘플을 불러왔어요.");
  } catch (error) {
    setUploadStatus(error.message || "샘플 시각화를 불러오지 못했습니다.", "error");
    showToast(error.message || "샘플 시각화를 불러오지 못했습니다.");
  } finally {
    isLoadingSample = false;
    setUploading(false);
  }
}

if (import.meta.env.DEV) {
  loadSampleSpecButton.hidden = false;
  developerTools.hidden = false;
}

document.querySelector("#start-upload").addEventListener("click", () => fileInput.click());
document.querySelector("#select-file").addEventListener("click", () => fileInput.click());
document.querySelector("#empty-upload").addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", () => {
  handleFiles(fileInput.files);
});

dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("is-dragging");
});

dropZone.addEventListener("dragleave", (event) => {
  if (!dropZone.contains(event.relatedTarget)) dropZone.classList.remove("is-dragging");
});

dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.classList.remove("is-dragging");
  handleFiles(event.dataTransfer.files);
});

filterButtons.forEach((button) => {
  button.addEventListener("click", () => {
    activeFilter = button.dataset.filter;
    syncFilters(button);
    renderDocuments();
  });
});

searchInput.addEventListener("input", renderDocuments);

document.querySelector("#view-all").addEventListener("click", () => {
  activeFilter = "all";
  searchInput.value = "";
  syncFilters();
  renderDocuments();
});

cancelDeleteDocumentButton.addEventListener("click", () => {
  if (isDeletingDocument) return;
  deleteDocumentDialog.close();
});
deleteDocumentDialog.addEventListener("cancel", (event) => {
  if (isDeletingDocument) event.preventDefault();
});
deleteDocumentDialog.addEventListener("close", () => {
  pendingDeleteDocumentId = null;
});
confirmDeleteDocumentButton.addEventListener("click", async () => {
  const id = pendingDeleteDocumentId;
  if (!id || isDeletingDocument) return;

  isDeletingDocument = true;
  cancelDeleteDocumentButton.disabled = true;
  confirmDeleteDocumentButton.disabled = true;
  try {
    await deleteDocument(id);
    deleteDocumentDialog.close();
  } catch {
    showToast("문서를 삭제하지 못했어요. 잠시 후 다시 시도해 주세요.");
  } finally {
    isDeletingDocument = false;
    cancelDeleteDocumentButton.disabled = false;
    confirmDeleteDocumentButton.disabled = false;
  }
});

loadSampleSpecButton.addEventListener("click", loadSampleVisualization);
aiSummarizeButton.addEventListener("click", () => {
  const record = documents.find((item) => item.id === selectedDocumentId);
  runAiSummary(record);
});
aiSummaryRetryButton.addEventListener("click", () => {
  const record = documents.find((item) => item.id === selectedDocumentId);
  runAiSummary(record);
});

document.querySelectorAll("[data-toast]").forEach((button) => {
  button.addEventListener("click", (event) => {
    if (button.tagName === "A") event.preventDefault();
    showToast(button.dataset.toast);
  });
});

document.addEventListener("keydown", (event) => {
  if (event.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) {
    event.preventDefault();
    searchInput.focus();
  }
});

window.grappler = {
  renderVisuals(spec) {
    const record = documents.find((item) => item.id === selectedDocumentId);
    return renderVisuals(spec, {
      container: visualizationOutput,
      sourceDocument: record,
      onNavigate: (sourceId) => record && selectDocument(record.id, sourceId),
    });
  },
  getVisualSpec() {
    return documents.find((item) => item.id === selectedDocumentId)?.visualSpec ?? null;
  },
};

async function init() {
  try {
    documents = await getStoredDocuments();
    for (const record of documents) {
      let needsSave = false;
      if (!Object.hasOwn(record, "visualSpec")) {
        record.visualSpec = record.type === "pdf"
          ? { status: "ok", message: "AI 요약 연결 후 시각화가 표시됩니다", visuals: [] }
          : buildSpreadsheetVisualizationSpec(record);
        needsSave = true;
      }

      if (record.aiSummary) {
        try {
          const completedAt = record.aiSummary.completedAt;
          const normalized = normalizeAiSummary(record.aiSummary, record);
          record.aiSummary = {
            ...normalized,
            completedAt: completedAt || normalized.completedAt,
          };
        } catch {
          delete record.aiSummary;
          aiErrors.set(record.id, "저장된 AI 결과가 원문 검증을 통과하지 않아 숨겼습니다. 다시 요약해 주세요.");
          needsSave = true;
        }
      }

      if (needsSave) await saveDocument(record);
    }
  } catch (error) {
    setUploadStatus(error.message || "저장된 문서를 불러오지 못했습니다.", "error");
  }

  isLoadingDocuments = false;
  renderDocuments();
  if (documents.length > 0) selectDocument(documents[0].id);
  else renderSelectedVisuals(null);
}

init();
