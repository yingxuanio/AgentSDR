"use client";

import { useEffect, useMemo, useState } from "react";
import {
  RiAddLine,
  RiArrowDownSLine,
  RiCheckLine,
  RiDeleteBinLine,
  RiExternalLinkLine,
  RiKey2Line,
  RiLoader4Line,
  RiPlayCircleLine,
  RiRefreshLine,
  RiSearchLine,
} from "@remixicon/react";
import { AiBrandIcon } from "@/components/ai/AiBrandIcon";
import * as Badge from "@/components/alignui/badge";
import * as Button from "@/components/alignui/button";
import * as Checkbox from "@/components/alignui/checkbox";
import * as Input from "@/components/alignui/input";
import * as Select from "@/components/alignui/select";
import { Frame, FramePanel } from "@/components/analytics/kit/Frame";
import { DocsLink } from "@/components/page/DocsLink";
import { EmptyState } from "@/components/page/EmptyState";
import { Callout, Field } from "@/components/settings/SettingsKit";
import { FormSkeleton } from "@/components/settings/SettingsSkeletons";
import { cn } from "@/utils/cn";

type AiProviderKey = "openai" | "anthropic" | "openrouter";

type Connection = {
  id: string;
  providerKey?: AiProviderKey | string;
  name: string;
  baseUrl?: string;
  enabled?: boolean;
  verified?: boolean;
};

type Model = {
  id: string;
  name: string;
  description?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  supportedParameters?: string[];
  outputModalities?: string[];
};

type Provider = {
  slug: string;
  name: string;
  credentialCount: number;
  prioritizedCredentialCount: number;
  fallbackCredentialCount: number;
  discoveredModelCount: number;
  modelFilterRestricted: boolean;
  allowedModelCount: number;
  unmatchedAllowedModels: string[];
  models: Model[];
};

type DefaultModel = { provider: string; modelId: string };

type Settings = {
  connectionId: string | null;
  providers: string[];
  modelsByProvider: Record<string, string[]>;
  defaultModel: DefaultModel | null;
  transcriptionModel: DefaultModel | null;
  byokOnlyConfirmed: boolean;
};

type CatalogResponse = {
  providers?: Provider[];
  settings?: Partial<Settings>;
  connection?: Connection;
};

type TestCallResponse = {
  ok: boolean;
  providerKey?: string;
  apiFormat?: string;
  baseUrl?: string;
  endpoint?: string;
  modelId?: string;
  latencyMs?: number;
  replyText?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  discoveredModelCount?: number;
  discoveredModels?: string[];
  error?: string;
};

const EMPTY_SETTINGS: Settings = {
  connectionId: null,
  providers: [],
  modelsByProvider: {},
  defaultModel: null,
  transcriptionModel: null,
  byokOnlyConfirmed: false,
};

const KEYS_URL = "https://openrouter.ai/settings/keys";
const MANAGEMENT_KEYS_URL = "https://openrouter.ai/settings/management-keys";
const BYOK_URL = "https://openrouter.ai/workspaces/default/byok";

const PROVIDER_FORMAT_OPTIONS: Array<{
  key: AiProviderKey;
  label: string;
  badge: string;
  defaultBaseUrl: string;
  keyPlaceholder: string;
  defaultTestModel: string;
  description: string;
}> = [
  {
    key: "openai",
    label: "OpenAI Responses API",
    badge: "POST /v1/responses",
    defaultBaseUrl: "https://api.openai.com/v1",
    keyPlaceholder: "sk-...",
    defaultTestModel: "gpt-6-luna",
    description: "Official OpenAI or custom OpenAI Responses compatible gateway (BaseURL + API Key).",
  },
  {
    key: "anthropic",
    label: "Anthropic Messages API",
    badge: "POST /v1/messages",
    defaultBaseUrl: "https://api.anthropic.com",
    keyPlaceholder: "sk-ant-...",
    defaultTestModel: "claude-sonnet-4-5",
    description: "Official Anthropic Claude or custom Anthropic Messages compatible gateway (BaseURL + API Key).",
  },
  {
    key: "openrouter",
    label: "OpenRouter BYOK",
    badge: "OpenRouter Gateway",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    keyPlaceholder: "sk-or-v1-...",
    defaultTestModel: "openai/gpt-4o-mini",
    description: "OpenRouter multi-provider workspace with BYOK management key.",
  },
];

function providerOptionFor(key?: string) {
  return PROVIDER_FORMAT_OPTIONS.find((item) => item.key === key) ?? PROVIDER_FORMAT_OPTIONS[0];
}

function normalizeSettings(value: unknown): Settings {
  if (!value || typeof value !== "object") return EMPTY_SETTINGS;
  const input = value as Partial<Settings>;
  const modelsByProvider: Record<string, string[]> = {};
  if (input.modelsByProvider && typeof input.modelsByProvider === "object") {
    for (const [provider, models] of Object.entries(input.modelsByProvider)) {
      if (Array.isArray(models)) modelsByProvider[provider] = models.filter((model): model is string => typeof model === "string");
    }
  }
  const defaultModel = input.defaultModel && typeof input.defaultModel === "object"
    && typeof input.defaultModel.provider === "string"
    && typeof input.defaultModel.modelId === "string"
    ? { provider: input.defaultModel.provider, modelId: input.defaultModel.modelId }
    : null;
  const transcriptionModel = input.transcriptionModel && typeof input.transcriptionModel === "object"
    && typeof input.transcriptionModel.provider === "string"
    && typeof input.transcriptionModel.modelId === "string"
    ? { provider: input.transcriptionModel.provider, modelId: input.transcriptionModel.modelId }
    : null;
  return {
    connectionId: typeof input.connectionId === "string" && input.connectionId ? input.connectionId : null,
    providers: Array.isArray(input.providers) ? input.providers.filter((provider): provider is string => typeof provider === "string") : [],
    modelsByProvider,
    defaultModel,
    transcriptionModel,
    byokOnlyConfirmed: input.byokOnlyConfirmed === true,
  };
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) throw new Error(body?.error ?? "Something went wrong. Please try again.");
  return body as T;
}

function pairKey(provider: string, modelId: string) {
  return `${provider}::${modelId}`;
}

function formatContextLength(value?: number) {
  if (!value) return null;
  return `${new Intl.NumberFormat("en-US", { notation: "compact" }).format(value)} context`;
}

function formatPrice(value?: string) {
  if (!value || value === "0") return null;
  const amount = Number(value) * 1_000_000;
  return Number.isFinite(amount) ? `$${amount.toFixed(amount < 0.01 ? 4 : 2)} / 1M` : null;
}

