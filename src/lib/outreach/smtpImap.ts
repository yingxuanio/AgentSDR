import { randomUUID } from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import nodemailer from "nodemailer";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { gridProviderCredentials, gridProviders } from "@/lib/grid/schema";
import {
  decryptIntegrationCredentials,
  encryptIntegrationCredentials,
} from "@/lib/integrations/credentials";
import { getPlatformCredentials } from "@/lib/platform/credentials";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import type { EmailAddress } from "@/lib/email/recipients";
import { parseAddressHeader } from "./addressHeader";
import type { InboundMessage, SendEmailParams, SendEmailResult } from "./gmail";

export const DEFAULT_ALIYUN_SMTP_HOST = "smtp.qiye.aliyun.com";
export const DEFAULT_ALIYUN_SMTP_PORT = 465;
export const DEFAULT_ALIYUN_IMAP_HOST = "imap.qiye.aliyun.com";
export const DEFAULT_ALIYUN_IMAP_PORT = 993;

export interface ResolvedSmtpImapConfig {
  emailAddress: string;
  password: string;
  smtpHost: string;
  smtpPort: number;
  imapHost: string;
  imapPort: number;
}

export interface StoredMailboxSmtpInput {
  emailAddress: string;
  password?: string;
  smtpHost?: string;
  smtpPort?: string | number;
  imapHost?: string;
  imapPort?: string | number;
}

function mailboxRowKey(emailAddress: string): string {
  return `mailbox-smtp:${emailAddress.trim().toLowerCase()}`;
}

function parsePort(value: string | number | undefined, fallback: number): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 && n <= 65535 ? n : fallback;
}

/**
 * Save per-mailbox SMTP/IMAP credentials encrypted in grid_providers /
 * grid_provider_credentials. Leaving password empty when updating keeps any
 * previously saved password for that mailbox.
 */
export async function saveMailboxSmtpCredentials(input: StoredMailboxSmtpInput): Promise<void> {
  const email = input.emailAddress.trim().toLowerCase();
  if (!email) return;

  const existing = await getMailboxSmtpCredentials(email);
  const password = (input.password ?? "").trim() || existing?.password || "";
  const smtpHost = (input.smtpHost ?? "").trim() || existing?.smtpHost || "";
  const smtpPort = input.smtpPort !== undefined && String(input.smtpPort).trim() !== ""
    ? String(parsePort(input.smtpPort, DEFAULT_ALIYUN_SMTP_PORT))
    : existing?.smtpPort ?? "";
  const imapHost = (input.imapHost ?? "").trim() || existing?.imapHost || "";
  const imapPort = input.imapPort !== undefined && String(input.imapPort).trim() !== ""
    ? String(parsePort(input.imapPort, DEFAULT_ALIYUN_IMAP_PORT))
    : existing?.imapPort ?? "";

  if (!password && !smtpHost && !imapHost) return;

  const stored: Record<string, string> = {
    emailAddress: email,
    password,
    smtpHost,
    smtpPort,
    imapHost,
    imapPort,
  };
  const config = {
    mailboxSmtp: true,
    emailAddress: email,
    smtpHost,
    smtpPort,
    imapHost,
    imapPort,
    hasPassword: Boolean(password),
  };
  const encryptedPayload = encryptIntegrationCredentials(stored);

  await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(gridProviders)
      .values({
        organizationId: currentOrganizationId(),
        key: mailboxRowKey(email),
        name: `Mailbox SMTP (${email})`,
        config,
        enabled: true,
      })
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
}

export async function getMailboxSmtpCredentials(
  emailAddress: string,
): Promise<Record<string, string> | null> {
  const email = emailAddress.trim().toLowerCase();
  const [row] = await db
    .select({
      enabled: gridProviders.enabled,
      encryptedPayload: gridProviderCredentials.encryptedPayload,
    })
    .from(gridProviders)
    .leftJoin(gridProviderCredentials, eq(gridProviderCredentials.providerId, gridProviders.id))
    .where(and(inOrg(gridProviders), eq(gridProviders.key, mailboxRowKey(email))))
    .limit(1);

  if (!row?.enabled || !row.encryptedPayload) return null;
  try {
    return decryptIntegrationCredentials(row.encryptedPayload);
  } catch {
    return null;
  }
}

export async function deleteMailboxSmtpCredentials(emailAddress: string): Promise<void> {
  const email = emailAddress.trim().toLowerCase();
  await db
    .delete(gridProviders)
    .where(and(inOrg(gridProviders), eq(gridProviders.key, mailboxRowKey(email))));
}

/**
 * Resolves the active SMTP/IMAP configuration for a mailbox by combining
 * per-mailbox credentials with the organization's `smtp` platform integration.
 * Returns null if neither per-mailbox SMTP credentials nor the `smtp` platform
 * integration is configured for this mailbox.
 */
