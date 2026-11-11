import "server-only";

import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { gridProviderCredentials, gridProviders } from "@/lib/grid/schema";
import {
  decryptIntegrationCredentials,
  encryptIntegrationCredentials,
} from "@/lib/integrations/credentials";
import {
  PLATFORM_INTEGRATIONS,
  PLATFORM_SETTINGS_LABEL,
  getPlatformIntegration,
  type PlatformCredentials,
  type PlatformKey,
  type LangfusePromptUpload,
  type PlatformStatus,
  type UnipileWebhookRegistration,
} from "./catalog";
import { uploadMissingLangfusePrompts } from "@/lib/observability/langfusePrompts";
import { registerUnipileWebhooks, unipileWebhookEndpoints, unregisterUnipileWebhooks, type UnipileWebhookEndpoint } from "./unipileWebhooks";
import { verifyPlatformCredentials } from "./verify";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";

/**
 * Storage for platform integrations (see catalog.ts).
 *
 * Each platform is one row in grid_providers under the fixed key
 * `platform-<key>` — the same singleton pattern as the OpenRouter BYOK
 * settings — with its whole credential object encrypted in
 * grid_provider_credentials, exactly as enrichment and AI accounts are. The
 * row's config carries `platformKey`, so neither the integrations nor the AI
 * listings (which filter on their own markers) ever pick it up.
 *
 * Reads are cached in-process for CACHE_TTL_MS: the Unipile client and the
 * Gmail sender sit on hot paths, and a DB round trip plus an AES-GCM decrypt
 * per call is waste. Saving or disconnecting clears this process's cache;
 * another instance picks the change up within the TTL.
 *
 * Integrations are per organization: every function works on the
 * organization in scope, and the cache is keyed by (organization, platform)
 * so one organization can never be served another's credentials.
 */

const CACHE_TTL_MS = 30_000;
const PLATFORM_ROW_NAME = "Platform integration";

type Cached = { value: Record<string, string> | null; expires: number };
const cache = new Map<string, Cached>();

function cacheKey(key: PlatformKey): string {
  return `${currentOrganizationId()}:${key}`;
}

type PlatformConfig = {
  platformKey: PlatformKey;
  /** Non-secret field values, readable without a decrypt. */
  values: Record<string, string>;
  secretsSet: string[];
  verifiedAt: string;
  /** Unipile only: the last webhook registration (unipileWebhooks.ts). */
  webhooks?: UnipileWebhookRegistration;
  /** Langfuse only: the prompt upload on the last save (langfusePrompts.ts). */
  prompts?: LangfusePromptUpload;
};

export class PlatformNotConnectedError extends Error {
  constructor(readonly platform: PlatformKey) {
    const name = getPlatformIntegration(platform)?.name ?? platform;
    super(`${name} is not connected — connect it in ${PLATFORM_SETTINGS_LABEL[platform]}`);
    this.name = "PlatformNotConnectedError";
  }
}

export function isPlatformNotConnectedError(error: unknown): error is PlatformNotConnectedError {
  return error instanceof PlatformNotConnectedError;
}

function rowKey(key: PlatformKey): string {
  return `platform-${key}`;
}

async function load(key: PlatformKey): Promise<Record<string, string> | null> {
  const hit = cache.get(cacheKey(key));
  if (hit && hit.expires > Date.now()) return hit.value;

  const [row] = await db
    .select({ enabled: gridProviders.enabled, encryptedPayload: gridProviderCredentials.encryptedPayload })
    .from(gridProviders)
    .leftJoin(gridProviderCredentials, eq(gridProviderCredentials.providerId, gridProviders.id))
    .where(and(inOrg(gridProviders), eq(gridProviders.key, rowKey(key))))
    .limit(1);

  const value = row?.enabled && row.encryptedPayload ? decryptIntegrationCredentials(row.encryptedPayload) : null;
  cache.set(cacheKey(key), { value, expires: Date.now() + CACHE_TTL_MS });
  return value;
}

