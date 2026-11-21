# Grappler Visualization Contract

This document defines the JSON contract shared by automatic spreadsheet rules and the AI-summary step. Both paths must pass their result to the same exported `renderVisuals(spec, options)` function in `visualization.js`.

## Runtime Flow

1. `buildSpreadsheetVisualizationSpec(record)` creates and returns a JSON-compatible spec for CSV and XLSX records.
2. The app saves the automatic spec on the same IndexedDB document record as the extracted text and source file (`record.visualSpec`). It is reused after reload.
3. PDF records show `{ "status": "ok", "message": "AI 요약 연결 후 시각화가 표시됩니다", "visuals": [] }` until an AI result is saved.
4. The `AI 요약` button sends the already extracted page/row text to the server route `/api/ai-summarize`. The server calls an OpenAI-compatible `chat/completions` endpoint with model `jitda-chat`. `LLM_API_KEY` is read only on the server; `LLM_BASE_URL` is the provider's base URL and should end at the API root (for example, `/v1`) or at `/chat/completions`.
5. AI result summary and spec are stored together on the document record as `record.aiSummary`. PDF renders its AI spec. CSV/XLSX keep their automatic visuals and append AI visuals; both pass through `renderVisuals`.
6. AI summaries are reused after reload and do not trigger another model call. A new call happens only when the user presses `AI 요약` again.
7. In the running browser, `window.grappler.renderVisuals(spec)` remains available for development and integration checks. It uses the currently selected document as the source map.

`renderVisuals` is the only renderer. Do not add a separate renderer for AI responses or sample data.

## AI Summary Envelope

The AI endpoint returns a small wrapper around the unchanged `spec` contract. `summary` contains at most two cited sentences; `key_points` contains up to five cited sentences of 60 characters or fewer. Each citation uses exact source IDs from the same document. The nested `spec` is exactly the top-level JSON shape documented below; its fields and visual schemas are not extended.

```json
{
  "summary": [
    {"text": "개발 행의 수치는 12입니다.", "evidence": "개발 | 12 | 진행", "source_ids": ["sheet:0:row:3"]}
  ],
  "key_points": [
    {"text": "개발 행 수치 12", "evidence": "개발 | 12 | 진행", "source_ids": ["sheet:0:row:3"]}
  ],
  "spec": {
    "status": "ok",
    "message": "개발팀의 완료 건수가 가장 많습니다.",
    "visuals": []
  }
}
```

The server includes this document and `public/test-fixtures/sample-visual-spec.json` in its model instructions. `evidence` must be an exact excerpt from a cited source; summary claims must also share supported content terms, status, and numbers with the cited material. For CSV/XLSX metric claims, cite both the original data row and the header row that names its metric or unit. The server checks that explicit decisions, changes, risks, dates, and procedures are cited, that their required visual types are present, and that highlights point to their data targets with consistent calculations and direction. Missing facts, mismatched types, duplicate highlights, stale source ids, or unsupported numbers trigger one reanalysis. The browser repeats these checks on new and cached results; invalid stored results are hidden instead of being shown. Both server and browser use the same `renderVisuals` validation and source navigation. The server never returns the API key.

## Top-Level Schema

```json
{
  "status": "ok",
  "message": "분기 매출이 전분기보다 증가했습니다.",
  "visuals": []
}
```

- `status`: required; `ok` or `insufficient_data`.
- `message`: required string. A normal message is shown above the visualizations. For `insufficient_data`, the UI always shows `제공된 자료만으로는 알 수 없어요.`.
- `visuals`: required array. An invalid visual is skipped without removing valid siblings.

## Visual Schema

Each visual has these required fields:

```json
{
  "id": "sales-by-quarter",
  "type": "line_chart",
  "title": "분기별 매출",
  "caption": "4분기 매출은 120억 원으로 3분기보다 20% 증가했습니다.",
  "source_ids": ["sheet:0:row:5"],
  "data": {},
  "highlights": []
}
```

- `id`: stable, unique id within the spec.
- `type`: one of `line_chart`, `bar_chart`, `comparison_table`, `flowchart`, `timeline`, `kpi_cards`.
- `title`: short title.
- `caption`: one sentence that states the main takeaway, including useful figures when available.
- `source_ids`: source locations that support the visual.
- `data`: type-specific payload described below.
- `highlights`: zero to three emphasis records.

## Source IDs

Source ids are scoped to the document whose spec is being rendered. Use the exact extracted source location:

- PDF page: `pdf:page:1` (one-based page number).
- CSV or XLSX row: `sheet:0:row:2` (zero-based sheet index, one-based source row number, including the header row). For CSV, this is the logical record number, so a quoted cell containing a newline still belongs to one row; for XLSX, it is the original worksheet row number.
- XLSX uses the sheet order in the workbook. CSV is sheet index `0`.
- Blank rows retain their original row numbers. Old browser records without `rowNumbers` use the extracted row index plus one.

The renderer resolves highlight `source_ids` against the selected document. It does not display a highlight if any of its source ids are missing or invalid. It also omits a malformed target, so a highlight can never point at a different row by accident.

For chart data, keep source ids aligned by index: `labels[i]`, `values[i]`, and `source_ids[i]` refer to the same source record. A missing value is `null`, never `0`. For line series, each series has its own aligned `source_ids` array.

## Type-Specific Data

### `line_chart`

```json
{
  "labels": ["1월", "2월", "3월"],
  "unit": "억원",
  "series": [
    {
      "id": "revenue",
      "name": "매출",
      "unit": "억원",
      "values": [100, null, 130],
      "source_ids": ["sheet:0:row:2", "sheet:0:row:3", "sheet:0:row:4"]
    }
  ],
  "note": "상위 4개 선만 표시했습니다."
}
```