export async function resolveMailboxSmtpConfig(
  emailAddress: string,
  override?: StoredMailboxSmtpInput,
): Promise<ResolvedSmtpImapConfig | null> {
  const email = emailAddress.trim().toLowerCase();
  const [mailboxCreds, platformSmtp] = await Promise.all([
    getMailboxSmtpCredentials(email),
    getPlatformCredentials("smtp"),
  ]);

  const overridePass = (override?.password ?? "").trim();
  const mailboxPass = (mailboxCreds?.password ?? "").trim();
  const platformDefaultEmail = (platformSmtp?.defaultEmail ?? "").trim().toLowerCase();
  const platformPass =
    platformSmtp?.defaultPassword &&
    (!platformDefaultEmail || platformDefaultEmail === email)
      ? platformSmtp.defaultPassword.trim()
      : "";

  const password = overridePass || mailboxPass || platformPass;
  if (!password && !platformSmtp && !mailboxCreds) {
    return null;
  }

  const smtpHost =
    (override?.smtpHost ?? "").trim() ||
    (mailboxCreds?.smtpHost ?? "").trim() ||
    (platformSmtp?.smtpHost ?? "").trim() ||
    DEFAULT_ALIYUN_SMTP_HOST;
  const smtpPort = parsePort(
    override?.smtpPort ?? mailboxCreds?.smtpPort ?? platformSmtp?.smtpPort,
    DEFAULT_ALIYUN_SMTP_PORT,
  );
  const imapHost =
    (override?.imapHost ?? "").trim() ||
    (mailboxCreds?.imapHost ?? "").trim() ||
    (platformSmtp?.imapHost ?? "").trim() ||
    DEFAULT_ALIYUN_IMAP_HOST;
  const imapPort = parsePort(
    override?.imapPort ?? mailboxCreds?.imapPort ?? platformSmtp?.imapPort,
    DEFAULT_ALIYUN_IMAP_PORT,
  );

  if (!password) {
    return null;
  }

  return {
    emailAddress: email,
    password,
    smtpHost,
    smtpPort,
    imapHost,
    imapPort,
  };
}

/**
 * Checks whether the organization is configured to use SMTP/IMAP (either via
 * the `smtp` platform integration or per-mailbox credentials for this email).
 */
export async function shouldUseSmtpImap(emailAddress: string): Promise<boolean> {
  const resolved = await resolveMailboxSmtpConfig(emailAddress);
  if (resolved) return true;
  const [smtpPlatform, googlePlatform] = await Promise.all([
    getPlatformCredentials("smtp"),
    getPlatformCredentials("google"),
  ]);
  return Boolean(smtpPlatform && !googlePlatform);
}

// ---------------------------------------------------------------------------
// Low-level TCP/TLS probe & SMTP verification
// ---------------------------------------------------------------------------

async function probeServerBanner(host: string, port: number, label: string): Promise<void> {
  const useTls = port === 465 || port === 993;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out connecting to ${label} (${host}:${port})`));
    }, 12_000);

    const onBanner = (chunk: Buffer) => {
      const line = chunk.toString("utf8").trim();
      if (line.length > 0) {
        clearTimeout(timer);
        socket.destroy();
        resolve();
      }
    };

    const socket = useTls
      ? tls.connect({ host, port, servername: host }, () => {
          // Wait for server greeting banner
        })
      : net.connect({ host, port });

    socket.once("data", onBanner);
    socket.once("error", (err: Error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error(`Could not connect to ${label} (${host}:${port}): ${err.message}`));
    });
  });
}

export async function verifySmtpConnection(config: ResolvedSmtpImapConfig): Promise<void> {
  const transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    auth: {
      user: config.emailAddress,
      pass: config.password,
    },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  });

  try {
    await transporter.verify();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`SMTP login failed (${config.smtpHost}:${config.smtpPort}): ${msg}`);
  } finally {
    transporter.close();
  }
}

export async function verifySmtpImapPlatform(input: {
  smtpHost: string;
  smtpPort: string;
  imapHost: string;
  imapPort: string;
  defaultEmail?: string;
  defaultPassword?: string;
}): Promise<void> {
  const smtpHost = input.smtpHost.trim() || DEFAULT_ALIYUN_SMTP_HOST;
  const smtpPort = parsePort(input.smtpPort, DEFAULT_ALIYUN_SMTP_PORT);
  const imapHost = input.imapHost.trim() || DEFAULT_ALIYUN_IMAP_HOST;
  const imapPort = parsePort(input.imapPort, DEFAULT_ALIYUN_IMAP_PORT);
  const defaultEmail = (input.defaultEmail ?? "").trim().toLowerCase();
  const defaultPassword = (input.defaultPassword ?? "").trim();

  if (defaultEmail && defaultPassword) {
    const config: ResolvedSmtpImapConfig = {
      emailAddress: defaultEmail,
      password: defaultPassword,
      smtpHost,
      smtpPort,
      imapHost,
      imapPort,
    };
    await verifySmtpConnection(config);
    const imapRes = await testImapConnection(config);
    if (!imapRes.ok) {
      throw new Error(imapRes.error);
    }
    return;
  }

  await Promise.all([
    probeServerBanner(smtpHost, smtpPort, "SMTP server"),
    probeServerBanner(imapHost, imapPort, "IMAP server"),
  ]);
}

export async function testSmtpImapMailbox(
  config: ResolvedSmtpImapConfig,
): Promise<{ ok: true; profileEmail: string; historyId: string } | { ok: false; error: string }> {
  try {
    await verifySmtpConnection(config);
    return await testImapConnection(config);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// SMTP Sending
// ---------------------------------------------------------------------------

function stripHtmlSimple(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function sendSmtpEmail(
  config: ResolvedSmtpImapConfig,
  params: SendEmailParams,
): Promise<SendEmailResult> {
  const transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    auth: {
      user: config.emailAddress,
      pass: config.password,
    },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });

  const domain = config.emailAddress.split("@")[1] || "agentsdr.local";
  const generatedMessageId = `<${randomUUID()}@${domain}>`;
  const headers: Record<string, string> = {};
  if (params.inReplyTo) headers["In-Reply-To"] = params.inReplyTo;
  if (params.references && params.references.length > 0) {
    headers["References"] = params.references.join(" ");
  }
  if (params.unsubscribeUrl) {
    headers["List-Unsubscribe"] = `<${params.unsubscribeUrl}>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }

  try {
    const info = await transporter.sendMail({
      from: params.fromName
        ? `"${params.fromName.replace(/["\\]/g, "\\$&")}" <${params.from}>`
        : params.from,
      to: params.to,
      cc: params.cc,
      bcc: params.bcc,
      subject: params.subject,
      text: params.text || (params.html ? stripHtmlSimple(params.html) : ""),
      html: params.html ?? params.text,
      messageId: generatedMessageId,
      headers,
    });

    const finalMessageId = info.messageId || generatedMessageId;
    const threadId = params.threadId || params.inReplyTo || finalMessageId;
    return {
      id: finalMessageId,
      messageId: finalMessageId,
      threadId,
    };
  } finally {
    transporter.close();
  }
}

