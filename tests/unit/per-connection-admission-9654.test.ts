// #9654: Per-connection virtual admission lanes
import test from "node:test";
import assert from "node:assert/strict";

const admissionModule = await import("../../src/shared/middleware/chatBodyAdmission.ts");
const {
  PerConnectionAdmissionController,
  resolveSessionId,
  admitChatRequest,
  admitChatStructure,
  perConnectionAdmissionController,
  ChatAdmissionController,
  CHAT_MAX_HEAVY_IN_FLIGHT,
} = admissionModule;

function makeRequest(headers: Record<string, string>, body = "{}"): Request {
  const h: Record<string, string> = { "content-type": "application/json", ...headers };
  return new Request("http://x/v1/chat/completions", { method: "POST", headers: h, body });
}

test("resolveSessionId hashes bearer token into opaque key", () => {
  const req = makeRequest({ authorization: "Bearer sk-secret-key-123" });
  const sid = resolveSessionId(req);
  assert.ok(sid.startsWith("key_"));
  assert.equal(sid.length, "key_".length + 16);
  // Same key → same hash
  const req2 = makeRequest({ authorization: "Bearer sk-secret-key-123" });
  assert.equal(resolveSessionId(req2), sid);
  // Different key → different hash
  const req3 = makeRequest({ authorization: "Bearer sk-different-key-456" });
  assert.notEqual(resolveSessionId(req3), sid);
});

test("resolveSessionId hashes x-api-key header (Anthropic-style)", () => {
  const req = makeRequest({ "x-api-key": "anthropic-key-xyz" });
  const sid = resolveSessionId(req);
  assert.ok(sid.startsWith("key_"));
  assert.equal(sid.length, "key_".length + 16);
});

test("resolveSessionId returns 'anonymous' for no auth", () => {
  const req = makeRequest({}, "{}");
  assert.equal(resolveSessionId(req), "anonymous");
});

test("resolveSessionId does not leak raw API key in the session ID", () => {
  const req = makeRequest({ authorization: "Bearer sk-secret-key-123" });
  const sid = resolveSessionId(req);
  assert.ok(!sid.includes("sk-secret-key-123"));
  assert.ok(!sid.includes("secret"));
});

test("PerConnectionAdmissionController isolates capacity across sessions", () => {
  const pc = new PerConnectionAdmissionController(1);
  const ctrlA = pc.getController("session-a");
  const ctrlB = pc.getController("session-b");

  // Session A acquires the only slot
  const leaseA = ctrlA.tryAcquireHeavy();
  assert.ok(leaseA);
  // Session A is now full
  assert.equal(ctrlA.tryAcquireHeavy(), null);
  // Session B still has capacity — isolation works
  const leaseB = ctrlB.tryAcquireHeavy();
  assert.ok(leaseB);
  leaseA.release();
  leaseB.release();
});

test("PerConnectionAdmissionController returns same controller for same session", () => {
  const pc = new PerConnectionAdmissionController(1);
  const a1 = pc.getController("session-a");
  const a2 = pc.getController("session-a");
  assert.equal(a1, a2);
});

test("PerConnectionAdmissionController creates new controller for new session", () => {
  const pc = new PerConnectionAdmissionController(1);
  const a = pc.getController("session-a");
  const b = pc.getController("session-b");
  assert.notEqual(a, b);
});

test("PerConnectionAdmissionController enforces maxSessions LRU eviction", () => {
  const pc = new PerConnectionAdmissionController(1, { maxSessions: 2, sessionTtlMs: 60000 });
  const a = pc.getController("a");
  const b = pc.getController("b");
  assert.equal(pc.sessionCount, 2);
  // Touch 'a' so 'b' is oldest
  const aAgain = pc.getController("a");
  assert.equal(aAgain, a, "same a reference");
  // Creating 'c' should evict 'b' (oldest)
  const c = pc.getController("c");
  assert.equal(pc.sessionCount, 2);
  // 'a' survives, 'b' is evicted
  const aAfter = pc.getController("a");
  assert.equal(aAfter, a, "a should still exist after c added");
  // 'b' gets a fresh controller (old one was evicted)
  const newB = pc.getController("b");
  assert.notEqual(newB, b, "b should be evicted and recreated");
});

