"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { RiArrowDownSLine, RiCheckLine, RiExternalLinkLine, RiEyeLine, RiEyeOffLine, RiFileCopyLine, RiFileUploadLine } from "@remixicon/react";

import * as Badge from "@/components/alignui/badge";
import * as Button from "@/components/alignui/button";
import * as Input from "@/components/alignui/input";
import * as Modal from "@/components/alignui/modal";
import * as Textarea from "@/components/alignui/textarea";
import { Frame, FramePanel } from "@/components/analytics/kit/Frame";
import { DocsLink } from "@/components/page/DocsLink";
import { useDialogs } from "@/components/DialogProvider";
import { Callout, Field } from "@/components/settings/SettingsKit";
import {
  PLATFORM_INTEGRATIONS,
  type LangfusePromptUpload,
  type PlatformIntegration,
  type PlatformKey,
  type PlatformStatus,
  type SetupStep,
  type UnipileWebhookRegistration,
} from "@/lib/platform/catalog";
import { cn } from "@/utils/cn";

/**
 * One platform integration as its channel's Connection section shows it
 * (Settings → Email / LinkedIn / WhatsApp → Connection): the card with its
 * status, Edit and Disconnect, and the guided setup dialog. `note` explains a
 * connection shared with another channel (Unipile powers LinkedIn and
 * WhatsApp).
 *
 * The catalog is imported here rather than passed from the page: it carries
 * functions (keyFile.read), which cannot cross the server/client boundary.
 */
export function PlatformConnection({
  platformKey,
  status,
  note,
  webhookUrl,
}: {
  platformKey: PlatformKey;
  status: PlatformStatus | null;
  note?: string;
  /**
   * A URL to paste into the provider's webhook settings (Cal.com), built on
   * the server with the organization in it. Undefined: none; null: this
   * deployment has no public URL to build it from.
   */
  webhookUrl?: string | null;
}) {
  const integration = PLATFORM_INTEGRATIONS.find((candidate) => candidate.key === platformKey)!;
  const [editing, setEditing] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      {note && <Callout tone="info">{note}</Callout>}
      <PlatformCard integration={integration} status={status} webhookUrl={webhookUrl} onEdit={() => setEditing(true)} />
      {editing && <IntegrationDialog key={integration.key} integration={integration} status={status} onClose={() => setEditing(false)} />}
    </div>
  );
}

/** A connection that is planned but not built yet: shown so people know it is coming. */
export type ComingSoonConnection = { name: string; description: string; iconUrl: string; enables: string[] };

export function ComingSoonCard({ connection }: { connection: ComingSoonConnection }) {
  return (
    <Frame>
      <FramePanel className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <PlatformLogo src={connection.iconUrl} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-label-md text-text-strong-950">{connection.name}</h3>
              <Badge.Root size="medium" variant="lighter" color="purple">Coming soon</Badge.Root>
            </div>
            <p className="mt-1 text-paragraph-sm text-text-sub-600">{connection.description}</p>
            <p className="mt-1 text-paragraph-xs text-text-soft-400">Will power: {connection.enables.join(", ")}</p>
          </div>
        </div>
        <Button.Root variant="neutral" mode="stroke" size="small" disabled className="shrink-0">
          Coming soon
        </Button.Root>
      </FramePanel>
    </Frame>
  );
}