// ---------------------------------------------------------------------------
// Minimal, dependency-free IMAP over TLS Client (UID search/fetch + IDLE)
// ---------------------------------------------------------------------------

function escapeImapQuoted(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

class SimpleImapSession {
  private socket: tls.TLSSocket | net.Socket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private seq = 0;
  private dataListeners: Array<() => void> = [];
  private closedError: Error | null = null;

  constructor(private readonly config: ResolvedSmtpImapConfig) {}

  async connect(): Promise<void> {
    const { imapHost, imapPort } = this.config;
    const useTls = imapPort === 993;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.close();
        reject(new Error(`IMAP connection timed out (${imapHost}:${imapPort})`));
      }, 15_000);

      const onError = (err: Error) => {
        clearTimeout(timeout);
        this.closedError = err;
        this.notifyListeners();
        reject(new Error(`IMAP connection error (${imapHost}:${imapPort}): ${err.message}`));
      };

      const sock = useTls
        ? tls.connect({ host: imapHost, port: imapPort, servername: imapHost })
        : net.connect({ host: imapHost, port: imapPort });

      this.socket = sock;

      sock.on("data", (chunk: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.notifyListeners();
      });

      sock.once("error", onError);
      sock.on("close", () => {
        if (!this.closedError) {
          this.closedError = new Error("IMAP socket closed");
        }
        this.notifyListeners();
      });

      this.waitForGreeting()
        .then(() => {
          clearTimeout(timeout);
          sock.removeListener("error", onError);
          sock.on("error", (err: Error) => {
            this.closedError = err;
            this.notifyListeners();
          });
          resolve();
        })
        .catch((err) => {
          clearTimeout(timeout);
          reject(err);
        });
    });
  }

  private notifyListeners(): void {
    const listeners = this.dataListeners.splice(0, this.dataListeners.length);
    for (const fn of listeners) fn();
  }

  private waitForData(timeoutMs = 20_000): Promise<void> {
    if (this.closedError) return Promise.reject(this.closedError);
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("IMAP operation timed out"));
      }, timeoutMs);
      this.dataListeners.push(() => {
        clearTimeout(timer);
        if (this.closedError) reject(this.closedError);
        else resolve();
      });
    });
  }

  private async waitForGreeting(): Promise<void> {
    while (true) {
      const idx = this.buffer.indexOf("\r\n");
      if (idx !== -1) {
        const line = this.buffer.subarray(0, idx).toString("utf8");
        this.buffer = this.buffer.subarray(idx + 2);
        if (line.startsWith("* OK")) return;
        if (line.startsWith("* BYE") || line.startsWith("* NO")) {
          throw new Error(`IMAP server rejected connection: ${line}`);
        }
      }
      await this.waitForData(15_000);
    }
  }

  async command(cmd: string, timeoutMs = 25_000): Promise<{ raw: Buffer; text: string; statusLine: string }> {
    if (!this.socket || this.closedError) {
      throw this.closedError ?? new Error("IMAP socket is not connected");
    }
    this.seq += 1;
    const tag = `A${this.seq}`;
    this.socket.write(`${tag} ${cmd}\r\n`);

    const chunks: Buffer[] = [];
    while (true) {
      // Check if we have a complete tagged status line at the end of any line in buffer
      const result = this.extractUntilTag(tag);
      if (result) {
        chunks.push(result.consumed);
        const raw = Buffer.concat(chunks);
        const text = raw.toString("latin1");
        if (/^(NO|BAD)\b/i.test(result.statusRest)) {
          throw new Error(`IMAP ${cmd.split(" ")[0]} failed: ${result.statusRest}`);
        }
        return { raw, text, statusLine: result.statusLine };
      }
      await this.waitForData(timeoutMs);
    }
  }

  /**
   * Scans `this.buffer` line by line, respecting IMAP literal blocks `{N}\r\n`
   * so a literal body that happens to contain `A1 OK` is never mistaken for the
   * command's completion tag.
   */
  private extractUntilTag(tag: string): { consumed: Buffer; statusLine: string; statusRest: string } | null {
    let offset = 0;
    const tagPrefix = `${tag} `;
    while (offset < this.buffer.length) {
      const eol = this.buffer.indexOf("\r\n", offset);
      if (eol === -1) return null;

      const line = this.buffer.subarray(offset, eol).toString("latin1");
      const nextOffset = eol + 2;

      if (line.startsWith(tagPrefix)) {
        const consumed = this.buffer.subarray(0, nextOffset);
        this.buffer = this.buffer.subarray(nextOffset);
        return {
          consumed,
          statusLine: line,
          statusRest: line.slice(tagPrefix.length).trim(),
        };
      }

      // Check for IMAP literal marker at end of line: `{12345}`
      const literalMatch = line.match(/\{(\d+)\}\s*$/);
      if (literalMatch) {
        const literalBytes = Number.parseInt(literalMatch[1], 10);
        if (nextOffset + literalBytes > this.buffer.length) {
          // Wait until the entire literal has arrived
          return null;
        }
        offset = nextOffset + literalBytes;
      } else {
        offset = nextOffset;
      }
    }
    return null;
  }

  async loginAndSelectInbox(): Promise<{ uidNext: number | null; exists: number }> {
    try {
      await this.command(
        `LOGIN "${escapeImapQuoted(this.config.emailAddress)}" "${escapeImapQuoted(this.config.password)}"`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `IMAP login rejected for ${this.config.emailAddress} on ${this.config.imapHost}:${this.config.imapPort} (${msg})`,
      );
    }

    // Best-effort RFC 2971 ID command (supported by Aliyun / NetEase enterprise mail)
    try {
      await this.command('ID ("name" "AgentSDR" "version" "1.0")', 5_000);
    } catch {
      // Ignore if server does not implement ID extension
    }

    const selectRes = await this.command("SELECT INBOX");
    const uidNextMatch = selectRes.text.match(/\[UIDNEXT\s+(\d+)\]/i);
    const existsMatch = selectRes.text.match(/\*\s+(\d+)\s+EXISTS/i);
    return {
      uidNext: uidNextMatch ? Number.parseInt(uidNextMatch[1], 10) : null,
      exists: existsMatch ? Number.parseInt(existsMatch[1], 10) : 0,
    };
  }

  async searchAllUids(): Promise<number[]> {
    const res = await this.command("UID SEARCH ALL");
    return parseSearchUids(res.text);
  }

  async searchUidsSince(minUid: number): Promise<number[]> {
    const res = await this.command(`UID SEARCH UID ${Math.max(1, minUid)}:*`);
    return parseSearchUids(res.text).filter((uid) => uid >= minUid);
  }

  async fetchRawMessageByUid(uid: number): Promise<{ rawMessage: Buffer; internalDate: Date } | null> {
    const res = await this.command(`UID FETCH ${uid} (UID INTERNALDATE BODY.PEEK[])`, 30_000);
    return extractFetchedLiteral(res.raw);
  }

  async logout(): Promise<void> {
    try {
      if (this.socket && !this.closedError) {
        await this.command("LOGOUT", 3_000);
      }
    } catch {
      // Ignore logout errors
    } finally {
      this.close();
    }
  }

  close(): void {
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch {
        // Ignore
      }
      this.socket = null;
    }
  }
}

