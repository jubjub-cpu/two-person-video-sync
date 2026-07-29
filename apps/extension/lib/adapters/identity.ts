import type { SafeVideoIdentity } from "../types";

interface IdentityContext {
  url: URL;
  title: string;
  durationSeconds: number;
  seekable: TimeRanges;
}

interface ProviderRule {
  provider: string;
  hosts: RegExp;
  contentKey: (url: URL) => string | null;
}

const providerRules: ProviderRule[] = [
  {
    provider: "youtube",
    hosts: /(^|\.)youtube\.com$|(^|\.)youtu\.be$/,
    contentKey: (url) =>
      url.hostname.endsWith("youtu.be")
        ? segment(url.pathname, 0)
        : (url.searchParams.get("v") ??
          capture(url.pathname, /^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{6,})/)),
  },
  {
    provider: "vimeo",
    hosts: /(^|\.)vimeo\.com$/,
    contentKey: (url) => capture(url.pathname, /\/(?:video\/)?(\d{5,})/),
  },
  {
    provider: "dailymotion",
    hosts: /(^|\.)dailymotion\.com$|(^|\.)dai\.ly$/,
    contentKey: (url) => capture(url.pathname, /\/(?:video\/)?([A-Za-z0-9]+)/),
  },
  {
    provider: "twitch-vod",
    hosts: /(^|\.)twitch\.tv$/,
    contentKey: (url) => capture(url.pathname, /\/videos\/(\d+)/),
  },
  {
    provider: "netflix",
    hosts: /(^|\.)netflix\.com$/,
    contentKey: (url) => capture(url.pathname, /\/watch\/(\d+)/),
  },
  {
    provider: "prime-video",
    hosts: /(^|\.)amazon\.[a-z.]+$|(^|\.)primevideo\.com$/,
    contentKey: (url) =>
      capture(url.pathname, /\/(?:detail|gp\/video\/detail)\/([A-Za-z0-9]+)/) ??
      url.searchParams.get("gti"),
  },
  {
    provider: "disney-plus",
    hosts: /(^|\.)disneyplus\.com$/,
    contentKey: (url) => capture(url.pathname, /\/(?:video|play)\/([A-Za-z0-9-]+)/),
  },
  {
    provider: "hulu",
    hosts: /(^|\.)hulu\.com$/,
    contentKey: (url) => capture(url.pathname, /\/watch\/([A-Za-z0-9-]+)/),
  },
  {
    provider: "max",
    hosts: /(^|\.)max\.com$|(^|\.)hbomax\.com$/,
    contentKey: (url) => capture(url.pathname, /\/(?:video\/watch|feature|episode)\/([^/]+)/),
  },
  {
    provider: "peacock",
    hosts: /(^|\.)peacocktv\.com$/,
    contentKey: (url) => capture(url.pathname, /\/(?:watch|playback)\/(?:[^/]+\/)*([^/]+)/),
  },
  {
    provider: "paramount-plus",
    hosts: /(^|\.)paramountplus\.com$/,
    contentKey: (url) => capture(url.pathname, /\/(?:video|movies|shows)\/([^/]+)/),
  },
  {
    provider: "apple-tv-plus",
    hosts: /(^|\.)tv\.apple\.com$/,
    contentKey: (url) => capture(url.pathname, /\/(?:episode|movie)\/[^/]+\/([A-Za-z0-9.]+)/),
  },
  {
    provider: "crunchyroll",
    hosts: /(^|\.)crunchyroll\.com$/,
    contentKey: (url) => capture(url.pathname, /\/watch\/([A-Z0-9]+)/i),
  },
  {
    provider: "plex-web",
    hosts: /(^|\.)plex\.tv$/,
    contentKey: (url) =>
      capture(url.hash, /\/library\/metadata\/(\d+)/) ??
      capture(url.pathname, /\/library\/metadata\/(\d+)/),
  },
  {
    provider: "jellyfin-web",
    hosts: /.*/,
    contentKey: (url) =>
      /jellyfin/i.test(url.pathname + url.hash)
        ? capture(url.hash, /(?:\?|&)id=([A-Fa-f0-9-]+)/)
        : null,
  },
];

function segment(pathname: string, index: number): string | null {
  return pathname.split("/").filter(Boolean)[index] ?? null;
}

function capture(value: string, pattern: RegExp): string | null {
  return pattern.exec(value)?.[1] ?? null;
}

export function fingerprint(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

export function safeDisplayTitle(title: string): string {
  const withoutControls = Array.from(title, (character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f ? " " : character;
  }).join("");
  return withoutControls
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, "[private]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

export function normalizedPath(url: URL): string {
  const path = url.pathname
    .replace(/\/+/g, "/")
    .replace(/\/(?:account|profile|user)\/[^/]+/gi, "/private")
    .replace(/\/$/, "");
  return path || "/";
}

export function deriveVideoIdentity(context: IdentityContext): SafeVideoIdentity {
  const { url, durationSeconds, seekable } = context;
  const title = safeDisplayTitle(context.title);
  const rule = providerRules.find((candidate) => candidate.hosts.test(url.hostname));
  const extracted = rule?.contentKey(url);
  const path = normalizedPath(url);
  const isLive = !Number.isFinite(durationSeconds) || durationSeconds <= 0;
  const durationMs =
    Number.isFinite(durationSeconds) && durationSeconds > 0
      ? Math.round(durationSeconds * 1000)
      : null;
  return {
    provider: extracted ? (rule?.provider ?? "generic-html5") : "generic-html5",
    contentKey:
      extracted ?? `${fingerprint(url.origin + path)}-${Math.round(durationSeconds || 0)}`,
    origin: url.origin,
    pathFingerprint: fingerprint(path),
    titleFingerprint: fingerprint(title.toLocaleLowerCase()),
    displayTitle: title || "Untitled video",
    durationMs,
    isLive,
    seekable: !isLive && seekable.length > 0,
  };
}

export interface IdentityComparison {
  compatible: boolean;
  reason?: string;
}

export function compareVideoIdentities(
  local: SafeVideoIdentity,
  remote: SafeVideoIdentity,
): IdentityComparison {
  if (local.isLive || remote.isLive) {
    return { compatible: false, reason: "Live streams have provider-specific latency." };
  }
  if (local.provider !== remote.provider || local.contentKey !== remote.contentKey) {
    return { compatible: false, reason: "The two tabs appear to have different videos open." };
  }
  if (local.durationMs !== null && remote.durationMs !== null) {
    const tolerance = Math.max(2_000, Math.min(local.durationMs, remote.durationMs) * 0.005);
    if (Math.abs(local.durationMs - remote.durationMs) > tolerance) {
      return { compatible: false, reason: "The available video cuts have different durations." };
    }
  }
  if (!local.seekable || !remote.seekable) {
    return { compatible: false, reason: "At least one player cannot be safely seeked." };
  }
  return { compatible: true };
}
