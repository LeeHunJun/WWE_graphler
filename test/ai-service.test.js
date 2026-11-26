import assert from "node:assert/strict";
import test from "node:test";
import { AiServiceError, requestAiSummary, resolveChatCompletionsUrl, validateAiEnvelope } from "../ai-service.js";
import { validateAiQuality } from "../ai-quality.js";
import { isSupportedByEvidence } from "../source-evidence.js";
import { buildDocumentChunks } from "../ai-chunks.js";
import { normalizeAiEnvelope, parseJsonObject } from "../ai-response.js";
import { parseTemporal } from "../visualization.js";

const sampleSpec = {
  status: "ok",
  message: "테스트 명세",
  visuals: [],
};
const document = {
  name: "업무.csv",
  type: "csv",
  sources: [
    { source_id: "sheet:0:row:1", text: "항목 | 값" },
    { source_id: "sheet:0:row:2", text: "매출 | 123" },
  ],
};
const options = {
  apiKey: "unit-test-key",
  baseUrl: "https://llm.example/v1",
  contractText: "공유 시각화 규격",
  dataContractText: "요약·핵심 항목·시각화 응답 계약",
  sampleSpec,
};
const validResult = {
  summary: [{ text: "매출은 123입니다.", evidence: "매출 | 123", source_ids: ["sheet:0:row:2", "sheet:0:row:1"] }],
  key_points: [{ text: "매출은 123입니다.", evidence: "매출 | 123", source_ids: ["sheet:0:row:2", "sheet:0:row:1"] }],
  spec: sampleSpec,
};

function modelResponse(content, status = 200) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function truncatedResponse(content) {
  return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "length" }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("OpenAI 호환 기본 주소에 chat completions 경로를 붙입니다", () => {
  assert.equal(resolveChatCompletionsUrl("https://llm.example/v1/"), "https://llm.example/v1/chat/completions");
  assert.equal(resolveChatCompletionsUrl("https://llm.example/v1/chat/completions"), "https://llm.example/v1/chat/completions");
});

test("모델 이름, 서버 인증 헤더와 샘플 명세를 보냅니다", async () => {
  let request;
  const result = await requestAiSummary(document, {
    ...options,
    fetchImpl: async (url, init) => {
      request = { url, init };
      return modelResponse(JSON.stringify(validResult));
    },
  });
  const body = JSON.parse(request.init.body);
  assert.equal(result.spec.status, "ok");
  assert.equal(body.model, "jitda-chat");
  assert.ok(body.max_completion_tokens > 0);
  assert.equal(request.url, "https://llm.example/v1/chat/completions");
  assert.equal(request.init.headers.Authorization, "Bearer unit-test-key");
  assert.equal(body.max_completion_tokens, 5000);
  assert.ok(body.messages[0].content.includes("공유 시각화 규격"));
  assert.ok(body.messages[0].content.includes("docs/data-contract.md"));
  assert.ok(body.messages[0].content.includes(JSON.stringify(sampleSpec)));
  assert.ok(body.messages[1].content.includes("sheet:0:row:2"));
});

test("JSON이 잘못되면 한 번 재시도해 정상 응답을 사용합니다", async () => {
  let callCount = 0;
  const result = await requestAiSummary(document, {
    ...options,
    fetchImpl: async () => {
      callCount += 1;
      return modelResponse(callCount === 1 ? "아직 JSON이 아닙니다" : JSON.stringify(validResult));
    },
  });
  assert.equal(callCount, 2);
  assert.deepEqual(result, validResult);
});

test("두 번 잘못된 뒤에는 JSON 전용 지시로 세 번째 호출을 합니다", async () => {
  let callCount = 0;
  const result = await requestAiSummary(document, {
    ...options,
    fetchImpl: async (_url, init) => {
      callCount += 1;
      const request = JSON.parse(init.body);
      if (callCount === 3) assert.match(request.messages.at(-1).content, /JSON 객체만 출력/);
      return modelResponse(callCount < 3 ? "설명만 있고 JSON은 없습니다" : JSON.stringify(validResult));
    },
  });
  assert.equal(callCount, 3);
  assert.deepEqual(result, validResult);
});

test("명세가 불완전해도 기본값으로 채워 유효한 요점과 visual을 보존합니다", async () => {
  let callCount = 0;
  const result = await requestAiSummary(document, {
    ...options,
    fetchImpl: async () => {
      callCount += 1;
      return modelResponse(JSON.stringify({
        summary: [{ text: "매출은 123입니다.", evidence: "매출 | 123", source_ids: ["sheet:0:row:2"] }],
        spec: {
          status: "ok",
          message: "매출을 표시합니다.",
          visuals: [{
            type: "bar_chart",
            title: "매출 비교",
            data: { labels: ["매출"], values: [123], source_ids: ["sheet:0:row:2"] },
          }],
        },
      }));
    },
  });
  assert.equal(callCount, 1);
  assert.deepEqual(result.key_points, []);
  assert.equal(result.spec.visuals.length, 1);
  assert.match(result.spec.visuals[0].id, /^ai-visual-/);
});

