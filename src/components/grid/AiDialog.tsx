"use client";

import type { Dispatch, SetStateAction } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { createPortal } from "react-dom";
import {
  RiAddLine,
  RiArrowDownSLine,
  RiCheckLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiLoader4Line,
  RiMagicLine,
  RiSearchLine,
} from "@remixicon/react";
import type { GridColumn } from "@/lib/grid/schema";
import type {
  AiConfig,
  AiExample,
  AiOutputField,
  AiUseCase,
  StaticColumnType,
} from "@/lib/grid/types";
import {
  AI_USE_CASES,
  getAiModel,
  getAiProvider,
  modelsForUseCase,
} from "@/lib/ai/catalog";
import type { AiModelChoice } from "@/lib/ai/catalog";
import { AiBrandIcon } from "@/components/ai/AiBrandIcon";
import { DocsLink } from "@/components/page/DocsLink";
import * as Select from "@/components/alignui/select";

type OpenRouterChoice = AiModelChoice & { upstreamProvider: string; upstreamProviderName: string };

const OUTPUT_TYPES: Array<{ value: StaticColumnType; label: string }> = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "boolean", label: "Checkbox" },
  { value: "date", label: "Date" },
  { value: "url", label: "URL" },
  { value: "email", label: "Email" },
  { value: "image", label: "Image" },
  { value: "json", label: "JSON" },
];

const PICKER_WIDTH = 260;
const PICKER_MAX_HEIGHT = 220;

/** Output field keys are stable and machine-facing; names are not. */
function fieldKey(name: string, taken: Set<string>) {
  const base =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "field";
  let key = base;
  let n = 2;
  while (taken.has(key)) key = `${base}_${n++}`;
  return key;
}

/**
 * Viewport position of the caret at `index` in a textarea: a hidden mirror
 * with the same box and font wraps the text the same way, and a marker span
 * lands where the caret would.
 */
function caretRect(el: HTMLTextAreaElement, index: number) {
  const style = getComputedStyle(el);
  const mirror = document.createElement("div");
  for (const prop of [
    "boxSizing", "width", "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing",
    "lineHeight", "textTransform", "wordSpacing", "tabSize",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "borderStyle",
  ] as const) mirror.style[prop] = style[prop];
  Object.assign(mirror.style, {
    position: "absolute", top: "0", left: "-9999px", visibility: "hidden",
    whiteSpace: "pre-wrap", overflowWrap: "break-word", overflow: "hidden",
  });
  mirror.textContent = el.value.slice(0, index);
  const marker = document.createElement("span");
  marker.textContent = el.value.slice(index) || ".";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const box = el.getBoundingClientRect();
  const top = box.top + parseFloat(style.borderTopWidth) + marker.offsetTop - el.scrollTop;
  const left = box.left + parseFloat(style.borderLeftWidth) + marker.offsetLeft - el.scrollLeft;
  const lineHeight = parseFloat(style.lineHeight) || 20;
  document.body.removeChild(mirror);
  return { top, left, bottom: top + lineHeight };
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="rounded-xl border border-stroke-soft-200">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between rounded-t-xl bg-bg-weak-50 px-4 py-3 text-left text-[14px] font-semibold text-text-strong-950"
      >
        {title}
        <RiArrowDownSLine className={`size-4 text-text-soft-400 transition ${open ? "rotate-180" : ""}`} />
      </button>
      {open && <div className="space-y-4 p-4">{children}</div>}
    </div>
  );
}

