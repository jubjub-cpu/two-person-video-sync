import { z } from "zod";

const MAX_DURATION_SEC = 31 * 24 * 60 * 60;
const SAFE_CONTENT_ID = /^[A-Za-z0-9._~-]{1,160}$/;

function containsControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export const VideoIdentitySchema = z
  .object({
    identityVersion: z.literal(1),
    kind: z.enum(["known", "generic"]),
    provider: z.string().regex(/^[a-z0-9-]{1,40}$/),
    origin: z
      .string()
      .max(255)
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            (url.protocol === "http:" || url.protocol === "https:") &&
            url.origin === value &&
            url.username === "" &&
            url.password === ""
          );
        } catch {
          return false;
        }
      }, "Expected a safe HTTP(S) origin"),
    contentId: z.string().regex(SAFE_CONTENT_ID).optional(),
    normalizedPath: z
      .string()
      .min(1)
      .max(512)
      .startsWith("/")
      .refine((value) => !containsControlCharacters(value), "Path contains control characters")
      .optional(),
    titleFingerprint: z.string().regex(/^[a-f0-9]{16}$/),
    durationSec: z.number().finite().nonnegative().max(MAX_DURATION_SEC).nullable(),
    isLive: z.boolean(),
  })
  .strict()
  .superRefine((identity, context) => {
    if (identity.kind === "known" && identity.contentId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["contentId"],
        message: "Known video identities require a content ID",
      });
    }
    if (identity.kind === "generic" && identity.normalizedPath === undefined) {
      context.addIssue({
        code: "custom",
        path: ["normalizedPath"],
        message: "Generic video identities require a normalized path",
      });
    }
    if (identity.isLive && identity.durationSec !== null) {
      context.addIssue({
        code: "custom",
        path: ["durationSec"],
        message: "Live video identities must not claim a fixed duration",
      });
    }
  });

export const VideoCapabilitiesSchema = z
  .object({
    canPlayPause: z.boolean(),
    canSeek: z.boolean(),
    canSetPlaybackRate: z.boolean(),
    seekableStartSec: z.number().finite().nonnegative().max(MAX_DURATION_SEC).nullable(),
    seekableEndSec: z.number().finite().nonnegative().max(MAX_DURATION_SEC).nullable(),
  })
  .strict()
  .superRefine((capabilities, context) => {
    if (
      capabilities.seekableStartSec !== null &&
      capabilities.seekableEndSec !== null &&
      capabilities.seekableEndSec < capabilities.seekableStartSec
    ) {
      context.addIssue({
        code: "custom",
        path: ["seekableEndSec"],
        message: "Seekable end must not precede seekable start",
      });
    }
    if (
      !capabilities.canSeek &&
      (capabilities.seekableStartSec !== null || capabilities.seekableEndSec !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "An unseekable video must not advertise a seekable range",
      });
    }
  });

export const AdStateSchema = z.enum(["content", "advertisement", "unknown"]);

export const VideoStateSchema = z
  .object({
    identity: VideoIdentitySchema,
    capabilities: VideoCapabilitiesSchema,
    adState: AdStateSchema,
  })
  .strict();

export type VideoIdentity = z.infer<typeof VideoIdentitySchema>;
export type VideoCapabilities = z.infer<typeof VideoCapabilitiesSchema>;
export type AdState = z.infer<typeof AdStateSchema>;
export type VideoState = z.infer<typeof VideoStateSchema>;

export interface NormalizeVideoIdentityInput {
  readonly url: string;
  readonly provider?: string;
  readonly contentId?: string;
  readonly title?: string;
  readonly durationSec?: number | null;
  readonly isLive?: boolean;
}

interface KnownIdentity {
  readonly provider: string;
  readonly contentId: string;
}

function safeContentId(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return SAFE_CONTENT_ID.test(value) ? value : null;
}

function providerForHostname(hostname: string): string {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  const knownProviders: Readonly<Record<string, string>> = {
    "youtube.com": "youtube",
    "m.youtube.com": "youtube",
    "youtu.be": "youtube",
    "vimeo.com": "vimeo",
    "player.vimeo.com": "vimeo",
    "dailymotion.com": "dailymotion",
    "dai.ly": "dailymotion",
    "twitch.tv": "twitch",
    "netflix.com": "netflix",
    "primevideo.com": "prime-video",
    "disneyplus.com": "disney-plus",
    "hulu.com": "hulu",
    "max.com": "max",
    "peacocktv.com": "peacock",
    "paramountplus.com": "paramount-plus",
    "tv.apple.com": "apple-tv",
    "crunchyroll.com": "crunchyroll",
    "app.plex.tv": "plex",
  };
  return knownProviders[host] ?? "generic";
}

