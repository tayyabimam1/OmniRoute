import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeThinkingEffort,
  resolveChatGptModel,
} from "../../open-sse/executors/chatgpt-web/models.ts";
import {
  ChatGptWebExecutor,
  __resetChatGptWebCachesForTesting,
} from "../../open-sse/executors/chatgpt-web.ts";
import { __setTlsFetchOverrideForTesting } from "../../open-sse/services/chatgptTlsClient.ts";

function mockResponse(status: number, body: unknown, contentType = "application/json") {
  return {
    status,
    headers: new Headers({ "Content-Type": contentType }),
    text: typeof body === "string" ? body : JSON.stringify(body),
    body: null,
  };
}

function installMockFetch() {
  const calls: {
    userConfigUrl: string | null;
    userConfigMethod: string | null;
    conversationBody: string | null;
  } = {
    userConfigUrl: null,
    userConfigMethod: null,
    conversationBody: null,
  };

  __setTlsFetchOverrideForTesting(async (url, opts = {}) => {
    const u = String(url);

    if (u === "https://chatgpt.com/" || u === "https://chatgpt.com") {
      return mockResponse(
        200,
        '<html data-build="prod-test"><script src="https://cdn.oaistatic.com/test.js"></script></html>',
        "text/html"
      );
    }

    if (u.includes("/api/auth/session")) {
      return mockResponse(200, {
        accessToken: "jwt-test",
        expires: new Date(Date.now() + 3_600_000).toISOString(),
        user: { id: "user-test" },
      });
    }

    if (u.includes("/backend-api/settings/user_last_used_model_config")) {
      calls.userConfigUrl = u;
      calls.userConfigMethod = (opts.method || "GET").toUpperCase();
      return mockResponse(200, { is_disabled: false });
    }

    if (u.includes("/backend-api/sentinel/chat-requirements")) {
      return mockResponse(200, {
        token: "requirements-test",
        proofofwork: { required: false },
      });
    }

    if (u.endsWith("/backend-api/f/conversation")) {
      calls.conversationBody = opts.body ?? null;
      return mockResponse(
        200,
        [
          `data: ${JSON.stringify({
            conversation_id: "conv-test",
            message: {
              id: "msg-test",
              author: { role: "assistant" },
              content: { content_type: "text", parts: ["ok"] },
              status: "finished_successfully",
            },
          })}`,
          "",
          "data: [DONE]",
          "",
        ].join("\r\n"),
        "text/event-stream"
      );
    }

    // Browser-like warmup endpoints are best-effort. Returning a normal 200
    // keeps this focused test independent from their response details.
    return mockResponse(200, {});
  });

  return {
    calls,
    restore() {
      __setTlsFetchOverrideForTesting(null);
    },
  };
}

test("ChatGPT Web thinking effort aliases map to the three native tiers", () => {
  const cases = [
    ["minimal", "standard"],
    ["low", "standard"],
    ["medium", "standard"],
    ["standard", "standard"],
    ["high", "extended"],
    ["extended", "extended"],
    ["xhigh", "max"],
    ["max", "max"],
  ] as const;

  for (const [input, expected] of cases) {
    assert.equal(normalizeThinkingEffort(input), expected, input);
  }
});

test("providerSpecificData can request native max with highest precedence", () => {
  const resolved = resolveChatGptModel(
    "gpt-5.6-thinking",
    { reasoning_effort: "low" },
    { thinkingEffort: "max" }
  );
  assert.equal(resolved.effort, "max");
});

for (const effort of ["xhigh", "max"] as const) {
  test(`ChatGPT Web executor sends ${effort} as thinking_effort=max`, async () => {
    __resetChatGptWebCachesForTesting();
    const mock = installMockFetch();
    try {
      const executor = new ChatGptWebExecutor();
      const result = await executor.execute({
        model: "gpt-5.6-thinking",
        body: {
          messages: [{ role: "user", content: "hi" }],
          reasoning_effort: effort,
        },
        stream: false,
        credentials: { apiKey: `cookie-${effort}` },
        signal: AbortSignal.timeout(10_000),
        log: null,
      });

      assert.equal(result.response.status, 200);
      assert.equal(mock.calls.userConfigMethod, "PATCH");
      assert.ok(mock.calls.userConfigUrl);
      const settingsUrl = new URL(mock.calls.userConfigUrl);
      assert.equal(settingsUrl.searchParams.get("model_slug"), "gpt-5-6-thinking");
      assert.equal(settingsUrl.searchParams.get("thinking_effort"), "max");

      assert.ok(mock.calls.conversationBody);
      const conversationBody = JSON.parse(mock.calls.conversationBody) as Record<string, unknown>;
      assert.equal(conversationBody.thinking_effort, "max");
    } finally {
      mock.restore();
    }
  });
}