test("두 번째 재시도에는 JSON 형식만 요청하는 보정 지시를 붙입니다", async () => {
  let callCount = 0;
  const result = await requestAiSummary(document, {
    ...options,
    fetchImpl: async (_url, init) => {
      callCount += 1;
      const request = JSON.parse(init.body);
      if (callCount === 3) assert.ok(request.messages.at(-1).content.includes("JSON 객체만 출력"));
      return modelResponse(callCount < 3 ? "```json\n{ broken" : JSON.stringify(validResult));
    },
  });
  assert.equal(callCount, 3);
  assert.deepEqual(result, validResult);
});

test("빈 응답은 한 번 자동으로 다시 요청합니다", async () => {
  let callCount = 0;
  const result = await requestAiSummary(document, {
    ...options,
    fetchImpl: async () => {
      callCount += 1;
      return modelResponse(callCount === 1 ? "" : JSON.stringify(validResult));
    },
  });
  assert.equal(callCount, 2);
  assert.deepEqual(result, validResult);
});

test("잘린 응답을 다시 요청하고 diagnostic에 원문과 finish_reason을 남깁니다", async () => {
  let callCount = 0;
  const diagnostics = [];
  const result = await requestAiSummary(document, {
    ...options,
    onDiagnostic: (entry) => diagnostics.push(entry),
    fetchImpl: async () => {
      callCount += 1;
      return callCount === 1
        ? truncatedResponse('{"summary":[{"text":"잘린 응답')
        : modelResponse(JSON.stringify(validResult));
    },
  });
  assert.equal(callCount, 2);
  assert.deepEqual(result, validResult);
  assert.equal(diagnostics[0].stage, "completion_truncated");
  assert.equal(diagnostics[0].finish_reason, "length");
  assert.equal(diagnostics[0].raw_response, '{"summary":[{"text":"잘린 응답');
});

test("설명 문장과 Markdown 코드펜스 앞뒤에서 JSON만 추출합니다", () => {
  const result = parseJsonObject(`분석 결과입니다.\n\`\`\`json\n${JSON.stringify(validResult)}\n\`\`\`\n참고 설명입니다.`);
  assert.deepEqual(result, validResult);
});

test("누락된 선택 필드는 기본값으로 채우고 유효한 visual은 유지합니다", () => {
  const result = normalizeAiEnvelope({
    spec: {
      status: "ok",
      message: "매출을 표시합니다.",
      visuals: [{
        type: "bar_chart",
        title: "매출 비교",
        data: { labels: ["매출"], values: [123], source_ids: ["sheet:0:row:2"] },
      }],
    },
  }, new Map([
    ["sheet:0:row:1", { text: "항목 | 값" }],
    ["sheet:0:row:2", { text: "매출 | 123" }],
  ]));
  assert.deepEqual(result.summary, []);
  assert.deepEqual(result.key_points, []);
  assert.equal(result.spec.visuals.length, 1);
  assert.match(result.spec.visuals[0].id, /^ai-visual-/);
  assert.deepEqual(result.spec.visuals[0].source_ids, ["sheet:0:row:2"]);
});

test("행 구절을 세미콜론으로 합친 evidence는 실제 원문별로 나누어 복구합니다", () => {
  const sourceMap = new Map([
    ["sheet:0:row:1", { text: "월 | 매출(억원)" }],
    ["sheet:0:row:2", { text: "2026-01 | 100" }],
    ["sheet:0:row:3", { text: "2026-02 | 150" }],
  ]);
  const result = normalizeAiEnvelope({
    summary: [{
      text: "2026-01 매출은 100에서 2026-02 150으로 증가했습니다.",
      evidence: "2026-01|100;2026-02|150",
      source_ids: ["sheet:0:row:1", "sheet:0:row:2", "sheet:0:row:3"],
    }],
    key_points: [],
    spec: { status: "ok", message: "월별 매출이 증가했습니다.", visuals: [] },
  }, sourceMap);
  assert.equal(result.summary.length, 1);
  assert.equal(result.summary[0].evidence, "2026-01 | 100");
  assert.ok(result.summary[0].source_ids.includes("sheet:0:row:2"));
  assert.ok(result.summary[0].source_ids.includes("sheet:0:row:3"));
});