function PlatformCard({
  integration,
  status,
  webhookUrl,
  onEdit,
}: {
  integration: PlatformIntegration;
  status: PlatformStatus | null;
  webhookUrl?: string | null;
  onEdit: () => void;
}) {
  const router = useRouter();
  const dialogs = useDialogs();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const connected = status?.connected ?? false;

  const shownValues = integration.fields.filter((field) => !field.secret && status?.values[field.key]);

  async function disconnect() {
    const confirmed = await dialogs.confirm({
      title: `Disconnect ${integration.name}?`,
      description: `${integration.enables.join(" and ")} will stop working until it is connected again.`,
      confirmLabel: "Disconnect",
      variant: "error",
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/settings/integrations/${integration.key}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      startTransition(() => router.refresh());
    } catch {
      await dialogs.alert({ title: `Could not disconnect ${integration.name}`, description: "Something went wrong. Please try again.", variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Frame>
      <FramePanel className="flex flex-col gap-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <PlatformLogo src={integration.iconUrl} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-label-md text-text-strong-950">{integration.name}</h3>
                <Badge.Root size="medium" variant="lighter" color={connected ? "green" : "gray"}>
                  {connected ? "Connected" : "Not connected"}
                </Badge.Root>
              </div>
              <p className="mt-1 text-paragraph-sm text-text-sub-600">{integration.description}</p>
              <p className="mt-1 text-paragraph-xs text-text-soft-400">Powers: {integration.enables.join(", ")}</p>
              {connected && integration.guideUrl && (
                <DocsLink href={integration.guideUrl} appearance="inline" className="mt-1.5 text-paragraph-xs">
                  Setup guide
                </DocsLink>
              )}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {!connected && integration.guideUrl && <DocsLink href={integration.guideUrl} />}
            {connected && (
              <Button.Root variant="error" mode="ghost" size="small" disabled={busy} onClick={disconnect}>
                Disconnect
              </Button.Root>
            )}
            <Button.Root variant={connected ? "neutral" : "primary"} mode={connected ? "stroke" : "filled"} size="small" onClick={onEdit}>
              {connected ? "Edit" : "Connect"}
            </Button.Root>
          </div>
        </div>

        {connected && (shownValues.length > 0 || status?.verifiedAt) && (
          <dl className="grid gap-x-6 gap-y-2 border-t border-stroke-soft-200 pt-3 text-paragraph-xs sm:grid-cols-2">
            {shownValues.map((field) => (
              <div key={field.key} className="min-w-0">
                <dt className="text-text-soft-400">{field.label}</dt>
                <dd className="truncate text-text-strong-950">{status?.values[field.key]}</dd>
              </div>
            ))}
            {status?.verifiedAt && (
              <div>
                <dt className="text-text-soft-400">Last verified</dt>
                <dd className="text-text-strong-950">{formatVerified(status.verifiedAt)}</dd>
              </div>
            )}
          </dl>
        )}

        {connected && integration.key === "unipile" && <UnipileWebhooks registration={status?.webhooks ?? null} />}
        {connected && integration.key === "langfuse" && <LangfusePrompts upload={status?.prompts ?? null} />}
        {webhookUrl !== undefined && (
          <section className="flex flex-col gap-1.5 border-t border-stroke-soft-200 pt-3">
            <span className="text-label-xs text-text-strong-950">Webhook URL</span>
            {webhookUrl ? (
              <>
                <CopyValue value={webhookUrl} />
                <p className="text-paragraph-xs text-text-soft-400">
                  Paste it as the Subscriber URL of a {integration.name} webhook. It names your organization, so keep one per organization.
                </p>
              </>
            ) : (
              <p className="text-paragraph-xs text-text-soft-400">Set BETTER_AUTH_URL to this deployment&apos;s public address to get the webhook URL.</p>
            )}
          </section>
        )}
      </FramePanel>
    </Frame>
  );
}

/**
 * The prompts AgentSDR uploads to a Langfuse project when it is saved:
 * how many it created, or why it could not. Saving again retries.
 */
function LangfusePrompts({ upload }: { upload: LangfusePromptUpload | null }) {
  const badge =
    upload?.status === "uploaded"
      ? { color: "green" as const, text: "In Langfuse" }
      : upload?.status === "failed"
        ? { color: "red" as const, text: "Upload failed" }
        : { color: "gray" as const, text: "Not uploaded yet" };
  const prompts = (count: number) => `${count} prompt${count === 1 ? "" : "s"}`;
  return (
    <section className="flex flex-col gap-1 border-t border-stroke-soft-200 pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-label-sm text-text-strong-950">Prompts</h4>
        <Badge.Root size="small" variant="lighter" color={badge.color}>
          {badge.text}
        </Badge.Root>
      </div>
      <p className="text-paragraph-xs text-text-sub-600">
        {upload?.status === "uploaded"
          ? `On ${formatVerified(upload.at)} AgentSDR uploaded ${prompts(upload.created)} to this project, labelled production${upload.existing ? `; ${prompts(upload.existing)} were already there and were left as they are` : ""}. Edit them in Langfuse: AgentSDR uses the production version.`
          : upload?.status === "failed"
            ? `${upload.message ?? "Langfuse did not take the prompts."} Edit and save the connection to try again.`
            : "AgentSDR uploads its prompts when the connection is saved. Edit and save it to upload them."}
      </p>
    </section>
  );
}

type WebhookSetup = { endpoints: { key: string; label: string; url: string }[] | null; secret: string };

/**
 * Unipile's webhooks, which AgentSDR registers itself on save: whether that
 * worked, a way to run it again, and, on request, the URLs and the secret
 * for registering them by hand.
 */
function UnipileWebhooks({ registration }: { registration: UnipileWebhookRegistration | null }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [current, setCurrent] = useState(registration);
  const [registering, setRegistering] = useState(false);
  const [error, setError] = useState("");
  const [setup, setSetup] = useState<WebhookSetup | null>(null);
  const [loadingSetup, setLoadingSetup] = useState(false);
  const [secretShown, setSecretShown] = useState(false);

  async function register() {
    setRegistering(true);
    setError("");
    try {
      const res = await fetch("/api/settings/integrations/unipile/webhooks", { method: "POST" });
      const body = (await res.json().catch(() => null)) as (UnipileWebhookRegistration & { error?: string }) | null;
      if (!res.ok || !body) throw new Error(body?.error || "Could not register the webhooks.");
      setCurrent(body);
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not register the webhooks.");
    } finally {
      setRegistering(false);
    }
  }

  async function toggleSetup() {
    if (setup) {
      setSetup(null);
      setSecretShown(false);
      return;
    }
    setLoadingSetup(true);
    setError("");
    try {
      const res = await fetch("/api/settings/integrations/unipile/webhooks", { cache: "no-store" });
      const body = (await res.json().catch(() => null)) as (WebhookSetup & { error?: string }) | null;
      if (!res.ok || !body) throw new Error(body?.error || "Could not load the webhook details.");
      setSetup(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the webhook details.");
    } finally {
      setLoadingSetup(false);
    }
  }

  const badge =
    current?.status === "registered"
      ? { color: "green" as const, text: `${current.items?.length ?? 0} registered` }
      : current?.status === "failed"
        ? { color: "red" as const, text: "Registration failed" }
        : current?.status === "skipped"
          ? { color: "orange" as const, text: "Not registered" }
          : { color: "gray" as const, text: "Not registered yet" };

  return (
    <section className="flex flex-col gap-3 border-t border-stroke-soft-200 pt-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-label-sm text-text-strong-950">Webhooks</h4>
            <Badge.Root size="small" variant="lighter" color={badge.color}>
              {badge.text}
            </Badge.Root>
          </div>
          <p className="mt-1 text-paragraph-xs text-text-sub-600">
            {current?.status === "registered"
              ? `AgentSDR registered them in your Unipile workspace on ${formatVerified(current.at)}, so replies, accepted invitations and WhatsApp messages arrive here.`
              : current?.message
                ? current.message
                : "AgentSDR registers them in your Unipile workspace, so replies, accepted invitations and WhatsApp messages arrive here."}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button.Root variant="neutral" mode="ghost" size="small" disabled={loadingSetup} onClick={() => void toggleSetup()}>
            {setup ? "Hide URLs" : loadingSetup ? "Loading…" : "Show URLs and secret"}
          </Button.Root>
          <Button.Root variant="neutral" mode="stroke" size="small" disabled={registering} onClick={() => void register()}>
            {registering ? "Registering…" : current?.status === "registered" ? "Register again" : "Register webhooks"}
          </Button.Root>
        </div>
      </div>

      {error && <Callout tone="error">{error}</Callout>}

      {setup && (
        <div className="flex flex-col gap-3 rounded-lg bg-bg-weak-50 p-3">
          <p className="text-paragraph-xs text-text-sub-600">
            Only needed to register the webhooks by hand. Each URL is called with the header <code className="font-mono">x-unipile-secret</code> set to the secret below.
          </p>
          {setup.endpoints ? (
            <ul className="flex flex-col gap-2">
              {setup.endpoints.map((endpoint) => (
                <li key={endpoint.key} className="flex flex-col gap-1">
                  <span className="text-label-xs text-text-strong-950">{endpoint.label}</span>
                  <CopyValue value={endpoint.url} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-paragraph-xs text-text-sub-600">Set BETTER_AUTH_URL to the app&apos;s public address to get the webhook URLs.</p>
          )}
          <div className="flex flex-col gap-1">
            <span className="text-label-xs text-text-strong-950">Secret</span>
            <CopyValue value={setup.secret} masked={!secretShown} onToggleMask={() => setSecretShown((shown) => !shown)} />
          </div>
        </div>
      )}
    </section>
  );
}

/** A value on one line with Copy; optionally masked behind a show/hide toggle. */
function CopyValue({ value, masked = false, onToggleMask }: { value: string; masked?: boolean; onToggleMask?: () => void }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked: the value is selectable text (once shown).
    }
  }
  return (
    <div className="flex items-start gap-2 rounded-md bg-bg-white-0 p-2 ring-1 ring-inset ring-stroke-soft-200">
      <code className="min-w-0 flex-1 select-all break-all font-mono text-paragraph-xs text-text-strong-950">
        {masked ? "•".repeat(Math.min(value.length, 32)) : value}
      </code>
      {onToggleMask && (
        <Button.Root type="button" variant="neutral" mode="ghost" size="xxsmall" onClick={onToggleMask} aria-label={masked ? "Show secret" : "Hide secret"}>
          <Button.Icon as={masked ? RiEyeLine : RiEyeOffLine} />
        </Button.Root>
      )}
      <Button.Root type="button" variant="neutral" mode="ghost" size="xxsmall" onClick={() => void copy()}>
        <Button.Icon as={copied ? RiCheckLine : RiFileCopyLine} />
        {copied ? "Copied" : "Copy"}
      </Button.Root>
    </div>
  );
}

/** "How to connect", closed until asked for — the fields' own hints carry most people through. */
function SetupGuide({ integration }: { integration: PlatformIntegration }) {
  const [open, setOpen] = useState(false);
  const id = `setup-guide-${integration.key}`;
  return (
    <section className="rounded-lg bg-bg-weak-50">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-3 rounded-lg px-3.5 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary-base"
      >
        <span className="text-label-sm text-text-strong-950">
          How to connect
          <span className="ml-1.5 text-paragraph-xs text-text-soft-400">{integration.setupSteps.length} steps</span>
        </span>
        <RiArrowDownSLine aria-hidden="true" className={cn("size-5 shrink-0 text-text-soft-400 transition-transform duration-200", open && "rotate-180")} />
      </button>
      {open && (
        <ol id={id} className="space-y-1.5 px-3.5 pb-3.5">
          {integration.setupSteps.map((step, index) => (
            <li key={index} className="flex gap-2 text-paragraph-sm text-text-sub-600">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-bg-white-0 text-label-xs text-text-strong-950 ring-1 ring-inset ring-stroke-soft-200">
                {index + 1}
              </span>
              <SetupStepText step={step} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function SetupStepText({ step }: { step: SetupStep }) {
  const [copied, setCopied] = useState(false);
  if (typeof step === "string") return <span className="min-w-0 flex-1">{step}</span>;

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked: the value is selectable text, so it can still be copied by hand.
    }
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <span>{step.text}</span>
      <div className="flex items-start gap-2 rounded-md bg-bg-white-0 p-2 ring-1 ring-inset ring-stroke-soft-200">
        <code className="min-w-0 flex-1 select-all break-all font-mono text-paragraph-xs text-text-strong-950">{step.copy}</code>
        <Button.Root type="button" variant="neutral" mode="ghost" size="xxsmall" onClick={() => void copy(step.copy)}>
          <Button.Icon as={copied ? RiCheckLine : RiFileCopyLine} />
          {copied ? "Copied" : "Copy"}
        </Button.Root>
      </div>
    </div>
  );
}

/**
 * The provider's mark on a white tile in both themes — the marks are drawn
 * for a light background (OpenRouter's is black), so the tile keeps them
 * legible in dark mode.
 */
export function PlatformLogo({ src, size = "medium" }: { src: string; size?: "small" | "medium" }) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white ring-1 ring-inset ring-stroke-soft-200",
        size === "medium" ? "size-10 p-2" : "size-9 p-1.5",
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- a static brand asset from public/ */}
      <img src={src} alt="" className="size-full object-contain" />
    </span>
  );
}

function formatVerified(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

function IntegrationDialog({
  integration,
  status,
  onClose,
}: {
  integration: PlatformIntegration;
  status: PlatformStatus | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      integration.fields.map((field) => [
        field.key,
        field.secret ? "" : (status?.values[field.key] ?? field.defaultValue ?? ""),
      ]),
    ),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filledFrom, setFilledFrom] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const secretsSet = new Set(status?.secretsSet ?? []);
  const connected = status?.connected ?? false;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/settings/integrations/${integration.key}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const data: { error?: string } = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Could not save the integration");
        return;
      }
      router.refresh();
      onClose();
    } catch {
      setError("Network error — please try again");
    } finally {
      setSaving(false);
    }
  }

  async function readKeyFile(file: File) {
    if (!integration.keyFile) return;
    setError(null);
    setFilledFrom(null);
    try {
      const filled = integration.keyFile.read(await file.text());
      setValues((current) => ({ ...current, ...filled }));
      setFilledFrom(file.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read that file");
    }
  }

  const links = [
    integration.guideUrl && { href: integration.guideUrl, label: "Step-by-step guide" },
    integration.videoUrl && { href: integration.videoUrl, label: "Watch how" },
    integration.docsUrl && { href: integration.docsUrl, label: `${integration.name} docs` },
  ].filter((link): link is { href: string; label: string } => Boolean(link));

  const missing = integration.fields.some(
    (field) => field.required && !values[field.key].trim() && !(field.secret && secretsSet.has(field.key)),
  );

  return (
    <Modal.Root open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <Modal.Content size="max-w-xl" hideClose={saving} onEscapeKeyDown={(event) => saving && event.preventDefault()}>
        <Modal.Header>
          <div className="flex items-start gap-3">
            <PlatformLogo src={integration.iconUrl} size="small" />
            <div className="min-w-0">
              <Modal.Title>{connected ? `Edit ${integration.name}` : `Connect ${integration.name}`}</Modal.Title>
              <Modal.Description>
                Everything is tested against {integration.name} before it is saved.
              </Modal.Description>
              {links.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-paragraph-xs">
                  {links.map((link) => (
                    <a key={link.href} href={link.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-primary-base underline-offset-2 hover:underline">
                      {link.label} <RiExternalLinkLine className="size-3.5" aria-hidden="true" />
                    </a>
                  ))}
                </div>
              )}
            </div>
          </div>
        </Modal.Header>

        <form onSubmit={submit} className="flex min-h-0 flex-col">
          <Modal.Body className="space-y-4">
            <SetupGuide integration={integration} />

            {integration.keyFile && (
              <div className="flex flex-wrap items-center gap-3">
                <input
                  ref={fileInput}
                  type="file"
                  accept={integration.keyFile.accept}
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) void readKeyFile(file);
                  }}
                />
                <Button.Root type="button" variant="neutral" mode="stroke" size="small" disabled={saving} onClick={() => fileInput.current?.click()}>
                  <Button.Icon as={RiFileUploadLine} />
                  {integration.keyFile.label}
                </Button.Root>
                <span className="text-paragraph-xs text-text-soft-400">
                  {filledFrom ? `Filled in from ${filledFrom} — check the values, then connect.` : "Fills in the fields below. The file stays in your browser."}
                </span>
              </div>
            )}
            {integration.fields.map((field) => {
              const id = `platform-${integration.key}-${field.key}`;
              const saved = field.secret && secretsSet.has(field.key);
              const placeholder = saved ? "Saved — leave blank to keep" : field.placeholder;
              const set = (value: string) => setValues((current) => ({ ...current, [field.key]: value }));
              return (
                <Field key={field.key} label={field.label} htmlFor={id} required={field.required} optional={!field.required} description={field.help}>
                  {field.inputType === "textarea" ? (
                    <Textarea.Root
                      id={id}
                      simple
                      rows={6}
                      value={values[field.key]}
                      onChange={(e) => set(e.target.value)}
                      placeholder={placeholder}
                      spellCheck={false}
                      autoComplete="off"
                      className="font-mono text-paragraph-xs"
                    />
                  ) : (
                    <Input.Root size="medium">
                      <Input.Wrapper>
                        <Input.Input
                          id={id}
                          type={field.inputType}
                          value={values[field.key]}
                          onChange={(e) => set(e.target.value)}
                          placeholder={placeholder}
                          spellCheck={false}
                          autoComplete="off"
                        />
                      </Input.Wrapper>
                    </Input.Root>
                  )}
                </Field>
              );
            })}

            {error && (
              <Callout tone="error" title="Could not connect">
                {error}
              </Callout>
            )}
          </Modal.Body>

          <Modal.Footer>
            <Button.Root type="button" variant="neutral" mode="stroke" size="small" disabled={saving} onClick={onClose}>
              Cancel
            </Button.Root>
            <Button.Root type="submit" variant="primary" mode="filled" size="small" disabled={saving || missing}>
              {saving ? "Testing…" : connected ? "Save" : "Connect & test"}
            </Button.Root>
          </Modal.Footer>
        </form>
      </Modal.Content>
    </Modal.Root>
  );
}
