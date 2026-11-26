import assert from "node:assert/strict";
import test from "node:test";
import { isSameOrigin } from "../auth-api.js";

const req = (headers) => ({ headers });

test("같은 주소에서 온 요청은 허용한다", () => {
  assert.equal(isSameOrigin(req({ host: "localhost:3100", origin: "http://localhost:3100" })), true);
  assert.equal(isSameOrigin(req({ host: "localhost:3100" })), true);
});

test("프록시 뒤에서 Host가 바뀌어도 X-Forwarded-Host나 Sec-Fetch-Site로 허용한다", () => {
  assert.equal(isSameOrigin(req({ host: "localhost:3000", origin: "https://app.preview.example", "x-forwarded-host": "app.preview.example" })), true);
  assert.equal(isSameOrigin(req({ host: "localhost:3000", origin: "https://app.preview.example", "sec-fetch-site": "same-origin" })), true);
  assert.equal(isSameOrigin(req({ host: "example.com:443", origin: "https://example.com" })), true);
});

test("ALLOWED_ORIGINS에 적힌 주소는 허용한다", () => {
  process.env.ALLOWED_ORIGINS = "https://preview.example, not a url";
  try {
    assert.equal(isSameOrigin(req({ host: "localhost:3000", origin: "https://preview.example" })), true);
  } finally {
    delete process.env.ALLOWED_ORIGINS;
  }
});

test("다른 사이트에서 온 요청은 막는다", () => {
  assert.equal(isSameOrigin(req({ host: "localhost:3100", origin: "https://evil.example" })), false);
  assert.equal(isSameOrigin(req({ host: "localhost:3100", origin: "https://evil.example", "sec-fetch-site": "cross-site" })), false);
  assert.equal(isSameOrigin(req({ host: "localhost:3100", origin: "null" })), false);
});