function ProviderModelPicker({
  provider,
  enabled,
  selectedModels,
  open,
  search,
  customModelInput,
  onCustomModelInputChange,
  onAddCustomModel,
  onToggleProvider,
  onToggleOpen,
  onSearch,
  onToggleModel,
  onToggleVisible,
}: {
  provider: Provider;
  enabled: boolean;
  selectedModels: string[];
  open: boolean;
  search: string;
  customModelInput: string;
  onCustomModelInputChange: (value: string) => void;
  onAddCustomModel: () => void;
  onToggleProvider: () => void;
  onToggleOpen: () => void;
  onSearch: (value: string) => void;
  onToggleModel: (modelId: string) => void;
  onToggleVisible: (models: Model[]) => void;
}) {
  const query = search.trim().toLowerCase();
  const models = query
    ? provider.models.filter((model) =>
        `${model.name} ${model.id} ${model.description ?? ""}`.toLowerCase().includes(query),
      )
    : provider.models;
  const hasPrioritizedCredential = provider.prioritizedCredentialCount > 0;
  const hasModels = provider.models.length > 0;
  const canEnable = hasPrioritizedCredential && hasModels;
  const allVisibleSelected = models.length > 0
    && models.every((model) => selectedModels.includes(model.id));

  let unavailableMessage: React.ReactNode = null;
  if (!hasPrioritizedCredential) {
    unavailableMessage = <>This provider only has fallback-section credentials. Move or add a key in OpenRouter&apos;s prioritized BYOK section.</>;
  } else if (!hasModels && provider.modelFilterRestricted) {
    unavailableMessage = <>
      This key is restricted to {provider.allowedModelCount} model{provider.allowedModelCount === 1 ? "" : "s"}, but none could be resolved to a selectable text or image model.
      {provider.unmatchedAllowedModels.length > 0 && <span className="mt-1 block break-words font-mono text-[11px]">{provider.unmatchedAllowedModels.join(", ")}</span>}
    </>;
  } else if (!hasModels) {
    unavailableMessage = <>No models were returned for this provider. Add a custom model ID below or refresh.</>;
  }

  return (
    <article className={cn("flex flex-col overflow-hidden rounded-xl bg-bg-white-0 ring-1 ring-inset transition", enabled ? "ring-stroke-sub-300 shadow-regular-xs" : "ring-stroke-soft-200")}>
      <label className={cn("flex items-start gap-3 px-4 py-3", canEnable || enabled ? "cursor-pointer" : "cursor-not-allowed")}>
        <Checkbox.Root
          className="mt-2"
          checked={enabled}
          disabled={!canEnable && !enabled}
          onCheckedChange={onToggleProvider}
          aria-label={`Enable ${provider.name}`}
        />
        <AiBrandIcon identifier={provider.slug} label={provider.name} className="size-9" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-label-sm text-text-strong-950">{provider.name}</span>
          <span className="mt-0.5 block text-paragraph-xs text-text-sub-600">
            <code className="font-mono">{provider.slug}</code> · {provider.models.length} available model{provider.models.length === 1 ? "" : "s"}
          </span>
        </span>
        <Badge.Root size="medium" variant="lighter" color={selectedModels.length ? "blue" : "gray"} className="shrink-0">
          {selectedModels.length} selected
        </Badge.Root>
      </label>

      <div className="border-t border-stroke-soft-200 p-3 space-y-2.5">
        <div className="flex items-center gap-2">
          <Input.Root size="xsmall" className="min-w-0 flex-1">
            <Input.Wrapper>
              <Input.Input
                value={customModelInput}
                onChange={(event) => onCustomModelInputChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && customModelInput.trim()) {
                    event.preventDefault();
                    onAddCustomModel();
                  }
                }}
                placeholder="Add custom model ID (e.g. gpt-5.4, claude-sonnet-4-5)…"
              />
            </Input.Wrapper>
          </Input.Root>
          <Button.Root
            type="button"
            variant="neutral"
            mode="stroke"
            size="xsmall"
            onClick={onAddCustomModel}
            disabled={!customModelInput.trim()}
          >
            <Button.Icon as={RiAddLine} />
            Add model
          </Button.Root>
        </div>

        {unavailableMessage ? (
          <Callout tone="warning">
            <p>{unavailableMessage}</p>
          </Callout>
        ) : (
          <>
            <button
              type="button"
              onClick={onToggleOpen}
              aria-expanded={open}
              className="flex h-9 w-full items-center justify-between gap-2 rounded-lg bg-bg-white-0 px-3 text-left text-paragraph-sm text-text-strong-950 shadow-regular-xs outline-none ring-1 ring-inset ring-stroke-soft-200 transition hover:bg-bg-weak-50 focus-visible:shadow-button-important-focus focus-visible:ring-stroke-strong-950"
            >
              <span className={cn(!selectedModels.length && "text-text-soft-400")}>
                {selectedModels.length ? `${selectedModels.length} model${selectedModels.length === 1 ? "" : "s"} selected` : `Select ${provider.name} models`}
              </span>
              <RiArrowDownSLine className={cn("size-5 text-text-soft-400 transition-transform duration-200", open && "rotate-180")} aria-hidden="true" />
            </button>

            {open && (
              <div className="mt-2 rounded-xl bg-bg-weak-50 p-2 ring-1 ring-inset ring-stroke-soft-200">
                <div className="flex items-center gap-2">
                  <Input.Root size="xsmall" className="min-w-0 flex-1">
                    <Input.Wrapper>
                      <Input.Icon as={RiSearchLine} />
                      <Input.Input value={search} onChange={(event) => onSearch(event.target.value)} aria-label={`Search ${provider.name} models`} placeholder={`Search ${provider.name} models…`} />
                    </Input.Wrapper>
                  </Input.Root>
                  <Button.Root type="button" variant="neutral" mode="ghost" size="xsmall" onClick={() => onToggleVisible(models)} disabled={!models.length}>
                    {allVisibleSelected ? "Clear shown" : "Select shown"}
                  </Button.Root>
                </div>
                <div className="mt-2 max-h-72 divide-y divide-stroke-soft-200 overflow-y-auto rounded-lg bg-bg-white-0 ring-1 ring-inset ring-stroke-soft-200">
                  {models.map((model) => (
                    <label key={model.id} className="flex cursor-pointer items-start gap-2.5 px-3 py-2.5 transition hover:bg-bg-weak-50">
                      <Checkbox.Root className="mt-1" checked={selectedModels.includes(model.id)} onCheckedChange={() => onToggleModel(model.id)} />
                      <AiBrandIcon identifier={model.id} label={model.name} className="size-7" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-label-sm text-text-strong-950">{model.name}</span>
                        <span className="mt-0.5 block truncate font-mono text-paragraph-xs text-text-sub-600">{model.id}</span>
                        {model.description && <span className="mt-1 line-clamp-2 block text-paragraph-xs text-text-soft-400">{model.description}</span>}
                        <span className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-paragraph-xs text-text-sub-600">
                          {model.outputModalities?.includes("image") && <span>Image</span>}
                          {model.outputModalities?.includes("text") && <span>Text</span>}
                          {formatContextLength(model.context_length) && <span>{formatContextLength(model.context_length)}</span>}
                          {formatPrice(model.pricing?.prompt) && <span>Input {formatPrice(model.pricing?.prompt)}</span>}
                          {formatPrice(model.pricing?.completion) && <span>Output {formatPrice(model.pricing?.completion)}</span>}
                        </span>
                      </span>
                    </label>
                  ))}
                  {!models.length && <p className="px-3 py-5 text-center text-paragraph-sm text-text-sub-600">No models match this search.</p>}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </article>
  );
}

/** A numbered setup step: the number turns into a tick once the step is done. */
function StepFrame({
  step,
  done,
  title,
  description,
  actions,
  children,
}: {
  step: number;
  done: boolean;
  title: string;
  description: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Frame>
      <header className="flex flex-col gap-3 px-4 pb-3 pt-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 gap-3">
          <span
            aria-label={done ? `Step ${step}, done` : `Step ${step}`}
            className={cn(
              "mt-px flex size-5 shrink-0 items-center justify-center rounded-full text-label-xs tabular-nums",
              done ? "bg-success-base text-static-white" : "bg-bg-white-0 text-text-sub-600 ring-1 ring-inset ring-stroke-soft-200",
            )}
          >
            {done ? <RiCheckLine className="size-3.5" aria-hidden="true" /> : step}
          </span>
          <div className="min-w-0">
            <h3 className="text-label-sm text-text-strong-950">{title}</h3>
            <div className="mt-0.5 max-w-2xl text-paragraph-xs text-text-sub-600">{description}</div>
          </div>
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2 pl-8 sm:pl-0">{actions}</div>}
      </header>
      <FramePanel>{children}</FramePanel>
    </Frame>
  );
}

const linkClass = "inline-flex items-center gap-1 rounded text-label-xs text-text-sub-600 underline decoration-stroke-sub-300 underline-offset-2 outline-none transition hover:text-text-strong-950 hover:decoration-text-strong-950 focus-visible:ring-2 focus-visible:ring-primary-base";

/** `children`: more of the AI provider page (Langfuse), shown after the steps and above the save bar. */
export default function ByokSettingsClient({ children }: { children?: React.ReactNode }) {
  const [settings, setSettings] = useState<Settings>(EMPTY_SETTINGS);
  const [catalog, setCatalog] = useState<Provider[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [showConnectForm, setShowConnectForm] = useState(false);

  // Connect form state
  const [formProviderKey, setFormProviderKey] = useState<AiProviderKey>("openai");
  const [accountName, setAccountName] = useState("");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [apiKey, setApiKey] = useState("");
  const [organization, setOrganization] = useState("");
  const [managementKey, setManagementKey] = useState("");
  const [formTestModel, setFormTestModel] = useState("gpt-5.4");
  const [formTesting, setFormTesting] = useState(false);
  const [formTestResult, setFormTestResult] = useState<TestCallResponse | null>(null);

  // Catalog & custom models state
  const [providerSearch, setProviderSearch] = useState("");
  const [modelSearch, setModelSearch] = useState<Record<string, string>>({});
  const [customModelInputs, setCustomModelInputs] = useState<Record<string, string>>({});
  const [openModelPicker, setOpenModelPicker] = useState<string | null>(null);

  // Live Test Call panel state (for connected account)
  const [testModelId, setTestModelId] = useState("");
  const [testPrompt, setTestPrompt] = useState("Reply with one short sentence confirming the API connection is working and state your model name.");
  const [testingCall, setTestingCall] = useState(false);
  const [testCallResult, setTestCallResult] = useState<TestCallResponse | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  function mergeSavedCustomModelsIntoCatalog(providers: Provider[], modelsByProvider: Record<string, string[]>): Provider[] {
    return providers.map((provider) => {
      const existingIds = new Set(provider.models.map((m) => m.id));
      const extraModels: Model[] = [];
      for (const savedId of modelsByProvider[provider.slug] ?? []) {
        if (!existingIds.has(savedId)) {
          existingIds.add(savedId);
          const isImage = /image|dall-e|flux/i.test(savedId);
          extraModels.push({
            id: savedId,
            name: savedId,
            description: `Custom ${provider.name} model`,
            supportedParameters: isImage ? [] : ["tools"],
            outputModalities: isImage ? ["image"] : ["text"],
          });
        }
      }
      return extraModels.length
        ? { ...provider, models: [...extraModels, ...provider.models] }
        : provider;
    });
  }

  async function loadCatalog(connectionId = settings.connectionId, currentModelsByProvider = settings.modelsByProvider) {
    const params = connectionId ? `?all=1&connectionId=${encodeURIComponent(connectionId)}` : "?all=1";
    const response = await fetch(`/api/ai/openrouter/models${params}`);
    const data = await readJson<CatalogResponse>(response);
    const merged = mergeSavedCustomModelsIntoCatalog(data.providers ?? [], currentModelsByProvider);
    setCatalog(merged);
    if (merged.length === 1) {
      setOpenModelPicker((prev) => prev ?? merged[0].slug);
    }
    return merged;
  }

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      fetch("/api/ai/openrouter/settings").then((response) => readJson<Settings>(response)),
      fetch("/api/grid/ai/providers/all/connections").then((response) => readJson<{ connections?: Connection[] }>(response)),
    ]).then(async ([saved, accountData]) => {
      if (cancelled) return;
      const normalized = normalizeSettings(saved);
      const loadedConnections = accountData.connections ?? [];
      setSettings(normalized);
      setConnections(loadedConnections);
      if (normalized.defaultModel?.modelId) {
        setTestModelId(normalized.defaultModel.modelId);
      }
      if (normalized.connectionId) {
        const response = await fetch(`/api/ai/openrouter/models?all=1&connectionId=${encodeURIComponent(normalized.connectionId)}`);
        const models = await readJson<CatalogResponse>(response);
        if (!cancelled) {
          const merged = mergeSavedCustomModelsIntoCatalog(models.providers ?? [], normalized.modelsByProvider);
          setCatalog(merged);
          if (merged.length === 1) setOpenModelPicker(merged[0].slug);
        }
      }
    }).catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load AI settings.");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  const selectedConnection = connections.find((connection) => connection.id === settings.connectionId);
  const isOpenRouterConnection = selectedConnection?.providerKey === "openrouter";

  const selectedPairs = useMemo(() => {
    const selectedProviders = new Set(settings.providers);
    return catalog.flatMap((provider) => selectedProviders.has(provider.slug)
      ? (settings.modelsByProvider[provider.slug] ?? [])
        .filter((modelId) => provider.models.some((model) => model.id === modelId))
        .map((modelId) => ({ provider: provider.slug, modelId }))
      : []);
  }, [catalog, settings.modelsByProvider, settings.providers]);

  const defaultPairs = useMemo(() => selectedPairs.filter((item) => {
    const model = catalog
      .find((provider) => provider.slug === item.provider)
      ?.models.find((candidate) => candidate.id === item.modelId);
    return (model?.outputModalities ?? ["text"]).includes("text")
      && (model?.supportedParameters ?? ["tools"]).includes("tools");
  }), [catalog, selectedPairs]);

  const filteredProviders = useMemo(() => {
    const query = providerSearch.trim().toLowerCase();
    return query
      ? catalog.filter((provider) => `${provider.name} ${provider.slug}`.toLowerCase().includes(query))
      : catalog;
  }, [catalog, providerSearch]);

  function updateSettings(patch: Partial<Settings>) {
    setSettings((current) => {
      const next = patch.connectionId !== undefined && patch.connectionId !== current.connectionId
        ? {
            ...current,
            providers: [],
            modelsByProvider: {},
            defaultModel: null,
            transcriptionModel: null,
            byokOnlyConfirmed: false,
            ...patch,
          }
        : { ...current, ...patch };
      const tm = next.transcriptionModel;
      return tm && !(next.providers.includes(tm.provider) && next.modelsByProvider[tm.provider]?.includes(tm.modelId))
        ? { ...next, transcriptionModel: null }
        : next;
    });
    setSuccess(null);
  }

  function toggleProvider(slug: string) {
    const enabled = settings.providers.includes(slug);
    const providers = enabled ? settings.providers.filter((provider) => provider !== slug) : [...settings.providers, slug];
    updateSettings({
      providers,
      defaultModel: enabled && settings.defaultModel?.provider === slug ? null : settings.defaultModel,
    });
  }

  function toggleModel(provider: string, modelId: string) {
    const current = settings.modelsByProvider[provider] ?? [];
    const selected = current.includes(modelId);
    const nextModels = selected ? current.filter((id) => id !== modelId) : [...current, modelId];
    const nextDefault =
      selected && settings.defaultModel?.provider === provider && settings.defaultModel.modelId === modelId
        ? null
        : !selected && !settings.defaultModel
        ? { provider, modelId }
        : settings.defaultModel;
    if (nextDefault?.modelId && !testModelId) {
      setTestModelId(nextDefault.modelId);
    }
    updateSettings({
      providers: selected || settings.providers.includes(provider) ? settings.providers : [...settings.providers, provider],
      modelsByProvider: { ...settings.modelsByProvider, [provider]: nextModels },
      defaultModel: nextDefault,
    });
  }

  function addCustomModel(providerSlug: string) {
    const raw = (customModelInputs[providerSlug] ?? "").trim();
    if (!raw) return;
    setCatalog((current) =>
      current.map((provider) => {
        if (provider.slug !== providerSlug) return provider;
        if (provider.models.some((m) => m.id === raw)) return provider;
        const isImage = /image|dall-e|flux/i.test(raw);
        return {
          ...provider,
          models: [
            {
              id: raw,
              name: raw,
              description: `Custom ${provider.name} model`,
              supportedParameters: isImage ? [] : ["tools"],
              outputModalities: isImage ? ["image"] : ["text"],
            },
            ...provider.models,
          ],
        };
      }),
    );
    const currentModels = settings.modelsByProvider[providerSlug] ?? [];
    const nextModels = currentModels.includes(raw) ? currentModels : [raw, ...currentModels];
    const nextDefault = settings.defaultModel ?? { provider: providerSlug, modelId: raw };
    setTestModelId(raw);
    updateSettings({
      providers: settings.providers.includes(providerSlug) ? settings.providers : [...settings.providers, providerSlug],
      modelsByProvider: { ...settings.modelsByProvider, [providerSlug]: nextModels },
      defaultModel: nextDefault,
      byokOnlyConfirmed: isOpenRouterConnection ? settings.byokOnlyConfirmed : true,
    });
    setCustomModelInputs((prev) => ({ ...prev, [providerSlug]: "" }));
    setOpenModelPicker(providerSlug);
  }

  function toggleVisibleModels(provider: Provider, models: Model[]) {
    const current = settings.modelsByProvider[provider.slug] ?? [];
    const allSelected = models.length > 0 && models.every((model) => current.includes(model.id));
    const nextModels = allSelected
      ? current.filter((id) => !models.some((model) => model.id === id))
      : [...new Set([...current, ...models.map((model) => model.id)])];
    updateSettings({
      providers: settings.providers.includes(provider.slug) ? settings.providers : [...settings.providers, provider.slug],
      modelsByProvider: { ...settings.modelsByProvider, [provider.slug]: nextModels },
      defaultModel: allSelected && settings.defaultModel?.provider === provider.slug && models.some((model) => model.id === settings.defaultModel?.modelId)
        ? null
        : settings.defaultModel,
    });
  }

  function setDefaultModel(value: string) {
    const selected = selectedPairs.find((item) => pairKey(item.provider, item.modelId) === value);
    if (selected) setTestModelId(selected.modelId);
    updateSettings({ defaultModel: selected ? selected : null });
  }

  function setTranscriptionModel(value: string) {
    const selected = selectedPairs.find((item) => pairKey(item.provider, item.modelId) === value);
    updateSettings({ transcriptionModel: selected ? selected : null });
  }

  async function refreshDiscovery() {
    setRefreshing(true);
    setError(null);
    try {
      await loadCatalog();
      setSuccess("Model list refreshed from provider endpoint.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not refresh models.");
    } finally {
      setRefreshing(false);
    }
  }

  function switchConnection(connectionId: string) {
    if (connectionId === settings.connectionId) return;
    const conn = connections.find((item) => item.id === connectionId);
    const isDirectProvider = conn?.providerKey === "openai" || conn?.providerKey === "anthropic";
    updateSettings({
      connectionId,
      providers: isDirectProvider && conn?.providerKey ? [conn.providerKey] : [],
      modelsByProvider: {},
      defaultModel: null,
      transcriptionModel: null,
      byokOnlyConfirmed: isDirectProvider,
    });
    setTestCallResult(null);
    setRefreshing(true);
    setError(null);
    setSuccess(null);
    void loadCatalog(connectionId, {})
      .then((loadedProviders) => {
        if (isDirectProvider && loadedProviders.length === 1) {
          const prov = loadedProviders[0];
          const firstModels = prov.models.slice(0, 6).map((m) => m.id);
          const firstDefault = firstModels[0] ? { provider: prov.slug, modelId: firstModels[0] } : null;
          if (firstDefault) setTestModelId(firstDefault.modelId);
          setSettings((curr) => ({
            ...curr,
            connectionId,
            providers: [prov.slug],
            modelsByProvider: { [prov.slug]: firstModels },
            defaultModel: firstDefault,
            byokOnlyConfirmed: true,
          }));
        }
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load models for this connection."))
      .finally(() => setRefreshing(false));
  }

  async function removeConnection(connectionId: string, event: React.MouseEvent) {
    event.stopPropagation();
    setError(null);
    try {
      const response = await fetch(`/api/grid/ai/connections/${encodeURIComponent(connectionId)}`, {
        method: "DELETE",
      });
      await readJson<{ ok?: boolean }>(response);
      const remaining = connections.filter((item) => item.id !== connectionId);
      setConnections(remaining);
      if (settings.connectionId === connectionId) {
        const nextConn = remaining[0];
        if (nextConn) {
          switchConnection(nextConn.id);
        } else {
          setSettings(EMPTY_SETTINGS);
          setCatalog([]);
        }
      }
      setSuccess("Connection removed.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete connection.");
    }
  }

  async function testUnsavedFormConnection() {
    if (!apiKey.trim()) {
      setError("Enter an API key first to run a test call.");
      return;
    }
    setFormTesting(true);
    setFormTestResult(null);
    setError(null);
    try {
      const response = await fetch("/api/ai/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerKey: formProviderKey,
          credentials: {
            baseUrl: baseUrl.trim(),
            apiKey: apiKey.trim(),
            organization: organization.trim(),
            managementKey: managementKey.trim(),
          },
          modelId: formTestModel.trim() || undefined,
        }),
      });
      const data = (await response.json().catch(() => null)) as TestCallResponse | null;
      if (!response.ok || !data?.ok) {
        setFormTestResult({
          ok: false,
          error: data?.error ?? `Test call failed (${response.status})`,
          latencyMs: data?.latencyMs,
        });
      } else {
        setFormTestResult(data);
      }
    } catch (cause) {
      setFormTestResult({
        ok: false,
        error: cause instanceof Error ? cause.message : "Test call failed",
      });
    } finally {
      setFormTesting(false);
    }
  }

  async function connectAccount() {
    if (!apiKey.trim()) {
      setError("Enter the API key.");
      return;
    }
    if (formProviderKey === "openrouter" && !managementKey.trim()) {
      setError("Enter both the inference API key and management API key for OpenRouter.");
      return;
    }
    setConnecting(true);
    setError(null);
    setSuccess(null);
    try {
      const option = providerOptionFor(formProviderKey);
      const credentials: Record<string, string> =
        formProviderKey === "openrouter"
          ? { apiKey: apiKey.trim(), managementKey: managementKey.trim() }
          : formProviderKey === "openai"
          ? {
              baseUrl: baseUrl.trim() || option.defaultBaseUrl,
              apiKey: apiKey.trim(),
              ...(organization.trim() ? { organization: organization.trim() } : {}),
            }
          : {
              baseUrl: baseUrl.trim() || option.defaultBaseUrl,
              apiKey: apiKey.trim(),
            };

      const defaultName =
        accountName.trim()
        || (formProviderKey === "openrouter"
          ? "OpenRouter account"
          : `${option.label} (${baseUrl.trim() || option.defaultBaseUrl})`);

      const response = await fetch(`/api/grid/ai/providers/${formProviderKey}/connections`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: defaultName,
          credentials,
        }),
      });
      const data = await readJson<{ connection?: Connection }>(response);
      if (!data.connection) throw new Error("The account was created without a connection record.");
      const createdConn = data.connection;
      setConnections((current) => [createdConn, ...current.filter((item) => item.id !== createdConn.id)]);

      const isDirectProvider = formProviderKey === "openai" || formProviderKey === "anthropic";
      const customSeedModel = formTestModel.trim();
      const seedModelsMap = isDirectProvider && customSeedModel ? { [formProviderKey]: [customSeedModel] } : {};

      const loadedProviders = await loadCatalog(createdConn.id, seedModelsMap);
      if (isDirectProvider && loadedProviders.length === 1) {
        const prov = loadedProviders[0];
        const initialSelected = [...new Set([
          ...(customSeedModel ? [customSeedModel] : []),
          ...prov.models.slice(0, 6).map((m) => m.id),
        ])];
        const chosenDefault = initialSelected[0]
          ? { provider: prov.slug, modelId: initialSelected[0] }
          : null;
        if (chosenDefault) setTestModelId(chosenDefault.modelId);
        setSettings({
          connectionId: createdConn.id,
          providers: [prov.slug],
          modelsByProvider: { [prov.slug]: initialSelected },
          defaultModel: chosenDefault,
          transcriptionModel: null,
          byokOnlyConfirmed: true,
        });
      } else {
        updateSettings({
          connectionId: createdConn.id,
          byokOnlyConfirmed: !isDirectProvider ? false : true,
        });
      }

      setApiKey("");
      setManagementKey("");
      setOrganization("");
      setAccountName("");
      setFormTestResult(null);
      setShowConnectForm(false);
      setSuccess(`${option.label} connected and verified.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not connect AI provider.");
    } finally {
      setConnecting(false);
    }
  }

  async function runSavedConnectionTestCall() {
    if (!settings.connectionId) {
      setError("Connect an AI provider first.");
      return;
    }
    const modelToTest = testModelId.trim() || settings.defaultModel?.modelId || selectedPairs[0]?.modelId || "";
    if (!modelToTest) {
      setError("Select or enter a model ID to test.");
      return;
    }
    setTestingCall(true);
    setTestCallResult(null);
    setError(null);
    try {
      const response = await fetch("/api/ai/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionId: settings.connectionId,
          modelId: modelToTest,
          prompt: testPrompt.trim() || undefined,
        }),
      });
      const data = (await response.json().catch(() => null)) as TestCallResponse | null;
      if (!response.ok || !data?.ok) {
        setTestCallResult({
          ok: false,
          modelId: modelToTest,
          latencyMs: data?.latencyMs,
          error: data?.error ?? `Test call failed (${response.status})`,
        });
      } else {
        setTestCallResult(data);
      }
    } catch (cause) {
      setTestCallResult({
        ok: false,
        modelId: modelToTest,
        error: cause instanceof Error ? cause.message : "Test call failed",
      });
    } finally {
      setTestingCall(false);
    }
  }

  async function save() {
    if (!settings.connectionId) return setError("Connect an AI provider account before saving.");
    if (!settings.providers.length) return setError("Enable at least one provider.");
    if (!selectedPairs.length) return setError("Select or add at least one model.");
    if (!settings.defaultModel) return setError("Choose a default model.");
    if (isOpenRouterConnection && !settings.byokOnlyConfirmed) {
      return setError("Confirm that OpenRouter shared capacity fallback is set to Never use shared capacity.");
    }
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const payload: Settings = {
        ...settings,
        byokOnlyConfirmed: isOpenRouterConnection ? settings.byokOnlyConfirmed : true,
      };
      const response = await fetch("/api/ai/openrouter/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const saved = await readJson<Settings>(response);
      setSettings(normalizeSettings(saved));
      setSuccess("AI settings saved.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save AI settings.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <FormSkeleton frames={3} />;

  const stepsDone = isOpenRouterConnection
    ? [Boolean(selectedConnection), selectedPairs.length > 0, Boolean(settings.defaultModel), settings.byokOnlyConfirmed]
    : [Boolean(selectedConnection), selectedPairs.length > 0, Boolean(settings.defaultModel)];
  const transcriptionValue = settings.transcriptionModel ? pairKey(settings.transcriptionModel.provider, settings.transcriptionModel.modelId) : "";
  const defaultValue = settings.defaultModel ? pairKey(settings.defaultModel.provider, settings.defaultModel.modelId) : "";
  const activeFormatOption = providerOptionFor(formProviderKey);

  return (
    <div className="space-y-4">
      {error && <Callout tone="error">{error}</Callout>}
      {success && <Callout tone="success">{success}</Callout>}

      <StepFrame
        step={1}
        done={stepsDone[0]}
        title="AI API provider & connection"
        description="Support OpenAI Responses (/v1/responses), Anthropic Messages (/v1/messages), and OpenRouter with custom BaseURL and API key."
      >
        {connections.length > 0 && (
          <div role="radiogroup" aria-label="AI provider connection" className="grid gap-2 sm:grid-cols-2">
            {connections.map((connection) => {
              const active = connection.id === settings.connectionId;
              const opt = providerOptionFor(connection.providerKey);
              return (
                <div
                  key={connection.id}
                  role="radio"
                  aria-checked={active}
                  tabIndex={0}
                  onClick={() => switchConnection(connection.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      switchConnection(connection.id);
                    }
                  }}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-3 rounded-xl px-3.5 py-3 text-left outline-none ring-inset transition focus-visible:shadow-button-important-focus",
                    active ? "bg-bg-white-0 ring-2 ring-primary-base" : "ring-1 ring-stroke-soft-200 hover:bg-bg-weak-50",
                  )}
                >
                  <AiBrandIcon identifier={connection.providerKey ?? "openai"} label={connection.name} className="size-9 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-label-sm text-text-strong-950">{connection.name}</span>
                      <Badge.Root size="small" variant="lighter" color={connection.providerKey === "anthropic" ? "orange" : connection.providerKey === "openai" ? "green" : "blue"}>
                        {opt.badge}
                      </Badge.Root>
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-paragraph-xs text-text-sub-600">
                      {connection.baseUrl || opt.defaultBaseUrl}
                    </span>
                  </span>
                  <button
                    type="button"
                    title="Delete connection"
                    onClick={(event) => void removeConnection(connection.id, event)}
                    className="rounded-md p-1.5 text-text-soft-400 transition hover:bg-bg-weak-50 hover:text-error-base"
                  >
                    <RiDeleteBinLine className="size-4" />
                  </button>
                  {active && <RiCheckLine className="size-5 shrink-0 text-primary-base" aria-hidden="true" />}
                </div>
              );
            })}
          </div>
        )}

        {!showConnectForm ? (
          <div className={cn("flex flex-wrap items-center gap-3", connections.length > 0 && "mt-4")}>
            <Button.Root
              type="button"
              variant={connections.length ? "neutral" : "primary"}
              mode={connections.length ? "stroke" : "filled"}
              size="small"
              onClick={() => {
                setShowConnectForm(true);
                setError(null);
                setFormTestResult(null);
              }}
            >
              <Button.Icon as={RiKey2Line} />
              {connections.length ? "Add another AI connection" : "Configure AI provider"}
            </Button.Root>
            {!selectedConnection && <p className="text-paragraph-xs text-text-sub-600">Configure OpenAI Responses or Anthropic Messages to get started.</p>}
          </div>
        ) : (
          <div className={cn("rounded-xl bg-bg-weak-50 p-4 ring-1 ring-inset ring-stroke-soft-200", connections.length > 0 && "mt-4")}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h4 className="text-label-sm text-text-strong-950">Add AI Provider Connection</h4>
                <p className="mt-0.5 text-paragraph-xs text-text-sub-600">
                  Choose the API protocol format (OpenAI Responses or Anthropic Messages), set your custom BaseURL and API Key, and test or connect.
                </p>
              </div>
            </div>

            {/* API Format Selector */}
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              {PROVIDER_FORMAT_OPTIONS.map((opt) => {
                const selected = formProviderKey === opt.key;
                return (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => {
                      setFormProviderKey(opt.key);
                      setBaseUrl(opt.defaultBaseUrl);
                      setFormTestModel(opt.defaultTestModel);
                      setFormTestResult(null);
                    }}
                    className={cn(
                      "flex flex-col items-start rounded-xl p-3 text-left ring-inset transition",
                      selected ? "bg-bg-white-0 ring-2 ring-primary-base shadow-regular-xs" : "bg-bg-white-0/60 ring-1 ring-stroke-soft-200 hover:bg-bg-white-0",
                    )}
                  >
                    <div className="flex w-full items-center justify-between gap-2">
                      <span className="text-label-sm text-text-strong-950">{opt.label}</span>
                      <Badge.Root size="small" variant="lighter" color={selected ? "blue" : "gray"}>
                        {opt.badge}
                      </Badge.Root>
                    </div>
                    <span className="mt-1 text-paragraph-xs text-text-sub-600">{opt.description}</span>
                  </button>
                );
              })}
            </div>

            {formProviderKey === "openrouter" ? (
              <div className="mt-4 grid gap-4 md:grid-cols-3">
                <Field label="Account name" htmlFor="or-name" optional>
                  <Input.Root size="small">
                    <Input.Wrapper>
                      <Input.Input id="or-name" value={accountName} onChange={(event) => setAccountName(event.target.value)} placeholder="OpenRouter production" />
                    </Input.Wrapper>
                  </Input.Root>
                </Field>
                <Field label="Inference API key" htmlFor="or-key" required>
                  <Input.Root size="small">
                    <Input.Wrapper>
                      <Input.Input id="or-key" type="password" autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-or-v1-…" />
                    </Input.Wrapper>
                  </Input.Root>
                </Field>
                <Field label="Management API key" htmlFor="or-mgmt" required>
                  <Input.Root size="small">
                    <Input.Wrapper>
                      <Input.Input id="or-mgmt" type="password" autoComplete="new-password" value={managementKey} onChange={(event) => setManagementKey(event.target.value)} placeholder="sk-or-mgmt-…" />
                    </Input.Wrapper>
                  </Input.Root>
                </Field>
              </div>
            ) : (
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <Field label="Connection name" htmlFor="ai-conn-name" optional>
                  <Input.Root size="small">
                    <Input.Wrapper>
                      <Input.Input
                        id="ai-conn-name"
                        value={accountName}
                        onChange={(event) => setAccountName(event.target.value)}
                        placeholder={`${activeFormatOption.label} (Production)`}
                      />
                    </Input.Wrapper>
                  </Input.Root>
                </Field>
                <Field
                  label="Base URL"
                  htmlFor="ai-base-url"
                  description={
                    formProviderKey === "openai"
                      ? "Requests POST to {BaseURL}/responses (or /v1/responses) and GET {BaseURL}/models"
                      : "Requests POST to {BaseURL}/v1/messages and GET {BaseURL}/v1/models"
                  }
                >
                  <Input.Root size="small">
                    <Input.Wrapper>
                      <Input.Input
                        id="ai-base-url"
                        value={baseUrl}
                        onChange={(event) => setBaseUrl(event.target.value)}
                        placeholder={activeFormatOption.defaultBaseUrl}
                      />
                    </Input.Wrapper>
                  </Input.Root>
                </Field>
                <Field label="API Key" htmlFor="ai-api-key" required>
                  <Input.Root size="small">
                    <Input.Wrapper>
                      <Input.Input
                        id="ai-api-key"
                        type="password"
                        autoComplete="new-password"
                        value={apiKey}
                        onChange={(event) => setApiKey(event.target.value)}
                        placeholder={activeFormatOption.keyPlaceholder}
                      />
                    </Input.Wrapper>
                  </Input.Root>
                </Field>
                <Field label="Test Model ID (for test call & initial selection)" htmlFor="ai-test-model" optional>
                  <Input.Root size="small">
                    <Input.Wrapper>
                      <Input.Input
                        id="ai-test-model"
                        value={formTestModel}
                        onChange={(event) => setFormTestModel(event.target.value)}
                        placeholder={activeFormatOption.defaultTestModel}
                      />
                    </Input.Wrapper>
                  </Input.Root>
                </Field>
              </div>
            )}

            {formTestResult && (
              <div
                className={cn(
                  "mt-3 rounded-xl p-3 text-paragraph-xs ring-1 ring-inset",
                  formTestResult.ok
                    ? "bg-success-lighter/60 text-text-strong-950 ring-success-base/30"
                    : "bg-error-lighter/60 text-error-base ring-error-base/30",
                )}
              >
                {formTestResult.ok ? (
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2 font-medium">
                      <span className="text-success-base">✓ Test Call Succeeded</span>
                      <span>· {formTestResult.apiFormat}</span>
                      <span>· Model: <code className="font-mono">{formTestResult.modelId}</code></span>
                      {formTestResult.latencyMs !== undefined && <span>· {formTestResult.latencyMs} ms</span>}
                      {formTestResult.discoveredModelCount !== undefined && (
                        <span>· Discovered {formTestResult.discoveredModelCount} models via /v1/models</span>
                      )}
                    </div>
                    {formTestResult.endpoint && (
                      <div className="font-mono text-[11px] text-text-sub-600">Endpoint: {formTestResult.endpoint}</div>
                    )}
                    <div className="rounded bg-bg-white-0/80 px-2.5 py-1.5 font-mono text-[12px] text-text-strong-950">
                      {formTestResult.replyText}
                    </div>
                  </div>
                ) : (
                  <div>
                    <strong className="font-medium">Test Call Failed:</strong> {formTestResult.error}
                    {formTestResult.latencyMs !== undefined && ` (${formTestResult.latencyMs} ms)`}
                  </div>
                )}
              </div>
            )}

            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <Button.Root
                type="button"
                variant="neutral"
                mode="stroke"
                size="small"
                onClick={() => {
                  setShowConnectForm(false);
                  setFormTestResult(null);
                }}
                disabled={connecting || formTesting}
              >
                Cancel
              </Button.Root>
              <Button.Root
                type="button"
                variant="neutral"
                mode="stroke"
                size="small"
                onClick={() => void testUnsavedFormConnection()}
                disabled={connecting || formTesting || !apiKey.trim()}
              >
                <Button.Icon as={formTesting ? RiLoader4Line : RiPlayCircleLine} className={cn(formTesting && "animate-spin")} />
                {formTesting ? "Testing call…" : "Test call"}
              </Button.Root>
              <Button.Root
                type="button"
                variant="primary"
                mode="filled"
                size="small"
                onClick={() => void connectAccount()}
                disabled={connecting || formTesting || !apiKey.trim() || (formProviderKey === "openrouter" && !managementKey.trim())}
              >
                {connecting && <Button.Icon as={RiLoader4Line} className="animate-spin" />}
                {connecting ? "Verifying & saving…" : "Verify & connect"}
              </Button.Root>
            </div>
          </div>
        )}
      </StepFrame>

      <StepFrame
        step={2}
        done={stepsDone[1]}
        title="Models & discovery"
        description="Models discovered from /v1/models and built-in presets. You can also add any custom model ID supported by your BaseURL."
        actions={
          <Button.Root type="button" variant="neutral" mode="stroke" size="xsmall" onClick={() => void refreshDiscovery()} disabled={refreshing || !settings.connectionId}>
            <Button.Icon as={refreshing ? RiLoader4Line : RiRefreshLine} className={cn(refreshing && "animate-spin")} />
            {refreshing ? "Refreshing…" : "Refresh models"}
          </Button.Root>
        }
      >
        {catalog.length > 1 && (
          <Input.Root size="small" className="mb-3">
            <Input.Wrapper>
              <Input.Icon as={RiSearchLine} />
              <Input.Input type="search" aria-label="Search providers" value={providerSearch} onChange={(event) => setProviderSearch(event.target.value)} placeholder="Search providers…" />
            </Input.Wrapper>
          </Input.Root>
        )}
        {filteredProviders.length ? (
          <div className={cn("grid gap-3", filteredProviders.length > 1 && "xl:grid-cols-2", refreshing && "opacity-60")} aria-busy={refreshing || undefined}>
            {filteredProviders.map((provider) => (
              <ProviderModelPicker
                key={provider.slug}
                provider={provider}
                enabled={settings.providers.includes(provider.slug)}
                selectedModels={settings.modelsByProvider[provider.slug] ?? []}
                open={openModelPicker === provider.slug}
                search={modelSearch[provider.slug] ?? ""}
                customModelInput={customModelInputs[provider.slug] ?? ""}
                onCustomModelInputChange={(value) => setCustomModelInputs((prev) => ({ ...prev, [provider.slug]: value }))}
                onAddCustomModel={() => addCustomModel(provider.slug)}
                onToggleProvider={() => toggleProvider(provider.slug)}
                onToggleOpen={() => setOpenModelPicker((current) => current === provider.slug ? null : provider.slug)}
                onSearch={(value) => setModelSearch((current) => ({ ...current, [provider.slug]: value }))}
                onToggleModel={(modelId) => toggleModel(provider.slug, modelId)}
                onToggleVisible={(models) => toggleVisibleModels(provider, models)}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            compact
            icon={RiSearchLine}
            title={providerSearch.trim() ? "No providers match" : "No AI connection active"}
            description={providerSearch.trim() ? "Try another search." : "Connect an OpenAI Responses, Anthropic Messages, or OpenRouter account in Step 1."}
          />
        )}
      </StepFrame>

      <StepFrame
        step={3}
        done={stepsDone[2]}
        title="Default model & live test call"
        description="Every internal AI task (CRM reply classification, email drafting, formula generation) uses the default model."
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <Field
              label="Default model"
              description={defaultPairs.length ? "Selected text models enabled above." : "Select or add at least one model in Step 2."}
            >
              <Select.Root size="small" value={defaultValue} onValueChange={(value) => setDefaultModel(value)} disabled={!defaultPairs.length && !defaultValue}>
                <Select.Trigger aria-label="Default model">
                  <Select.Value placeholder="Select a default model" />
                </Select.Trigger>
                <Select.Content>
                  <Select.Item value="">Select a default model</Select.Item>
                  {defaultPairs.map((item) => {
                    const provider = catalog.find((candidate) => candidate.slug === item.provider);
                    const model = provider?.models.find((candidate) => candidate.id === item.modelId);
                    return (
                      <Select.Item key={pairKey(item.provider, item.modelId)} value={pairKey(item.provider, item.modelId)}>
                        {provider?.name ?? item.provider} · {model?.name ?? item.modelId}
                      </Select.Item>
                    );
                  })}
                </Select.Content>
              </Select.Root>
            </Field>

            <Field
              label="Call transcription model"
              description="Optional model used to transcribe WhatsApp call recordings."
              className="mt-4"
            >
              <Select.Root size="small" value={transcriptionValue} onValueChange={(value) => setTranscriptionModel(value)} disabled={!selectedPairs.length && !transcriptionValue}>
                <Select.Trigger aria-label="Call transcription model">
                  <Select.Value placeholder="Off" />
                </Select.Trigger>
                <Select.Content>
                  <Select.Item value="">Off</Select.Item>
                  {selectedPairs.map((item) => {
                    const provider = catalog.find((candidate) => candidate.slug === item.provider);
                    const model = provider?.models.find((candidate) => candidate.id === item.modelId);
                    return (
                      <Select.Item key={pairKey(item.provider, item.modelId)} value={pairKey(item.provider, item.modelId)}>
                        {provider?.name ?? item.provider} · {model?.name ?? item.modelId}
                      </Select.Item>
                    );
                  })}
                </Select.Content>
              </Select.Root>
            </Field>
          </div>

          {/* Live Test Call Panel */}
          <div className="rounded-xl bg-bg-weak-50 p-3.5 ring-1 ring-inset ring-stroke-soft-200">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h4 className="text-label-sm text-text-strong-950">Test Call (测试调用)</h4>
                <p className="text-paragraph-xs text-text-sub-600">
                  Send a real request to verify the active connection and model response.
                </p>
              </div>
              <Button.Root
                type="button"
                variant="primary"
                mode="stroke"
                size="xsmall"
                onClick={() => void runSavedConnectionTestCall()}
                disabled={testingCall || !settings.connectionId}
              >
                <Button.Icon as={testingCall ? RiLoader4Line : RiPlayCircleLine} className={cn(testingCall && "animate-spin")} />
                {testingCall ? "Calling…" : "Run test call"}
              </Button.Root>
            </div>

            <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
              <Field label="Model ID to test" htmlFor="saved-test-model">
                <Input.Root size="xsmall">
                  <Input.Wrapper>
                    <Input.Input
                      id="saved-test-model"
                      value={testModelId || settings.defaultModel?.modelId || ""}
                      onChange={(event) => setTestModelId(event.target.value)}
                      placeholder={settings.defaultModel?.modelId || "e.g. gpt-5.4 or claude-sonnet-4-5"}
                    />
                  </Input.Wrapper>
                </Input.Root>
              </Field>
              <Field label="Test prompt" htmlFor="saved-test-prompt">
                <Input.Root size="xsmall">
                  <Input.Wrapper>
                    <Input.Input
                      id="saved-test-prompt"
                      value={testPrompt}
                      onChange={(event) => setTestPrompt(event.target.value)}
                      placeholder="Reply with OK..."
                    />
                  </Input.Wrapper>
                </Input.Root>
              </Field>
            </div>

            {testCallResult && (
              <div
                className={cn(
                  "mt-3 rounded-lg p-2.5 text-paragraph-xs ring-1 ring-inset",
                  testCallResult.ok
                    ? "bg-bg-white-0 text-text-strong-950 ring-success-base/40"
                    : "bg-error-lighter/60 text-error-base ring-error-base/40",
                )}
              >
                {testCallResult.ok ? (
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge.Root size="small" variant="lighter" color="green">200 OK</Badge.Root>
                      <span className="font-medium">{testCallResult.apiFormat}</span>
                      <span className="font-mono text-text-sub-600">{testCallResult.modelId}</span>
                      {testCallResult.latencyMs !== undefined && <span className="text-text-sub-600">· {testCallResult.latencyMs} ms</span>}
                      {(testCallResult.usage?.inputTokens !== undefined || testCallResult.usage?.outputTokens !== undefined) && (
                        <span className="text-text-sub-600">
                          · Tokens: {testCallResult.usage?.inputTokens ?? 0} in / {testCallResult.usage?.outputTokens ?? 0} out
                        </span>
                      )}
                    </div>
                    {testCallResult.endpoint && (
                      <div className="truncate font-mono text-[11px] text-text-soft-400">
                        POST {testCallResult.endpoint}
                      </div>
                    )}
                    <div className="mt-1 rounded bg-bg-weak-50 px-2.5 py-1.5 font-mono text-[12px] text-text-strong-950">
                      {testCallResult.replyText}
                    </div>
                  </div>
                ) : (
                  <div>
                    <strong>Error:</strong> {testCallResult.error}
                    {testCallResult.latencyMs !== undefined && ` (${testCallResult.latencyMs} ms)`}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </StepFrame>

      {isOpenRouterConnection && (
        <StepFrame
          step={4}
          done={stepsDone[3] ?? false}
          title="Shared capacity"
          description="AgentSDR only sends requests on your own provider keys."
        >
          <label className={cn("flex cursor-pointer items-start gap-3 rounded-xl p-3.5 ring-1 ring-inset transition", settings.byokOnlyConfirmed ? "ring-stroke-soft-200" : "bg-warning-lighter ring-warning-light")}>
            <Checkbox.Root className="mt-0.5" checked={settings.byokOnlyConfirmed} onCheckedChange={(checked) => updateSettings({ byokOnlyConfirmed: checked === true })} />
            <span className="min-w-0">
              <span className="block text-label-sm text-text-strong-950">Never use shared capacity</span>
              <span className="mt-1 block text-paragraph-xs text-text-sub-600">
                In every enabled provider&apos;s OpenRouter BYOK settings, set Shared capacity fallback to <strong className="font-medium text-text-strong-950">Never use shared capacity on this provider</strong>.
              </span>
              <a href={BYOK_URL} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()} className={cn(linkClass, "mt-2")}>
                Review OpenRouter BYOK settings<RiExternalLinkLine className="size-3.5" aria-hidden="true" />
              </a>
            </span>
          </label>
        </StepFrame>
      )}

      {children}

      <div className="sticky bottom-0 z-10 -mx-4 -mb-5 flex flex-wrap items-center justify-between gap-3 border-t border-stroke-soft-200 bg-bg-white-0/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:-mb-6 sm:px-6 lg:-mx-8 lg:-mb-7 lg:px-8">
        <p className="text-paragraph-xs text-text-sub-600">
          {selectedConnection ? (
            <>
              Using <span className="text-text-strong-950">{selectedConnection.name}</span> · {stepsDone.filter(Boolean).length} of {stepsDone.length} steps done
            </>
          ) : (
            "Connect an AI provider account to continue"
          )}
        </p>
        <Button.Root
          type="button"
          variant="primary"
          mode="filled"
          size="small"
          onClick={() => void save()}
          disabled={saving || !settings.connectionId || (isOpenRouterConnection && !settings.byokOnlyConfirmed)}
        >
          {saving && <Button.Icon as={RiLoader4Line} className="animate-spin" />}
          {saving ? "Saving…" : "Save AI settings"}
        </Button.Root>
      </div>
    </div>
  );
}
