// 빠른 AI 핵심 요약(스트리밍).
// 코드로 계산한 '사실 목록'(ai-digest.js)만 보내고, AI에게는 짧은 요약 문장만 쓰게 한다.
// - 한 번만 호출하고 답이 짧아(최대 약 600토큰) 몇 초 안에 끝난다.
// - stream: true로 받아 글자가 만들어지는 대로 화면에 흘려 보낸다(프록시 60초 제한에도 연결이 끊기지 않음).
// - 끝나면 사실 목록에 없는 숫자가 들어간 문장은 뺀다.

import { AiServiceError, resolveChatCompletionsUrl } from "./ai-service.js";

const MODEL_NAME = "jitda-chat";
const MAX_OUTPUT_TOKENS = 700;
const BRIEF_TIMEOUT_MS = 55_000;
const MAX_DIGEST_CHARS = 14_000;

export function buildBriefMessages(digest) {
  return [
    {
      role: "system",
      content: [
        "너는 업무 데이터를 짧게 요약하는 도우미다. 아래 '사실'에 있는 내용과 숫자만 사용해 한국어 존댓말(~요)로 쓴다.",
        "반드시 이 형식만 출력한다. 머리말·설명·마크다운·코드블록은 쓰지 않는다.",
        "요약: (문서 전체를 한 문장으로)",
        "요약: (가장 중요한 변화나 차이를 한 문장으로)",
        "- (핵심 내용 한 줄, 40자 이내) ← 3~5줄",
        "규칙: 사실에 없는 숫자를 만들지 않는다. 숫자는 사실에 적힌 그대로 쓴다. 원인은 '~일 수 있어요'처럼 추정으로 쓴다.",
      ].join("\n"),
    },
    {
      role: "user",
      content: `문서: ${digest.name || "이름 없음"} (${digest.type || "알 수 없음"})\n사실:\n${String(digest.text || "").slice(0, MAX_DIGEST_CHARS)}`,
    },
  ];
}

// "요약: …" 줄은 전체 요약, "- …" 줄은 핵심 내용으로 나눈다. 끝나지 않은 마지막 줄도 그대로 둔다.
export function parseBriefText(text) {
  const summary = [];
  const keyPoints = [];
  String(text || "").split(/\r?\n/).forEach((raw) => {
    const line = raw.trim().replace(/^\*\*|\*\*$/g, "");
    if (!line) return;
    const summaryMatch = /^(?:요약|summary)\s*[:：]\s*(.+)$/i.exec(line);
    const pointMatch = /^(?:[-•*·]|\d+[.)])\s*(.+)$/.exec(line);
    if (summaryMatch) summary.push(summaryMatch[1].trim());
    else if (pointMatch) keyPoints.push(pointMatch[1].trim());
    else if (summary.length === 0) summary.push(line);
  });
  return { summary: summary.slice(0, 2), key_points: keyPoints.slice(0, 5) };
}

