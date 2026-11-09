import "server-only";

import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  decryptIntegrationCredentials,
  encryptIntegrationCredentials,
} from "@/lib/integrations/credentials";
import { gridProviderCredentials, gridProviders, type GridProvider } from "@/lib/grid/schema";
import { getAiProvider } from "./catalog";
import { verifyAiCredentials } from "./server/verify";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";

/**
 * AI provider accounts.
 *
 * These live in grid_providers alongside integration connections — same two
 * tables, same envelope encryption, same operational story for key rotation.
 * They are told apart by which marker the config carries: integrations set
 * `integrationKey`, AI providers set `aiProviderKey`. That keeps the AI
 * catalog out of the integrations catalog (an AI model is not an action with
 * declared inputs) without duplicating credential storage, which is the part
 * that is genuinely security-sensitive and worth having exactly once.
 */
export type AiConnection = {
  id: string;
  providerKey: string;
  name: string;
  baseUrl?: string;
  enabled: boolean;
  verified: boolean;
};

type AiProviderConfig = Record<string, unknown> & {
  aiProviderKey?: string;
  baseUrl?: string;
  verification?: { status?: "verified"; verifiedAt?: string };
};

function toConnection(provider: GridProvider): AiConnection {
  const config = provider.config as AiProviderConfig;
  return {
    id: provider.id,
    providerKey: String(config.aiProviderKey ?? ""),
    name: provider.name,
    ...(typeof config.baseUrl === "string" && config.baseUrl.trim() ? { baseUrl: config.baseUrl.trim() } : {}),
    enabled: provider.enabled,
    verified: provider.enabled && config.verification?.status === "verified",
  };
}

/** Accounts for one provider, or every AI account when `providerKey` is omitted. */
export async function listAiConnections(providerKey?: string): Promise<AiConnection[]> {
  const rows = await db
    .select()
    .from(gridProviders)
    .where(
      and(
        inOrg(gridProviders),
        providerKey
          ? sql`${gridProviders.config} ->> 'aiProviderKey' = ${providerKey}`
          : sql`${gridProviders.config} ? 'aiProviderKey'`,
      ),
    )
    .orderBy(desc(gridProviders.createdAt));
  return rows.map(toConnection);
}

export async function getAiConnection(id: string): Promise<AiConnection | null> {
  const [row] = await db
    .select()
    .from(gridProviders)
    .where(and(inOrg(gridProviders), eq(gridProviders.id, id)))
    .limit(1);
  if (!row) return null;
  const connection = toConnection(row);
  return connection.providerKey ? connection : null;
}

export async function createAiConnection(input: {
  providerKey: string;
  name: string;
  credentials: Record<string, string>;
}): Promise<AiConnection> {
  const provider = getAiProvider(input.providerKey);
  if (!provider) throw new Error("Unknown AI provider");

  const allowed = new Set(provider.auth.fields.map((field) => field.key));
  if (Object.keys(input.credentials).some((key) => !allowed.has(key))) {
    throw new Error("One or more credential fields are invalid");
  }
  const credentials = Object.fromEntries(
    provider.auth.fields.map((field) => [field.key, String(input.credentials[field.key] ?? "").trim()]),
  );
  const missing = provider.auth.fields.find((field) => field.required && !credentials[field.key]);
  if (missing) throw new Error(`${missing.label} is required`);
  if (Object.values(credentials).some((value) => value.length > 4096)) {
    throw new Error("A credential value is too long");
  }

  const name = input.name.trim();
  if (name.length > 120) throw new Error("Account name is too long");

  // Verified before it is stored, so a typo'd key fails here rather than on
  // the first row of a 10,000-row run.
  await verifyAiCredentials(input.providerKey, credentials);

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(gridProviders)
      .values({
        organizationId: currentOrganizationId(),
        key: `ai-${input.providerKey}-${randomUUID()}`,
        name: name || `${provider.name} account`,
        config: {
          aiProviderKey: input.providerKey,
          ...(credentials.baseUrl ? { baseUrl: credentials.baseUrl } : {}),
          verification: { status: "verified", verifiedAt: new Date().toISOString() },
        },
        enabled: true,
      })
      .returning();
    await tx.insert(gridProviderCredentials).values({
      providerId: row.id,
      encryptedPayload: encryptIntegrationCredentials(credentials),
    });
    return toConnection(row);
  });
}

export async function deleteAiConnection(id: string): Promise<boolean> {
  const deleted = await db
    .delete(gridProviders)
    .where(and(inOrg(gridProviders), eq(gridProviders.id, id), sql`${gridProviders.config} ? 'aiProviderKey'`))
    .returning({ id: gridProviders.id });
  return deleted.length > 0;
}

/** Decrypted only inside the runner, immediately before a provider call. */
export async function getAiCredentials(id: string): Promise<Record<string, string> | null> {
  const [row] = await db
    .select({
      provider: gridProviders,
      encryptedPayload: gridProviderCredentials.encryptedPayload,
    })
    .from(gridProviders)
    .leftJoin(gridProviderCredentials, eq(gridProviderCredentials.providerId, gridProviders.id))
    .where(and(inOrg(gridProviders), eq(gridProviders.id, id)))
    .limit(1);

  if (!row?.provider.enabled || !row.encryptedPayload) return null;
  const config = row.provider.config as AiProviderConfig;
  if (config.verification?.status !== "verified") return null;
  return decryptIntegrationCredentials(row.encryptedPayload);
}