`series` supports up to four lines. `values` and `source_ids` must have exactly the same length as `labels`.

### `bar_chart`

```json
{
  "labels": ["기획", "개발"],
  "values": [8, 12],
  "source_ids": ["sheet:0:row:2", "sheet:0:row:3"],
  "series_name": "완료 업무",
  "unit": "건",
  "note": "상위 10개만 표시했습니다."
}
```

`values` and `source_ids` must have exactly the same length as `labels`.

### `comparison_table`

```json
{
  "columns": [
    {"key": "metric", "label": "항목"},
    {"key": "before", "label": "변경 전"},
    {"key": "after", "label": "변경 후"}
  ],
  "rows": [
    {
      "id": "processing-time",
      "cells": {"metric": "처리 시간", "before": "10분", "after": "7분"},
      "source_ids": ["sheet:0:row:4"]
    }
  ]
}
```

Every row must provide a `cells` value (which may be empty) for every declared column key.

### `flowchart`

```json
{
  "nodes": [
    {"id": "request", "label": "요청 등록", "description": "자료 첨부", "source_ids": ["sheet:0:row:2"]},
    {"id": "review", "label": "검토", "source_ids": ["sheet:0:row:3"]}
  ],
  "edges": [
    {"from": "request", "to": "review", "label": "자료 확인", "source_ids": ["sheet:0:row:2"]}
  ]
}
```

Node ids must be unique. Every edge must refer to existing nodes. Nodes are displayed in array order, and every edge is listed with its source and destination.

### `timeline`

```json
{
  "items": [
    {"id": "launch", "date": "2026-04-16", "label": "정식 출시", "description": "전체 공개", "source_ids": ["sheet:0:row:8"]}
  ]
}
```

### `kpi_cards`

```json
{
  "cards": [
    {"id": "readiness", "label": "출시 준비율", "value": 92, "unit": "%", "note": "목표 100%", "source_ids": ["sheet:0:row:9"]}
  ]
}
```

## Highlight Schema

```json
{
  "target": {"series_id": "revenue", "point_index": 2},
  "level": "critical",
  "label": "3월 매출 하락",
  "reason": "전월보다 매출이 12.5% 줄었습니다.",
  "source_ids": ["sheet:0:row:3", "sheet:0:row:4"],
  "derived": {
    "formula": "(현재 값 - 직전 값) ÷ 직전 값 × 100",
    "original_values": [
      {"label": "2월 매출", "value": 160},
      {"label": "3월 매출", "value": 140}
    ],
    "result": -12.5
  }
}
```

- `level`: `critical`, `important`, or `info`. The UI always pairs the red, orange, or gray treatment with the `긴급`, `중요`, or `참고` label.
- `target` by type: line `{ "series_id", "point_index" }`; bar `{ "point_index" }`; table `{ "row_id", "column_key?" }`; flow `{ "node_id" }` or `{ "edge_from", "edge_to" }`; timeline `{ "item_id" }`; KPI `{ "card_id" }`.
- `source_ids`: one or more real source ids. Selecting an emphasis opens its reason and formula, then moves the document preview to the first source location. All source links remain available in the detail.
- `derived`: `null` when the value is not a direct calculation. Otherwise include `formula`, the original values used, and the result. Use `null` result if the formula cannot be evaluated, for example a zero denominator.

## Automatic CSV and XLSX Rules

- The first non-empty text or date column is used as the category axis. A recognized date, month, quarter, or year axis selects `line_chart`; other categories select `bar_chart`.
- Numeric columns are parsed independently. Empty cells remain `null` and appear as gaps, not zeroes.
- A categorical bar chart keeps at most ten rows. When rows exceed ten, it sorts by numeric value descending and adds `상위 10개만 표시했습니다.` to the visual note and a numeric caption.
- A time-series chart keeps at most four numeric series, ranked by the sum of absolute values. It does not discard dates.
- Each chart adds at most three emphasis records: the largest decrease from the preceding source row is `critical`; maximum and minimum values are `important` unless the same point is already emphasized.
- A decrease stores `(현재 값 - 직전 값) ÷ |직전 값| × 100` and both original values in `derived`.
- If no numeric column exists, the spec message is `수치 데이터가 없어 그래프를 만들 수 없습니다`.
- PDF specs stay in the AI-pending state until a later step supplies an AI spec.

## Validation and Partial Results

- A missing top-level field blocks the invalid spec, but a malformed visual is skipped on its own. Warnings explain missing required fields or mismatched label/value counts.
- Highlights are independently validated. A stale source id or a target that does not exist in its visual is hidden without discarding that visual.
- `insufficient_data` uses the fixed Korean message `제공된 자료만으로는 알 수 없어요.`.
- A drawing error removes only the failed card, preserves cards already drawn, and presents a `다시 시도` button.

## Chart Library

The project uses Chart.js for `line_chart` and `bar_chart`. This app is plain JavaScript with Vite, so Chart.js adds responsive charts and click-to-source interactions without introducing a UI framework. Comparison tables, process flows, timelines, and KPI cards remain semantic HTML, which makes their source navigation and emphasis states straightforward.

## Test Fixtures

The development panel links to the CSV and XLSX fixtures under `public/test-fixtures/`. `sample-visual-spec.json` is the six-type example. The `6종 샘플 보기` button loads `visual-demo.xlsx`, stores its spec in IndexedDB, and renders it through the same `renderVisuals` function.