test("시간 변화 강조에 derived가 빠지면 원본 시점에서 계산해 채웁니다", () => {
  const normalized = normalizeAiEnvelope({
    summary: [{ text: "2월 매출은 123에서 100으로 감소했습니다.", evidence: "1월 | 매출 123", source_ids: ["sheet:0:row:3", "sheet:0:row:4"] }],
    spec: {
      status: "ok",
      message: "월별 매출 흐름입니다.",
      visuals: [{
        type: "line_chart",
        title: "월별 매출",
        caption: "2월은 100으로 1월보다 감소했습니다.",
        source_ids: ["sheet:0:row:1", "sheet:0:row:2", "sheet:0:row:3", "sheet:0:row:4"],
        data: {
          labels: ["1월", "2월"],
          series: [{ id: "sales", name: "매출", values: [123, 100], source_ids: ["sheet:0:row:3", "sheet:0:row:4"] }],
        },
        highlights: [{
          target: { series_id: "sales", point_index: 1 },
          level: "critical",
          label: "매출 감소",
          reason: "2월 매출은 전월보다 감소했습니다.",
          source_ids: ["sheet:0:row:4"],
        }],
      }],
    },
  }, new Map([
    ["sheet:0:row:1", { text: "월 | 매출" }],
    ["sheet:0:row:2", { text: "구분 | 값" }],
    ["sheet:0:row:3", { text: "1월 | 매출 123" }],
    ["sheet:0:row:4", { text: "2월 | 매출 100" }],
  ]));
  const highlight = normalized.spec.visuals[0].highlights[0];
  assert.deepEqual(highlight.source_ids, ["sheet:0:row:4", "sheet:0:row:3"]);
  assert.equal(highlight.derived.result, -18.7);
  assert.equal(highlight.derived.original_values[0].value, 123);
  assert.equal(highlight.derived.original_values[1].value, 100);
});

test("시계열 강조에서 실제 데이터 행을 넓게 인용하면 대상 구간만 남깁니다", () => {
  const sources = new Map([
    ["sheet:0:row:1", { text: "월 | 매출" }],
    ["sheet:0:row:2", { text: "1월 | 100" }],
    ["sheet:0:row:3", { text: "2월 | 150" }],
    ["sheet:0:row:4", { text: "3월 | 120" }],
  ]);
  const result = normalizeAiEnvelope({
    summary: [{ text: "매출은 2월보다 3월에 감소했습니다.", evidence: "2월 | 150", source_ids: [...sources.keys()] }],
    key_points: [],
    spec: {
      status: "ok",
      message: "월별 매출입니다.",
      visuals: [{
        id: "sales-trend",
        type: "line_chart",
        title: "월별 매출",
        caption: "3월 매출 120은 2월 150보다 낮습니다.",
        source_ids: [...sources.keys()],
        data: { labels: ["1월", "2월", "3월"], series: [{ id: "sales", name: "매출", values: [100, 150, 120], source_ids: ["sheet:0:row:2", "sheet:0:row:3", "sheet:0:row:4"] }] },
        highlights: [{
          target: { series_id: "sales", point_index: 2 },
          level: "critical",
          label: "매출 하락",
          reason: "매출이 2월보다 3월에 줄었습니다.",
          source_ids: [...sources.keys()],
        }],
      }],
    },
  }, sources);
  assert.deepEqual(result.spec.visuals[0].highlights[0].source_ids, ["sheet:0:row:4", "sheet:0:row:3", "sheet:0:row:1"]);
});

test("페이지·시트 행 경계에서 긴 입력을 나누고 행 제목을 반복합니다", () => {
  const sources = [
    { source_id: "sheet:0:row:1", text: "항목 | 값" },
    ...Array.from({ length: 8 }, (_, index) => ({ source_id: `sheet:0:row:${index + 2}`, text: `${index} | ${"실적 ".repeat(400)}` })),
  ];
  const chunks = buildDocumentChunks({ type: "excel", sources }, { maxCharacters: 1800, maxSources: 4 });
  assert.ok(chunks.length > 1);
  chunks.forEach((chunk) => {
    assert.equal(chunk.filter((source) => source.source_id === "sheet:0:row:1").length, 1);
    assert.ok(chunk.length <= 4);
  });
  assert.deepEqual(
    chunks.flatMap((chunk) => chunk.filter((source) => source.source_id !== "sheet:0:row:1").map((source) => source.source_id)),
    sources.slice(1).map((source) => source.source_id),
  );
});

