import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { gridProviders } from "@/lib/grid/schema";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { members, organizations, users } from "./schema";
import { roles, type OrgRole } from "./permissions";

export type ApiKeySummary = {
  id: string;
  name: string;
  keyPrefix: string;
  createdByEmail: string | null;
  createdAt: string;
  lastUsedAt: string | null;
};

type ApiKeyConfig = {
  apiKeyRecord: true;
  keyPrefix: string;
  keyHash: string;
  createdByUserId: string;
  createdByEmail: string | null;
  createdAt: string;
  lastUsedAt: string | null;
};

export function hashApiKey(rawKey: string): string {
  return createHash("sha256")
    .update("agentsdr:api-key:v1:")
    .update(rawKey.trim())
    .digest("hex");
}

export function maskApiKeyPrefix(rawKey: string): string {
  const trimmed = rawKey.trim();
  if (trimmed.length <= 16) return `${trimmed.slice(0, 8)}…`;
  return `${trimmed.slice(0, 14)}…${trimmed.slice(-4)}`;
}

/**
 * Extracts an AgentSDR API key from `x-api-key` or `Authorization: Bearer ...`.
 * Returns null when the request does not carry an API key header.
 */
export function extractApiKeyFromHeaders(headers: Headers): string | null {
  const xApiKey = headers.get("x-api-key")?.trim();
  if (xApiKey) return xApiKey;

  const authHeader = headers.get("authorization")?.trim();
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1].trim();
  return token || null;
}

function parseRoles(value: string | null | undefined): OrgRole[] {
  if (!value) return ["owner"];
  const parsed = value
    .split(",")
    .map((role) => role.trim())
    .filter((role): role is OrgRole => role in roles);
  return parsed.length > 0 ? parsed : ["owner"];
}

export type ResolvedApiKeyContext = {
  userId: string;
  userName: string;
  userEmail: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  roles: OrgRole[];
};

const lastUsedTouchCache = new Map<string, number>();

export async function resolveApiKeyContext(rawKey: string): Promise<ResolvedApiKeyContext | null> {
  const hashed = hashApiKey(rawKey);
  const [row] = await db
    .select({
      id: gridProviders.id,
      organizationId: gridProviders.organizationId,
      name: gridProviders.name,
      config: gridProviders.config,
      enabled: gridProviders.enabled,
    })
    .from(gridProviders)
    .where(
      and(
        eq(gridProviders.enabled, true),
        sql`${gridProviders.config} ->> 'apiKeyRecord' = 'true'`,
        sql`${gridProviders.config} ->> 'keyHash' = ${hashed}`,
      ),
    )
    .limit(1);

  if (!row) return null;

  const config = (row.config ?? {}) as Partial<ApiKeyConfig>;
  const [org] = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
    })
    .from(organizations)
    .where(eq(organizations.id, row.organizationId))
    .limit(1);

  if (!org) return null;

  let userId = config.createdByUserId || "";
  let userName = row.name || "API Key";
  let userEmail = config.createdByEmail || "api@linktion.cn";
  let memberRoles: OrgRole[] = ["owner"];

  if (userId) {
    const [memberRow] = await db
      .select({
        userId: users.id,
        userName: users.name,
        userEmail: users.email,
        role: members.role,
      })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .where(and(eq(members.organizationId, org.id), eq(members.userId, userId)))
      .limit(1);

    if (memberRow) {
      userId = memberRow.userId;
      userName = `${memberRow.userName} (API Key: ${row.name})`;
      userEmail = memberRow.userEmail;
      memberRoles = parseRoles(memberRow.role);
    }
  }

  if (!userId) {
    const [fallbackMember] = await db
      .select({
        userId: users.id,
        userName: users.name,
        userEmail: users.email,
        role: members.role,
      })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .where(eq(members.organizationId, org.id))
      .limit(1);

    if (fallbackMember) {
      userId = fallbackMember.userId;
      userName = `${fallbackMember.userName} (API Key: ${row.name})`;
      userEmail = fallbackMember.userEmail;
      memberRoles = parseRoles(fallbackMember.role);
    }
  }

  // Throttle lastUsedAt updates to once per 60 seconds per key
  const nowMs = Date.now();
  const prevTouch = lastUsedTouchCache.get(row.id) ?? 0;
  if (nowMs - prevTouch > 60_000) {
    lastUsedTouchCache.set(row.id, nowMs);
    const nowIso = new Date(nowMs).toISOString();
    void db
      .update(gridProviders)
      .set({
        config: sql`jsonb_set(${gridProviders.config}, '{lastUsedAt}', to_jsonb(${nowIso}::text), true)`,
        updatedAt: new Date(nowMs),
      })
      .where(eq(gridProviders.id, row.id))
      .catch(() => undefined);
  }

  return {
    userId,
    userName,
    userEmail,
    organizationId: org.id,
    organizationName: org.name,
    organizationSlug: org.slug,
    roles: memberRoles,
  };
}

export async function listApiKeys(): Promise<ApiKeySummary[]> {
  const rows = await db
    .select()
    .from(gridProviders)
    .where(
      and(
        inOrg(gridProviders),
        eq(gridProviders.enabled, true),
        sql`${gridProviders.config} ->> 'apiKeyRecord' = 'true'`,
      ),
    )
    .orderBy(desc(gridProviders.createdAt));

  return rows.map((row) => {
    const cfg = (row.config ?? {}) as Partial<ApiKeyConfig>;
    return {
      id: row.id,
      name: row.name,
      keyPrefix: String(cfg.keyPrefix ?? "asdr_…"),
      createdByEmail: cfg.createdByEmail ?? null,
      createdAt: cfg.createdAt ?? row.createdAt?.toISOString() ?? new Date().toISOString(),
      lastUsedAt: cfg.lastUsedAt ?? null,
    };
  });
}

export async function createApiKey(input: {
  name: string;
  createdByUserId: string;
  createdByEmail: string;
  customRawKey?: string;
}): Promise<{ apiKey: ApiKeySummary; secretKey: string }> {
  const name = input.name.trim();
  if (!name) throw new Error("API key name is required");
  if (name.length > 120) throw new Error("API key name is too long");

  const secretKey = input.customRawKey?.trim() || `asdr_live_${randomBytes(24).toString("hex")}`;
  const keyPrefix = maskApiKeyPrefix(secretKey);
  const keyHash = hashApiKey(secretKey);
  const nowIso = new Date().toISOString();
  const id = randomUUID();

  const config: ApiKeyConfig = {
    apiKeyRecord: true,
    keyPrefix,
    keyHash,
    createdByUserId: input.createdByUserId,
    createdByEmail: input.createdByEmail,
    createdAt: nowIso,
    lastUsedAt: null,
  };

  const [row] = await db
    .insert(gridProviders)
    .values({
      id,
      organizationId: currentOrganizationId(),
      key: `api-key-${id}`,
      name,
      config,
      enabled: true,
    })
    .returning();

  return {
    apiKey: {
      id: row.id,
      name: row.name,
      keyPrefix,
      createdByEmail: input.createdByEmail,
      createdAt: nowIso,
      lastUsedAt: null,
    },
    secretKey,
  };
}

export async function revokeApiKey(id: string): Promise<boolean> {
  const deleted = await db
    .delete(gridProviders)
    .where(
      and(
        inOrg(gridProviders),
        eq(gridProviders.id, id),
        sql`${gridProviders.config} ->> 'apiKeyRecord' = 'true'`,
      ),
    )
    .returning({ id: gridProviders.id });
  return deleted.length > 0;
}
