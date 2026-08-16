import {
  fetchModelSyncInternal,
  resolveModelSyncInternalBaseUrl,
} from "@/shared/services/modelSyncScheduler";

import {
  VIDEO_BRIDGE_BROKER_PATH,
  buildVideoBridgeBrokerHeaders,
  isVideoBridgeBrokerInternalRequest,
} from "./videoBridgeBrokerAuth";

export {
  VIDEO_BRIDGE_BROKER_PATH,
  buildVideoBridgeBrokerHeaders,
  isVideoBridgeBrokerInternalRequest,
};

export interface BrokerExtractedFrame {
  dataUri: string;
  timestampSeconds: number;
}

export interface BrokerExtractionResult {
  durationSeconds: number;
  frames: BrokerExtractedFrame[];
}

export interface BrokerExtractionOptions {
  frameCount: number;
  signal?: AbortSignal;
  timeoutMs: number;
}

const MAX_BROKER_RESPONSE_BYTES = 32 * 1024 * 1024;

export function resolveVideoBridgeBrokerBaseUrl(_candidate?: string): string {
  return resolveModelSyncInternalBaseUrl();
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<unknown> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) {
    await response.body?.cancel("Video extraction broker response exceeded its byte limit");
    throw new Error("Video extraction broker response exceeded its byte limit");
  }
  if (!response.body) {
    throw new Error("Video extraction broker returned an invalid response");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel("Video extraction broker response exceeded its byte limit");
        throw new Error("Video extraction broker response exceeded its byte limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const text = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    totalBytes
  ).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Video extraction broker returned an invalid response");
  }
}

function parseBrokerResult(value: unknown, frameCount: number): BrokerExtractionResult {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const durationSeconds = Number(record?.durationSeconds);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || !Array.isArray(record?.frames)) {
    throw new Error("Video extraction broker returned invalid metadata");
  }
  if (record.frames.length < 1 || record.frames.length > frameCount) {
    throw new Error("Video extraction broker returned an invalid frame count");
  }
  const frames = record.frames.map((entry) => {
    const frame = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
    const timestampSeconds = Number(frame?.timestampSeconds);
    const dataUri = typeof frame?.dataUri === "string" ? frame.dataUri : "";
    if (
      !Number.isFinite(timestampSeconds) ||
      timestampSeconds < 0 ||
      !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(dataUri)
    ) {
      throw new Error("Video extraction broker returned an invalid frame");
    }
    return { dataUri, timestampSeconds };
  });
  return { durationSeconds, frames };
}

export async function extractVideoFramesViaBroker(
  bytes: Uint8Array,
  options: BrokerExtractionOptions,
  dependencies: { fetchImpl?: typeof fetch; maxResponseBytes?: number } = {}
): Promise<BrokerExtractionResult> {
  if (options.signal?.aborted) throw new Error("Video extraction request aborted");
  const baseUrl = resolveVideoBridgeBrokerBaseUrl();
  const url = new URL(`${baseUrl}${VIDEO_BRIDGE_BROKER_PATH}`);
  url.searchParams.set("frames", String(options.frameCount));
  const fetchImpl = dependencies.fetchImpl ?? fetchModelSyncInternal;
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      body: Buffer.from(bytes),
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(bytes.byteLength),
        ...buildVideoBridgeBrokerHeaders(),
      },
      redirect: "error",
      signal,
    });
  } catch {
    if (signal.aborted) throw new Error("Video extraction request aborted");
    throw new Error("Video extraction broker is unavailable");
  }
  if (!response.ok) {
    throw new Error(`Video extraction broker failed (${response.status})`);
  }
  const maxResponseBytes = Math.min(
    MAX_BROKER_RESPONSE_BYTES,
    dependencies.maxResponseBytes ?? MAX_BROKER_RESPONSE_BYTES
  );
  return parseBrokerResult(
    await readBoundedResponse(response, maxResponseBytes),
    options.frameCount
  );
}
