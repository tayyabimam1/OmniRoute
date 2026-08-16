import { createHash, randomUUID } from "node:crypto";

import { normalizeCodexSessionId } from "./codexClient.ts";

const CODEX_INSTALLATION_SALT = "omniroute-codex-installation";
const CODEX_SESSION_SEED_PREFIX = "omniroute:codex-session-id:v1:";
const CODEX_THREAD_SEED_PREFIX = "omniroute:codex-thread-id:v1:";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const CODEX_FINGERPRINT_MODES = ["off", "device", "session", "full"] as const;
export type CodexFingerprintMode = (typeof CODEX_FINGERPRINT_MODES)[number];
export const CODEX_FINGERPRINT_MODE_KEY = "codexFingerprintMode";

export type CodexClientIdentity = {
  mode: CodexFingerprintMode;
  installationId: string;
  sessionId: string;
  threadId: string;
  turnId: string;
  windowId: string;
  turnStartedAtUnixMs: number;
};

type CodexIdentityOptions = {
  mode?: CodexFingerprintMode;
  accountKey?: string | null;
  isOAuth?: boolean;
};

function normalizeUuid(value: unknown): string | null {
  return typeof value === "string" && UUID_PATTERN.test(value.trim()) ? value.trim() : null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

/** Keep the historical installation-id layout so existing accounts stay stable. */
function uuidFromLegacyInstallationValue(value: string): string {
  const hash = createHash("sha256").update(value).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/** RFC4122 v4 from SHA-256. Same seed → same UUID. */
export function deriveStableUUIDv4(seed: string): string {
  const digest = createHash("sha256").update(seed).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return [
    bytes.subarray(0, 4).toString("hex"),
    bytes.subarray(4, 6).toString("hex"),
    bytes.subarray(6, 8).toString("hex"),
    bytes.subarray(8, 10).toString("hex"),
    bytes.subarray(10, 16).toString("hex"),
  ].join("-");
}

function accountSeed(
  providerSpecificData?: Record<string, unknown> | null,
  accountKey?: string | null
): string {
  return (
    nonEmptyString(accountKey) ||
    nonEmptyString(providerSpecificData?.connectionId) ||
    nonEmptyString(providerSpecificData?.workspaceId) ||
    nonEmptyString(providerSpecificData?.accountId) ||
    nonEmptyString(providerSpecificData?.email) ||
    "default"
  );
}

function readNamedHeader(
  headers: Headers | Record<string, unknown> | null | undefined,
  name: string
): string {
  if (!headers) return "";
  if (headers instanceof Headers) return headers.get(name)?.trim() || "";
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted && typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

export function isCodexOAuthCredentials(
  credentials?: {
    accessToken?: unknown;
    refreshToken?: unknown;
  } | null
): boolean {
  return Boolean(
    nonEmptyString(credentials?.accessToken) || nonEmptyString(credentials?.refreshToken)
  );
}

export function getCodexFingerprintMode(
  providerSpecificData?: Record<string, unknown> | null,
  isOAuth = true
): CodexFingerprintMode {
  if (!isOAuth) return "off";
  const raw = (
    nonEmptyString(providerSpecificData?.[CODEX_FINGERPRINT_MODE_KEY]) ||
    nonEmptyString(providerSpecificData?.codex_fingerprint_mode) ||
    ""
  ).toLowerCase();
  return (CODEX_FINGERPRINT_MODES as readonly string[]).includes(raw)
    ? (raw as CodexFingerprintMode)
    : "session";
}

export function getCodexInstallationId(
  providerSpecificData?: Record<string, unknown> | null,
  accountKey?: string | null
): string {
  const explicit = normalizeUuid(providerSpecificData?.codexInstallationId);
  if (explicit) return explicit;

  const legacyStableSource =
    nonEmptyString(providerSpecificData?.workspaceId) ||
    nonEmptyString(providerSpecificData?.accountId) ||
    nonEmptyString(providerSpecificData?.email);
  if (legacyStableSource) {
    return uuidFromLegacyInstallationValue(`${CODEX_INSTALLATION_SALT}:${legacyStableSource}`);
  }

  return deriveStableUUIDv4(
    `${CODEX_INSTALLATION_SALT}:${accountSeed(providerSpecificData, accountKey)}`
  );
}

export function getCodexConvergedSessionId(
  providerSpecificData?: Record<string, unknown> | null,
  accountKey?: string | null
): string {
  return deriveStableUUIDv4(
    `${CODEX_SESSION_SEED_PREFIX}${accountSeed(providerSpecificData, accountKey)}`
  );
}

export function getCodexConvergedThreadId(
  clientSessionId: string | null,
  providerSpecificData?: Record<string, unknown> | null,
  accountKey?: string | null
): string {
  if (!nonEmptyString(clientSessionId)) return "";
  return deriveStableUUIDv4(
    `${CODEX_THREAD_SEED_PREFIX}${accountSeed(providerSpecificData, accountKey)}:${clientSessionId}`
  );
}

export function getCodexClientSessionId(
  headers: Headers | Record<string, unknown> | null | undefined
): string | null {
  return (
    normalizeCodexSessionId(readNamedHeader(headers, "session-id")) ||
    normalizeCodexSessionId(readNamedHeader(headers, "session_id")) ||
    null
  );
}

/**
 * One identity object for every carrier in one upstream turn.
 * accountKey may be the OmniRoute connection id; it is never sent upstream.
 */
export function createCodexClientIdentity(
  clientSessionId: string | null,
  providerSpecificData?: Record<string, unknown> | null,
  options: CodexIdentityOptions = {}
): CodexClientIdentity | null {
  const mode =
    options.mode ?? getCodexFingerprintMode(providerSpecificData, options.isOAuth ?? true);
  if (mode === "off") return null;

  const installationId = getCodexInstallationId(providerSpecificData, options.accountKey);
  if (mode === "device") {
    return {
      mode,
      installationId,
      sessionId: "",
      threadId: "",
      turnId: "",
      windowId: "",
      turnStartedAtUnixMs: Date.now(),
    };
  }

  const sessionId = getCodexConvergedSessionId(providerSpecificData, options.accountKey);
  const threadId =
    mode === "full"
      ? sessionId
      : getCodexConvergedThreadId(clientSessionId, providerSpecificData, options.accountKey) ||
        sessionId;

  return {
    mode,
    installationId,
    sessionId,
    threadId,
    turnId: randomUUID(),
    windowId: `${threadId}:0`,
    turnStartedAtUnixMs: Date.now(),
  };
}

function isCompactRequestEndpoint(path: unknown): boolean {
  if (typeof path !== "string") return false;
  const normalized = path.trim().toLowerCase().replace(/\\/g, "/");
  return normalized === "/compact" || /(?:^|\/)responses\/compact(?:\/|$)/.test(normalized);
}

const CODEX_IDENTITY_HEADER_NAMES = [
  "session-id",
  "session_id",
  "thread-id",
  "thread_id",
  "x-client-request-id",
  "x-codex-installation-id",
  "x-codex-window-id",
  "x-codex-turn-metadata",
] as const;

type CodexCredentialIdentityInput = {
  connectionId?: string;
  requestEndpointPath?: string;
  accessToken?: unknown;
  refreshToken?: unknown;
  providerSpecificData?: Record<string, unknown> | null;
};

export function resolveCodexOriginalIdentityHeaders(input: {
  credentials?: CodexCredentialIdentityInput | null;
  clientHeaders?: Headers | Record<string, unknown> | null;
}): Record<string, string> | null {
  const credentials = input.credentials;
  if (!credentials || isCompactRequestEndpoint(credentials.requestEndpointPath)) return null;
  const providerSpecificData = credentials.providerSpecificData ?? null;
  if (
    !isCodexOAuthCredentials(credentials) ||
    getCodexFingerprintMode(providerSpecificData, true) !== "off"
  ) {
    return null;
  }

  const result: Record<string, string> = {};
  for (const name of CODEX_IDENTITY_HEADER_NAMES) {
    const value = readNamedHeader(input.clientHeaders, name);
    if (value) result[name] = value;
  }
  return Object.keys(result).length > 0 ? result : null;
}

/** One identity for headers, body, nested metadata, and WS payload. Compact skips. */
export function resolveCodexFingerprintIdentity(input: {
  credentials?: CodexCredentialIdentityInput | null;
  clientHeaders?: Headers | Record<string, unknown> | null;
  body?: unknown;
}): CodexClientIdentity | null {
  const credentials = input.credentials;
  if (!credentials || isCompactRequestEndpoint(credentials.requestEndpointPath)) return null;

  const providerSpecificData = credentials.providerSpecificData ?? null;
  const isOAuth = isCodexOAuthCredentials(credentials);
  if (getCodexFingerprintMode(providerSpecificData, isOAuth) === "off") return null;

  return createCodexClientIdentity(
    getCodexClientSessionId(input.clientHeaders),
    providerSpecificData,
    {
      accountKey: credentials.connectionId ?? null,
      isOAuth,
    }
  );
}

export function withCodexFingerprintCredentials<T extends CodexCredentialIdentityInput>(
  credentials: T,
  clientHeaders?: Headers | Record<string, unknown> | null,
  body?: unknown
): T {
  const identity = resolveCodexFingerprintIdentity({ credentials, clientHeaders, body });
  const original = resolveCodexOriginalIdentityHeaders({ credentials, clientHeaders });
  if (!identity && !original) return credentials;
  return {
    ...credentials,
    providerSpecificData: {
      ...(credentials.providerSpecificData || {}),
      ...(identity ? { codexClientIdentity: identity } : {}),
      ...(original ? { codexOriginalIdentityHeaders: original } : {}),
    },
  };
}

function mergeTurnMetadata(
  raw: unknown,
  identity: CodexClientIdentity,
  includeSessionFields: boolean
): string {
  let metadata: Record<string, unknown> = {};
  let hadExisting = false;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>;
        hadExisting = true;
      }
    } catch {
      // Keep non-JSON metadata only when we do not need a complete carrier.
    }
  }

  if (!hadExisting && includeSessionFields) {
    metadata.thread_source = "user";
    metadata.sandbox = "none";
  }

  metadata.installation_id = identity.installationId;
  if (includeSessionFields) {
    metadata.session_id = identity.sessionId;
    metadata.thread_id = identity.threadId || identity.sessionId;
    metadata.turn_id = identity.turnId;
    metadata.window_id = identity.windowId;
    metadata.turn_started_at_unix_ms = identity.turnStartedAtUnixMs;
  }
  return JSON.stringify(metadata);
}

