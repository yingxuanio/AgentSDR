/**
 * Platform integrations: the services AgentSDR itself runs on — Unipile for
 * LinkedIn and WhatsApp, Google Workspace for Gmail, Cloudflare R2 for call
 * recordings. Each is connected once per organization from the Connection
 * page of the channel it powers (PLATFORM_SETTINGS_HREF), and a feature works
 * only while its integration is connected. None of them is read from env.
 *
 * Not to be confused with `src/lib/integrations`, the enrichment providers a
 * grid column calls per row (any number of accounts each). OpenRouter is not
 * here either: it has its own connection flow under `src/lib/ai`
 * (Settings → AI provider).
 *
 * Client-safe — the settings UI imports this. Credentials are resolved in
 * `credentials.ts`.
 */

import { docsPageUrl } from "@/lib/support";

export type PlatformKey = "unipile" | "google" | "smtp" | "r2" | "gologin" | "calcom";

/** The decrypted credential object stored for each platform. */
export type PlatformCredentials = {
  unipile: {
    /** The DSN from the Unipile dashboard, e.g. https://api8.unipile.com:13851 — no trailing slash. */
    baseUrl: string;
    apiKey: string;
    /**
     * Sent by Unipile as the `x-unipile-secret` header (or `?secret=`) on
     * every webhook. Generated on first save when left empty.
     */
    notifySecret: string;
  };
  google: {
    /** The service account's email, …@….iam.gserviceaccount.com. */
    clientEmail: string;
    /** PEM, -----BEGIN PRIVATE KEY----- … -----END PRIVATE KEY-----. */
    privateKey: string;
    /** Pub/Sub topic Gmail publishes new-mail notifications to. Empty means replies are not picked up. */
    gmailWatchTopic: string;
  };
  smtp: {
    /** Outgoing SMTP server host, e.g. smtp.qiye.aliyun.com */
    smtpHost: string;
    /** Outgoing SMTP port, e.g. 465 (SSL/TLS) or 587 (STARTTLS) */
    smtpPort: string;
    /** Incoming IMAP server host, e.g. imap.qiye.aliyun.com */
    imapHost: string;
    /** Incoming IMAP port, e.g. 993 (SSL/TLS) */
    imapPort: string;
    /** Optional default mailbox email used for verification and fallback sending/sync */
    defaultEmail: string;
    /** Optional password / app-specific password for defaultEmail */
    defaultPassword: string;
  };
  r2: {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
  };
  gologin: {
    /** A GoLogin API token (Settings → API). */
    apiToken: string;
  };
  calcom: {
    /**
     * The secret set on the Cal.com webhook (Settings → Developer → Webhooks):
     * Cal.com signs every delivery with it (x-cal-signature-256).
     */
    webhookSecret: string;
    /** Optional Cal.com API key (cal_live_…); empty when not given. */
    apiKey: string;
  };
};

export type PlatformField = {
  key: string;
  label: string;
  placeholder?: string;
  defaultValue?: string;
  /** Where to find the value — written for someone who has never opened the provider's console. */
  help?: string;
  inputType: "text" | "password" | "textarea";
  required: boolean;
  /**
   * Secret values are never sent back to the browser; leaving one blank when
   * editing keeps the saved value. Non-secret values are shown and prefilled.
   */
  secret: boolean;
};

/** A step, optionally with a value the user must paste elsewhere verbatim — shown with a Copy button. */
export type SetupStep = string | { text: string; copy: string };

export type PlatformIntegration = {
  key: PlatformKey;
  name: string;
  description: string;
  /** What stops working without it — shown on the card and in Connect prompts. */
  enables: string[];
  websiteUrl: string;
  /** The provider's own mark, under public/Integrations - Icon/. */
  iconUrl: string;
  /** Numbered "How to connect" steps at the top of the connect dialog. */
  setupSteps: SetupStep[];
  /** Our own written walkthrough (docs.agentsdr.ai), shown as "How to connect" wherever it is connected. */
  guideUrl?: string;
  /** Our own video walkthrough, once there is one. */
  videoUrl?: string;
  /** The provider's reference docs. */
  docsUrl?: string;
  fields: PlatformField[];
  /**
   * A credentials file the provider hands out, read in the browser to fill
   * the fields so nobody has to open it. Returns field values; throws an
   * Error with a user-facing message if the file is not the expected kind.
   */
  keyFile?: {
    label: string;
    accept: string;
    read: (text: string) => Record<string, string>;
  };
};

const GMAIL_SCOPES = "https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/gmail.readonly";