test("PerConnectionAdmissionController evicts idle sessions after TTL", async () => {
  const pc = new PerConnectionAdmissionController(1, {
    sessionTtlMs: 50,
    maxSessions: 64,
  });
  const ctrl = pc.getController("idle-session");
  assert.ok(ctrl);
  assert.equal(pc.sessionCount, 1);

  // Wait past TTL + eviction tick
  await new Promise((resolve) => setTimeout(resolve, 120));
  // Accessing again should trigger eviction → fresh controller
  const fresh = pc.getController("idle-session");
  assert.notEqual(fresh, ctrl);
});

test("PerConnectionAdmissionController snapshot does not leak raw keys", () => {
  const pc = new PerConnectionAdmissionController(1);
  pc.getController("key_abc123");
  pc.getController("anonymous");
  const snap = pc.snapshot();
  assert.equal(snap.length, 2);
  for (const entry of snap) {
    assert.ok(typeof entry.sessionId === "string");
    assert.ok(entry.sessionId.includes("key_abc123") || entry.sessionId === "anonymous");
    assert.ok(typeof entry.activeHeavy === "number");
    assert.ok(typeof entry.idleMs === "number");
  }
});

test("admitChatRequest uses per-connection controller by default", async () => {
  const result = await admitChatRequest(
    makeRequest({ authorization: "Bearer sk-test-key" }),
    { largeBodyBytes: 32, hardMaxBytes: 1024 }
  );
  assert.equal(result.admit, true);
  if (result.admit) result.lease?.release();
});

test("admitChatRequest with explicit controller overrides per-connection lookup", async () => {
  const explicitController = new ChatAdmissionController(1);
  const result = await admitChatRequest(
    makeRequest({ authorization: "Bearer sk-test-key" }),
    { controller: explicitController, largeBodyBytes: 32, hardMaxBytes: 1024 }
  );
  assert.equal(result.admit, true);
  if (result.admit) result.lease?.release();
});

test("admitChatStructure routes structural rejection to per-connection controller", async () => {
  // occupy sess-a's per-connection controller via the module-level instance
  const controller = perConnectionAdmissionController.getController("sess-a");
  const occupied = controller.tryAcquireHeavy();
  assert.ok(occupied);

  const result = await admitChatStructure(
    {
      messages: Array.from({ length: 3 }, () => ({ role: "user", content: "x" })),
    },
    null,
    {
      sessionId: "sess-a",
      maxMessages: 10,
      heavyMessages: 1,
      heavyTools: 10,
      heavyTokens: 10_000,
    }
  );
  // Session A is busy → 503
  assert.equal(result.admit, false);
  if (result.admit) return;
  assert.equal(result.response.status, 503);
  assert.equal(result.response.headers.get("Retry-After"), "1");
  occupied.release();
});

test("admitChatStructure with different sessionId gets independent capacity", async () => {
  // occupy sess-a's per-connection controller
  const ctrlA = perConnectionAdmissionController.getController("sess-a");
  const occupied = ctrlA.tryAcquireHeavy();
  assert.ok(occupied);

  // Session B should get its own controller → admitted
  const result = await admitChatStructure(
    {
      messages: Array.from({ length: 500 }, () => ({ role: "user", content: "x" })),
    },
    null,
    {
      sessionId: "sess-b",
      maxMessages: 0,
      heavyMessages: 200,
      heavyTools: 64,
      heavyTokens: 32_000,
    }
  );
  assert.equal(result.admit, true);
  if (result.admit) {
    assert.notEqual(result.lease, null);
    result.lease?.release();
  }
  occupied.release();
});
