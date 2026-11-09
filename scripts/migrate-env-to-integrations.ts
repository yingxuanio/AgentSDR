/**
 * Copies a pre-Integrations env setup into Settings → Integrations, once.
 *
 *   bun run --conditions=react-server scripts/migrate-env-to-integrations.ts          # report only
 *   bun run --conditions=react-server scripts/migrate-env-to-integrations.ts --apply  # save
 *
 * The app stopped reading UNIPILE_*, GOOGLE_SERVICE_ACCOUNT_*,
 * OUTREACH_GMAIL_WATCH_TOPIC, R2_* and CALL_TRANSCRIPTION_*
 * when those moved into the database. A deployment that still has them only
 * in its env has every one of those features switched off until they are
 * entered in the UI; this enters them instead.
 *
 * Each platform goes through savePlatformIntegration, the same path as the
 * settings form, so it is verified against the live service before it is
 * stored, and stored encrypted with INTEGRATION_CREDENTIALS_KEY — which must
 * be the value the deployed app uses, or it cannot decrypt what is written
 * here. A platform already connected is left alone unless --overwrite.
 *
 * Bun loads .env.local automatically. --conditions=react-server is needed
 * because the store imports "server-only". No value is ever printed.
 *
 * Runs in ORGANIZATION_ID, or the initial organization when it is unset.
 */
import { runScriptInOrganization } from "./lib/organization";
import { getByokSettings, saveByokSettings } from "@/lib/ai/byok";
import { getPlatformIntegration, type PlatformKey } from "@/lib/platform/catalog";
import { isPlatformConnected, savePlatformIntegration } from "@/lib/platform/credentials";

const apply = process.argv.includes("--apply");
const overwrite = process.argv.includes("--overwrite");

/** Platform field → the env var that used to hold it (GoLogin, Cal.com and SMTP never lived in env). */
const FROM_ENV: Record<Exclude<PlatformKey, "gologin" | "calcom" | "smtp">, Record<string, string>> = {
  unipile: {
    baseUrl: "UNIPILE_BASE_URL",
    apiKey: "UNIPILE_API_KEY",
    notifySecret: "UNIPILE_NOTIFY_SECRET",
  },
  google: {
    clientEmail: "GOOGLE_SERVICE_ACCOUNT_CLIENT_EMAIL",
    privateKey: "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY",
    gmailWatchTopic: "OUTREACH_GMAIL_WATCH_TOPIC",
  },
  r2: {
    accountId: "R2_ACCOUNT_ID",
    accessKeyId: "R2_ACCESS_KEY_ID",
    secretAccessKey: "R2_SECRET_ACCESS_KEY",
    bucket: "R2_BUCKET",
  },
};

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

async function migratePlatform(key: keyof typeof FROM_ENV): Promise<boolean> {
  const integration = getPlatformIntegration(key)!;
  const label = integration.name.padEnd(18);
  const values = Object.fromEntries(Object.entries(FROM_ENV[key]).map(([field, name]) => [field, env(name)]));
  const missing = integration.fields.filter((field) => field.required && !values[field.key]);

  if (missing.length) {
    const names = missing.map((field) => FROM_ENV[key][field.key]).join(", ");
    console.log(`${label} skipped — not in env: ${names}`);
    return true;
  }
  if (!overwrite && (await isPlatformConnected(key))) {
    console.log(`${label} already connected — left alone (--overwrite to replace)`);
    return true;
  }
  const optionalEmpty = integration.fields.filter((field) => !field.required && !values[field.key]).map((field) => field.label);
  const note = optionalEmpty.length ? ` (empty: ${optionalEmpty.join(", ")})` : "";
  if (!apply) {
    console.log(`${label} would be saved from env${note}`);
    return true;
  }
  try {
    await savePlatformIntegration(key, values);
    console.log(`${label} saved and verified${note}`);
    return true;
  } catch (error) {
    console.log(`${label} FAILED — ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

async function migrateTranscriptionModel(): Promise<boolean> {
  const label = "Transcription".padEnd(18);
  const provider = env("CALL_TRANSCRIPTION_PROVIDER");
  const modelId = env("CALL_TRANSCRIPTION_MODEL");
  if (!provider || !modelId) {
    console.log(`${label} skipped — CALL_TRANSCRIPTION_PROVIDER / _MODEL not in env`);
    return true;
  }
  const current = await getByokSettings();
  if (!overwrite && current.transcriptionModel) {
    console.log(`${label} already chosen in AI settings — left alone (--overwrite to replace)`);
    return true;
  }
  // Normalization drops a model that is not enabled in AI settings, so
  // check before saving rather than silently storing null.
  if (!current.modelsByProvider[provider]?.includes(modelId)) {
    console.log(`${label} FAILED — ${provider} / ${modelId} is not enabled in Settings → AI provider; enable it there first`);
    return false;
  }
  if (!apply) {
    console.log(`${label} would be set to ${provider} / ${modelId}`);
    return true;
  }
  await saveByokSettings({ ...current, transcriptionModel: { provider, modelId } });
  console.log(`${label} set to ${provider} / ${modelId}`);
  return true;
}

async function main() {
  if (!process.env.INTEGRATION_CREDENTIALS_KEY) {
    throw new Error("INTEGRATION_CREDENTIALS_KEY is not set — nothing can be encrypted");
  }
  console.log(apply ? "Migrating env → Integrations\n" : "Dry run (pass --apply to save)\n");
  const results = [];
  for (const key of Object.keys(FROM_ENV) as (keyof typeof FROM_ENV)[]) results.push(await migratePlatform(key));
  results.push(await migrateTranscriptionModel());
  return results.every(Boolean);
}

runScriptInOrganization(main)
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
