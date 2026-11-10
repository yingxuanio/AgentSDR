"use client";

import { useState } from "react";
import {
  RiAddLine,
  RiCheckLine,
  RiDeleteBinLine,
  RiFileCopyLine,
  RiKey2Line,
  RiTerminalBoxLine,
} from "@remixicon/react";
import * as Button from "@/components/alignui/button";
import * as Input from "@/components/alignui/input";
import { Frame, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import type { ApiKeySummary } from "@/lib/auth/api-keys";

export default function ApiKeysSettingsClient({
  initialKeys,
}: {
  initialKeys: ApiKeySummary[];
}) {
  const [keys, setKeys] = useState<ApiKeySummary[]>(initialKeys);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [newlyCreatedSecret, setNewlyCreatedSecret] = useState<string | null>(null);
  const [copiedSecret, setCopiedSecret] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to create API key");
      }
      setKeys((prev) => [data.apiKey, ...prev]);
      setNewlyCreatedSecret(data.secretKey);
      setName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create API key");
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (id: string) => {
    if (busyId) return;
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/settings/api-keys/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to revoke API key");
      }
      setKeys((prev) => prev.filter((k) => k.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke API key");
    } finally {
      setBusyId(null);
    }
  };

  const copySecret = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedSecret(true);
      setTimeout(() => setCopiedSecret(false), 2000);
    } catch {
      // ignore clipboard errors
    }
  };

  return (
    <div className="space-y-6">
      <Frame>
        <FrameHeader
          title="Create API key"
          description="Authenticate external scripts, CLI tools, or AI agents with Authorization: Bearer <API_KEY> or x-api-key: <API_KEY>."
        />
        <FramePanel>
          <form onSubmit={handleCreate} className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="flex-1">
              <Input.Root size="small">
                <Input.Wrapper>
                  <Input.Icon as={RiKey2Line} />
                  <Input.Input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Key label (e.g. Linktion Draft Sync / Claude Code Agent)"
                    maxLength={120}
                  />
                </Input.Wrapper>
              </Input.Root>
            </div>
            <Button.Root
              type="submit"
              variant="primary"
              mode="filled"
              size="small"
              disabled={!name.trim() || creating}
            >
              <Button.Icon as={RiAddLine} />
              {creating ? "Creating…" : "Create API key"}
            </Button.Root>
          </form>

          {error && (
            <p className="mt-3 text-paragraph-xs text-error-base">{error}</p>
          )}

          {newlyCreatedSecret && (
            <div className="mt-4 rounded-xl bg-success-lighter/40 p-3.5 ring-1 ring-inset ring-success-base/30">
              <p className="text-label-xs text-text-strong-950">
                Copy your new API key now — for security, the full token is only shown once:
              </p>
              <div className="mt-2 flex items-center gap-2">
                <code className="flex-1 select-all overflow-x-auto rounded-lg bg-bg-white-0 px-3 py-2 font-mono text-paragraph-xs text-text-strong-950 ring-1 ring-inset ring-stroke-soft-200">
                  {newlyCreatedSecret}
                </code>
                <Button.Root
                  type="button"
                  variant="neutral"
                  mode="stroke"
                  size="small"
                  onClick={() => void copySecret(newlyCreatedSecret)}
                >
                  <Button.Icon as={copiedSecret ? RiCheckLine : RiFileCopyLine} />
                  {copiedSecret ? "Copied" : "Copy"}
                </Button.Root>
              </div>
            </div>
          )}
        </FramePanel>
      </Frame>

      <Frame>
        <FrameHeader
          title="Active API keys"
          description="Keys have full organization access to CRM drafts, leads, outreach, and settings APIs."
        />
        <FramePanel>
          {keys.length === 0 ? (
            <p className="py-4 text-center text-paragraph-sm text-text-sub-600">
              No API keys created yet.
            </p>
          ) : (
            <div className="divide-y divide-stroke-soft-200">
              {keys.map((item) => (
                <div
                  key={item.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <p className="truncate text-label-sm text-text-strong-950">{item.name}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-2 text-paragraph-xs text-text-sub-600">
                      <code className="rounded bg-bg-weak-50 px-1.5 py-0.5 font-mono text-text-strong-950">
                        {item.keyPrefix}
                      </code>
                      <span>·</span>
                      <span>Created {new Date(item.createdAt).toLocaleDateString()}</span>
                      {item.lastUsedAt && (
                        <>
                          <span>·</span>
                          <span>Last used {new Date(item.lastUsedAt).toLocaleString()}</span>
                        </>
                      )}
                    </p>
                  </div>
                  <Button.Root
                    type="button"
                    variant="error"
                    mode="ghost"
                    size="xsmall"
                    disabled={busyId === item.id}
                    onClick={() => void handleRevoke(item.id)}
                  >
                    <Button.Icon as={RiDeleteBinLine} />
                    Revoke
                  </Button.Root>
                </div>
              ))}
            </div>
          )}
        </FramePanel>
      </Frame>

      <Frame>
        <FrameHeader
          title="Draft API quick reference"
          description="Replace or batch-rewrite pending drafts directly via HTTP."
        />
        <FramePanel>
          <div className="space-y-3 text-paragraph-xs text-text-sub-600">
            <div className="flex items-center gap-1.5 text-label-xs text-text-strong-950">
              <RiTerminalBoxLine className="size-4 text-text-sub-600" />
              <span>1. List pending drafts (with draft ID, companyCode, toEmail, subject & body)</span>
            </div>
            <pre className="overflow-x-auto rounded-lg bg-bg-weak-50 p-3 font-mono text-xs text-text-strong-950 ring-1 ring-inset ring-stroke-soft-200">
{`curl -sS https://sdr.linktion.cn/api/crm/drafts \\
  -H "Authorization: Bearer <API_KEY>"`}
            </pre>

            <div className="flex items-center gap-1.5 pt-2 text-label-xs text-text-strong-950">
              <RiTerminalBoxLine className="size-4 text-text-sub-600" />
              <span>2. Directly replace a draft by companyCode, toEmail, or draft ID (syncs AI CRM + Master Inbox + Outreach)</span>
            </div>
            <pre className="overflow-x-auto rounded-lg bg-bg-weak-50 p-3 font-mono text-xs text-text-strong-950 ring-1 ring-inset ring-stroke-soft-200">
{`curl -sS -X PATCH https://sdr.linktion.cn/api/crm/drafts \\
  -H "Authorization: Bearer <API_KEY>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "companyCode": "HK01",
    "subject": "Magic: a first-phase development partnership",
    "bodyText": "Hi Sam,\\n\\n..."
  }'`}
            </pre>

            <div className="flex items-center gap-1.5 pt-2 text-label-xs text-text-strong-950">
              <RiTerminalBoxLine className="size-4 text-text-sub-600" />
              <span>3. Rebind sender mailbox (fromEmail) on an unsent awaiting_review draft without changing body or sending</span>
            </div>
            <pre className="overflow-x-auto rounded-lg bg-bg-weak-50 p-3 font-mono text-xs text-text-strong-950 ring-1 ring-inset ring-stroke-soft-200">
{`curl -sS -X PATCH https://sdr.linktion.cn/api/crm/drafts/<DRAFT_ID> \\
  -H "Authorization: Bearer <API_KEY>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "fromEmail": "ivan@linktion.cn"
  }'`}
            </pre>

            <div className="flex items-center gap-1.5 pt-2 text-label-xs text-text-strong-950">
              <RiTerminalBoxLine className="size-4 text-text-sub-600" />
              <span>4. Batch rewrite drafts with an AI instruction</span>
            </div>
            <pre className="overflow-x-auto rounded-lg bg-bg-weak-50 p-3 font-mono text-xs text-text-strong-950 ring-1 ring-inset ring-stroke-soft-200">
{`curl -sS -X POST https://sdr.linktion.cn/api/crm/drafts \\
  -H "Authorization: Bearer <API_KEY>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "action": "regenerate",
    "companyCodes": ["HK01", "TW01", "HK03"],
    "feedback": "Keep all verified facts and add our engagement overview link naturally."
  }'`}
            </pre>
          </div>
        </FramePanel>
      </Frame>
    </div>
  );
}
