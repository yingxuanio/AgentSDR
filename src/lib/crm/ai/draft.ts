import "server-only";

import type { OpenRouterModelSelection } from "@/lib/ai/openrouter-types";
import { completeStructuredWithOpenRouter, type StructuredCompletionTrace } from "@/lib/ai/server/structuredCompletion";
import { getPrompt } from "@/lib/observability/langfuse";
import type { PromptName } from "@/lib/prompts/registry";
import { fillPrompt } from "@/lib/prompts/template";
import { codeTemplates, type PromptTemplates } from "@/lib/prompts/templates";
import { resolveTemplates } from "@/lib/prompts/templates.server";
import { crmChannelLabel } from "../channels";
import type { CrmChannel } from "../schema";
import type {
  ClassificationCompanyProfile,
  ClassificationMessage,
  ClassificationPersonProfile,
} from "./types";

const DEFAULT_TIMEOUT_MS = 60_000;
// Reasoning models think inside this budget before the call; see structuredCompletion.
const DEFAULT_MAX_OUTPUT_TOKENS = 6_000;
const MAX_TEXT_LENGTH = 100_000;
const OUTPUT_KEYS = new Set(["subject", "bodyText", "bodyHtml"]);

/** The prompts a draft is built from (src/lib/prompts/crm.ts). */
export const DRAFT_PROMPTS = [
  "crm/draft-system",
  "crm/draft-channel-rules",
  "crm/draft-user",
] as const satisfies readonly PromptName[];
export type DraftTemplates = PromptTemplates<(typeof DRAFT_PROMPTS)[number]>;
const CODE_DRAFT_TEMPLATES = codeTemplates(DRAFT_PROMPTS);

type Scalar = string | number | boolean | null;

export type DraftSequenceStep = {
  id?: string | null;
  name: string;
  purpose?: string | null;
  position: number;
  stepType: "reply" | "follow_up";
  subjectTemplate?: string | null;
  bodyTemplate?: string | null;
  aiInstructions: string;
  knowledgeTags?: readonly string[];
};

export type DraftKnowledgeExcerpt = {
  documentVersionId: string;
  documentId?: string | null;
  title: string;
  kind?: string | null;
  excerpt: string;
  excerptHash: string;
  rank: number;
};

export type AcceptedDraftClassification = {
  categoryKey: string;
  subcategoryKey?: string | null;
  reasoning: string;
};

/**
 * Why a draft is being rewritten. Without this a regeneration is the same
 * prompt run twice, which mostly returns the same draft; with it the model
 * sees what it wrote and what the reviewer wants changed.
 */
export type DraftRevisionRequest = {
  previousDraft?: { subject: string | null; bodyText?: string | null } | null;
  reviewerFeedback: string;
};

/** A stage a person moved the record to because of something off-thread. */
export type DraftStageChange = {
  stage: string;
  /** ISO 8601. */
  occurredAt: string;
  note: string | null;
};

/** Who the draft goes out as: the owner of the sending mailbox, LinkedIn account or number. */
export type DraftSender = {
  /** Null when the account carries no usable name. */
  name: string | null;
  account: string;
};

/** The current moment, in the organization's time zone. */
export type DraftNow = {
  iso: string;
  timeZone: string;
  /** e.g. "Thursday, 29 October 2026 at 10:15". */
  local: string;
};

export type DraftPromptInput = {
  channel: CrmChannel;
  sequenceStep: DraftSequenceStep;
  knowledge: readonly DraftKnowledgeExcerpt[];
  person: ClassificationPersonProfile;
  company?: ClassificationCompanyProfile | null;
  recentConversation: readonly ClassificationMessage[];
  acceptedClassification: AcceptedDraftClassification;
  stageChange?: DraftStageChange | null;
  mergeVariables?: Readonly<Record<string, Scalar>>;
  revision?: DraftRevisionRequest | null;
  /** crm_settings.draft_instructions; appended to the system prompt. */
  instructions?: string | null;
  sender?: DraftSender | null;
  now?: DraftNow | null;
  /** Steps in the sequence; absent for a draft no sequence covers. */
  totalSteps?: number | null;
};