/** Decrypted credentials, or null when the platform is not connected. Server-only — never return these from an API route. */
export async function getPlatformCredentials<K extends PlatformKey>(
  key: K,
): Promise<PlatformCredentials[K] | null> {
  const value = await load(key);
  return value ? (normalize(key, value) as PlatformCredentials[K]) : null;
}

/** Like getPlatformCredentials, but throws PlatformNotConnectedError instead of returning null. */
export async function requirePlatformCredentials<K extends PlatformKey>(
  key: K,
): Promise<PlatformCredentials[K]> {
  const credentials = await getPlatformCredentials(key);
  if (!credentials) throw new PlatformNotConnectedError(key);
  return credentials;
}

export async function isPlatformConnected(key: PlatformKey): Promise<boolean> {
  if (key === "google") {
    const [googleCreds, smtpCreds] = await Promise.all([load("google"), load("smtp")]);
    if (googleCreds !== null || smtpCreds !== null) return true;
    const orgId = currentOrganizationId();
    const res = await db.execute<{ exists: boolean }>(
      sql`SELECT EXISTS(SELECT 1 FROM outreach_mailboxes WHERE organization_id = ${orgId}::uuid) AS exists`,
    );
    return Boolean(res[0]?.exists);
  }
  return (await load(key)) !== null;
}

export async function listPlatformStatus(): Promise<PlatformStatus[]> {
  const rows = await db
    .select({ key: gridProviders.key, enabled: gridProviders.enabled, config: gridProviders.config })
    .from(gridProviders)
    .where(and(inOrg(gridProviders), sql`${gridProviders.config} ? 'platformKey'`));
  return PLATFORM_INTEGRATIONS.map(({ key }) => {
    const row = rows.find((candidate) => candidate.key === rowKey(key));
    const config = row?.enabled ? (row.config as Partial<PlatformConfig>) : null;
    return {
      key,
      connected: Boolean(config),
      values: config?.values ?? {},
      secretsSet: config?.secretsSet ?? [],
      verifiedAt: config?.verifiedAt ?? null,
      webhooks: config?.webhooks ?? null,
      prompts: config?.prompts ?? null,
    };
  });
}

/**
 * Verifies, then saves. On an update, a secret field left blank keeps its
 * saved value, so the form never needs to hold a secret it was not given.
 */