export function applyCodexOriginalIdentityHeaders(
  headers: Record<string, string>,
  original?: Record<string, string> | null
): void {
  if (!original) return;
  for (const name of CODEX_IDENTITY_HEADER_NAMES) {
    const value = original[name];
    if (typeof value === "string" && value) headers[name] = value;
  }
}

export function applyCodexClientIdentityHeaders(
  headers: Record<string, string>,
  identity?: CodexClientIdentity | null
): void {
  if (!identity) return;

  headers["x-codex-installation-id"] = identity.installationId;
  if (identity.mode === "device") {
    if (headers["x-codex-turn-metadata"] !== undefined) {
      headers["x-codex-turn-metadata"] = mergeTurnMetadata(
        headers["x-codex-turn-metadata"],
        identity,
        false
      );
    }
    return;
  }

  headers["session-id"] = identity.sessionId;
  headers["session_id"] = identity.sessionId;
  headers["thread-id"] = identity.threadId || identity.sessionId;
  headers["x-client-request-id"] = identity.threadId || identity.sessionId;
  headers["x-codex-window-id"] = identity.windowId;
  headers["x-codex-turn-metadata"] = mergeTurnMetadata(
    headers["x-codex-turn-metadata"],
    identity,
    true
  );
}

export function applyCodexClientMetadata(
  body: Record<string, unknown>,
  identity?: CodexClientIdentity | null
): void {
  if (!identity) return;

  const existing =
    body.client_metadata &&
    typeof body.client_metadata === "object" &&
    !Array.isArray(body.client_metadata)
      ? { ...(body.client_metadata as Record<string, unknown>) }
      : {};
  existing["x-codex-installation-id"] = identity.installationId;

  if (identity.mode !== "device") {
    existing.session_id = identity.sessionId;
    existing.thread_id = identity.threadId || identity.sessionId;
    existing.turn_id = identity.turnId;
    existing["x-codex-window-id"] = identity.windowId;
  }

  if (existing["x-codex-turn-metadata"] !== undefined) {
    existing["x-codex-turn-metadata"] = mergeTurnMetadata(
      existing["x-codex-turn-metadata"],
      identity,
      identity.mode !== "device"
    );
  }

  body.client_metadata = existing;
}