test("한 구간이 세 번 실패해도 다른 PDF 페이지 결과를 합쳐 반환합니다", async () => {
  const pageText = "Alpha project details remain stable. ".repeat(210);
  const longDocument = {
    name: "long-report.pdf",
    type: "pdf",
    sources: [
      { source_id: "pdf:page:1", text: pageText },
      { source_id: "pdf:page:2", text: pageText.replaceAll("Alpha", "Beta") },
    ],
  };
  let callCount = 0;
  const diagnostics = [];
  const result = await requestAiSummary(longDocument, {
    ...options,
    onDiagnostic: (entry) => diagnostics.push(entry),
    fetchImpl: async (_url, init) => {
      callCount += 1;
      const request = JSON.parse(init.body);
      const userMessage = request.messages.find((message) => message.role === "user").content;
      if (userMessage.includes("pdf:page:1")) {
        return modelResponse(JSON.stringify({
          summary: [{
            text: "Alpha project details remain stable.",
            evidence: "Alpha project details remain stable.",
            source_ids: ["pdf:page:1"],
          }],
          key_points: [],
          spec: { status: "ok", message: "원문 내용을 정리했습니다.", visuals: [] },
        }));
      }
      return modelResponse("응답 본문이 잘렸습니다");
    },
  });

  assert.equal(callCount, 4);
  assert.equal(result.summary[0].source_ids[0], "pdf:page:1");
  assert.match(result.spec.message, /일부 문서 구간/);
  assert.equal(diagnostics.length, 3);
  assert.ok(diagnostics.every((entry) => entry.chunk_index === 2 && entry.chunk_count === 2));
  assert.ok(diagnostics.every((entry) => entry.raw_response === "응답 본문이 잘렸습니다"));
});

test("한 PDF 구간이 실패해도 성공한 다른 페이지의 요약은 반환합니다", async () => {
  const pageText = "Alpha project status is stable. ".repeat(230);
  const longDocument = {
    name: "long-report.pdf",
    type: "pdf",
    sources: [
      { source_id: "pdf:page:1", text: pageText },
      { source_id: "pdf:page:2", text: pageText.replaceAll("Alpha", "Beta") },
    ],
  };
  let callCount = 0;
  const diagnostics = [];
  const result = await requestAiSummary(longDocument, {
    ...options,
    onDiagnostic: (entry) => diagnostics.push(entry),
    fetchImpl: async (_url, init) => {
      callCount += 1;
      const requestBody = JSON.parse(init.body);
      const userMessage = requestBody.messages.find((message) => message.role === "user").content;
      if (userMessage.includes("pdf:page:1")) {
        return modelResponse(JSON.stringify({
          summary: [{ text: "Alpha project 상태는 stable입니다.", evidence: "Alpha project status is stable.", source_ids: ["pdf:page:1"] }],
          key_points: [],
          spec: { status: "ok", message: "원문 내용을 정리했습니다.", visuals: [] },
        }));
      }
      return modelResponse("아직 완성되지 않은 응답");
    },
  });

  assert.equal(callCount, 4);
  assert.equal(result.summary.length, 1);
  assert.equal(result.summary[0].source_ids[0], "pdf:page:1");
  assert.match(result.spec.message, /일부 문서 구간/);
  assert.equal(diagnostics.length, 3);
  assert.ok(diagnostics.every((entry) => entry.chunk_index === 2 && entry.chunk_count === 2));
  assert.ok(diagnostics.every((entry) => entry.raw_response === "아직 완성되지 않은 응답"));
});

test("원본에 없는 summary source_id는 한 번 재시도합니다", async () => {
  let callCount = 0;
  const fabricatedCitation = {
    ...validResult,
    summary: [{ text: "근거 없는 문장입니다.", evidence: "근거 없는 문장입니다.", source_ids: ["sheet:9:row:999"] }],
  };
  const result = await requestAiSummary(document, {
    ...options,
    fetchImpl: async () => {
      callCount += 1;
      return modelResponse(JSON.stringify(callCount === 1 ? fabricatedCitation : validResult));
    },
  });
  assert.equal(callCount, 2);
  assert.deepEqual(result.summary, validResult.summary);
});

test("원문에 없는 숫자 주장은 실제 source_id가 있어도 재시도합니다", async () => {
  let callCount = 0;
  const unsupportedNumber = {
    ...validResult,
    summary: [{ text: "매출은 999입니다.", evidence: "매출 | 123", source_ids: ["sheet:0:row:2"] }],
  };
  const result = await requestAiSummary(document, {
    ...options,
    fetchImpl: async () => {
      callCount += 1;
      return modelResponse(JSON.stringify(callCount === 1 ? unsupportedNumber : validResult));
    },
  });
  assert.equal(callCount, 2);
  assert.deepEqual(result.summary, validResult.summary);
});

test("원본 위치가 틀린 강조는 재분석하며 끝까지 틀리면 결과를 거부합니다", async () => {
  const invalidHighlight = {
    ...validResult,
    spec: {
      status: "ok",
      message: "실제 수치가 있는 시각화입니다.",
      visuals: [{
        id: "sales",
        type: "bar_chart",
        title: "매출",
        caption: "매출은 원문 수치입니다.",
        source_ids: ["sheet:0:row:2"],
        data: { labels: ["매출"], values: [123], source_ids: ["sheet:0:row:2"] },
        highlights: [{
          target: { point_index: 0 },
          level: "important",
          label: "잘못된 강조 위치",
          reason: "렌더러가 원본 위치를 검증합니다.",
          source_ids: ["sheet:9:row:999"],
          derived: null,
        }],
      }],
    },
  };
  let callCount = 0;
  await assert.rejects(requestAiSummary(document, {
    ...options,
    fetchImpl: async () => {
      callCount += 1;
      return modelResponse(JSON.stringify(invalidHighlight));
    },
  }), (error) => error instanceof AiServiceError && error.code === "AI_RESPONSE_INVALID");
  assert.equal(callCount, 3);
});

