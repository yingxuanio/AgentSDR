import "server-only";

import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { google } from "googleapis";
import { verifySmtpImapPlatform } from "@/lib/outreach/smtpImap";
import type { PlatformCredentials, PlatformKey } from "./catalog";
import { googleServiceAccount, r2Client } from "./clients";

/**
 * One cheap authenticated call per platform, run before credentials are
 * saved, so a typo fails on the settings form rather than on the first send.
 * Throws an Error whose message is safe to show the user.
 */
export async function verifyPlatformCredentials<K extends PlatformKey>(
  key: K,
  credentials: PlatformCredentials[K],
): Promise<void> {
  if (key === "unipile") return verifyUnipile(credentials as PlatformCredentials["unipile"]);
  if (key === "google") return verifyGoogle(credentials as PlatformCredentials["google"]);
  if (key === "smtp") return verifySmtpImapPlatform(credentials as PlatformCredentials["smtp"]);
  if (key === "r2") return verifyR2(credentials as PlatformCredentials["r2"]);
  if (key === "gologin") return verifyGoLogin(credentials as PlatformCredentials["gologin"]);
  if (key === "calcom") return verifyCalcom(credentials as PlatformCredentials["calcom"]);
  throw new Error("Unknown integration");
}

async function verifyUnipile({ baseUrl, apiKey }: PlatformCredentials["unipile"]): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/v1/accounts?limit=1`, {
      headers: { "X-API-KEY": apiKey, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("Could not reach Unipile at that API URL");
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error("Unipile rejected the access token");
  }
  if (!response.ok) throw new Error(`Unipile answered ${response.status}`);
}

async function verifyGoLogin({ apiToken }: PlatformCredentials["gologin"]): Promise<void> {
  let response: Response;
  try {
    response = await fetch("https://api.gologin.com/browser/v2?page=1", {
      headers: { Authorization: `Bearer ${apiToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("Could not reach GoLogin");
  }
  if (!response.ok) throw new Error(`GoLogin didn't accept this token (HTTP ${response.status})`);
}

/**
 * The webhook secret cannot be checked against Cal.com (it is ours as much as
 * theirs): it only has to be there. An API key, when given, gets one call.
 */
async function verifyCalcom({ webhookSecret, apiKey }: PlatformCredentials["calcom"]): Promise<void> {
  if (webhookSecret.length < 8) throw new Error("Use a webhook secret of at least 8 characters");
  if (!apiKey) return;
  let response: Response;
  try {
    response = await fetch("https://api.cal.com/v2/me", {
      headers: { Authorization: `Bearer ${apiKey}`, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("Could not reach Cal.com");
  }
  if (response.status === 401 || response.status === 403) throw new Error("Cal.com didn't accept this API key");
  if (!response.ok) throw new Error(`Cal.com answered ${response.status}`);
}

async function verifyGoogle(credentials: PlatformCredentials["google"]): Promise<void> {
  const key = googleServiceAccount(credentials);
  // A token for the service account itself proves the key is genuine and
  // live. It cannot prove domain-wide delegation — that is per mailbox, and
  // is what "Test connection" on an email account checks.
  const auth = new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  try {
    await auth.authorize();
  } catch {
    throw new Error("Google rejected this service account key");
  }
  const topic = credentials.gmailWatchTopic;
  if (topic && !/^projects\/[^/]+\/topics\/[^/]+$/.test(topic)) {
    throw new Error("Gmail Pub/Sub topic must look like projects/<project>/topics/<topic>");
  }
}

async function verifyR2(credentials: PlatformCredentials["r2"]): Promise<void> {
  const client: S3Client = r2Client(credentials);
  try {
    await client.send(new HeadBucketCommand({ Bucket: credentials.bucket }));
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404) throw new Error(`Bucket "${credentials.bucket}" does not exist`);
    if (status === 401 || status === 403) throw new Error("R2 rejected these credentials for that bucket");
    throw new Error("Could not reach R2 with this account ID");
  } finally {
    client.destroy();
  }
}

