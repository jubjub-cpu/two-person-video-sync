import { DEFAULT_ROOM_PARTICIPANT_CAPACITY, MAX_ROOM_PARTICIPANT_CAPACITY } from "@vyzync/protocol";

export type EnvironmentName = "development" | "test" | "production";

export interface RateLimitConfig {
  readonly connectionAttempts: number;
  readonly connectionWindowMs: number;
  readonly roomCreates: number;
  readonly roomCreateWindowMs: number;
  readonly roomJoins: number;
  readonly roomJoinWindowMs: number;
  readonly messagesPerConnection: number;
  readonly messagesPerIp: number;
  readonly messageWindowMs: number;
}

export interface ServerConfig {
  readonly environment: EnvironmentName;
  readonly host: string;
  readonly port: number;
  readonly logLevel: string;
  readonly trustProxy: boolean;
  readonly requireSecureWebSocket: boolean;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly allowExtensionOrigins: boolean;
  readonly allowLocalhostOrigins: boolean;
  readonly allowMissingOrigin: boolean;
  readonly maxPayloadBytes: number;
  readonly maxConnections: number;
  readonly maxConnectionsPerIp: number;
  readonly maxParticipantsPerRoom: number;
  readonly rateLimits: RateLimitConfig;
  readonly roomTtlMs: number;
  readonly roomIdleTtlMs: number;
  readonly reconnectGraceMs: number;
  readonly reconnectTokenTtlMs: number;
  readonly cleanupIntervalMs: number;
  readonly shutdownTimeoutMs: number;
}

type Environment = Readonly<Record<string, string | undefined>>;

function parseEnvironment(value: string | undefined): EnvironmentName {
  if (value === undefined || value === "development") {
    return "development";
  }
  if (value === "test" || value === "production") {
    return value;
  }
  throw new Error("NODE_ENV must be development, test, or production");
}

function parseInteger(
  env: Environment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function parseBoolean(env: Environment, name: string, fallback: boolean): boolean {
  const value = env[name];
  if (value === undefined || value === "") {
    return fallback;
  }
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) {
    return false;
  }
  throw new Error(`${name} must be true or false`);
}

function parseOrigins(raw: string | undefined): ReadonlySet<string> {
  const origins = new Set<string>();
  if (raw === undefined || raw.trim() === "") {
    return origins;
  }
  for (const candidate of raw.split(",")) {
    const origin = candidate.trim();
    if (origin === "") {
      continue;
    }
    if (origin.includes("*") || (origin.includes("/") && !origin.includes("://"))) {
      throw new Error("ALLOWED_ORIGINS accepts exact origins only");
    }
    if (
      !/^https?:\/\/[^/?#]+$/i.test(origin) &&
      !/^chrome-extension:\/\/[a-p]{32}$/.test(origin) &&
      !/^moz-extension:\/\/[0-9a-f-]{36}$/i.test(origin)
    ) {
      throw new Error(`ALLOWED_ORIGINS contains an invalid origin: ${origin}`);
    }
    origins.add(origin);
  }
  return origins;
}

export function loadConfig(env: Environment = process.env): ServerConfig {
  const environment = parseEnvironment(env.NODE_ENV);
  const production = environment === "production";

  return {
    environment,
    host: env.HOST?.trim() || "127.0.0.1",
    port: parseInteger(env, "PORT", 8787, 1, 65_535),
    logLevel: env.LOG_LEVEL?.trim() || (environment === "test" ? "silent" : "info"),
    trustProxy: parseBoolean(env, "TRUST_PROXY", false),
    requireSecureWebSocket: parseBoolean(env, "REQUIRE_SECURE_WEBSOCKET", production),
    allowedOrigins: parseOrigins(env.ALLOWED_ORIGINS),
    allowExtensionOrigins: parseBoolean(env, "ALLOW_EXTENSION_ORIGINS", true),
    allowLocalhostOrigins: parseBoolean(env, "ALLOW_LOCALHOST_ORIGINS", !production),
    allowMissingOrigin: parseBoolean(env, "ALLOW_MISSING_ORIGIN", false),
    maxPayloadBytes: parseInteger(env, "MAX_PAYLOAD_BYTES", 16 * 1024, 1024, 64 * 1024),
    maxConnections: parseInteger(env, "MAX_CONNECTIONS", 10_000, 2, 1_000_000),
    maxConnectionsPerIp: parseInteger(env, "MAX_CONNECTIONS_PER_IP", 20, 1, 10_000),
    maxParticipantsPerRoom: parseInteger(
      env,
      "MAX_PARTICIPANTS_PER_ROOM",
      DEFAULT_ROOM_PARTICIPANT_CAPACITY,
      2,
      MAX_ROOM_PARTICIPANT_CAPACITY,
    ),
    rateLimits: {
      connectionAttempts: parseInteger(env, "CONNECTION_ATTEMPTS_PER_MINUTE", 60, 1, 100_000),
      connectionWindowMs: 60_000,
      roomCreates: parseInteger(env, "ROOM_CREATES_PER_HOUR", 20, 1, 100_000),
      roomCreateWindowMs: 60 * 60_000,
      roomJoins: parseInteger(env, "ROOM_JOINS_PER_MINUTE", 30, 1, 100_000),
      roomJoinWindowMs: 60_000,
      messagesPerConnection: parseInteger(
        env,
        "MESSAGES_PER_CONNECTION_PER_10_SECONDS",
        120,
        1,
        100_000,
      ),
      messagesPerIp: parseInteger(env, "MESSAGES_PER_IP_PER_10_SECONDS", 600, 1, 1_000_000),
      messageWindowMs: 10_000,
    },
    roomTtlMs: parseInteger(env, "ROOM_TTL_MS", 6 * 60 * 60_000, 60_000, 24 * 60 * 60_000),
    roomIdleTtlMs: parseInteger(env, "ROOM_IDLE_TTL_MS", 30 * 60_000, 10_000, 24 * 60 * 60_000),
    reconnectGraceMs: parseInteger(env, "RECONNECT_GRACE_MS", 2 * 60_000, 1_000, 60 * 60_000),
    reconnectTokenTtlMs: parseInteger(
      env,
      "RECONNECT_TOKEN_TTL_MS",
      6 * 60 * 60_000,
      10_000,
      24 * 60 * 60_000,
    ),
    cleanupIntervalMs: parseInteger(env, "CLEANUP_INTERVAL_MS", 30_000, 1_000, 60 * 60_000),
    shutdownTimeoutMs: parseInteger(env, "SHUTDOWN_TIMEOUT_MS", 10_000, 1_000, 60_000),
  };
}

const CHROME_EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const FIREFOX_EXTENSION_ORIGIN = /^moz-extension:\/\/[0-9a-f-]{36}$/i;

export function isOriginAllowed(origin: string | undefined, config: ServerConfig): boolean {
  if (origin === undefined || origin === "") {
    return config.allowMissingOrigin;
  }
  if (config.allowedOrigins.has(origin)) {
    return true;
  }
  if (
    config.allowExtensionOrigins &&
    (CHROME_EXTENSION_ORIGIN.test(origin) || FIREFOX_EXTENSION_ORIGIN.test(origin))
  ) {
    return true;
  }
  if (!config.allowLocalhostOrigins) {
    return false;
  }
  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "::1" ||
        url.hostname === "[::1]") &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}