function extractKnownIdentity(url: URL): KnownIdentity | null {
  const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  const pathSegments = url.pathname.split("/").filter(Boolean);
  const first = pathSegments[0];
  const second = pathSegments[1];

  if (hostname === "youtu.be") {
    const contentId = safeContentId(first);
    return contentId === null ? null : { provider: "youtube", contentId };
  }
  if (hostname === "youtube.com" || hostname === "m.youtube.com") {
    const candidate =
      url.pathname === "/watch"
        ? url.searchParams.get("v")
        : first === "shorts" || first === "live" || first === "embed"
          ? second
          : null;
    const contentId = safeContentId(candidate);
    return contentId === null ? null : { provider: "youtube", contentId };
  }
  if (hostname === "vimeo.com" || hostname === "player.vimeo.com") {
    const contentId = pathSegments.find((segment) => /^\d+$/.test(segment));
    return contentId === undefined ? null : { provider: "vimeo", contentId };
  }
  if (hostname === "dailymotion.com" && first === "video") {
    const contentId = safeContentId(second?.split("_")[0]);
    return contentId === null ? null : { provider: "dailymotion", contentId };
  }
  if (hostname === "dai.ly") {
    const contentId = safeContentId(first);
    return contentId === null ? null : { provider: "dailymotion", contentId };
  }
  if (hostname === "twitch.tv" && first === "videos" && second !== undefined) {
    const contentId = safeContentId(second);
    return contentId === null ? null : { provider: "twitch", contentId };
  }
  if (hostname === "netflix.com" && first === "watch" && second !== undefined) {
    const contentId = safeContentId(second);
    return contentId === null ? null : { provider: "netflix", contentId };
  }
  return null;
}

function fingerprint(value: string): string {
  const normalized = value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < normalized.length; index += 1) {
    const codePoint = normalized.charCodeAt(index);
    first = Math.imul(first ^ codePoint, 0x01000193);
    second = Math.imul(second ^ codePoint, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

function normalizePath(pathname: string): string {
  let path = pathname.replace(/\/+/g, "/");
  if (!path.startsWith("/")) {
    path = `/${path}`;
  }
  if (path.length > 1) {
    path = path.replace(/\/$/, "");
  }
  if (path.length <= 512) {
    return path;
  }
  return `${path.slice(0, 490)}~${fingerprint(path)}`;
}

function normalizeDuration(durationSec: number | null | undefined, isLive: boolean): number | null {
  if (
    isLive ||
    durationSec === undefined ||
    durationSec === null ||
    !Number.isFinite(durationSec)
  ) {
    return null;
  }
  return Math.round(Math.max(0, durationSec) * 2) / 2;
}

/**
 * Produces a privacy-minimized identity. Search parameters, fragments, credentials, and the
 * raw title are never returned.
 */
export function normalizeVideoIdentity(input: NormalizeVideoIdentityInput): VideoIdentity {
  const url = new URL(input.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP(S) video pages can be normalized");
  }

  const explicitContentId = safeContentId(input.contentId);
  const explicitProvider =
    input.provider !== undefined && /^[a-z0-9-]{1,40}$/.test(input.provider)
      ? input.provider
      : null;
  const extracted = extractKnownIdentity(url);
  const known =
    explicitContentId === null
      ? extracted
      : {
          provider: explicitProvider ?? providerForHostname(url.hostname),
          contentId: explicitContentId,
        };
  const isLive = input.isLive ?? false;

  return VideoIdentitySchema.parse({
    identityVersion: 1,
    kind: known === null ? "generic" : "known",
    provider: known?.provider ?? explicitProvider ?? providerForHostname(url.hostname),
    origin: url.origin,
    contentId: known?.contentId,
    normalizedPath: known === null ? normalizePath(url.pathname) : undefined,
    titleFingerprint: fingerprint(input.title ?? ""),
    durationSec: normalizeDuration(input.durationSec, isLive),
    isLive,
  });
}

export type VideoCompatibilityReason =
  | "compatible"
  | "live-unsupported"
  | "provider-mismatch"
  | "content-mismatch"
  | "path-mismatch"
  | "duration-mismatch";

export interface VideoCompatibility {
  readonly compatible: boolean;
  readonly reason: VideoCompatibilityReason;
  readonly durationDifferenceSec?: number;
}

export interface VideoCompatibilityOptions {
  readonly absoluteDurationToleranceSec?: number;
  readonly relativeDurationTolerance?: number;
}

export function compareVideoIdentities(
  left: VideoIdentity,
  right: VideoIdentity,
  options: VideoCompatibilityOptions = {},
): VideoCompatibility {
  if (left.isLive || right.isLive) {
    return { compatible: false, reason: "live-unsupported" };
  }
  if (left.provider !== right.provider) {
    return { compatible: false, reason: "provider-mismatch" };
  }
  if (left.kind === "known" || right.kind === "known") {
    if (left.kind !== right.kind || left.contentId !== right.contentId) {
      return { compatible: false, reason: "content-mismatch" };
    }
  } else if (left.origin !== right.origin || left.normalizedPath !== right.normalizedPath) {
    return { compatible: false, reason: "path-mismatch" };
  }

  if (left.durationSec !== null && right.durationSec !== null) {
    const difference = Math.abs(left.durationSec - right.durationSec);
    const absoluteTolerance = options.absoluteDurationToleranceSec ?? 3;
    const relativeTolerance = options.relativeDurationTolerance ?? 0.005;
    const tolerance = Math.max(
      absoluteTolerance,
      Math.max(left.durationSec, right.durationSec) * relativeTolerance,
    );
    if (difference > tolerance) {
      return {
        compatible: false,
        reason: "duration-mismatch",
        durationDifferenceSec: difference,
      };
    }
  }
  return { compatible: true, reason: "compatible" };
}