const businessDocument = {
  name: "업무 보고서.pdf",
  type: "pdf",
  sources: [
    {
      source_id: "pdf:page:1",
      text: "Quarterly operations report. Q1 revenue: 100 units. Q2 revenue: 125 units. Q3 revenue: 118 units. Q3 change from Q2: -5.6 percent.",
    },
    {
      source_id: "pdf:page:2",
      text: "Planned release: 2026-05-15. Review initial results: 2026-05-22. Process: collect requests, review by product lead, approve and share.",
    },
  ],
};

function makeBusinessResult() {
  return {
    summary: [
      {
        text: "Q3 매출은 Q2보다 5.6 percent 감소했습니다.",
        evidence: "Q2 revenue: 125 units. Q3 revenue: 118 units. Q3 change from Q2: -5.6 percent.",
        source_ids: ["pdf:page:1"],
      },
      {
        text: "출시와 초기 결과 검토 일정은 각각 2026-05-15와 2026-05-22입니다.",
        evidence: "Planned release: 2026-05-15. Review initial results: 2026-05-22.",
        source_ids: ["pdf:page:2"],
      },
    ],
    key_points: [
      { text: "Q3 매출은 Q2보다 5.6 percent 감소", evidence: "Q2 revenue: 125 units. Q3 revenue: 118 units. Q3 change from Q2: -5.6 percent.", source_ids: ["pdf:page:1"] },
      { text: "출시 예정일은 2026-05-15", evidence: "Planned release: 2026-05-15.", source_ids: ["pdf:page:2"] },
      { text: "초기 검토는 2026-05-22", evidence: "Review initial results: 2026-05-22.", source_ids: ["pdf:page:2"] },
    ],
    spec: {
      status: "ok",
      message: "분기 매출 변화, 일정과 업무 절차를 정리했습니다.",
      visuals: [
        {
          id: "revenue-trend",
          type: "line_chart",
          title: "분기별 매출",
          caption: "Q2 매출 125 units에서 Q3 매출 118 units로 감소했습니다.",
          source_ids: ["pdf:page:1"],
          data: {
            labels: ["Q1", "Q2", "Q3"],
            unit: "units",
            series: [{ id: "revenue", name: "revenue", values: [100, 125, 118], source_ids: ["pdf:page:1", "pdf:page:1", "pdf:page:1"] }],
          },
          highlights: [{
            target: { series_id: "revenue", point_index: 2 },
            level: "critical",
            label: "Q3 revenue 감소",
            reason: "Q3 revenue는 Q2보다 5.6 percent 감소했습니다.",
            source_ids: ["pdf:page:1"],
            derived: {
              formula: "(현재 값 - 직전 값) ÷ |직전 값| × 100",
              original_values: [{ label: "Q2", value: 125 }, { label: "Q3", value: 118 }],
              result: -5.6,
            },
          }],
        },
        {
          id: "release-timeline",
          type: "timeline",
          title: "주요 일정",
          caption: "출시는 2026-05-15이고 초기 결과 검토는 2026-05-22입니다.",
          source_ids: ["pdf:page:2"],
          data: { items: [
            { id: "release", date: "2026-05-15", label: "Planned release", source_ids: ["pdf:page:2"] },
            { id: "review", date: "2026-05-22", label: "Review initial results", source_ids: ["pdf:page:2"] },
          ] },
          highlights: [
            { target: { item_id: "release" }, level: "important", label: "출시 예정일", reason: "원문에 계획된 출시일이 명시되어 있습니다.", source_ids: ["pdf:page:2"], derived: null },
            { target: { item_id: "review" }, level: "important", label: "초기 검토일", reason: "원문에 초기 결과 검토일이 명시되어 있습니다.", source_ids: ["pdf:page:2"], derived: null },
          ],
        },
        {
          id: "request-process",
          type: "flowchart",
          title: "업무 절차",
          caption: "요청을 수집하고 검토한 뒤 승인 및 공유합니다.",
          source_ids: ["pdf:page:2"],
          data: {
            nodes: [
              { id: "collect", label: "collect requests", source_ids: ["pdf:page:2"] },
              { id: "review", label: "review by product lead", source_ids: ["pdf:page:2"] },
              { id: "approve", label: "approve and share", source_ids: ["pdf:page:2"] },
            ],
            edges: [
              { from: "collect", to: "review", source_ids: ["pdf:page:2"] },
              { from: "review", to: "approve", source_ids: ["pdf:page:2"] },
            ],
          },
          highlights: [],
        },
      ],
    },
  };
}