function parseSearchUids(text: string): number[] {
  const uids: number[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^\*\s+SEARCH\b/i.test(trimmed)) {
      const rest = trimmed.replace(/^\*\s+SEARCH\s*/i, "");
      if (!rest) continue;
      for (const token of rest.split(/\s+/)) {
        const n = Number.parseInt(token, 10);
        if (Number.isFinite(n) && n > 0) uids.push(n);
      }
    }
  }
  return Array.from(new Set(uids)).sort((a, b) => a - b);
}

function extractFetchedLiteral(raw: Buffer): { rawMessage: Buffer; internalDate: Date } | null {
  const latin1 = raw.toString("latin1");
  const dateMatch = latin1.match(/INTERNALDATE\s+"([^"]+)"/i);
  const internalDate = dateMatch ? new Date(dateMatch[1]) : new Date();
  const safeDate = Number.isNaN(internalDate.getTime()) ? new Date() : internalDate;

  // Match `BODY[] {N}\r\n` or `BODY.PEEK[] {N}\r\n` or `RFC822 {N}\r\n`
  const headerRe = /BODY(?:\.PEEK)?\[\]\s+\{(\d+)\}\r\n/i;
  const match = headerRe.exec(latin1);
  if (!match || match.index === undefined) return null;

  const byteLength = Number.parseInt(match[1], 10);
  const startOffset = match.index + match[0].length;
  if (startOffset + byteLength > raw.length) {
    return {
      rawMessage: raw.subarray(startOffset),
      internalDate: safeDate,
    };
  }
  return {
    rawMessage: raw.subarray(startOffset, startOffset + byteLength),
    internalDate: safeDate,
  };
}

