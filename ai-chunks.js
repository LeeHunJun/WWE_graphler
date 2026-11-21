const MAX_CHUNK_CHARACTERS = 12000;
const MAX_CHUNK_SOURCES = 40;
const SHEET_SOURCE_PATTERN = /^sheet:(\d+):row:(\d+)$/;

function splitText(text, limit) {
  const parts = [];
  let remaining = String(text);
  while (remaining.length > limit) {
    let boundary = remaining.lastIndexOf("\n", limit);
    if (boundary < limit * 0.5) boundary = remaining.lastIndexOf(" ", limit);
    if (boundary < limit * 0.5) boundary = limit;
    parts.push(remaining.slice(0, boundary));
    remaining = remaining.slice(boundary).replace(/^\s+/, "");
  }
  if (remaining.length > 0) parts.push(remaining);
  return parts;
}

function splitOversizedSource(source, limit) {
  if (source.text.length <= limit) return [source];
  return splitText(source.text, limit).map((text) => ({ source_id: source.source_id, text }));
}

function packSources(sources, { limit, maxSources, prefix = [] }) {
  const chunks = [];
  let current = [...prefix];
  let length = current.reduce((total, source) => total + source.text.length, 0);

  for (const source of sources) {
    const pieces = splitOversizedSource(source, limit);
    for (const piece of pieces) {
      const nextLength = length + piece.text.length;
      if (current.length > prefix.length && (nextLength > limit || current.length >= maxSources)) {
        chunks.push(current);
        current = [...prefix];
        length = current.reduce((total, item) => total + item.text.length, 0);
      }
      if (piece.text.length > limit - length && current.length > prefix.length) {
        chunks.push(current);
        current = [...prefix];
        length = current.reduce((total, item) => total + item.text.length, 0);
      }
      current.push(piece);
      length += piece.text.length;
      if (pieces.length > 1) {
        chunks.push(current);
        current = [...prefix];
        length = current.reduce((total, item) => total + item.text.length, 0);
      }
    }
  }

  if (current.length > prefix.length) chunks.push(current);
  return chunks;
}

function chunkTabularSources(sources, options) {
  const sheets = new Map();
  for (const source of sources) {
    const match = source.source_id.match(SHEET_SOURCE_PATTERN);
    if (!match) continue;
    const sheetIndex = Number(match[1]);
    const rowNumber = Number(match[2]);
    if (!sheets.has(sheetIndex)) sheets.set(sheetIndex, []);
    sheets.get(sheetIndex).push({ ...source, rowNumber });
  }

  const chunks = [];
  for (const rows of sheets.values()) {
    rows.sort((first, second) => first.rowNumber - second.rowNumber);
    const header = rows.find((row) => row.text.trim());
    if (!header) continue;
    const dataRows = rows.filter((row) => row !== header && row.text.trim());
    if (dataRows.length === 0) {
      chunks.push([header]);
      continue;
    }

    let current = [header];
    let currentLength = header.text.length;
    for (const row of dataRows) {
      const exceedsCharacters = currentLength + row.text.length > options.limit;
      const exceedsSources = current.length >= options.maxSources;
      if (current.length > 1 && (exceedsCharacters || exceedsSources)) {
        chunks.push(current.map(({ source_id, text }) => ({ source_id, text })));
        current = [header];
        currentLength = header.text.length;
      }
      current.push(row);
      currentLength += row.text.length;
      if (row.text.length > options.limit - header.text.length) {
        chunks.push(current.map(({ source_id, text }) => ({ source_id, text })));
        current = [header];
        currentLength = header.text.length;
      }
    }
    if (current.length > 1) chunks.push(current.map(({ source_id, text }) => ({ source_id, text })));
  }

  return chunks.length > 0 ? chunks : packSources(sources, { ...options, prefix: [] });
}

export function buildDocumentChunks(document, {
  maxCharacters = MAX_CHUNK_CHARACTERS,
  maxSources = MAX_CHUNK_SOURCES,
} = {}) {
  const sources = document.sources.filter((source) => source.text.trim());
  if (sources.reduce((total, source) => total + source.text.length, 0) <= maxCharacters
    && sources.length <= maxSources) return [sources];

  const options = { limit: maxCharacters, maxSources };
  if (document.type === "csv" || document.type === "excel") return chunkTabularSources(sources, options);
  return packSources(sources, { ...options, prefix: [] });
}