export async function savePlatformIntegration(key: PlatformKey, input: Record<string, unknown>): Promise<PlatformStatus> {
  const integration = getPlatformIntegration(key);
  if (!integration) throw new Error("Unknown integration");

  const allowed = new Set(integration.fields.map((field) => field.key));
  if (Object.keys(input).some((field) => !allowed.has(field))) {
    throw new Error("One or more fields are invalid");
  }
  if (Object.values(input).some((value) => value !== undefined && typeof value !== "string")) {
    throw new Error("Field values must be text");
  }

  cache.delete(cacheKey(key));
  const existing = (await load(key)) ?? {};
  const merged: Record<string, string> = {};
  for (const field of integration.fields) {
    const given = String(input[field.key] ?? "").trim();
    merged[field.key] = given || (field.secret ? (existing[field.key] ?? "") : (field.defaultValue ?? ""));
    if (merged[field.key].length > 16_384) throw new Error(`${field.label} is too long`);
  }
  const missing = integration.fields.find((field) => field.required && !merged[field.key]);
  if (missing) throw new Error(`${missing.label} is required`);
  // Unipile's webhook secret is ours to make: nobody should have to invent one.
  if (key === "unipile" && !merged.notifySecret) merged.notifySecret = randomBytes(32).toString("base64url");

  const credentials = normalize(key, merged);
  await verifyPlatformCredentials(key, credentials);

  const stored = credentials as unknown as Record<string, string>;
  const config: PlatformConfig = {
    platformKey: key,
    values: Object.fromEntries(
      integration.fields.filter((field) => !field.secret).map((field) => [field.key, stored[field.key] ?? ""]),
    ),
    secretsSet: integration.fields.filter((field) => field.secret && stored[field.key]).map((field) => field.key),
    verifiedAt: new Date().toISOString(),
  };
  const encryptedPayload = encryptIntegrationCredentials(stored);

  await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(gridProviders)
      .values({ organizationId: currentOrganizationId(), key: rowKey(key), name: PLATFORM_ROW_NAME, config, enabled: true })
      .onConflictDoUpdate({
        target: [gridProviders.organizationId, gridProviders.key],
        set: { config, enabled: true, updatedAt: new Date() },
      })
      .returning({ id: gridProviders.id });
    await tx
      .insert(gridProviderCredentials)
      .values({ providerId: row.id, encryptedPayload })
      .onConflictDoUpdate({
        target: gridProviderCredentials.providerId,
        set: { encryptedPayload, updatedAt: new Date() },
      });
  });

  cache.delete(cacheKey(key));
  const webhooks =
    key === "unipile"
      ? await storeWebhookRegistration(
          await registerUnipileWebhooks(currentOrganizationId(), credentials as PlatformCredentials["unipile"]),
        )
      : null;
  // Like Unipile's webhooks: the project gets AgentSDR's prompts on save. A
  // failure is shown on the card, never fails the save.
  let prompts: LangfusePromptUpload | null = null;
  if (key === "langfuse") {
    prompts = await uploadMissingLangfusePrompts(credentials as PlatformCredentials["langfuse"]);
    await storeConfigOutcome("langfuse", { prompts });
  }
  return {
    key,
    connected: true,
    values: config.values,
    secretsSet: config.secretsSet,
    verifiedAt: config.verifiedAt,
    webhooks,
    prompts,
  };
}

/** Record the outcome of a step run after saving (webhooks, prompts) on the integration's row, for Settings to show. */
async function storeConfigOutcome(key: PlatformKey, outcome: Pick<PlatformConfig, "webhooks" | "prompts">): Promise<void> {
  const [row] = await db
    .select({ id: gridProviders.id, config: gridProviders.config })
    .from(gridProviders)
    .where(and(inOrg(gridProviders), eq(gridProviders.key, rowKey(key))))
    .limit(1);
  if (row) {
    await db
      .update(gridProviders)
      .set({ config: { ...row.config, ...outcome }, updatedAt: new Date() })
      .where(and(inOrg(gridProviders), eq(gridProviders.id, row.id)));
  }
}

/** Record a Unipile webhook registration on the integration's row, for Settings to show. */
async function storeWebhookRegistration(registration: UnipileWebhookRegistration): Promise<UnipileWebhookRegistration> {
  await storeConfigOutcome("unipile", { webhooks: registration });
  return registration;
}

/** Register Unipile's webhooks again (Settings → LinkedIn → Connection → Register again). */
export async function reregisterUnipileWebhooks(): Promise<UnipileWebhookRegistration> {
  const credentials = await requirePlatformCredentials("unipile");
  return storeWebhookRegistration(await registerUnipileWebhooks(currentOrganizationId(), credentials));
}

/**
 * The webhook URLs and the secret, for an admin who chose to reveal them —
 * to register them by hand when automatic registration cannot run. The
 * only place a stored secret leaves the server; the route gates it on the
 * integrations permission.
 */
export async function revealUnipileWebhookSetup(): Promise<{ endpoints: UnipileWebhookEndpoint[] | null; secret: string }> {
  const credentials = await requirePlatformCredentials("unipile");
  return { endpoints: unipileWebhookEndpoints(currentOrganizationId()), secret: credentials.notifySecret };
}

