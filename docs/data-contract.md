# Grappler AI Response Contract

This contract wraps the visualization spec in `VISUALIZATION-SPEC.md`. The model should return one JSON object. The server safely extracts a balanced object from surrounding prose or a Markdown code fence and then normalizes it against this contract.

## Response

```json
{
  "summary": [
    {
      "text": "Q3 매출은 Q2보다 5.6% 감소했습니다.",
      "evidence": "Q2 매출 125, Q3 매출 118, 변화율 -5.6%",
      "source_ids": ["sheet:0:row:4", "sheet:0:row:5"]
    }
  ],
  "key_points": [
    {
      "text": "Q3 매출은 118입니다.",
      "evidence": "Q3 매출 | 118",
      "source_ids": ["sheet:0:row:5"]
    }
  ],
  "spec": {
    "status": "ok",
    "message": "Q3 매출은 전 분기보다 감소했습니다.",
    "visuals": []
  }
}
```

- `summary`: up to two concise sentences.
- `key_points`: up to five sentences after merge, each at most 60 characters. The model is asked for at most three per source chunk to keep responses short.
- Summary and key point entries require `text`, exact contiguous `evidence` copied from one supplied source, and one or more existing `source_ids`.
- If a model combines multiple row quotes in `evidence` separated by line breaks or semicolons, the server keeps the first exact quote for display and attaches the matching original row IDs for the remaining quotes.
- For CSV/Excel metric claims, cite both the data row and the header row that supplies the metric name or unit.
- `spec`: the existing status/message/visuals shape and six visual schemas in `VISUALIZATION-SPEC.md`. Do not add fields to that visualization contract.

## Recovery Defaults

- Missing `summary` or `key_points` arrays default to empty arrays. Invalid individual entries are omitted; source-backed important omissions trigger a reanalysis.
- Missing `spec.visuals` defaults to an empty array. Invalid individual visuals are omitted; valid sibling visuals remain.
- Missing `visual.id` receives a stable response-local ID. A missing title, caption, or data object makes only that visual unusable.
- Missing `highlights` defaults to an empty array. Invalid highlight entries are omitted; the quality checks request a reanalysis when a source-backed important change or deadline then has no emphasis.
- If a line-chart highlight marks a numeric change but omits `derived`, the server computes the adjacent-point percentage from that line and its real source rows. Supplied calculations are checked and are never silently overwritten.
- Missing or invalid `spec.status` is treated as `insufficient_data`; its summary, key points, and visuals are cleared so unsupported content is never shown.
- A non-object response, an unextractable/truncated JSON object, or a response with no usable summary and no valid visual is a retryable response error.

## Length And Chunking

- The server splits long documents at PDF page and CSV/Excel sheet-row boundaries, repeats the sheet header with each row chunk, and sends an oversized single source as contiguous text slices under the same original source ID.
- Each chunk is validated independently. A failed chunk is recorded and does not erase valid results from other chunks.
- The server limits each completion with the provider-supported `max_completion_tokens` field (5,000 tokens), asks for at most three key points and three visuals per chunk, and retries an invalid response at most twice (three total attempts). The second retry explicitly requests JSON only.
- The original model response for an invalid attempt is written to the server-only `.opencode/ai-response-diagnostics.jsonl` log with its attempt number, finish reason, and validation issue. These raw responses may repeat document content; the log is outside the served directory and ignored by Git. API keys and request authorization headers are never logged.
