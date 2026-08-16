import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import {
  CREDITS_EXHAUSTED_STATUS,
  isCreditsExhaustedReprobeCandidate,
  isRecoverableCooldownConnection,
  selectRecoverableConnections,
  runConnectionRecoveryTick,
} from "@/lib/quota/connectionRecovery";

describe("connectionRecovery — credits_exhausted reprobe", () => {
  const nowMs = 1_700_000_000_000;
  const thirtyMinMs = 30 * 60 * 1000;

  it("should NOT recover credits_exhausted as transient cooldown", () => {
    const conn = {
      id: "conn-1",
      testStatus: CREDITS_EXHAUSTED_STATUS,
      rateLimitedUntil: new Date(nowMs - 5000).toISOString(),
    };
    assert.equal(isRecoverableCooldownConnection(conn, nowMs), false);
  });

  it("should reprobe credits_exhausted when >30m has elapsed since lastErrorAt", () => {
    const thirtyOneMinAgo = new Date(nowMs - thirtyMinMs - 60_000).toISOString();
    const conn = {
      id: "conn-1",
      testStatus: CREDITS_EXHAUSTED_STATUS,
      lastErrorAt: thirtyOneMinAgo,
    };
    assert.equal(isCreditsExhaustedReprobeCandidate(conn, nowMs), true);
  });

  it("should NOT reprobe credits_exhausted when <30m has elapsed since lastErrorAt", () => {
    const tenMinAgo = new Date(nowMs - 10 * 60 * 1000).toISOString();
    const conn = {
      id: "conn-1",
      testStatus: CREDITS_EXHAUSTED_STATUS,
      lastErrorAt: tenMinAgo,
    };
    assert.equal(isCreditsExhaustedReprobeCandidate(conn, nowMs), false);
  });

  it("should reprobe credits_exhausted if no timestamp is present (first tick after startup)", () => {
    const conn = {
      id: "conn-1",
      testStatus: CREDITS_EXHAUSTED_STATUS,
    };
    assert.equal(isCreditsExhaustedReprobeCandidate(conn, nowMs), true);
  });

  it("selectRecoverableConnections includes both transient cooldowns and expired credits_exhausted", () => {
    const activeTransient = {
      id: "t-1",
      testStatus: "unavailable",
      rateLimitedUntil: new Date(nowMs - 1000).toISOString(),
    };
    const expiredCredits = {
      id: "c-1",
      testStatus: CREDITS_EXHAUSTED_STATUS,
      lastErrorAt: new Date(nowMs - thirtyMinMs - 1000).toISOString(),
    };
    const freshCredits = {
      id: "c-2",
      testStatus: CREDITS_EXHAUSTED_STATUS,
      lastErrorAt: new Date(nowMs - 1000).toISOString(),
    };

    const selected = selectRecoverableConnections(
      [activeTransient, expiredCredits, freshCredits],
      nowMs
    );
    assert.deepEqual(selected.map((c) => c.id), ["t-1", "c-1"]);
  });

  it("runConnectionRecoveryTick calls clearConnectionError for reprobe candidates", async () => {
    const loadConnections = mock.fn(async () => [
      {
        id: "c-1",
        testStatus: CREDITS_EXHAUSTED_STATUS,
        lastErrorAt: new Date(nowMs - thirtyMinMs - 1000).toISOString(),
      },
    ]);
    const clearConnectionError = mock.fn(async () => undefined);

    const res = await runConnectionRecoveryTick({
      nowMs,
      loadConnections,
      clearConnectionError,
    });

    assert.equal(res.recovered, 1);
    assert.deepEqual(res.recoveredIds, ["c-1"]);
    assert.equal(clearConnectionError.mock.callCount(), 1);
    assert.equal(clearConnectionError.mock.calls[0].arguments[0], "c-1");
    assert.notEqual(clearConnectionError.mock.calls[0].arguments[1], undefined);
  });
});