export default function AiDialog({
  open,
  tableId,
  columns,
  firstRowIds,
  column: columnProp,
  afterColumnId,
  beforeColumnId,
  onClose,
  onSaved,
}: {
  open: boolean;
  tableId: string;
  columns: GridColumn[];
  firstRowIds: string[];
  /** Present when editing an existing AI column. */
  column?: GridColumn;
  afterColumnId?: string;
  beforeColumnId?: string;
  onClose: () => void;
  onSaved: (activeJobs?: number) => void | Promise<void>;
}) {
  // A column created by this dialog: if the run that follows fails, the dialog
  // stays open and a second save must update this column, not create another.
  const [created, setCreated] = useState<GridColumn | null>(null);
  const column = columnProp ?? created ?? undefined;
  const saved = column?.config as AiConfig | undefined;
  const savedKeys = new Set(Object.keys(saved?.outputColumns ?? {}));

  const mounted = useSyncExternalStore(() => () => {}, () => true, () => false);
  const [useCase, setUseCaseRaw] = useState<AiUseCase>(saved?.useCase ?? "web-research");
  const [providerKey, setProviderKeyRaw] = useState(saved?.providerKey ?? "");
  const [modelKey, setModelKeyRaw] = useState(saved?.modelKey ?? "");
  const [upstreamProvider, setUpstreamProviderRaw] = useState(saved?.upstreamProvider ?? "");
  const [connectionId, setConnectionIdRaw] = useState(saved?.connectionId ?? "");
  const [prompt, setPromptRaw] = useState(saved?.prompt ?? "");
  const [outputFormat, setOutputFormatRaw] = useState<"fields" | "json_schema">(
    saved?.outputFormat ?? "fields",
  );
  const [outputs, setOutputsRaw] = useState<AiOutputField[]>(
    saved?.outputs?.length ? saved.outputs : [{ key: "response", name: "response", type: "text" }],
  );
  const [schemaText, setSchemaTextRaw] = useState(
    saved?.jsonSchema ? JSON.stringify(saved.jsonSchema, null, 2) : "",
  );
  const [examples, setExamplesRaw] = useState<AiExample[]>(saved?.examples ?? []);
  const [autoRun, setAutoRun] = useState(column ? column.autoRun : true);
  const [conditionEnabled, setConditionEnabled] = useState(Boolean(saved?.runCondition));
  const [runCondition, setRunCondition] = useState(saved?.runCondition ?? "");
  const [delayEnabled, setDelayEnabled] = useState(Boolean(saved?.delaySeconds));
  const [delaySeconds, setDelaySeconds] = useState(saved?.delaySeconds ?? 0);

  const [openRouterChoices, setOpenRouterChoices] = useState<OpenRouterChoice[]>([]);
  // Starts true when the dialog mounts open (it always does, see GridClient), so the list shows "Loading models…".
  const [modelsLoading, setModelsLoading] = useState(open);
  const [defaultModel, setDefaultModel] = useState<{ provider: string; modelId: string } | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // An error banner describes the last attempt: editing any of the fields it
  // could be about dismisses it, so it never outlives the fix.
  const clearing = <T,>(set: Dispatch<SetStateAction<T>>): Dispatch<SetStateAction<T>> =>
    (value) => {
      set(value);
      setError(null);
    };
  const setUseCase = clearing(setUseCaseRaw);
  const setProviderKey = clearing(setProviderKeyRaw);
  const setModelKey = clearing(setModelKeyRaw);
  const setUpstreamProvider = clearing(setUpstreamProviderRaw);
  const setPrompt = clearing(setPromptRaw);
  const setOutputFormat = clearing(setOutputFormatRaw);
  const setOutputs = clearing(setOutputsRaw);
  const setSchemaText = clearing(setSchemaTextRaw);
  const setExamples = clearing(setExamplesRaw);
  /** The open column picker: where its trigger starts and what follows it. */
  const [picker, setPicker] = useState<{ start: number; query: string } | null>(null);
  const [pickerIndex, setPickerIndex] = useState(0);
  const [pickerAt, setPickerAt] = useState<{ top?: number; bottom?: number; left: number } | null>(null);
  const pickerMenuRef = useRef<HTMLDivElement>(null);

  const promptRef = useRef<HTMLTextAreaElement>(null);

  // The column's own outputs would make its prompt depend on itself.
  const ownOutputIds = useMemo(() => new Set(
    column
      ? columns
          .filter((c) => c.type === "ai_output"
            && (c.config as { sourceColumnKey?: string }).sourceColumnKey === column.key)
          .map((c) => c.id)
      : [],
  ), [columns, column]);

  const pickerColumns = useMemo(() => {
    if (!picker) return [];
    const query = picker.query.toLowerCase();
    return columns.filter((c) =>
      c.id !== column?.id
      && !ownOutputIds.has(c.id)
      && (c.name.toLowerCase().includes(query) || c.key.toLowerCase().includes(query)));
  }, [picker, columns, column?.id, ownOutputIds]);

  // Anchor the picker at its trigger, below the line — or above it when the
  // line sits too near the bottom of the window for the list to fit.
  const pickerStart = picker?.start;
  useLayoutEffect(() => {
    const el = promptRef.current;
    if (pickerStart === undefined || !el) return setPickerAt(null);
    const caret = caretRect(el, pickerStart);
    const left = Math.max(8, Math.min(caret.left, window.innerWidth - PICKER_WIDTH - 8));
    setPickerAt(caret.bottom + 4 + PICKER_MAX_HEIGHT > window.innerHeight
      ? { bottom: window.innerHeight - caret.top + 4, left }
      : { top: caret.bottom + 4, left });
  }, [pickerStart]);

  // The list is fixed to the window, so it would float off its line once the
  // panel scrolls; close it instead (scrolling the list itself is fine).
  useEffect(() => {
    if (pickerStart === undefined) return;
    const close = (event: Event) => {
      if (!pickerMenuRef.current?.contains(event.target as Node)) setPicker(null);
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [pickerStart]);

  // A token that names no column interpolates to "" — silently, per row — so
  // say so while the prompt is still being written.
  const unknownTokens = useMemo(() => {
    const keys = new Set(columns.map((c) => c.key));
    const found = [...prompt.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]);
    return [...new Set(found)].filter((key) => !keys.has(key));
  }, [prompt, columns]);

  // Tokens carry the column's key, which a rename does not change, so
  // {{name}} can mean the column now called "Domain" — spell that out.
  const usedColumns = columns.filter((c) => new RegExp(`\\{\\{\\s*${c.key}\\s*\\}\\}`).test(prompt));

  const choices = useMemo<OpenRouterChoice[]>(() => [
    ...openRouterChoices
      .filter((choice) => choice.model.useCases.includes(useCase))
      .map((choice) => ({
        ...choice,
        model: { ...choice.model, producesImages: useCase === "image-generation" },
      })),
  ], [openRouterChoices, useCase]);
  const provider = getAiProvider(providerKey);
  const selectedChoice = choices.find((choice) => choice.model.key === modelKey && choice.upstreamProvider === upstreamProvider);
  const model = selectedChoice?.model
    ?? getAiModel(providerKey, modelKey, useCase);

  // Once per open: the use case only filters the list, which happens here.
  // The loading flag is raised while rendering the open transition (not in the effect).
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setModelsLoading(true);
  }
  useEffect(() => {
    if (!open) return;
    void fetch("/api/ai/openrouter/models").then(async (response) => {
      const body = await response.json() as {
        error?: string;
        models?: Array<{ id: string; name: string; description?: string; provider: string; providerName: string; providerKey?: string; outputModalities?: string[] }>;
        settings?: { connectionId?: string | null; defaultModel?: { provider: string; modelId: string } | null };
        connection?: { providerKey?: string };
      };
      if (!response.ok) return setError(body.error ?? "Could not load configured AI models");
      const fallbackProviderKey = body.connection?.providerKey ?? "openrouter";
      const next = (body.models ?? []).flatMap((model) => {
        const resolvedProvider = getAiProvider(model.providerKey ?? fallbackProviderKey);
        if (!resolvedProvider) return [];
        const modalities = model.outputModalities ?? ["text"];
        const useCases: AiUseCase[] = [];
        if (modalities.includes("text")) useCases.push("content", "web-research");
        if (modalities.includes("image")) useCases.push("image-generation");
        return [{
          provider: resolvedProvider,
          upstreamProvider: model.provider,
          upstreamProviderName: model.providerName,
          model: {
            key: model.id,
            modelId: model.id,
            name: model.name,
            description: model.description ?? `${resolvedProvider.name} model`,
            useCases,
            creditsPerRun: 0,
          },
        }];
      });
      setOpenRouterChoices(next);
      setConnectionIdRaw((current) => body.settings?.connectionId || current);
      setDefaultModel(body.settings?.defaultModel ?? null);
    }).finally(() => setModelsLoading(false));
  }, [open]);

  // A new column starts on the AI Settings default when it suits the use
  // case — without replacing a model the person already picked.
  // Adjusted while rendering: once the choice is made, modelKey is set and this stops.
  const defaultChoice = defaultModel
    ? openRouterChoices.find((choice) =>
        choice.model.key === defaultModel.modelId
        && choice.upstreamProvider === defaultModel.provider
        && choice.model.useCases.includes(useCase))
    : undefined;
  if (!saved?.modelKey && !modelKey && defaultChoice && defaultModel) {
    setProviderKey(defaultChoice.provider.key);
    setModelKey(defaultModel.modelId);
    setUpstreamProvider(defaultModel.provider);
  }

  /**
   * "{{" anywhere, or "/" at the start of a word (so a URL's slashes do not
   * open it), opens the column picker; the letters typed after it filter.
   */
  function syncPicker(value: string, caret: number) {
    const before = value.slice(0, caret);
    const braces = /\{\{\s*([A-Za-z0-9_]*)$/.exec(before);
    const slash = /(^|\s)\/([A-Za-z0-9_]*)$/.exec(before);
    const next = braces
      ? { start: braces.index, query: braces[1] }
      : slash
        ? { start: slash.index + slash[1].length, query: slash[2] }
        : null;
    if (next?.start !== picker?.start || next?.query !== picker?.query) setPickerIndex(0);
    setPicker(next);
  }

  /** Replaces the picker's trigger with {{key}} — the same token syntax formulas use. */
  function insertColumn(key: string) {
    const el = promptRef.current;
    const token = `{{${key}}}`;
    if (!el || !picker) {
      setPrompt((p) => p + token);
    } else {
      const caret = el.selectionStart ?? prompt.length;
      // Swallow a "}}" the person already typed after the trigger.
      const after = prompt.slice(caret).replace(/^\s*\}\}/, "");
      const before = prompt.slice(0, picker.start) + token;
      setPrompt(before + after);
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(before.length, before.length);
      });
    }
    setPicker(null);
  }

  function setOutput(index: number, patch: Partial<AiOutputField>) {
    setOutputs((current) =>
      current.map((field, i) => {
        if (i !== index) return field;
        const next = { ...field, ...patch };
        // A saved field keeps its key: the server matches a renamed output to
        // its existing column by key. A new field's key follows its name,
        // because the key is the property name the model is asked to fill.
        if (patch.name !== undefined && !savedKeys.has(field.key)) {
          next.key = fieldKey(patch.name || "field", new Set(current.filter((_, j) => j !== i).map((f) => f.key)));
        }
        return next;
      }),
    );
  }

  async function save(runFirstTen: boolean) {
    if (!model || !selectedChoice) return setError("Select a model enabled in AI Settings.");
    if (!connectionId) return setError(`Connect a ${provider?.name ?? "provider"} account first.`);
    if (!prompt.trim()) return setError("Write a prompt.");
    if (outputFormat === "fields" && !model.producesImages) {
      const names = outputs.map((field) => field.name.trim().toLowerCase());
      if (names.some((name) => !name)) return setError("Every output needs a name.");
      if (new Set(names).size !== names.length) return setError("Output names must be different from each other.");
    }
    // The grid can hand over its coverage row, which is not a real row.
    const runRowIds = firstRowIds.filter((id) => id !== "__coverage").slice(0, 10);
    if (runFirstTen && runRowIds.length === 0) {
      return setError("There are no rows on this page to run. Use Save, then run once rows are loaded.");
    }

    let jsonSchema: Record<string, unknown> | undefined;
    if (outputFormat === "json_schema") {
      try {
        jsonSchema = JSON.parse(schemaText);
      } catch {
        return setError("The JSON Schema is not valid JSON.");
      }
    }

    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/grid/tables/${tableId}/ai`, {
        method: column ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          columnId: column?.id,
          useCase,
          providerKey,
          modelKey,
          upstreamProvider,
          connectionId,
          prompt,
          outputFormat,
          outputs,
          jsonSchema,
          examples: examples.filter((e) => e.response.trim()),
          autoRun,
          runCondition: conditionEnabled ? runCondition : undefined,
          delaySeconds: delayEnabled ? delaySeconds : 0,
          afterColumnId,
          beforeColumnId,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return setError(data.error ?? "Could not save this AI column");
      if (!column && Array.isArray(data.columns) && data.columns[0]) setCreated(data.columns[0] as GridColumn);

      let activeJobs: number | undefined;
      if (runFirstTen) {
        const run = await fetch(`/api/grid/tables/${tableId}/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ columnKey: data.primaryColumnKey, rowIds: runRowIds }),
        });
        const runData = await run.json().catch(() => ({}));
        if (!run.ok) {
          // The column exists now: refresh the grid and keep the dialog open on it.
          await onSaved();
          return setError(runData.error ?? "Saved, but the run could not start");
        }
        activeJobs = runData.activeJobs;
      }
      setError(null);
      await onSaved(activeJobs);
      onClose();
    } catch {
      setError("Could not save this AI column");
    } finally {
      setBusy(false);
    }
  }

  if (!open || !mounted) return null;

  const filteredChoices = modelSearch.trim()
    ? choices.filter(({ provider: p, model: m, upstreamProviderName }) =>
        `${p.name} ${upstreamProviderName} ${m.name}`.toLowerCase().includes(modelSearch.trim().toLowerCase()),
      )
    : choices;

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-slate-900/35 backdrop-blur-[1px]" onClick={busy ? undefined : onClose} />

      <div className="relative z-10 flex h-full w-full max-w-[560px] flex-col bg-bg-white-0 shadow-2xl">
        {/* header */}
        <div className="flex shrink-0 items-center justify-between border-b border-stroke-soft-200 px-5 py-3.5">
          <div className="flex items-center gap-2">
            <RiMagicLine className="size-5 text-violet-500" />
            <h2 className="text-[15px] font-semibold text-text-strong-950">Use AI</h2>
          </div>
          <button type="button" onClick={onClose} disabled={busy} className="rounded-md p-1 text-text-soft-400 hover:bg-bg-weak-50 disabled:opacity-50">
            <RiCloseLine className="size-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          {/* ---- use case ---- */}
          <div>
            <label className="text-[13px] font-semibold text-text-strong-950">Use case</label>
            <div className="mt-2 space-y-1.5">
              {AI_USE_CASES.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => {
                    setUseCase(item.key);
                    const current = openRouterChoices.find((choice) =>
                      choice.model.key === modelKey && choice.upstreamProvider === upstreamProvider,
                    );
                    if (current && !current.model.useCases.includes(item.key)) {
                      setProviderKey("");
                      setModelKey("");
                      setUpstreamProvider("");
                    }
                  }}
                  className={`flex w-full items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition ${
                    useCase === item.key
                      ? "border-blue-400 bg-blue-50/60 dark:bg-blue-500/10"
                      : "border-stroke-soft-200 hover:bg-bg-weak-50"
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium text-text-strong-950">{item.name}</span>
                    <span className="mt-0.5 block text-[12px] leading-4 text-text-sub-600">{item.description}</span>
                  </span>
                  {useCase === item.key && <RiCheckLine className="mt-0.5 size-4 shrink-0 text-blue-600 dark:text-blue-400" />}
                </button>
              ))}
            </div>
          </div>

          {/* ---- model ---- */}
          <div>
            <label className="text-[13px] font-semibold text-text-strong-950">Model</label>
            <button
              type="button"
              onClick={() => setModelOpen((v) => !v)}
              className="mt-2 flex w-full items-center gap-2 rounded-lg border border-stroke-soft-200 px-3 py-2.5 text-left text-[13px]"
            >
              {model && provider ? (
                <>
                  <AiBrandIcon identifier={model.modelId} label={model.name} className="size-6" />
                  <span className="flex-1 truncate text-text-strong-950">{selectedChoice?.upstreamProviderName ?? provider.name} &gt; {model.name}</span>
                  <span className="shrink-0 rounded-full border border-stroke-soft-200 px-2 py-0.5 text-[11px] text-text-sub-600">{model.creditsPerRun}</span>
                </>
              ) : (
                <span className="flex-1 text-text-soft-400">{modelsLoading ? "Loading models…" : "Select a model"}</span>
              )}
              <RiArrowDownSLine className="size-4 shrink-0 text-text-soft-400" />
            </button>

            {modelOpen && (
              <div className="mt-1 overflow-hidden rounded-lg border border-stroke-soft-200 shadow-lg">
                <label className="flex items-center gap-2 border-b border-stroke-soft-200 px-3 py-2">
                  <RiSearchLine className="size-4 shrink-0 text-text-soft-400" />
                  <input
                    autoFocus
                    value={modelSearch}
                    onChange={(e) => setModelSearch(e.target.value)}
                    placeholder="Search models..."
                    className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-text-soft-400"
                  />
                </label>
                <div className="max-h-[280px] overflow-y-auto">
                  {filteredChoices.map(({ provider: p, model: m, upstreamProvider: choiceProvider, upstreamProviderName }) => (
                    <button
                      key={`${p.key}:${choiceProvider}:${m.key}`}
                      type="button"
                      onClick={() => {
                        setProviderKey(p.key);
                        setModelKey(m.key);
                        setUpstreamProvider(choiceProvider);
                        setModelOpen(false);
                        setModelSearch("");
                      }}
                      className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition hover:bg-bg-weak-50"
                    >
                      <AiBrandIcon identifier={m.modelId} label={m.name} className="mt-0.5 size-7" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] font-medium text-text-strong-950">{upstreamProviderName} · {m.name}</span>
                        <span className="mt-0.5 block text-[12px] leading-4 text-text-sub-600">{m.description}</span>
                      </span>
                      <span className="shrink-0 rounded-full border border-stroke-soft-200 px-2 py-0.5 text-[11px] text-text-sub-600">{m.creditsPerRun}</span>
                    </button>
                  ))}
                  {!filteredChoices.length && (
                    <p className="px-3 py-6 text-center text-[13px] text-text-sub-600">No models match that search.</p>
                  )}
                </div>
              </div>
            )}
          </div>

          {provider && !connectionId && (
            <div className="rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 p-4 text-[13px] text-amber-900 dark:text-amber-400">
              OpenRouter is not configured. Connect it and choose allowed BYOK models in <Link className="font-semibold underline" href="/settings/ai">AI Settings</Link>.{" "}
              <DocsLink page="integrations/openrouter#set-it-up" appearance="inline" className="ml-1 text-current underline" />
            </div>
          )}

          {/* ---- prompt ---- */}
          <Section title="Configuration">
            <div>
              <label className="text-[13px] font-medium text-text-strong-950">Prompt</label>
              <div className="relative mt-1.5">
                <textarea
                  ref={promptRef}
                  value={prompt}
                  rows={5}
                  onChange={(e) => {
                    setPrompt(e.target.value);
                    syncPicker(e.target.value, e.target.selectionStart ?? e.target.value.length);
                  }}
                  onSelect={(e) => syncPicker(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)}
                  onBlur={() => setPicker(null)}
                  onKeyDown={(e) => {
                    if (!picker || pickerColumns.length === 0) return;
                    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                      e.preventDefault();
                      const step = e.key === "ArrowDown" ? 1 : -1;
                      setPickerIndex((i) => (i + step + pickerColumns.length) % pickerColumns.length);
                    } else if (e.key === "Enter" || e.key === "Tab") {
                      e.preventDefault();
                      insertColumn(pickerColumns[Math.min(pickerIndex, pickerColumns.length - 1)].key);
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      setPicker(null);
                    }
                  }}
                  placeholder="For the person with linkedin url {{linkedin_url}}, find their current job title."
                  className="w-full resize-y rounded-lg border border-stroke-soft-200 px-3 py-2.5 text-[13px] leading-5 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:focus:ring-blue-500/20"
                />
                {picker && pickerAt && pickerColumns.length > 0 && createPortal(
                  <div
                    ref={pickerMenuRef}
                    style={{ ...pickerAt, width: PICKER_WIDTH, maxHeight: PICKER_MAX_HEIGHT }}
                    className="fixed z-[60] overflow-y-auto rounded-lg border border-stroke-soft-200 bg-bg-white-0 py-1 shadow-lg"
                  >
                    {pickerColumns.map((c, index) => (
                      <button
                        key={c.id}
                        type="button"
                        // Keep focus (and the caret) in the textarea, so its
                        // blur does not close the picker before the click lands.
                        onMouseDown={(e) => e.preventDefault()}
                        onMouseEnter={() => setPickerIndex(index)}
                        onClick={() => insertColumn(c.key)}
                        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-text-strong-950 ${index === pickerIndex ? "bg-bg-weak-50" : ""}`}
                      >
                        <span className="truncate">{c.name}</span>
                        <span className="ml-auto shrink-0 font-mono text-[11px] text-text-soft-400">{`{{${c.key}}}`}</span>
                      </button>
                    ))}
                  </div>,
                  document.body,
                )}
              </div>
              {unknownTokens.length > 0 && (
                <p className="mt-1.5 text-[12px] text-amber-700 dark:text-amber-400">
                  {unknownTokens.map((key) => `{{${key}}}`).join(", ")}{" "}
                  {unknownTokens.length === 1 ? "is not a column" : "are not columns"} in this table, so{" "}
                  {unknownTokens.length === 1 ? "it would be" : "they would be"} sent blank. Replace with a column below.
                </p>
              )}
              {usedColumns.length > 0 && (
                <p className="mt-1.5 text-[12px] text-text-sub-600">
                  {usedColumns.map((c, index) => (
                    <span key={c.id}>
                      {index > 0 && ", "}
                      <code className="font-mono">{`{{${c.key}}}`}</code> = {c.name}
                    </span>
                  ))}
                </p>
              )}
              <p className="mt-1.5 text-[12px] text-text-soft-400">
                Type <kbd className="rounded bg-bg-weak-50 px-1 font-mono">/</kbd> or{" "}
                <kbd className="rounded bg-bg-weak-50 px-1 font-mono">{"{{"}</kbd> to insert a column.
              </p>
            </div>
          </Section>

          {/* ---- outputs ---- */}
          <Section title="Define outputs">
            {model?.producesImages ? (
              <p className="text-[13px] text-text-sub-600">
                Image models return a single image, which lands in one image column.
              </p>
            ) : (
              <>
                <div className="flex gap-4">
                  {(["fields", "json_schema"] as const).map((value) => (
                    <label key={value} className="flex items-center gap-2 text-[13px] text-text-strong-950">
                      <input type="radio" checked={outputFormat === value} onChange={() => setOutputFormat(value)} className="size-4" />
                      {value === "fields" ? "Fields" : "JSON Schema"}
                    </label>
                  ))}
                </div>

                {outputFormat === "fields" ? (
                  <div className="space-y-2">
                    {outputs.map((field, index) => (
                      <div key={index} className="flex items-center gap-2">
                        <input
                          value={field.name}
                          onChange={(e) => setOutput(index, { name: e.target.value })}
                          placeholder="response"
                          className="min-w-0 flex-1 rounded-lg border border-stroke-soft-200 px-3 py-2 text-[13px] outline-none focus:border-blue-400"
                        />
                        <Select.Root size="small" value={field.type} onValueChange={(next) => setOutput(index, { type: next as StaticColumnType })}>
                          <Select.Trigger aria-label="Output type" className="w-[140px] shrink-0">
                            <Select.Value />
                          </Select.Trigger>
                          <Select.Content>
                            {OUTPUT_TYPES.map((t) => (
                              <Select.Item key={t.value} value={t.value}>{t.label}</Select.Item>
                            ))}
                          </Select.Content>
                        </Select.Root>
                        <button
                          type="button"
                          disabled={outputs.length === 1}
                          onClick={() => setOutputs((c) => c.filter((_, i) => i !== index))}
                          aria-label={`Remove ${field.name}`}
                          className="shrink-0 rounded-md p-1.5 text-text-soft-400 transition hover:bg-bg-weak-50 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-30"
                        >
                          <RiDeleteBinLine className="size-4" />
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() =>
                        setOutputs((c) => [
                          ...c,
                          { key: fieldKey("field", new Set(c.map((f) => f.key))), name: "", type: "text" },
                        ])
                      }
                      className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-stroke-sub-300 py-2 text-[13px] font-medium text-text-sub-600 transition hover:bg-bg-weak-50"
                    >
                      <RiAddLine className="size-4" />Add output
                    </button>
                  </div>
                ) : (
                  <textarea
                    value={schemaText}
                    rows={8}
                    onChange={(e) => setSchemaText(e.target.value)}
                    placeholder='{ "type": "object", "properties": { "name": { "type": "string" } } }'
                    className="w-full resize-y rounded-lg border border-stroke-soft-200 px-3 py-2.5 font-mono text-[12px] outline-none focus:border-blue-400"
                  />
                )}
              </>
            )}
          </Section>

          {/* ---- examples ---- */}
          <Section title="Examples">
            <p className="text-[13px] text-text-sub-600">
              Give examples of how the AI should respond — <span className="text-text-soft-400">optional</span>
            </p>
            {examples.map((example, index) => (
              <div key={index} className="rounded-lg border border-stroke-soft-200 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-[13px] font-medium text-text-strong-950">Custom example</span>
                  <button
                    type="button"
                    onClick={() => setExamples((c) => c.filter((_, i) => i !== index))}
                    aria-label="Remove example"
                    className="rounded-md p-1 text-text-soft-400 transition hover:bg-red-50 dark:hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400"
                  >
                    <RiDeleteBinLine className="size-4" />
                  </button>
                </div>
                {columns.filter((c) => prompt.includes(`{{${c.key}}}`)).map((c) => (
                  <div key={c.id} className="mt-2">
                    <label className="text-[12px] text-text-sub-600">{c.name}:</label>
                    <input
                      value={example.inputs[c.key] ?? ""}
                      onChange={(e) =>
                        setExamples((all) =>
                          all.map((item, i) =>
                            i === index ? { ...item, inputs: { ...item.inputs, [c.key]: e.target.value } } : item,
                          ),
                        )
                      }
                      className="mt-1 w-full rounded-lg border border-stroke-soft-200 px-3 py-1.5 text-[13px] outline-none focus:border-blue-400"
                    />
                  </div>
                ))}
                <label className="mt-2 block text-[12px] text-text-sub-600">Expected response:</label>
                <textarea
                  value={example.response}
                  rows={2}
                  onChange={(e) =>
                    setExamples((all) => all.map((item, i) => (i === index ? { ...item, response: e.target.value } : item)))
                  }
                  className="mt-1 w-full resize-y rounded-lg border border-stroke-soft-200 px-3 py-1.5 text-[13px] outline-none focus:border-blue-400"
                />
              </div>
            ))}
            <button
              type="button"
              onClick={() => setExamples((c) => [...c, { inputs: {}, response: "" }])}
              className="flex items-center gap-1.5 rounded-lg border border-stroke-soft-200 px-3 py-1.5 text-[13px] font-medium text-text-strong-950 transition hover:bg-bg-weak-50"
            >
              <RiAddLine className="size-4" />Add examples
            </button>
          </Section>

          {/* ---- run settings ---- */}
          <Section title="Run settings">
            <label className="flex items-center justify-between">
              <span className="text-[13px] font-medium text-text-strong-950">Auto-run</span>
              <input type="checkbox" checked={autoRun} onChange={(e) => setAutoRun(e.target.checked)} className="size-4" />
            </label>

            <label className="flex items-start gap-2">
              <input type="checkbox" checked={conditionEnabled} onChange={(e) => setConditionEnabled(e.target.checked)} className="mt-0.5 size-4" />
              <span>
                <span className="block text-[13px] text-text-strong-950">Add run condition</span>
                <span className="block text-[12px] text-text-sub-600">Only run if this formula resolves to true.</span>
              </span>
            </label>
            {conditionEnabled && (
              <input
                value={runCondition}
                onChange={(e) => setRunCondition(e.target.value)}
                placeholder="{{email}} != &quot;&quot;"
                className="w-full rounded-lg border border-stroke-soft-200 px-3 py-2 font-mono text-[12px] outline-none focus:border-blue-400"
              />
            )}

            <div>
              <span className="text-[13px] font-medium text-text-strong-950">Delay run</span>
              <div className="mt-1.5 space-y-1.5">
                <label className="flex items-center gap-2 text-[13px] text-text-strong-950">
                  <input type="radio" checked={!delayEnabled} onChange={() => setDelayEnabled(false)} className="size-4" />
                  Run immediately
                </label>
                <label className="flex items-center gap-2 text-[13px] text-text-strong-950">
                  <input type="radio" checked={delayEnabled} onChange={() => setDelayEnabled(true)} className="size-4" />
                  Run after delay
                </label>
                {delayEnabled && (
                  <input
                    type="number"
                    min={0}
                    max={600}
                    value={delaySeconds}
                    onChange={(e) => setDelaySeconds(Number(e.target.value))}
                    className="w-[140px] rounded-lg border border-stroke-soft-200 px-3 py-1.5 text-[13px] outline-none focus:border-blue-400"
                  />
                )}
              </div>
            </div>
          </Section>
        </div>

        {/* footer */}
        {error && <p role="alert" className="mx-5 mb-3 mt-3 shrink-0 rounded-lg bg-red-50 dark:bg-red-500/10 px-3 py-2 text-[13px] text-red-700 dark:text-red-400">{error}</p>}
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-stroke-soft-200 px-5 py-3.5">
          <span className="rounded-full border border-stroke-soft-200 px-2.5 py-1 text-[12px] text-text-sub-600">
            {model ? `${model.creditsPerRun} / row` : "—"}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void save(false)}
              disabled={busy}
              className="rounded-lg border border-stroke-soft-200 px-3 py-2 text-[13px] font-medium text-text-strong-950 transition hover:bg-bg-weak-50 disabled:opacity-50"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => void save(true)}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-[13px] font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"
            >
              {busy && <RiLoader4Line className="size-4 animate-spin" />}
              Save and run 10 rows
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
