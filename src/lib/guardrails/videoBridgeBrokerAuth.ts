import { randomUUID, timingSafeEqual } from "node:crypto";

import { AUTHZ_HEADER_PEER_LOCALITY } from "@/server/authz/headers";

export const VIDEO_BRIDGE_BROKER_PATH = "/api/modality-bridge/video/extract";
export const VIDEO_BRIDGE_BROKER_AUTH_HEADER = "x-omniroute-video-bridge-broker";

const globalState = globalThis as typeof globalThis & {
  __omnirouteVideoBridgeBrokerToken?: string;
};

function brokerToken(): string {
  if (!globalState.__omnirouteVideoBridgeBrokerToken) {
    globalState.__omnirouteVideoBridgeBrokerToken = randomUUID();
  }
  return globalState.__omnirouteVideoBridgeBrokerToken;
}

export function buildVideoBridgeBrokerHeaders(): Record<string, string> {
  return { [VIDEO_BRIDGE_BROKER_AUTH_HEADER]: brokerToken() };
}

export function isVideoBridgeBrokerTokenRequest(request: Request, path: string): boolean {
  if (path !== VIDEO_BRIDGE_BROKER_PATH) return false;
  const expected = brokerToken();
  const provided = request.headers.get(VIDEO_BRIDGE_BROKER_AUTH_HEADER)?.trim() ?? "";
  if (!provided || provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided, "utf8"), Buffer.from(expected, "utf8"));
}

export function isVideoBridgeBrokerInternalRequest(request: Request, path: string): boolean {
  return (
    request.headers.get(AUTHZ_HEADER_PEER_LOCALITY) === "loopback" &&
    isVideoBridgeBrokerTokenRequest(request, path)
  );
}