/** What the caller adds to the draft's Langfuse trace (record ids; never secrets). */
export type DraftTraceContext = Pick<StructuredCompletionTrace, "metadata" | "sessionId">;

/**
 * Where a sequence step sits, and how many of our messages have gone out
 * since the person last wrote — so a follow-up knows what it would repeat.
 */
export function draftSequenceProgress(
  step: Pick<DraftSequenceStep, "position" | "stepType">,
  totalSteps: number,
  conversation: readonly Pick<ClassificationMessage, "direction">[],
) {
  let ourMessagesSinceTheirLastReply = 0;
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    if (conversation[index]!.direction === "inbound") break;
    ourMessagesSinceTheirLastReply += 1;
  }
  return {
    step: step.position,
    totalSteps,
    stepType: step.stepType,
    isLastStep: step.position >= totalSteps,
    ourMessagesSinceTheirLastReply,
  };
}

export type BuiltDraftPrompt = {
  systemPrompt: string;
  userPrompt: string;
  snapshot: Record<string, unknown>;
  jsonSchema: Record<string, unknown>;
};

export type DraftCompletionInput = BuiltDraftPrompt & {
  /** Rejects an attempt by throwing; the completion may then try again. */
  accept?: (text: string) => void;
  requestedModel?: OpenRouterModelSelection;
  timeoutMs: number;
  maxOutputTokens: number;
  signal?: AbortSignal;
  trace?: StructuredCompletionTrace;
};

export type DraftCompletionResult = {
  text: string;
  provider: string;
  model: string;
  request: unknown;
  response: unknown;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
};

export type DraftCompletion = (
  input: DraftCompletionInput,
) => Promise<DraftCompletionResult>;

export type GenerateCrmDraftInput = DraftPromptInput & {
  requestedModel?: OpenRouterModelSelection;
  timeoutMs?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  trace?: DraftTraceContext;
};

export type CrmDraftContent = {
  subject: string | null;
  bodyText: string;
  bodyHtml: string | null;
};