/** Deletes the row and its credentials (cascade). Features depending on it stop at once in this process. */
export async function disconnectPlatformIntegration(key: PlatformKey): Promise<void> {
  if (key === "unipile") {
    const credentials = await getPlatformCredentials("unipile");
    if (credentials) await unregisterUnipileWebhooks(currentOrganizationId(), credentials);
  }
  await db.delete(gridProviders).where(and(inOrg(gridProviders), eq(gridProviders.key, rowKey(key))));
  cache.delete(cacheKey(key));
}

/**
 * Organizations that have `key` connected — for webhooks and workers that
 * must find which organization owns an inbound event (e.g. whose Unipile
 * notify secret matches). Runs outside any scope; callers then resolve the
 * credentials per organization inside runInOrganization(orgId, …).
 */
export async function listOrganizationsWithPlatform(key: PlatformKey): Promise<string[]> {
  const rows = await db
    .select({ organizationId: gridProviders.organizationId })
    .from(gridProviders)
    .where(and(eq(gridProviders.key, rowKey(key)), eq(gridProviders.enabled, true)));
  return rows.map((row) => row.organizationId);
}

function normalize<K extends PlatformKey>(key: K, raw: Record<string, string>): PlatformCredentials[K] {
  const text = (name: string) => (raw[name] ?? "").trim();
  if (key === "unipile") {
    // The dashboard shows the DSN without a scheme; accept it as shown.
    const dsn = text("baseUrl").replace(/\/+$/, "");
    const baseUrl = dsn && !/^[a-z]+:\/\//i.test(dsn) ? `https://${dsn}` : dsn;
    if (baseUrl && !/^https:\/\/[^\s/]+$/.test(baseUrl)) {
      throw new Error("Unipile DSN must look like api8.unipile.com:13851");
    }
    const value: PlatformCredentials["unipile"] = {
      baseUrl,
      apiKey: text("apiKey"),
      notifySecret: text("notifySecret"),
    };
    return value as PlatformCredentials[K];
  }
  if (key === "google") {
    const value: PlatformCredentials["google"] = {
      clientEmail: text("clientEmail"),
      privateKey: text("privateKey"),
      gmailWatchTopic: text("gmailWatchTopic"),
    };
    return value as PlatformCredentials[K];
  }
  if (key === "smtp") {
    const value: PlatformCredentials["smtp"] = {
      smtpHost: text("smtpHost") || "smtp.qiye.aliyun.com",
      smtpPort: text("smtpPort") || "465",
      imapHost: text("imapHost") || "imap.qiye.aliyun.com",
      imapPort: text("imapPort") || "993",
      defaultEmail: text("defaultEmail").toLowerCase(),
      defaultPassword: text("defaultPassword"),
    };
    return value as PlatformCredentials[K];
  }
  if (key === "gologin") {
    const value: PlatformCredentials["gologin"] = { apiToken: text("apiToken") };
    return value as PlatformCredentials[K];
  }
  if (key === "calcom") {
    const value: PlatformCredentials["calcom"] = { webhookSecret: text("webhookSecret"), apiKey: text("apiKey") };
    return value as PlatformCredentials[K];
  }
  if (key === "langfuse") {
    const host = text("baseUrl").replace(/\/+$/, "");
    const baseUrl = host && !/^[a-z]+:\/\//i.test(host) ? `https://${host}` : host;
    // A self-hosted Langfuse may sit under a path; it must still be https.
    if (baseUrl && !/^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(baseUrl)) {
      throw new Error("Langfuse host must be an https:// address, like https://cloud.langfuse.com");
    }
    const value: PlatformCredentials["langfuse"] = { baseUrl, publicKey: text("publicKey"), secretKey: text("secretKey") };
    return value as PlatformCredentials[K];
  }
  const value: PlatformCredentials["r2"] = {
    accountId: text("accountId"),
    accessKeyId: text("accessKeyId"),
    secretAccessKey: text("secretAccessKey"),
    bucket: text("bucket"),
  };
  return value as PlatformCredentials[K];
}