test("완전한 보고서 명세는 원문·유형·강조 검증을 통과합니다", () => {
  const result = makeBusinessResult();
  const sourceMap = new Map(businessDocument.sources.map((source) => [source.source_id, { text: source.text }]));
  [...result.summary, ...result.key_points].forEach((item) => assert.equal(isSupportedByEvidence(item, sourceMap), true, item.text));
  assert.deepEqual(validateAiQuality(result, businessDocument), []);
  assert.equal(validateAiEnvelope(result, sourceMap), null);
});

test("여러 일정 중 중요한 항목만 highlight해도 visual별 세 개 제한과 양립합니다", () => {
  const document = structuredClone(businessDocument);
  document.sources[1].text += " Additional review: 2026-05-29.";
  const result = makeBusinessResult();
  result.spec.visuals.find((visual) => visual.type === "timeline").data.items.push({
    id: "additional-review",
    date: "2026-05-29",
    label: "Additional review",
    source_ids: ["pdf:page:2"],
  });

  assert.deepEqual(validateAiQuality(result, document), []);
});

test("중요 일정·결정·변경 누락과 잘못된 유형은 검증에서 거부합니다", () => {
  const result = makeBusinessResult();
  assert.deepEqual(validateAiQuality(result, businessDocument), []);

  const missingDeadline = structuredClone(result);
  missingDeadline.summary[1].source_ids = ["pdf:page:1"];
  missingDeadline.summary[1].evidence = businessDocument.sources[0].text;
  missingDeadline.key_points = [];
  missingDeadline.spec.visuals = missingDeadline.spec.visuals.filter((visual) => visual.type !== "timeline");
  const omissionIssues = validateAiQuality(missingDeadline, businessDocument);
  assert.ok(omissionIssues.some((issue) => issue.includes("중요한 원본 위치 pdf:page:2")));
  assert.ok(omissionIssues.some((issue) => issue.includes("timeline")));

  const wrongChartType = structuredClone(result);
  wrongChartType.spec.visuals[0].type = "bar_chart";
  wrongChartType.spec.visuals[0].data = {
    labels: ["Q1", "Q2", "Q3"],
    values: [100, 125, 118],
    source_ids: ["pdf:page:1", "pdf:page:1", "pdf:page:1"],
  };
  wrongChartType.spec.visuals[0].highlights = [];
  const typeIssues = validateAiQuality(wrongChartType, businessDocument);
  assert.ok(typeIssues.some((issue) => issue.includes("line_chart")));

  const unsortedTimeline = structuredClone(result);
  const lineChart = unsortedTimeline.spec.visuals.find((visual) => visual.type === "line_chart");
  lineChart.data.labels = ["Q1", "Q3", "Q2"];
  lineChart.data.series[0].values = [100, 118, 125];
  lineChart.data.series[0].source_ids = ["pdf:page:1", "pdf:page:1", "pdf:page:1"];
  const orderIssues = validateAiQuality(unsortedTimeline, businessDocument);
  assert.ok(orderIssues.some((issue) => issue.includes("시간순으로 정렬")));

  const wrongProcessType = structuredClone(result);
  const flowIndex = wrongProcessType.spec.visuals.findIndex((visual) => visual.type === "flowchart");
  wrongProcessType.spec.visuals[flowIndex] = {
    id: "process-as-table",
    type: "comparison_table",
    title: "업무 절차",
    caption: "요청 수집 후 검토와 승인을 진행합니다.",
    source_ids: ["pdf:page:2"],
    data: {
      columns: [{ key: "step", label: "절차 단계" }],
      rows: [{ id: "collect", cells: { step: "collect requests" }, source_ids: ["pdf:page:2"] }],
    },
    highlights: [],
  };
  const processIssues = validateAiQuality(wrongProcessType, businessDocument);
  assert.ok(processIssues.some((issue) => issue.includes("flowchart")));
});

test("중요 항목과 시간순 그래프가 빠진 첫 응답은 자동 재분석합니다", async () => {
  let callCount = 0;
  const incomplete = makeBusinessResult();
  incomplete.summary = [incomplete.summary[0]];
  incomplete.key_points = [];
  incomplete.spec.visuals = [incomplete.spec.visuals[0]];
  const complete = makeBusinessResult();
  const diagnostics = [];

  const result = await requestAiSummary(businessDocument, {
    ...options,
    onDiagnostic: (entry) => diagnostics.push(entry),
    fetchImpl: async (_url, init) => {
      callCount += 1;
      if (callCount === 2) assert.ok(init.body.includes("검증 실패:"));
      return modelResponse(JSON.stringify(callCount === 1 ? incomplete : complete));
    },
  });

  assert.equal(callCount, 2, JSON.stringify(diagnostics.map((entry) => ({ issue: entry.issue, stage: entry.stage }))));
  assert.equal(result.spec.visuals.length, 3);
});