// 날짜(2025-06, 2025년 6월)는 빼고, 쉼표·부호를 정리한 숫자 목록.
export function extractNumbers(text) {
  const cleaned = String(text || "")
    .replace(/\d{4}\s*년\s*\d{1,2}\s*월(?:\s*\d{1,2}\s*일)?/g, " ")
    .replace(/\d{4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?/g, " ");
  return [...cleaned.matchAll(/[+\-−]?\d[\d,]*(?:\.\d+)?/g)]
    .map((match) => Number(match[0].replace(/[,+]/g, "").replace("−", "-")))
    .filter(Number.isFinite);
}

// 문장의 숫자가 모두 사실 목록에 있는지(부호 무시, 반올림 차이 0.5% 허용, 12 이하 작은 수는 개수·순위로 보고 허용).
export function isGrounded(sentence, digestNumbers) {
  return extractNumbers(sentence).every((value) => {
    const target = Math.abs(value);
    if (target <= 12) return true;
    return digestNumbers.some((known) => {
      const reference = Math.abs(known);
      return reference === target || (reference > 0 && Math.abs(reference - target) / reference <= 0.005);
    });
  });
}

export function finalizeBrief(text, digest) {
  const parsed = parseBriefText(text);
  const digestNumbers = extractNumbers(digest.text);
  const keep = (items) => items.filter((item) => isGrounded(item, digestNumbers));
  const summary = keep(parsed.summary);
  const keyPoints = keep(parsed.key_points);
  return {
    summary,
    key_points: keyPoints,
    dropped: parsed.summary.length + parsed.key_points.length - summary.length - keyPoints.length,
  };
}

function providerError(status) {
  if (status === 404 || status === 405) return new AiServiceError("AI_NOT_CONFIGURED", `AI 주소(LLM_BASE_URL)에 AI API가 없어요 (HTTP ${status}). 주소를 확인해 주세요.`);
  if (status === 401 || status === 403) return new AiServiceError("AI_NOT_CONFIGURED", `AI 서비스가 API 키를 거부했어요 (HTTP ${status}). LLM_API_KEY를 확인해 주세요.`);
  if (status === 429) return new AiServiceError("AI_BUSY", "AI 서비스 요청이 많아 잠시 막혔어요 (HTTP 429). 1분쯤 뒤에 다시 시도해 주세요.");
  if (status >= 500) return new AiServiceError("AI_PROVIDER_ERROR", `AI 서비스 쪽에서 오류가 났어요 (HTTP ${status}). 잠시 뒤 다시 시도해 주세요.`);
  return new AiServiceError("AI_PROVIDER_ERROR", `AI 서비스가 요청을 처리하지 못했어요 (HTTP ${status}).`);
}

/**
 * AI에게 짧은 요약을 스트리밍으로 받는다. onDelta(텍스트 조각)를 만들어지는 대로 부른다.
 * 서비스가 스트리밍을 지원하지 않고 한 번에 JSON으로 답해도 그대로 처리한다.
 * @returns {Promise<string>} 받은 전체 텍스트
 */
export async function streamBrief(digest, { apiKey, baseUrl, fetchImpl = fetch, onDelta = () => {}, timeoutMs = BRIEF_TIMEOUT_MS } = {}) {
  if (!apiKey || !baseUrl) throw new AiServiceError("AI_NOT_CONFIGURED", "AI가 연결되지 않았어요. LLM_API_KEY와 LLM_BASE_URL을 설정해 주세요.");
  if (!String(digest?.text || "").trim()) throw new AiServiceError("NO_ANALYZABLE_CONTENT", "요약할 내용이 없어요. 파일에 데이터가 있는지 확인해 주세요.");
  const endpoint = resolveChatCompletionsUrl(baseUrl);
  const signal = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "text/event-stream, application/json" },
      body: JSON.stringify({ model: MODEL_NAME, messages: buildBriefMessages(digest), stream: true, max_completion_tokens: MAX_OUTPUT_TOKENS }),
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw new AiServiceError("AI_TIMEOUT", `AI가 ${Math.round(timeoutMs / 1000)}초 안에 답하지 않았어요. 잠시 뒤 다시 시도해 주세요.`);
    throw new AiServiceError("AI_UNREACHABLE", "AI 서비스에 연결하지 못했어요. 네트워크나 LLM_BASE_URL을 확인해 주세요.");
  }
  if (!response.ok) throw providerError(response.status);

  const contentType = response.headers.get("content-type") || "";
  let full = "";
  try {
    if (!/event-stream/i.test(contentType) || !response.body) {
      // 스트리밍을 지원하지 않는 서비스: 한 번에 받은 답을 그대로 쓴다.
      const raw = await response.text();
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
      if (!body && /<html|<!doctype/i.test(raw)) throw new AiServiceError("AI_NOT_CONFIGURED", "AI 주소가 AI API가 아니라 웹 페이지 주소예요. LLM_BASE_URL을 확인해 주세요.");
      full = String(body?.choices?.[0]?.message?.content ?? "");
      if (full) onDelta(full);
    } else {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split(/\r?\n/);
        buffer = events.pop() || "";
        for (const line of events) {
          const data = line.replace(/^data:\s?/, "").trim();
          if (!line.startsWith("data:") || !data || data === "[DONE]") continue;
          let chunk = null;
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
          }
          const piece = chunk?.choices?.[0]?.delta?.content ?? chunk?.choices?.[0]?.message?.content ?? "";
          if (piece) {
            full += piece;
            onDelta(piece);
          }
        }
      }
    }
  } catch (error) {
    if (error instanceof AiServiceError) throw error;
    if (signal.aborted) throw new AiServiceError("AI_TIMEOUT", `AI가 ${Math.round(timeoutMs / 1000)}초 안에 답을 끝내지 못했어요. 받은 데까지만 보여 드려요.`);
    throw new AiServiceError("AI_STREAM_BROKEN", "AI 답을 받는 중에 연결이 끊겼어요. 다시 시도해 주세요.");
  }
  if (!full.trim()) throw new AiServiceError("AI_EMPTY", "AI가 빈 답을 보냈어요. 다시 시도해 주세요.");
  return full;
}