export type GeneratedCrmDraft = CrmDraftContent & {
  provider: string;
  model: string;
  request: Record<string, unknown>;
  response: unknown;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  prompt: BuiltDraftPrompt;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cleanRequiredText(value: string, label: string): string {
  const clean = value.trim();
  if (!clean) throw new Error(`${label} is required`);
  if (clean.length > MAX_TEXT_LENGTH) throw new Error(`${label} is too long`);
  return clean;
}

function cleanOptionalText(value: string | null | undefined): string | null {
  if (value == null) return null;
  const clean = value.trim();
  if (!clean) return null;
  if (clean.length > MAX_TEXT_LENGTH) throw new Error("CRM draft context text is too long");
  return clean;
}

function isoDate(value: Date | string, label: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} has an invalid sentAt value`);
  return date.toISOString();
}

function sortedRecord<T>(value: Readonly<Record<string, T>> | undefined): Record<string, T> {
  return Object.fromEntries(
    Object.entries(value ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function profileSnapshot<T extends ClassificationPersonProfile | ClassificationCompanyProfile>(
  profile: T,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(profile)
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [
        key,
        key === "attributes" && isPlainObject(value)
          ? sortedRecord(value as Record<string, Scalar>)
          : value,
      ]),
  );
}

function normalizeConversation(messages: readonly ClassificationMessage[]) {
  const ids = new Set<string>();
  return messages.map((message) => {
    const id = cleanRequiredText(message.id, "CRM draft conversation message id");
    if (ids.has(id)) throw new Error(`CRM draft conversation contains duplicate message ${id}`);
    ids.add(id);
    return {
      id,
      channel: message.channel,
      direction: message.direction,
      sentAt: isoDate(message.sentAt, `CRM draft conversation message ${id}`),
      subject: cleanOptionalText(message.subject),
      bodyText: cleanRequiredText(message.bodyText, `CRM draft conversation message ${id} body`),
      ...(message.participants ? { participants: message.participants } : {}),
    };
  }).sort((left, right) => (
    left.sentAt.localeCompare(right.sentAt) || left.id.localeCompare(right.id)
  ));
}

function normalizeKnowledge(knowledge: readonly DraftKnowledgeExcerpt[]) {
  const versions = new Set<string>();
  return knowledge.map((item) => {
    const documentVersionId = cleanRequiredText(
      item.documentVersionId,
      "Knowledge document version id",
    );
    if (versions.has(documentVersionId)) {
      throw new Error(`CRM draft Knowledge repeats document version ${documentVersionId}`);
    }
    versions.add(documentVersionId);
    if (!Number.isFinite(item.rank) || item.rank < 0) {
      throw new Error(`Knowledge document version ${documentVersionId} has an invalid rank`);
    }
    return {
      documentVersionId,
      documentId: cleanOptionalText(item.documentId),
      title: cleanRequiredText(item.title, "Knowledge title"),
      kind: cleanOptionalText(item.kind),
      excerpt: cleanRequiredText(item.excerpt, "Knowledge excerpt"),
      excerptHash: cleanRequiredText(item.excerptHash, "Knowledge excerpt hash"),
      rank: item.rank,
    };
  });
}

export function draftJsonSchema(channel: CrmChannel): Record<string, unknown> {
  switch (channel) {
    case "email":
      return {
        type: "object",
        additionalProperties: false,
        required: ["subject", "bodyText", "bodyHtml"],
        properties: {
          subject: { type: "string", minLength: 1, maxLength: 998 },
          bodyText: { type: "string", minLength: 1 },
          bodyHtml: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
        },
      };
    case "linkedin":
    case "whatsapp":
      return {
        type: "object",
        additionalProperties: false,
        required: ["subject", "bodyText", "bodyHtml"],
        properties: {
          subject: { type: "null" },
          bodyText: { type: "string", minLength: 1 },
          bodyHtml: { type: "null" },
        },
      };
    default:
      throw new Error(`Unsupported CRM draft channel: ${String(channel satisfies never)}`);
  }
}

/** What the draft model is told about the channel it is writing for: crm/draft-channel-rules, one rule per line. */
export function draftChannelConstraints(
  channel: CrmChannel,
  template: string = CODE_DRAFT_TEMPLATES["crm/draft-channel-rules"],
): string[] {
  switch (channel) {
    case "email":
    case "linkedin":
    case "whatsapp":
      break;
    default:
      throw new Error(`Unsupported CRM draft channel: ${String(channel satisfies never)}`);
  }
  return fillPrompt(template, { email: channel === "email", linkedin: channel === "linkedin", whatsapp: channel === "whatsapp" })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function buildDraftPrompt(input: DraftPromptInput, templates: DraftTemplates = CODE_DRAFT_TEMPLATES): BuiltDraftPrompt {
  const step = input.sequenceStep;
  if (!Number.isInteger(step.position) || step.position < 1) {
    throw new Error("CRM draft sequence step position must be a positive integer");
  }
  const name = cleanRequiredText(step.name, "CRM draft sequence step name");
  const aiInstructions = cleanRequiredText(
    step.aiInstructions,
    "CRM draft sequence step AI instructions",
  );
  if (step.position === 1 && step.stepType !== "reply") {
    throw new Error("The first CRM sequence step must be a reply");
  }
  if (step.position > 1 && step.stepType !== "follow_up") {
    throw new Error("CRM sequence steps after the first must be follow-ups");
  }

  const categoryKey = cleanRequiredText(
    input.acceptedClassification.categoryKey,
    "Accepted CRM classification category",
  );
  const reasoning = cleanRequiredText(
    input.acceptedClassification.reasoning,
    "Accepted CRM classification reasoning",
  );
  const mergeVariables = sortedRecord(input.mergeVariables);
  const constraints = draftChannelConstraints(input.channel, templates["crm/draft-channel-rules"]);

  const snapshot: Record<string, unknown> = {
    channel: input.channel,
    channelConstraints: constraints,
    sequenceStep: {
      id: cleanOptionalText(step.id),
      name,
      purpose: cleanOptionalText(step.purpose) ?? name,
      position: step.position,
      stepType: step.stepType,
      subjectTemplate: cleanOptionalText(step.subjectTemplate),
      bodyTemplate: cleanOptionalText(step.bodyTemplate),
      aiInstructions,
      knowledgeTags: [...new Set((step.knowledgeTags ?? []).map((tag) => tag.trim()).filter(Boolean))]
        .sort((left, right) => left.localeCompare(right)),
    },
    knowledge: normalizeKnowledge(input.knowledge),
    person: profileSnapshot(input.person),
    company: input.company ? profileSnapshot(input.company) : null,
    recentConversation: normalizeConversation(input.recentConversation),
    acceptedClassification: {
      categoryKey,
      subcategoryKey: cleanOptionalText(input.acceptedClassification.subcategoryKey),
      reasoning,
    },
    mergeVariables,
  };
  if (input.sender) {
    snapshot.sender = { name: cleanOptionalText(input.sender.name), account: cleanRequiredText(input.sender.account, "CRM draft sender account") };
  }
  if (input.now) snapshot.now = { ...input.now };
  if (input.totalSteps && Number.isInteger(input.totalSteps) && input.totalSteps >= step.position) {
    snapshot.sequenceProgress = draftSequenceProgress(step, input.totalSteps, input.recentConversation);
  }
  const previousBodyText = cleanOptionalText(input.revision?.previousDraft?.bodyText);
  const previousSubject = cleanOptionalText(input.revision?.previousDraft?.subject);
  const revision = input.revision
    ? {
        ...(previousBodyText || previousSubject
          ? {
              previousDraft: {
                subject: previousSubject,
                bodyText: previousBodyText,
              },
            }
          : {}),
        reviewerFeedback: cleanRequiredText(input.revision.reviewerFeedback, "CRM draft reviewer feedback"),
      }
    : null;
  if (revision) snapshot.revisionRequest = revision;
  if (input.stageChange) {
    snapshot.stageChange = {
      stage: cleanRequiredText(input.stageChange.stage, "CRM stage change stage"),
      occurredAt: input.stageChange.occurredAt,
      note: cleanOptionalText(input.stageChange.note),
    };
  }

  return {
    systemPrompt: fillPrompt(templates["crm/draft-system"], { instructions: input.instructions?.trim() }),
    userPrompt:
      revision && !previousBodyText
        ? [
            "Prepare the current CRM sequence-step draft from this server-assembled context. revisionRequest.reviewerFeedback is an instruction from the operator — follow it within the step and channel constraints:",
            JSON.stringify(snapshot, null, 2),
          ].join("\n\n")
        : fillPrompt(templates["crm/draft-user"], {
            revision: Boolean(revision),
            context_json: JSON.stringify(snapshot, null, 2),
          }),
    snapshot,
    jsonSchema: draftJsonSchema(input.channel),
  };
}

function parseStrictJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("CRM draft generator returned malformed JSON");
  }
}

export function validateDraftOutput(raw: unknown, channel: CrmChannel): CrmDraftContent {
  const value = typeof raw === "string" ? parseStrictJson(raw) : raw;
  if (!isPlainObject(value)) throw new Error("CRM draft output must be a JSON object");

  const unknown = Object.keys(value).filter((key) => !OUTPUT_KEYS.has(key));
  if (unknown.length) throw new Error(`CRM draft generator returned unknown field(s): ${unknown.join(", ")}`);
  if (!Object.hasOwn(value, "bodyText")) throw new Error("CRM draft generator omitted bodyText");
  if (!Object.hasOwn(value, "bodyHtml")) throw new Error("CRM draft generator omitted bodyHtml");
  if (typeof value.bodyText !== "string" || !value.bodyText.trim()) {
    throw new Error("CRM draft bodyText is required");
  }
  if (value.bodyHtml !== null && (typeof value.bodyHtml !== "string" || !value.bodyHtml.trim())) {
    throw new Error("CRM draft bodyHtml must be a non-empty string or null");
  }

  if (channel === "email") {
    if (typeof value.subject !== "string" || !value.subject.trim()) {
      throw new Error("CRM email draft subject is required");
    }
    if (value.subject.length > 998) throw new Error("CRM email draft subject is too long");
    return {
      subject: value.subject.trim(),
      bodyText: value.bodyText.trim(),
      bodyHtml: typeof value.bodyHtml === "string" ? value.bodyHtml.trim() : null,
    };
  }

  if (channel !== "linkedin" && channel !== "whatsapp") {
    throw new Error(`Unsupported CRM draft channel: ${String(channel satisfies never)}`);
  }
  const label = crmChannelLabel(channel);
  if (Object.hasOwn(value, "subject") && value.subject !== null) {
    throw new Error(`CRM ${label} draft subject must be null or absent`);
  }
  if (value.bodyHtml !== null) throw new Error(`CRM ${label} draft bodyHtml must be null`);
  return { subject: null, bodyText: value.bodyText.trim(), bodyHtml: null };
}

const SENSITIVE_METADATA_KEYS = new Set([
  "accesstoken",
  "apikey",
  "authorization",
  "cookie",
  "credentials",
  "idtoken",
  "password",
  "proxyauthorization",
  "refreshtoken",
  "secret",
  "setcookie",
  "xapikey",
]);

function normalizedMetadataKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Removes transport secrets and converts arbitrary SDK values into JSON-safe audit metadata. */
export function sanitizeProviderMetadata(value: unknown, depth = 0): unknown {
  if (depth > 20) return "[truncated]";
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => sanitizeProviderMetadata(item, depth + 1));
  if (!isPlainObject(value)) return String(value);

  return Object.fromEntries(Object.entries(value)
    .filter(([key, item]) => item !== undefined && !SENSITIVE_METADATA_KEYS.has(normalizedMetadataKey(key)))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, sanitizeProviderMetadata(item, depth + 1)]));
}

export const completeDraftWithOpenRouter: DraftCompletion = async (input) => {
  const tool = await getPrompt("crm/draft-tool");
  return completeStructuredWithOpenRouter({
    requestedModel: input.requestedModel,
    timeoutMs: input.timeoutMs,
    systemPrompt: input.systemPrompt,
    userPrompt: input.userPrompt,
    maxOutputTokens: input.maxOutputTokens,
    jsonSchema: input.jsonSchema,
    schemaName: "crm_message_draft",
    schemaDescription: tool.text,
    accept: input.accept,
    signal: input.signal,
    trace: {
      name: input.trace?.name ?? "crm-draft",
      ...input.trace,
      prompts: [...(input.trace?.prompts ?? []), tool],
    },
  });
};

export async function generateCrmDraft(
  input: GenerateCrmDraftInput,
  dependencies: { complete?: DraftCompletion } = {},
): Promise<GeneratedCrmDraft> {
  const { templates, prompts } = await resolveTemplates(DRAFT_PROMPTS);
  const prompt = buildDraftPrompt(input, templates);
  const timeoutMs = Math.floor(input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const maxOutputTokens = Math.floor(input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("CRM draft timeout must be positive");
  if (!Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) {
    throw new Error("CRM draft maxOutputTokens must be positive");
  }

  const completion = await (dependencies.complete ?? completeDraftWithOpenRouter)({
    ...prompt,
    // Validated inside the completion so an off-schema call is retried
    // rather than failing the job; validated again below for the result.
    accept: (text) => { validateDraftOutput(text, input.channel); },
    requestedModel: input.requestedModel,
    timeoutMs,
    maxOutputTokens,
    signal: input.signal,
    trace: {
      name: "crm-draft",
      prompts,
      sessionId: input.trace?.sessionId,
      metadata: {
        ...input.trace?.metadata,
        channel: input.channel,
        sequenceStepId: input.sequenceStep.id ?? null,
        stepPosition: input.sequenceStep.position,
        stepType: input.sequenceStep.stepType,
        revision: Boolean(input.revision),
      },
    },
  });
  if (input.requestedModel && (
    completion.provider !== input.requestedModel.provider
    || completion.model !== input.requestedModel.modelId
  )) {
    throw new Error("CRM draft completion did not use the requested provider and model");
  }
  const provider = cleanRequiredText(completion.provider, "CRM draft completion provider");
  const model = cleanRequiredText(completion.model, "CRM draft completion model");

  const content = validateDraftOutput(completion.text, input.channel);
  const request = sanitizeProviderMetadata(completion.request);
  if (!isPlainObject(request)) throw new Error("CRM draft provider request metadata must be an object");
  return {
    ...content,
    provider,
    model,
    request,
    response: sanitizeProviderMetadata(completion.response),
    usage: completion.usage,
    prompt,
  };
}