test("같은 시각화에서 날짜·수치·절차 결과가 서로 모순되면 한 번 재분석합니다", async () => {
  let callCount = 0;
  const wrongDirection = makeBusinessResult();
  wrongDirection.spec.visuals[0].highlights[0].label = "Q3 revenue 증가";
  wrongDirection.spec.visuals[0].highlights[0].reason = "Q3 revenue는 Q2보다 5.6 percent 증가했습니다.";

  const result = await requestAiSummary(businessDocument, {
    ...options,
    fetchImpl: async () => {
      callCount += 1;
      return modelResponse(JSON.stringify(callCount === 1 ? wrongDirection : makeBusinessResult()));
    },
  });

  assert.equal(callCount, 2);
  assert.equal(result.spec.visuals[0].highlights[0].label, "Q3 revenue 감소");
});

test("원문에 없는 일정 날짜는 한 번 재분석합니다", async () => {
  let callCount = 0;
  const wrongDate = makeBusinessResult();
  wrongDate.summary[1] = {
    text: "출시 예정일은 2026-05-16입니다.",
    evidence: "Planned release: 2026-05-15.",
    source_ids: ["pdf:page:2"],
  };

  const result = await requestAiSummary(businessDocument, {
    ...options,
    fetchImpl: async () => {
      callCount += 1;
      return modelResponse(JSON.stringify(callCount === 1 ? wrongDate : makeBusinessResult()));
    },
  });

  assert.equal(callCount, 2);
  assert.match(result.summary[1].text, /2026-05-15/);
});

test("시계열 CSV 요약은 기간 간 변화 방향을 설명하도록 재요청합니다", async () => {
  const csvDocument = {
    name: "월별 매출.csv",
    type: "csv",
    sources: [
      { source_id: "sheet:0:row:1", text: "월 | 매출(억원)" },
      { source_id: "sheet:0:row:2", text: "2026-01 | 100" },
      { source_id: "sheet:0:row:3", text: "2026-02 | 150" },
      { source_id: "sheet:0:row:4", text: "2026-03 | 120" },
    ],
  };
  const makeResult = (summaryText, evidence) => ({
    summary: [{ text: summaryText, evidence, source_ids: ["sheet:0:row:1", "sheet:0:row:2", "sheet:0:row:3", "sheet:0:row:4"] }],
    key_points: [],
    spec: {
      status: "ok",
      message: "월별 매출 흐름입니다.",
      visuals: [{
        id: "monthly-sales",
        type: "line_chart",
        title: "월별 매출",
        caption: "3월 매출은 120억원으로 2월 150억원보다 감소했습니다.",
        source_ids: ["sheet:0:row:1", "sheet:0:row:2", "sheet:0:row:3", "sheet:0:row:4"],
        data: {
          labels: ["2026-01", "2026-02", "2026-03"],
          unit: "억원",
          series: [{ id: "sales", name: "매출", values: [100, 150, 120], source_ids: ["sheet:0:row:2", "sheet:0:row:3", "sheet:0:row:4"] }],
        },
        highlights: [{
          target: { series_id: "sales", point_index: 2 },
          level: "critical",
          label: "3월 매출 감소",
          reason: "3월은 2월보다 감소했습니다.",
          source_ids: ["sheet:0:row:3", "sheet:0:row:4"],
          derived: { formula: "(현재 값 - 직전 값) ÷ |직전 값| × 100", original_values: [{ label: "2월", value: 150 }, { label: "3월", value: 120 }], result: -20 },
        }],
      }],
    },
  });
  let callCount = 0;
  const diagnostics = [];
  let result;
  try {
    result = await requestAiSummary(csvDocument, {
      ...options,
      onDiagnostic: (entry) => diagnostics.push({ attempt: entry.attempt, issue: entry.issue }),
      fetchImpl: async () => {
        callCount += 1;
        const invalid = makeResult("자료에는 월별 매출이 기록되어 있습니다.", "월 | 매출(억원)");
        const valid = makeResult("월별 매출은 1월 100억원에서 2월 150억원으로 증가한 뒤 3월 120억원으로 감소했습니다.", "2026-01 | 100");
        return modelResponse(JSON.stringify(callCount === 1 ? invalid : valid));
      },
    });
  } catch (error) {
    assert.fail(`${error.code}: ${JSON.stringify(diagnostics)}`);
  }
  assert.equal(callCount, 2);
  assert.match(result.summary[0].text, /증가한 뒤/);
});