/**
 * #3697: detect the Codex CLI as the request *client* (not the routed provider) from
 * request headers, so the model-echo shim can fire regardless of which upstream provider
 * ultimately serves the request (e.g. `codex/gpt-5.5-xhigh` routed through a combo).
 */
export function isCodexOriginatedHeaders(
  headers: Headers | Record<string, unknown> | null | undefined
): boolean {
  const getHeader = (name: string): string => {
    if (headers instanceof Headers) {
      return headers.get(name)?.toLowerCase() ?? "";
    }
    if (headers && typeof headers === "object") {
      for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
        if (key.toLowerCase() === name && typeof value === "string") {
          return value.toLowerCase();
        }
      }
    }
    return "";
  };

  if (getHeader("originator").startsWith("codex")) return true;
  return getHeader("user-agent").startsWith("codex");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Require the native Codex thread/turn binding; prompt text and cache keys are not authority. */
export function hasNativeCodexTurnBinding(body: unknown): boolean {
  const metadata = asRecord(asRecord(body)?.client_metadata);
  const raw = metadata?.["x-codex-turn-metadata"];
  let turn = asRecord(raw);
  if (typeof raw === "string") {
    try {
      turn = asRecord(JSON.parse(raw));
    } catch {
      return false;
    }
  }
  return (
    typeof turn?.thread_id === "string" &&
    turn.thread_id.trim().length > 0 &&
    typeof turn.turn_id === "string" &&
    turn.turn_id.trim().length > 0
  );
}

export function isVerifiedNativeCodexRequest(
  body: unknown,
  headers: Headers | Record<string, unknown> | null | undefined
): boolean {
  return isCodexOriginatedHeaders(headers) && hasNativeCodexTurnBinding(body);
}