export const PLATFORM_INTEGRATIONS: readonly PlatformIntegration[] = [
  {
    key: "unipile",
    name: "Unipile",
    description: "Connects LinkedIn and WhatsApp accounts for sending, inbox sync and calling.",
    enables: ["LinkedIn accounts and campaigns", "WhatsApp messaging and calling"],
    websiteUrl: "https://www.unipile.com",
    iconUrl: "/Integrations - Icon/unipile.png",
    guideUrl: docsPageUrl("integrations/unipile"),
    docsUrl: "https://developer.unipile.com/docs/getting-started",
    setupSteps: [
      "Sign in to the Unipile dashboard at dashboard.unipile.com.",
      "Copy your DSN — the API address shown at the top of the dashboard.",
      "Under Access tokens, generate a token and copy it. It is shown only once.",
      "Save. AgentSDR registers the webhooks it needs in your Unipile workspace itself, with a secret it generates.",
    ],
    fields: [
      {
        key: "baseUrl",
        label: "DSN (API address)",
        placeholder: "api8.unipile.com:13851",
        help: "Shown at the top of the Unipile dashboard. Paste it as it appears — https:// is added if missing.",
        inputType: "text",
        required: true,
        secret: false,
      },
      {
        key: "apiKey",
        label: "Access token",
        help: "Unipile dashboard → Access tokens → Generate. Copy it right away; Unipile shows it only once.",
        inputType: "password",
        required: true,
        secret: true,
      },
      {
        key: "notifySecret",
        label: "Webhook secret",
        help: "Leave empty: AgentSDR generates one and registers the webhooks with it. Fill it in only to keep a secret you already use.",
        inputType: "password",
        required: false,
        secret: true,
      },
    ],
  },
  {
    key: "smtp",
    name: "SMTP / IMAP Mail Server",
    description: "Sends email over SMTP and syncs replies in real time via IMAP IDLE + UID polling (supports Aliyun Enterprise Mail, Tencent Exmail, Zoho, or any standard mail server).",
    enables: ["Email accounts", "Email campaigns and real-time IMAP reply sync"],
    websiteUrl: "https://qiye.aliyun.com",
    iconUrl: "/Integrations - Icon/smtp.svg",
    setupSteps: [
      "Enable SMTP and IMAP in your enterprise mailbox settings (for Aliyun Enterprise Mail: Account Settings → Third-party client login / Security → Generate client-specific password 客户端专用密码).",
      "Confirm your outgoing SMTP server (default: smtp.qiye.aliyun.com, SSL port 465) and incoming IMAP server (default: imap.qiye.aliyun.com, SSL port 993).",
      "Optionally fill in a default mailbox address and password below to test login right away, or connect each mailbox individually under Settings → Email → Accounts.",
    ],
    fields: [
      {
        key: "smtpHost",
        label: "SMTP host",
        placeholder: "smtp.qiye.aliyun.com",
        defaultValue: "smtp.qiye.aliyun.com",
        help: "Outgoing SMTP hostname (e.g. smtp.qiye.aliyun.com for Aliyun Enterprise Mail, smtp.exmail.qq.com for Tencent Exmail).",
        inputType: "text",
        required: true,
        secret: false,
      },
      {
        key: "smtpPort",
        label: "SMTP port",
        placeholder: "465",
        defaultValue: "465",
        help: "Use 465 for SSL/TLS (recommended) or 587 for STARTTLS.",
        inputType: "text",
        required: true,
        secret: false,
      },
      {
        key: "imapHost",
        label: "IMAP host",
        placeholder: "imap.qiye.aliyun.com",
        defaultValue: "imap.qiye.aliyun.com",
        help: "Incoming IMAP hostname (e.g. imap.qiye.aliyun.com for Aliyun Enterprise Mail). Used for real-time IMAP IDLE and incremental UID reply sync.",
        inputType: "text",
        required: true,
        secret: false,
      },
      {
        key: "imapPort",
        label: "IMAP port",
        placeholder: "993",
        defaultValue: "993",
        help: "Use 993 for IMAP over SSL/TLS.",
        inputType: "text",
        required: true,
        secret: false,
      },
      {
        key: "defaultEmail",
        label: "Default / test mailbox email",
        placeholder: "sdr@linktion.cn",
        help: "Optional: if provided alongside the password below, AgentSDR verifies full SMTP & IMAP login immediately and uses this password automatically for this mailbox.",
        inputType: "text",
        required: false,
        secret: false,
      },
      {
        key: "defaultPassword",
        label: "Default / test mailbox password",
        placeholder: "Client-specific password (客户端专用密码)",
        help: "Optional: password or app-specific password for the default mailbox above. Each mailbox in Email → Accounts can also store its own password.",
        inputType: "password",
        required: false,
        secret: true,
      },
    ],
  },
  {
    key: "google",
    name: "Google Workspace",
    description: "Sends and reads Gmail through a service account with domain-wide delegation.",
    enables: ["Email accounts", "Email campaigns and reply sync"],
    websiteUrl: "https://workspace.google.com",
    iconUrl: "/Integrations - Icon/google.svg",
    guideUrl: docsPageUrl("integrations/google-workspace"),
    docsUrl: "https://developers.google.com/identity/protocols/oauth2/service-account#delegatingauthority",
    setupSteps: [
      "In the Google Cloud console, open APIs & Services → Library and enable the Gmail API.",
      "Open IAM & Admin → Service accounts → Create service account. It needs no roles.",
      "Open the new service account → Keys → Add key → Create new key → JSON. A key file downloads.",
      {
        text: "In the Google Admin console, open Security → Access and data control → API controls → Manage domain-wide delegation → Add new. Paste the service account's Client ID (on its Details tab) and these scopes:",
        copy: GMAIL_SCOPES,
      },
      "Upload the key file below to fill in the fields, or copy each value in by hand.",
    ],
    fields: [
      {
        key: "clientEmail",
        label: "Service account email",
        placeholder: "agentsdr@my-project.iam.gserviceaccount.com",
        help: "Google Cloud console → IAM & Admin → Service accounts, in the Email column. It ends in .iam.gserviceaccount.com.",
        inputType: "text",
        required: true,
        secret: false,
      },
      {
        key: "privateKey",
        label: "Private key",
        placeholder: "-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----",
        help: "Google only gives this out inside a JSON key file (service account → Keys → Add key → Create new key → JSON). Upload that file above, or open it and copy the private_key value, from -----BEGIN to END PRIVATE KEY-----.",
        inputType: "textarea",
        required: true,
        secret: true,
      },
      {
        key: "gmailWatchTopic",
        label: "Gmail Pub/Sub topic",
        placeholder: "projects/my-project/topics/agentsdr-inbox",
        help: "Google Cloud console → Pub/Sub → Topics: create a topic, give gmail-api-push@system.gserviceaccount.com the Pub/Sub Publisher role on it, and copy its full name. Sending works without it, but email replies are not picked up.",
        inputType: "text",
        required: false,
        secret: false,
      },
    ],
    keyFile: {
      label: "Upload key file",
      accept: "application/json,.json",
      read: (text) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new Error("That file is not a Google key file (it is not JSON).");
        }
        const key = (parsed ?? {}) as Record<string, unknown>;
        if (key.type !== "service_account" || typeof key.client_email !== "string" || typeof key.private_key !== "string") {
          throw new Error("That file is not a service account key file. Download one from the service account's Keys tab.");
        }
        return { clientEmail: key.client_email, privateKey: key.private_key };
      },
    },
  },
  {
    key: "r2",
    name: "Cloudflare R2",
    description: "Stores WhatsApp call recordings and contact photos.",
    enables: ["Call recordings", "Contact photos"],
    websiteUrl: "https://www.cloudflare.com/developer-platform/products/r2/",
    iconUrl: "/Integrations - Icon/cloudflare.svg",
    guideUrl: docsPageUrl("integrations/cloudflare-r2"),
    docsUrl: "https://developers.cloudflare.com/r2/api/tokens/",
    setupSteps: [
      "In the Cloudflare dashboard, open R2 Object Storage and create a bucket for recordings (or pick an existing one).",
      "Copy your Account ID from the R2 overview page.",
      "Open Manage API tokens → Create API token, give it Object Read & Write on that bucket, and copy the Access Key ID and Secret Access Key. The secret is shown only once.",
    ],
    fields: [
      {
        key: "accountId",
        label: "Account ID",
        help: "Cloudflare dashboard → R2 Object Storage, under Account details on the overview page.",
        inputType: "text",
        required: true,
        secret: false,
      },
      {
        key: "bucket",
        label: "Bucket name",
        help: "The bucket's name exactly as listed under R2 Object Storage.",
        inputType: "text",
        required: true,
        secret: false,
      },
      {
        key: "accessKeyId",
        label: "Access key ID",
        help: "Shown when you create an R2 API token (R2 Object Storage → Manage API tokens).",
        inputType: "text",
        required: true,
        secret: false,
      },
      {
        key: "secretAccessKey",
        label: "Secret access key",
        help: "Shown once, next to the access key ID, when you create the token.",
        inputType: "password",
        required: true,
        secret: true,
      },
    ],
  },
  {
    key: "gologin",
    name: "GoLogin",
    description: "Browser profiles that run cloud calling numbers' WhatsApp Web, so AI agent calls can be placed without anyone's laptop.",
    enables: ["Cloud calling numbers (GoLogin launchers)"],
    websiteUrl: "https://gologin.com",
    // No bundled mark in public/: the favicon, as the grid's integration icons fall back to.
    iconUrl: "https://www.google.com/s2/favicons?domain=gologin.com&sz=64",
    guideUrl: docsPageUrl("whatsapp/calling#what-you-need"),
    docsUrl: "https://gologin.com/docs/api-reference/introduction/quickstart",
    setupSteps: [
      "Sign in to GoLogin and open Settings → API.",
      "Create a new API token and copy it. It is shown only once.",
      "Paste it below and save. Then add a calling number under Settings → WhatsApp → Calling numbers.",
    ],
    fields: [
      {
        key: "apiToken",
        label: "API token",
        help: "GoLogin → Settings → API → New token. Copy it right away; GoLogin shows it only once.",
        inputType: "password",
        required: true,
        secret: true,
      },
    ],
  },
  {
    key: "calcom",
    name: "Cal.com",
    description: "Tells AI calling campaigns when a lead books (or cancels) a meeting from the booking link the agent sent them.",
    enables: ["Meetings booked from AI calling campaigns"],
    websiteUrl: "https://cal.com",
    iconUrl: "https://www.google.com/s2/favicons?domain=cal.com&sz=64",
    docsUrl: "https://cal.com/docs/developing/guides/automation/webhooks",
    setupSteps: [
      "In Cal.com, open Settings → Developer → Webhooks and create a new webhook.",
      "Paste the webhook URL shown on this page (it carries your organization) as the Subscriber URL.",
      "Turn on the Booking created, Booking rescheduled and Booking cancelled triggers.",
      "Type a long random secret into Secret, save the webhook, and paste the same secret below.",
    ],
    fields: [
      {
        key: "webhookSecret",
        label: "Webhook secret",
        help: "The Secret you typed on the Cal.com webhook. AgentSDR refuses deliveries that are not signed with it.",
        inputType: "password",
        required: true,
        secret: true,
      },
      {
        key: "apiKey",
        label: "API key (optional)",
        placeholder: "cal_live_…",
        help: "Cal.com → Settings → Developer → API keys. Only checked for now; leave it empty if you like.",
        inputType: "password",
        required: false,
        secret: true,
      },
    ],
  },
];