export async function testImapConnection(
  config: ResolvedSmtpImapConfig,
): Promise<{ ok: true; profileEmail: string; historyId: string } | { ok: false; error: string }> {
  const session = new SimpleImapSession(config);
  try {
    await session.connect();
    const { uidNext, exists } = await session.loginAndSelectInbox();
    let latestUid = 0;
    if (uidNext && uidNext > 1) {
      latestUid = uidNext - 1;
    } else if (exists > 0) {
      const uids = await session.searchAllUids();
      latestUid = uids.length > 0 ? uids[uids.length - 1] : 0;
    }
    await session.logout();
    return {
      ok: true,
      profileEmail: config.emailAddress,
      historyId: String(latestUid),
    };
  } catch (err) {
    session.close();
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function fetchNewImapInboundMessages(
  config: ResolvedSmtpImapConfig,
  startHistoryId: string,
): Promise<{ messages: InboundMessage[]; newHistoryId: string }> {
  const session = new SimpleImapSession(config);
  try {
    await session.connect();
    await session.loginAndSelectInbox();

    const parsedStart = Number.parseInt(startHistoryId, 10);
    let lastUid = Number.isFinite(parsedStart) && parsedStart >= 0 ? parsedStart : 0;

    let candidateUids: number[];
    if (lastUid === 0) {
      const allUids = await session.searchAllUids();
      // On first sync with historyId "0", only inspect the last 15 messages
      candidateUids = allUids.slice(-15);
    } else {
      candidateUids = (await session.searchUidsSince(lastUid + 1)).filter((uid) => uid > lastUid);
    }

    if (candidateUids.length === 0) {
      await session.logout();
      return { messages: [], newHistoryId: String(lastUid) };
    }

    const batchUids = candidateUids.slice(0, 50);
    const messages: InboundMessage[] = [];
    let maxSeenUid = lastUid;

    for (const uid of batchUids) {
      if (uid > maxSeenUid) maxSeenUid = uid;
      const fetched = await session.fetchRawMessageByUid(uid);
      if (!fetched) continue;

      const parsed = parseRawEmailMessage(fetched.rawMessage, {
        uid,
        mailboxEmail: config.emailAddress,
        internalDate: fetched.internalDate,
      });
      if (parsed) {
        messages.push(parsed);
      }
    }

    await session.logout();
    return {
      messages,
      newHistoryId: String(maxSeenUid),
    };
  } finally {
    session.close();
  }
}

export async function fetchImapMessageRecipients(
  config: ResolvedSmtpImapConfig,
  providerMessageId: string,
): Promise<{ to: EmailAddress[]; cc: EmailAddress[]; replyTo: EmailAddress[] } | null> {
  const uidMatch = providerMessageId.match(/^imap-(\d+)$/i);
  if (!uidMatch) return null;
  const uid = Number.parseInt(uidMatch[1], 10);
  if (!Number.isFinite(uid) || uid <= 0) return null;

  const session = new SimpleImapSession(config);
  try {
    await session.connect();
    await session.loginAndSelectInbox();
    const fetched = await session.fetchRawMessageByUid(uid);
    await session.logout();
    if (!fetched) return null;
    const headers = parseHeadersBlock(fetched.rawMessage.toString("latin1").split(/\r?\n\r?\n/)[0] ?? "");
    return {
      to: parseAddressHeader(decodeMimeWords(headers.get("to") ?? "")),
      cc: parseAddressHeader(decodeMimeWords(headers.get("cc") ?? "")),
      replyTo: parseAddressHeader(decodeMimeWords(headers.get("reply-to") ?? "")),
    };
  } catch {
    session.close();
    return null;
  }
}

// ---------------------------------------------------------------------------
// RFC 5322 / MIME Email Parser (Exported for Unit Testing)
// ---------------------------------------------------------------------------

export function decodeMimeWords(input: string): string {
  if (!input) return "";
  // Collapse whitespace between adjacent encoded-words per RFC 2047
  const normalized = input.replace(/\?=\s+=\?/g, "?==?");
  return normalized.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_full, charsetRaw: string, encoding: string, text: string) => {
    try {
      const enc = encoding.toUpperCase();
      let bytes: Buffer;
      if (enc === "B") {
        bytes = Buffer.from(text, "base64");
      } else {
        const qp = text.replace(/_/g, " ");
        bytes = decodeQuotedPrintableToBuffer(qp);
      }
      return decodeBufferWithCharset(bytes, charsetRaw);
    } catch {
      return text;
    }
  });
}

