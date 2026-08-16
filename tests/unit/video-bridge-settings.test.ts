import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveAudioCapability,
  resolveVideoCapability,
} from "../../src/lib/modelCapabilityModalities.ts";
import {
  MODALITY_BRIDGE_DEFAULTS,
  resolveVideoBridgeRuntimeSettings,
} from "../../src/shared/constants/modalityBridgeDefaults.ts";
import { updateSettingsSchema } from "../../src/shared/validation/settingsSchemas.ts";

test("audio and video capability resolution trusts explicit catalog data before modalities", () => {
  assert.equal(resolveAudioCapability({ supportsAudio: false }, null, ["audio"]), false);
  assert.equal(resolveVideoCapability(undefined, { supportsVideo: true }, ["text"]), true);
  assert.equal(resolveVideoCapability(undefined, null, ["text", "video"]), true);
  assert.equal(resolveVideoCapability(undefined, null, ["text"]), false);
  assert.equal(resolveVideoCapability(undefined, null, []), null);
});

test("Video Bridge settings default to a bounded disabled runtime and accept valid overrides", () => {
  assert.deepEqual(resolveVideoBridgeRuntimeSettings({}), {
    enabled: false,
    model: "",
    frameCount: 8,
    maxVideos: 1,
    timeoutMs: 120_000,
    cacheEnabled: MODALITY_BRIDGE_DEFAULTS.cacheEnabled,
    cacheTtlMinutes: MODALITY_BRIDGE_DEFAULTS.cacheTtlMinutes,
    cacheMaxEntries: MODALITY_BRIDGE_DEFAULTS.cacheMaxEntries,
  });

  const valid = updateSettingsSchema.safeParse({
    modalityBridgeVideoEnabled: true,
    modalityBridgeVideoModel: "openai/gpt-4o-mini",
    modalityBridgeVideoFrameCount: 16,
    modalityBridgeVideoMaxVideos: 4,
    modalityBridgeVideoTimeout: 120_000,
  });
  assert.equal(valid.success, true);
});

test("Video Bridge settings schema rejects values outside extraction bounds", () => {
  for (const [field, value] of Object.entries({
    modalityBridgeVideoFrameCount: 17,
    modalityBridgeVideoMaxVideos: 0,
    modalityBridgeVideoTimeout: 120_001,
  })) {
    assert.equal(
      updateSettingsSchema.safeParse({ [field]: value }).success,
      false,
      `${field}=${value} should be rejected`
    );
  }
});

test("persisted legacy Video Bridge timeouts clamp to the broker's 120 second deadline", () => {
  for (const timeoutMs of [180_000, 300_000]) {
    assert.equal(
      resolveVideoBridgeRuntimeSettings({ modalityBridgeVideoTimeout: timeoutMs }).timeoutMs,
      120_000
    );
    assert.equal(
      updateSettingsSchema.safeParse({ modalityBridgeVideoTimeout: timeoutMs }).success,
      false,
      `new writes must reject ${timeoutMs}ms instead of exceeding the broker deadline`
    );
  }
});
