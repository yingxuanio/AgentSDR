import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { headers as nextHeaders } from "next/headers";
import { cache } from "react";
import { db } from "@/lib/db";
import { runInOrganization } from "@/lib/tenancy/scope";
import { roles, type OrgRole } from "./permissions";
import { members, organizations } from "./schema";
import { auth } from "./server";
import { extractApiKeyFromHeaders, resolveApiKeyContext } from "./api-keys";

/**
 * Who is asking, and for which organization — the one gate every request
 * that touches organization data goes through.
 *
 * - The session comes from Better Auth (usually its signed cookie cache, so
 *   no query).
 * - The active organization comes from the session.
 * - Membership and role are read from `members` on every call, so someone
 *   removed from an organization loses access at once rather than when the
 *   cookie cache expires.
 *
 * Route handlers pass their Request; server components and pages call it
 * without one and share a single lookup per render (React cache).
 *
 * Lib functions never call this: they take `organizationId` as an argument,
 * which is what lets background workers and webhooks — which have no
 * session — reuse them.
 */

export type OrgContext = {
  userId: string;
  userName: string;
  userEmail: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  roles: OrgRole[];
};

export type AuthContextErrorCode = "UNAUTHENTICATED" | "NO_ACTIVE_ORGANIZATION" | "NOT_A_MEMBER" | "FORBIDDEN";

export class AuthContextError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403 | 409,
    readonly code: AuthContextErrorCode,
  ) {
    super(message);
    this.name = "AuthContextError";
  }
}

export function isAuthContextError(error: unknown): error is AuthContextError {
  return error instanceof AuthContextError;
}

function parseRoles(value: string): OrgRole[] {
  return value
    .split(",")
    .map((role) => role.trim())
    .filter((role): role is OrgRole => role in roles);
}

async function resolve(headers: Headers): Promise<OrgContext> {
  const apiKey = extractApiKeyFromHeaders(headers);
  if (apiKey) {
    const apiKeyCtx = await resolveApiKeyContext(apiKey);
    if (!apiKeyCtx) {
      throw new AuthContextError("Invalid or revoked API key", 401, "UNAUTHENTICATED");
    }
    return apiKeyCtx;
  }

  const session = await auth.api.getSession({ headers });
  if (!session) throw new AuthContextError("Sign in to continue", 401, "UNAUTHENTICATED");

  const organizationId = session.session.activeOrganizationId;
  if (!organizationId) {
    throw new AuthContextError("Choose or create an organization first", 409, "NO_ACTIVE_ORGANIZATION");
  }

  const [membership] = await db
    .select({ role: members.role, name: organizations.name, slug: organizations.slug })
    .from(members)
    .innerJoin(organizations, eq(organizations.id, members.organizationId))
    .where(and(eq(members.organizationId, organizationId), eq(members.userId, session.user.id)))
    .limit(1);
  if (!membership) {
    throw new AuthContextError("You are no longer a member of this organization", 403, "NOT_A_MEMBER");
  }

  return {
    userId: session.user.id,
    userName: session.user.name,
    userEmail: session.user.email,
    organizationId,
    organizationName: membership.name,
    organizationSlug: membership.slug,
    roles: parseRoles(membership.role),
  };
}

const resolveForRender = cache(async () => resolve(await nextHeaders()));

/** Anything carrying the request's headers — a Request, a NextRequest. */
type HasHeaders = { headers: Headers };

/** The caller's organization context; throws AuthContextError (401/403/409). */
export async function requireOrgContext(request?: HasHeaders): Promise<OrgContext> {
  return request ? resolve(request.headers) : resolveForRender();
}

/** Like requireOrgContext, but null instead of throwing. */
export async function getOrgContext(request?: HasHeaders): Promise<OrgContext | null> {
  try {
    return await requireOrgContext(request);
  } catch (error) {
    if (isAuthContextError(error)) return null;
    throw error;
  }
}

/** For server pages and layouts: sends the visitor where they can fix it instead of throwing. */
export async function requirePageOrgContext(): Promise<OrgContext> {
  try {
    return await requireOrgContext();
  } catch (error) {
    if (!isAuthContextError(error)) throw error;
    // Imported here, not at the top: next/navigation needs React's client
    // context and fails to load under the test runner's react-server
    // condition, which every module importing this file would inherit.
    const { redirect } = await import("next/navigation");
    return redirect(error.code === "UNAUTHENTICATED" ? "/sign-in" : "/onboarding");
  }
}

type PermissionRequest = Parameters<(typeof roles)["owner"]["authorize"]>[0];

/** Whether any of the caller's roles grants every requested action. */
export function can(ctx: Pick<OrgContext, "roles">, permissions: PermissionRequest): boolean {
  return ctx.roles.some((role) => roles[role].authorize(permissions).success);
}

export function requirePermission(ctx: Pick<OrgContext, "roles">, permissions: PermissionRequest): void {
  if (!can(ctx, permissions)) {
    throw new AuthContextError("Your role in this organization doesn't allow this", 403, "FORBIDDEN");
  }
}

/** JSON response for an AuthContextError, or null for any other error. */
export function authContextErrorResponse(error: unknown): Response | null {
  if (!isAuthContextError(error)) return null;
  return Response.json({ error: error.message, code: error.code }, { status: error.status });
}

/**
 * Resolve the caller's organization and run `fn` inside its scope — the
 * usual first line of a route handler:
 *
 *   export async function GET(request: NextRequest) {
 *     return withOrgContext(request, async (ctx) => { … });
 *   }
 *
 * Auth failures throw AuthContextError; map them with
 * authContextErrorResponse (or let requireCrmMutationContext's callers'
 * CrmRequestError mapping handle them).
 */
export async function withOrgContext<T>(
  request: HasHeaders | undefined,
  fn: (ctx: OrgContext) => Promise<T>,
): Promise<T> {
  const ctx = await requireOrgContext(request);
  return runInOrganization(ctx.organizationId, () => fn(ctx));
}

/**
 * The platform operator: an owner or admin of the operator organization —
 * the one flagged `initial` by the migration from the single-workspace app,
 * or on a fresh install the first organization created — i.e. the team that
 * runs this AgentSDR instance. Platform-wide system data that
 * cannot be split by organization (the LinkedIn job runs and their logs,
 * which cover every organization's accounts) is visible to them alone.
 */
export async function isPlatformOperator(ctx: Pick<OrgContext, "organizationId" | "roles">): Promise<boolean> {
  if (!ctx.roles.some((role) => role === "owner" || role === "admin")) return false;
  return ctx.organizationId === (await operatorOrganizationId());
}

/** The organization flagged `initial`, else the oldest one. */
async function operatorOrganizationId(): Promise<string | null> {
  const [flagged] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(sql`${organizations.metadata}::jsonb ->> 'initial' = 'true'`)
    .limit(1);
  if (flagged) return flagged.id;
  const [oldest] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .orderBy(organizations.createdAt)
    .limit(1);
  return oldest?.id ?? null;
}

export async function requirePlatformOperator(ctx: Pick<OrgContext, "organizationId" | "roles">): Promise<void> {
  if (!(await isPlatformOperator(ctx))) {
    throw new AuthContextError("Only the team running this AgentSDR instance can see system job logs", 403, "FORBIDDEN");
  }
}