function decodeBufferWithCharset(bytes: Buffer, charsetRaw?: string): string {
  const charset = (charsetRaw ?? "utf-8").trim().toLowerCase().replace(/^["']|["']$/g, "");
  const normalizedCharset =
    charset === "gb2312" || charset === "gbk" || charset === "cp936"
      ? "gb18030"
      : charset === "utf8" || charset === "us-ascii" || charset === "ascii" || !charset
        ? "utf-8"
        : charset;
  try {
    return new TextDecoder(normalizedCharset, { fatal: false }).decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
}

export function decodeQuotedPrintableToBuffer(input: string): Buffer {
  // Remove soft line breaks `=\r\n` or `=\n`
  const stripped = input.replace(/=\r?\n/g, "");
  const out: number[] = [];
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch === "=" && i + 2 < stripped.length) {
      const hex = stripped.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out.push(Number.parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    out.push(stripped.charCodeAt(i) & 0xff);
  }
  return Buffer.from(out);
}

function parseHeadersBlock(rawHeaderBlock: string): Map<string, string> {
  // Unfold multi-line headers (lines starting with space or tab)
  const unfolded = rawHeaderBlock.replace(/\r?\n[ \t]+/g, " ");
  const headers = new Map<string, string>();
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const val = line.slice(colon + 1).trim();
    const existing = headers.get(name);
    headers.set(name, existing ? `${existing}, ${val}` : val);
  }
  return headers;
}

function extractSingleAddress(raw: string): { email: string; name: string | null } {
  const parsed = parseAddressHeader(decodeMimeWords(raw));
  if (parsed.length > 0) {
    return { email: parsed[0].email, name: parsed[0].name };
  }
  const decoded = decodeMimeWords(raw).trim();
  const angle = decoded.match(/^(?:"?([^"<]*)"?\s*)?<([^>]+)>/);
  if (angle) {
    const name = angle[1]?.trim().replace(/^["']|["']$/g, "") || null;
    return { email: angle[2].trim().toLowerCase(), name };
  }
  const emailMatch = decoded.match(/[^\s<>,;]+@[^\s<>,;]+/);
  return { email: (emailMatch ? emailMatch[0] : decoded).toLowerCase(), name: null };
}

function extractMimeText(rawEntity: Buffer, defaultCharset = "utf-8"): { plain: string; html: string } {
  const rawStr = rawEntity.toString("latin1");
  const sepMatch = /\r?\n\r?\n/.exec(rawStr);
  const headerPart = sepMatch ? rawStr.slice(0, sepMatch.index) : "";
  const bodyStartByte = sepMatch ? sepMatch.index + sepMatch[0].length : 0;
  const bodyBuffer = rawEntity.subarray(bodyStartByte);

  const headers = parseHeadersBlock(headerPart);
  const contentType = headers.get("content-type") ?? "text/plain";
  const transferEncoding = (headers.get("content-transfer-encoding") ?? "").toLowerCase().trim();
  const contentDisposition = (headers.get("content-disposition") ?? "").toLowerCase();

  // Skip explicit file attachments
  if (contentDisposition.startsWith("attachment")) {
    return { plain: "", html: "" };
  }

  const charsetMatch = contentType.match(/charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i);
  const charset = charsetMatch?.[1] || charsetMatch?.[2] || charsetMatch?.[3] || defaultCharset;

  const boundaryMatch = contentType.match(/boundary\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i);
  const boundary = boundaryMatch?.[1] || boundaryMatch?.[2] || boundaryMatch?.[3];

  if (/^multipart\//i.test(contentType) && boundary) {
    const delim = `--${boundary}`;
    const bodyLatin1 = bodyBuffer.toString("latin1");
    const parts = bodyLatin1.split(delim);
    let plain = "";
    let html = "";
    // First item is preamble, last item starting with `--` is epilogue
    for (let i = 1; i < parts.length; i++) {
      const partStr = parts[i];
      if (partStr.startsWith("--")) break;
      const trimmedPart = partStr.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
      const sub = extractMimeText(Buffer.from(trimmedPart, "latin1"), charset);
      if (sub.plain && !plain) plain = sub.plain;
      else if (sub.plain && plain) plain = `${plain}\n${sub.plain}`;
      if (sub.html && !html) html = sub.html;
    }
    return { plain, html };
  }

  let decodedBytes: Buffer;
  if (transferEncoding === "base64") {
    const cleaned = bodyBuffer.toString("ascii").replace(/[^A-Za-z0-9+/=]/g, "");
    decodedBytes = Buffer.from(cleaned, "base64");
  } else if (transferEncoding === "quoted-printable") {
    decodedBytes = decodeQuotedPrintableToBuffer(bodyBuffer.toString("latin1"));
  } else {
    decodedBytes = bodyBuffer;
  }

  const text = decodeBufferWithCharset(decodedBytes, charset).trim();
  if (/^text\/html\b/i.test(contentType)) {
    return { plain: "", html: text };
  }
  if (/^text\/plain\b/i.test(contentType) || !contentType.includes("/")) {
    return { plain: text, html: "" };
  }
  return { plain: "", html: "" };
}

export function parseRawEmailMessage(
  rawMessage: Buffer,
  context: { uid: number; mailboxEmail: string; internalDate?: Date },
): InboundMessage | null {
  const rawLatin1 = rawMessage.toString("latin1");
  const headerEnd = /\r?\n\r?\n/.exec(rawLatin1);
  const headerBlock = headerEnd ? rawLatin1.slice(0, headerEnd.index) : rawLatin1;
  const headers = parseHeadersBlock(headerBlock);

  const fromRaw = decodeMimeWords(headers.get("from") ?? "");
  const toRaw = decodeMimeWords(headers.get("to") ?? "");
  const ccRaw = decodeMimeWords(headers.get("cc") ?? "");
  const replyToRaw = decodeMimeWords(headers.get("reply-to") ?? "");
  const subject = decodeMimeWords(headers.get("subject") ?? "");
  const messageId = (headers.get("message-id") ?? "").trim() || `<imap-uid-${context.uid}@${context.mailboxEmail}>`;
  const inReplyTo = (headers.get("in-reply-to") ?? "").trim() || null;
  const references = (headers.get("references") ?? "").trim();
  const dateHeader = headers.get("date");

  const { email: fromEmail, name: fromName } = extractSingleAddress(fromRaw);
  const mailboxLower = context.mailboxEmail.trim().toLowerCase();
  if (!fromEmail || fromEmail === mailboxLower) {
    return null;
  }

  // Note: Do NOT drop Auto-Submitted / X-Autoreply messages here. Standard
  // RFC 3464 bounce DSNs, "no longer with company" notices, and OOO replies
  // carry Auto-Submitted: auto-replied and must reach replyBridge + CRM AI
  // classification (AgentSDR never blindly auto-responds without review, so
  // there is no auto-responder loop risk).

  const { plain, html } = extractMimeText(rawMessage);
  const bodyText = (plain || (html ? stripHtmlSimple(html) : "")).trim();

  const firstReference = references ? references.split(/\s+/)[0]?.trim() : null;
  const threadId = firstReference || inReplyTo || messageId;

  const parsedDate = dateHeader ? new Date(dateHeader) : context.internalDate ?? new Date();
  const internalDate = Number.isNaN(parsedDate.getTime()) ? (context.internalDate ?? new Date()) : parsedDate;

  const toAddresses = parseAddressHeader(toRaw);
  const ccAddresses = parseAddressHeader(ccRaw);
  const replyToAddresses = parseAddressHeader(replyToRaw);

  return {
    gmailMessageId: `imap-${context.uid}`,
    threadId,
    fromEmail,
    fromName,
    toEmail: toAddresses[0]?.email ?? mailboxLower,
    to: toAddresses,
    cc: ccAddresses,
    replyTo: replyToAddresses,
    ccEmails: ccAddresses.map((a) => a.email),
    subject,
    bodyText,
    messageId,
    inReplyTo,
    internalDate,
  };
}

// ---------------------------------------------------------------------------
// Real-Time IMAP IDLE Watcher Manager
// ---------------------------------------------------------------------------

interface IdleWatcherEntry {
  key: string;
  organizationId: string;
  mailboxId: string;
  config: ResolvedSmtpImapConfig;
  socket: tls.TLSSocket | net.Socket | null;
  stopped: boolean;
  rearmTimer: ReturnType<typeof setTimeout> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

const idleWatchers = new Map<string, IdleWatcherEntry>();

const IDLE_REFRESH_MS = 12 * 60 * 1000; // Re-issue IDLE every 12 minutes

export function ensureImapIdleWatcher(params: {
  organizationId: string;
  mailboxId: string;
  config: ResolvedSmtpImapConfig;
  onNewMail: (organizationId: string, mailboxId: string) => Promise<void>;
}): void {
  const key = `${params.organizationId}:${params.mailboxId}`;
  const existing = idleWatchers.get(key);
  if (
    existing &&
    !existing.stopped &&
    existing.config.emailAddress === params.config.emailAddress &&
    existing.config.password === params.config.password &&
    existing.config.imapHost === params.config.imapHost &&
    existing.config.imapPort === params.config.imapPort
  ) {
    return;
  }

  if (existing) {
    stopImapIdleWatcher(params.organizationId, params.mailboxId);
  }

  const entry: IdleWatcherEntry = {
    key,
    organizationId: params.organizationId,
    mailboxId: params.mailboxId,
    config: params.config,
    socket: null,
    stopped: false,
    rearmTimer: null,
    reconnectTimer: null,
    debounceTimer: null,
  };
  idleWatchers.set(key, entry);
  void startIdleLoop(entry, params.onNewMail);
}

export function stopImapIdleWatcher(organizationId: string, mailboxId: string): void {
  const key = `${organizationId}:${mailboxId}`;
  const existing = idleWatchers.get(key);
  if (!existing) return;
  existing.stopped = true;
  if (existing.rearmTimer) clearTimeout(existing.rearmTimer);
  if (existing.reconnectTimer) clearTimeout(existing.reconnectTimer);
  if (existing.debounceTimer) clearTimeout(existing.debounceTimer);
  if (existing.socket) {
    try {
      existing.socket.destroy();
    } catch {
      // Ignore
    }
    existing.socket = null;
  }
  idleWatchers.delete(key);
}

async function startIdleLoop(
  entry: IdleWatcherEntry,
  onNewMail: (organizationId: string, mailboxId: string) => Promise<void>,
): Promise<void> {
  if (entry.stopped) return;

  const { imapHost, imapPort, emailAddress, password } = entry.config;
  const useTls = imapPort === 993;

  const scheduleReconnect = (delayMs = 15_000) => {
    if (entry.stopped) return;
    if (entry.rearmTimer) clearTimeout(entry.rearmTimer);
    if (entry.socket) {
      try {
        entry.socket.destroy();
      } catch {
        // Ignore
      }
      entry.socket = null;
    }
    entry.reconnectTimer = setTimeout(() => {
      void startIdleLoop(entry, onNewMail);
    }, delayMs);
  };

  try {
    const sock = useTls
      ? tls.connect({ host: imapHost, port: imapPort, servername: imapHost })
      : net.connect({ host: imapHost, port: imapPort });

    sock.setKeepAlive(true, 30_000);
    entry.socket = sock;

    let stage: "greeting" | "login" | "select" | "idle" = "greeting";
    let lineBuf = "";

    const sendLine = (line: string) => {
      if (!entry.stopped && entry.socket === sock && !sock.destroyed) {
        sock.write(`${line}\r\n`);
      }
    };

    const armIdleRefresh = () => {
      if (entry.rearmTimer) clearTimeout(entry.rearmTimer);
      entry.rearmTimer = setTimeout(() => {
        if (stage === "idle") {
          sendLine("DONE");
        }
      }, IDLE_REFRESH_MS);
    };

    sock.on("data", (chunk: Buffer) => {
      if (entry.stopped) return;
      lineBuf += chunk.toString("latin1");
      let idx: number;
      while ((idx = lineBuf.indexOf("\r\n")) !== -1) {
        const line = lineBuf.slice(0, idx).trim();
        lineBuf = lineBuf.slice(idx + 2);

        if (stage === "greeting" && line.startsWith("* OK")) {
          stage = "login";
          sendLine(`I1 LOGIN "${escapeImapQuoted(emailAddress)}" "${escapeImapQuoted(password)}"`);
        } else if (stage === "login" && line.startsWith("I1 ")) {
          if (line.startsWith("I1 OK")) {
            stage = "select";
            sendLine("I2 SELECT INBOX");
          } else {
            scheduleReconnect(60_000);
          }
        } else if (stage === "select" && line.startsWith("I2 ")) {
          if (line.startsWith("I2 OK")) {
            stage = "idle";
            sendLine("I3 IDLE");
            armIdleRefresh();
          } else {
            scheduleReconnect(30_000);
          }
        } else if (stage === "idle") {
          if (/^\*\s+\d+\s+(EXISTS|RECENT)\b/i.test(line)) {
            if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
            entry.debounceTimer = setTimeout(() => {
              void onNewMail(entry.organizationId, entry.mailboxId).catch((err) => {
                console.error(`[imap-idle] sync failed for mailbox ${entry.mailboxId}:`, err);
              });
            }, 800);
          } else if (line.startsWith("I3 ")) {
            // IDLE command completed after DONE; immediately re-enter IDLE
            sendLine("I3 IDLE");
            armIdleRefresh();
          }
        }
      }
    });

    sock.on("error", () => {
      scheduleReconnect(15_000);
    });
    sock.on("close", () => {
      scheduleReconnect(15_000);
    });
  } catch {
    scheduleReconnect(15_000);
  }
}
