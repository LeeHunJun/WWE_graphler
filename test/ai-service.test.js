import assert from "node:assert/strict";
import test from "node:test";
import { AiServiceError, requestAiSummary, resolveChatCompletionsUrl, validateAiEnvelope } from "../ai-service.js";
import { validateAiQuality } from "../ai-quality.js";
import { isSupportedByEvidence } from "../source-evidence.js";

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
  sampleSpec,
};
const validResult = {
  summary: [{ text: "매출은 123입니다.", evidence: "매출 | 123", source_ids: ["sheet:0:row:2"] }],
  key_points: [{ text: "매출은 123입니다.", evidence: "매출 | 123", source_ids: ["sheet:0:row:2"] }],
  spec: sampleSpec,
};

function modelResponse(content, status = 200) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
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
  assert.equal(request.url, "https://llm.example/v1/chat/completions");
  assert.equal(request.init.headers.Authorization, "Bearer unit-test-key");
  assert.ok(body.messages[0].content.includes("공유 시각화 규격"));
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

test("필수 바깥 값이 계속 없으면 한 번 재시도한 뒤 응답 오류를 반환합니다", async () => {
  let callCount = 0;
  await assert.rejects(
    requestAiSummary(document, {
      ...options,
      fetchImpl: async () => {
        callCount += 1;
        return modelResponse(JSON.stringify({ summary: [], key_points: [], spec: { status: "ok", visuals: [] } }));
      },
    }),
    (error) => error instanceof AiServiceError && error.code === "AI_RESPONSE_INVALID",
  );
  assert.equal(callCount, 2);
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

test("실제 행을 가리켜도 틀린 강조 source_id면 AI 결과 전체를 재요청합니다", async () => {
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
  assert.equal(callCount, 2);
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

  const result = await requestAiSummary(businessDocument, {
    ...options,
    fetchImpl: async (_url, init) => {
      callCount += 1;
      if (callCount === 2) assert.ok(init.body.includes("검증 오류가 발견됐습니다"));
      return modelResponse(JSON.stringify(callCount === 1 ? incomplete : complete));
    },
  });

  assert.equal(callCount, 2);
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

test("AI 서비스 HTTP 실패는 키나 원문을 노출하지 않습니다", async () => {
  await assert.rejects(
    requestAiSummary(document, { ...options, fetchImpl: async () => new Response("secret response", { status: 500 }) }),
    (error) => error instanceof AiServiceError
      && error.code === "AI_CALL_FAILED"
      && !error.message.includes("secret response")
      && !error.message.includes("unit-test-key"),
  );
});

test("AI 서버로 연결할 수 없으면 안전한 호출 실패를 반환합니다", async () => {
  await assert.rejects(
    requestAiSummary(document, {
      ...options,
      fetchImpl: async () => { throw new TypeError("network failure"); },
    }),
    (error) => error instanceof AiServiceError
      && error.code === "AI_CALL_FAILED"
      && error.message === "AI 서비스에 연결하지 못했습니다.",
  );
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
