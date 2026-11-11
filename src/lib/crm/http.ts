import "server-only";

import { extractApiKeyFromHeaders } from "@/lib/auth/api-keys";
import { isAuthContextError, requireOrgContext, type OrgContext } from "@/lib/auth/context";

export type CrmMutationRequest = {
  url: string;
  method: string;
  headers: Headers;
};

export class CrmRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "CrmRequestError";
  }
}

function normalizeHttpOrigin(value: string | null): string | null {
  const candidate = value?.trim();
  if (!candidate || candidate.includes(",")) return null;
  try {
    const url = new URL(candidate);
    if (
      !["http:", "https:"].includes(url.protocol)
      || url.username
      || url.password
      || url.pathname !== "/"
      || url.search
      || url.hash
    ) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function forwardedTargetOrigin(headers: Headers): string | null {
  const host = headers.get("x-forwarded-host")?.trim() || headers.get("host")?.trim();
  const protocol = headers.get("x-forwarded-proto")?.trim().toLowerCase();
  if (!host || !protocol || host.includes(",") || protocol.includes(",")) return null;
  if (protocol !== "http" && protocol !== "https") return null;
  return normalizeHttpOrigin(`${protocol}://${host}`);
}

function targetHostMatchesOrigin(headers: Headers, origin: string): boolean {
  const originUrl = new URL(origin);
  return [headers.get("x-forwarded-host"), headers.get("host")].some((value) => {
    const host = value?.trim();
    if (!host || host.includes(",")) return false;
    return normalizeHttpOrigin(`${originUrl.protocol}//${host}`) === origin;
  });
}

function isInternalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (["localhost", "0.0.0.0", "::1", "[::1]"].includes(normalized)) return true;
  if (normalized.endsWith(".localhost") || normalized.endsWith(".internal")) return true;
  if (/^(?:10|127)\./.test(normalized) || /^192\.168\./.test(normalized)) return true;
  const private172 = normalized.match(/^172\.(\d{1,2})\./);
  return Boolean(private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31);
}

export function assertSameOriginMutation(
  request: Pick<CrmMutationRequest, "url" | "method" | "headers">,
): void {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) return;

  const origin = normalizeHttpOrigin(request.headers.get("origin"));
  const fetchSite = request.headers.get("sec-fetch-site");
  if (!origin || (fetchSite && fetchSite !== "same-origin")) {
    throw new CrmRequestError("Cross-origin CRM mutation rejected", 403, "INVALID_ORIGIN");
  }

  const requestOrigin = new URL(request.url).origin;
  const forwardedOrigin = forwardedTargetOrigin(request.headers);
  if (origin === requestOrigin || origin === forwardedOrigin) return;

  // Fetch Metadata describes the browser-facing request before a reverse
  // proxy rewrites its URL. Modern browsers control this forbidden header.
  // Only use it as a fallback when the public host survived in a forwarding
  // header, or the URL clearly points at a private container-facing address.
  const requestUrl = new URL(request.url);
  if (
    fetchSite === "same-origin"
    && (targetHostMatchesOrigin(request.headers, origin) || isInternalHostname(requestUrl.hostname))
  ) return;

  throw new CrmRequestError("Cross-origin CRM mutation rejected", 403, "INVALID_ORIGIN");
}

/**
 * The guard for state-changing CRM-style routes: same-origin first (no
 * query needed to refuse a cross-site request), then the signed-in member
 * and their active organization. Auth failures surface as CrmRequestError
 * with the AuthContextError's status and code, so every route's existing
 * error mapping keeps working.
 */
export async function requireCrmMutationContext(request: CrmMutationRequest): Promise<OrgContext> {
  if (!extractApiKeyFromHeaders(request.headers)) {
    assertSameOriginMutation(request);
  }
  try {
    return await requireOrgContext(request);
  } catch (error) {
    if (isAuthContextError(error)) throw new CrmRequestError(error.message, error.status, error.code);
    throw error;
  }
}

export function requireIdempotencyKey(headers: Headers): string {
  const value = headers.get("idempotency-key")?.trim() ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(value)) {
    throw new CrmRequestError(
      "A valid Idempotency-Key header is required",
      400,
      "INVALID_IDEMPOTENCY_KEY",
    );
  }
  return value;
}

export function crmRequestErrorResponse(error: unknown): Response | null {
  if (!(error instanceof CrmRequestError)) return null;
  return Response.json(
    { error: error.message, code: error.code },
    { status: error.status },
  );
}