/** OpenRouter is connected on the AI provider page; the Integrations page only shows its card. */
export const OPENROUTER_ICON_URL = "/Integrations - Icon/openrouter.svg";

/**
 * Where each integration is connected in Settings: the Connection page of
 * the channel it powers. Unipile powers LinkedIn and WhatsApp; WhatsApp
 * screens pass their own page to RequiresPlatform.
 */
export const PLATFORM_SETTINGS_HREF: Record<PlatformKey, string> = {
  google: "/settings/email-connection",
  smtp: "/settings/email-connection",
  unipile: "/settings/linkedin-connection",
  r2: "/settings/whatsapp-connection",
  gologin: "/settings/whatsapp-connection",
  calcom: "/settings/whatsapp-connection",
};

/** Where that page sits in the Settings sidebar, for messages. */
export const PLATFORM_SETTINGS_LABEL: Record<PlatformKey, string> = {
  google: "Settings → Email → Connection",
  smtp: "Settings → Email → Connection",
  unipile: "Settings → LinkedIn → Connection",
  r2: "Settings → WhatsApp → Integrations",
  gologin: "Settings → WhatsApp → Integrations",
  calcom: "Settings → WhatsApp → Integrations",
};

export function getPlatformIntegration(key: string): PlatformIntegration | null {
  return PLATFORM_INTEGRATIONS.find((integration) => integration.key === key) ?? null;
}

export function isPlatformKey(key: string): key is PlatformKey {
  return getPlatformIntegration(key) !== null;
}

/** What the settings UI receives about one platform — never a secret value. */
export type PlatformStatus = {
  key: PlatformKey;
  connected: boolean;
  /** Non-secret field values, for display and to prefill the edit form. */
  values: Record<string, string>;
  /** Secret fields that currently hold a value. */
  secretsSet: string[];
  verifiedAt: string | null;
  /** Unipile only: the outcome of registering its webhooks. */
  webhooks?: UnipileWebhookRegistration | null;
};

/** What happened when AgentSDR registered Unipile's webhooks for an organization. */
export type UnipileWebhookRegistration = {
  /** registered: all created. skipped: nothing to do yet (local address, no public URL). failed: Unipile refused. */
  status: "registered" | "skipped" | "failed";
  at: string;
  /** The public origin the webhook URLs point at. */
  origin?: string;
  /** One per registered webhook: our key and Unipile's webhook id. */
  items?: { key: string; id: string }[];
  /** Why it was skipped or failed, in words for the settings page. */
  message?: string;
};
