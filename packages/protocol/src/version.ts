import { z } from "zod";

export const PROTOCOL_VERSION = 2 as const;
export const SUPPORTED_PROTOCOL_VERSIONS = [PROTOCOL_VERSION] as const;
export const ProtocolVersionSchema = z.literal(PROTOCOL_VERSION);
export type ProtocolVersion = z.infer<typeof ProtocolVersionSchema>;

export function isSupportedProtocolVersion(value: unknown): value is ProtocolVersion {
  return ProtocolVersionSchema.safeParse(value).success;
}

/**
 * Selects the highest mutually supported version. Returning null is an explicit signal
 * that the peers must not exchange state.
 */
export function negotiateProtocolVersion(
  offeredVersions: readonly number[],
): ProtocolVersion | null {
  const offered = new Set(offeredVersions);
  for (let index = SUPPORTED_PROTOCOL_VERSIONS.length - 1; index >= 0; index -= 1) {
    const version = SUPPORTED_PROTOCOL_VERSIONS[index];
    if (version !== undefined && offered.has(version)) {
      return version;
    }
  }
  return null;
}

export interface ProtocolVersionInspection {
  readonly receivedVersion: number | null;
  readonly supported: boolean;
}

export function inspectProtocolVersion(value: unknown): ProtocolVersionInspection {
  if (typeof value !== "object" || value === null || !("protocolVersion" in value)) {
    return { receivedVersion: null, supported: false };
  }

  const receivedVersion = Reflect.get(value, "protocolVersion");
  return {
    receivedVersion:
      typeof receivedVersion === "number" && Number.isSafeInteger(receivedVersion)
        ? receivedVersion
        : null,
    supported: isSupportedProtocolVersion(receivedVersion),
  };
}