test("영어 월 이름의 PDF 추이를 시간순으로 검증하고 요약 방향도 확인합니다", () => {
  const source = "Completed work increased from 18 items in February to 24 items in March.";
  const pdf = { name: "monthly-work.pdf", type: "pdf", sources: [{ source_id: "pdf:page:1", text: source }] };
  const makeResult = (summaryText) => ({
    summary: [{ text: summaryText, evidence: source, source_ids: ["pdf:page:1"] }],
    key_points: [],
    spec: {
      status: "ok",
      message: "Completed work changed across months.",
      visuals: [{
        id: "work-by-month",
        type: "line_chart",
        title: "Completed work by month",
        caption: "Completed work increased from 18 to 24.",
        source_ids: ["pdf:page:1"],
        data: {
          labels: ["February", "March"],
          unit: "items",
          series: [{ id: "completed-work", name: "Completed work", values: [18, 24], source_ids: ["pdf:page:1", "pdf:page:1"] }],
        },
        highlights: [{
          target: { series_id: "completed-work", point_index: 1 },
          level: "important",
          label: "Completed work increased",
          reason: "Completed work increased from February to March.",
          source_ids: ["pdf:page:1"],
          derived: {
            formula: "(current - previous) / previous * 100",
            original_values: [{ label: "February", value: 18 }, { label: "March", value: 24 }],
            result: 33.3,
          },
        }],
      }],
    },
  });

  assert.ok(parseTemporal("February") < parseTemporal("March"));
  assert.deepEqual(validateAiQuality(makeResult("Completed work increased from February to March."), pdf), []);
  assert.ok(validateAiQuality(makeResult("Completed work decreased from February to March."), pdf)
    .some((issue) => issue.includes("증가·감소 표현이 원문 수치 변화와 반대")));
});

test("AI 서비스 HTTP 실패는 키나 원문을 노출하지 않습니다", async () => {
  await assert.rejects(
    requestAiSummary(document, { ...options, fetchImpl: async () => new Response("secret response", { status: 500 }) }),
    (error) => error instanceof AiServiceError
      && error.code === "AI_CALL_FAILED"
      && !error.message.includes("secret response")
      && !error.message.includes("unit-test-key"),
  );
});

test("jitda-chat에는 지원되는 max_completion_tokens만 전달합니다", async () => {
  let requestBody;
  await requestAiSummary(document, {
    ...options,
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return modelResponse(JSON.stringify(validResult));
    },
  });
  assert.equal(requestBody.max_completion_tokens, 5000);
  assert.equal(Object.hasOwn(requestBody, "max_tokens"), false);
});

test("AI 서버로 연결할 수 없으면 안전한 호출 실패를 반환합니다", async () => {
  let callCount = 0;
  await assert.rejects(
    requestAiSummary(document, {
      ...options,
      fetchImpl: async () => { callCount += 1; throw new TypeError("network failure"); },
    }),
    (error) => error instanceof AiServiceError
      && error.code === "AI_CALL_FAILED"
      && error.message === "잠시 후 다시 시도해 주세요",
  );
  assert.equal(callCount, 3);
});

test("데이터 행이 없는 CSV는 모델을 호출하지 않습니다", async () => {
  let callCount = 0;
  await assert.rejects(requestAiSummary({
    name: "empty.csv",
    type: "csv",
    sources: [{ source_id: "sheet:0:row:1", text: "부서 | 실적" }],
  }, {
    ...options,
    fetchImpl: async () => { callCount += 1; return modelResponse(JSON.stringify(validResult)); },
  }), (error) => error instanceof AiServiceError && error.code === "NO_ANALYZABLE_CONTENT");
  assert.equal(callCount, 0);
});

test("AI 주소가 틀리면(404) 모든 조각을 반복하지 않고 설정 안내를 돌려준다", async () => {
  let calls = 0;
  await assert.rejects(
    requestAiSummary(document, {
      ...options,
      fetchImpl: async () => {
        calls += 1;
        return new Response("<!doctype html><html><title>앱</title></html>", { status: 404, headers: { "Content-Type": "text/html" } });
      },
    }),
    (error) => error.code === "AI_NOT_CONFIGURED" && error.message.includes("HTTP 404") && error.message.includes("웹 페이지 주소"),
  );
  assert.equal(calls, 1);
});

test("API 키가 거부되면(401) 키를 확인하라고 안내한다", async () => {
  await assert.rejects(
    requestAiSummary(document, {
      ...options,
      fetchImpl: async () => new Response(JSON.stringify({ error: { code: "invalid_api_key" } }), { status: 401, headers: { "Content-Type": "application/json" } }),
    }),
    (error) => error.code === "AI_NOT_CONFIGURED" && error.message.includes("LLM_API_KEY"),
  );
});
