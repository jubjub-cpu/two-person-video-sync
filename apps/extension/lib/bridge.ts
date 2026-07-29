import { browser } from "wxt/browser";

import type { RuntimeRequest, RuntimeResponse } from "./types";

type RuntimeRequestWithoutId = RuntimeRequest extends infer Request
  ? Request extends { requestId: string }
    ? Omit<Request, "requestId"> & { requestId?: string }
    : never
  : never;

export function makeRequestId(): string {
  return crypto.randomUUID();
}

export function isRuntimeResponse(value: unknown): value is RuntimeResponse<unknown> {
  if (typeof value !== "object" || value === null) return false;
  const response = value as Record<string, unknown>;
  return (
    typeof response.ok === "boolean" &&
    typeof response.requestId === "string" &&
    (response.ok || typeof response.error === "string")
  );
}

export async function sendRuntimeRequest<T>(request: RuntimeRequestWithoutId): Promise<T> {
  const requestId = request.requestId ?? makeRequestId();
  const response: unknown = await browser.runtime.sendMessage({
    ...request,
    requestId,
  });
  if (!isRuntimeResponse(response)) {
    throw new Error("The extension did not respond.");
  }
  if (!response.ok) {
    throw new Error(response.error);
  }
  return response.data as T;
}

export function success<T>(requestId: string, data?: T): RuntimeResponse<T> {
  return { ok: true, requestId, data };
}

export function failure(requestId: string, error: unknown): RuntimeResponse {
  return {
    ok: false,
    requestId,
    error: error instanceof Error ? error.message : "Unexpected extension error.",
  };
}
