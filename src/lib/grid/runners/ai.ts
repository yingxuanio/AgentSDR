import { getAiConnection, getAiCredentials } from "@/lib/ai/connections";
import { getByokSettings } from "@/lib/ai/byok";
import { getAiModel, getAiProvider, promptColumnKeys } from "@/lib/ai/catalog";
import { getAiRunner } from "@/lib/ai/server/registry";
import type { AiRunner } from "@/lib/ai/server/types";
import type { AiModelDefinition } from "@/lib/ai/types";
import type { AiConfig, CellResult, CellValues } from "../types";
import { PermanentRunError, aiProviderLabel, interpolate, type ColumnRunner, type RunSession } from "./types";

type AiSession = RunSession & {
  credentials: Record<string, string>;
  model: AiModelDefinition;
  invoke: AiRunner;
};

/**
 * Turns the user's output fields into the JSON Schema handed to the model.
 *
 * Every field is required and additionalProperties is false: a model given an
 * optional field will sometimes omit it, and a silently missing key is much
 * harder for the user to debug than an empty string in the cell.
 */
function schemaFor(config: AiConfig): Record<string, unknown> | null {
  if (config.outputFormat === "json_schema") return config.jsonSchema ?? null;
  if (!config.outputs.length) return null;

  return {
    type: "object",
    additionalProperties: false,
    required: config.outputs.map((field) => field.key),
    properties: Object.fromEntries(
      config.outputs.map((field) => [
        field.key,
        {
          // Nullable, so a model that found nothing can say so: forced to a
          // string or number it answers "" or 0, and 0 employees reads as a
          // fact rather than as "not found".
          type: [field.type === "number" ? "number" : field.type === "boolean" ? "boolean" : "string", "null"],
          description: [field.description, "null when it is not known or cannot be found; never guess."]
            .filter(Boolean)
            .join(" — "),
        },
      ]),
    ),
  };
}

export const aiRunner: ColumnRunner<AiConfig> = {
  type: "ai",

  resolveDeps(config) {
    // Examples reference columns too, but only the prompt reads a row's live
    // values — an example is a fixed literal, so it creates no DAG edge.
    return promptColumnKeys(config.prompt);
  },

  async prepare(config): Promise<AiSession> {
    if (
      config.providerKey !== "openrouter"
      && config.providerKey !== "openai"
      && config.providerKey !== "anthropic"
    ) {
      throw new PermanentRunError("Re-save this legacy AI column with a configured AI provider and model");
    }
    const provider = getAiProvider(config.providerKey);
    const model = getAiModel(config.providerKey, config.modelKey, config.useCase);
    if (!provider || !model) {
      throw new PermanentRunError("That AI model is no longer available");
    }
    if (!model.useCases.includes(config.useCase)) {
      throw new PermanentRunError(`${model.name} cannot be used for this use case`);
    }

    const invoke = getAiRunner(config.providerKey, Boolean(model.producesImages));
    if (!invoke) throw new PermanentRunError(`${provider.name} is not available`);

    const settings = await getByokSettings();
    const targetConnectionId = config.connectionId || settings.connectionId;
    const connection = targetConnectionId ? await getAiConnection(targetConnectionId) : null;
    if (!connection || !connection.verified || connection.providerKey !== config.providerKey) {
      throw new PermanentRunError(`Connect a verified ${provider.name} account`);
    }
    const credentials = await getAiCredentials(connection.id);
    if (!credentials?.apiKey) {
      throw new PermanentRunError(`Reconnect the ${provider.name} account before running`);
    }

    return { credentials, model, invoke };
  },

  async run(config, row, ctx, session): Promise<CellResult> {
    const prepared = session as AiSession | undefined;
    if (!prepared?.invoke) throw new PermanentRunError("AI credentials were not prepared");

    const prompt = interpolate(config.prompt, row).trim();
    if (!prompt) {
      // Every referenced column was empty. Charging a provider call to ask a
      // model about nothing is worse than reporting the row as skipped.
      return { value: "Skipped", outcome: "skipped", costCents: 0 };
    }

    const schema = prepared.model.producesImages ? null : schemaFor(config);
    const started = Date.now();

    const result = await prepared.invoke({
      config,
      model: prepared.model,
      credentials: prepared.credentials,
      prompt,
      schema,
      examples: (config.examples ?? []).map((example) => ({
        input: interpolate(config.prompt, example.inputs as CellValues).trim(),
        response: example.response,
      })),
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
    });

    const latencyMs = Date.now() - started;
    const provider = aiProviderLabel(config.providerKey, config.upstreamProvider, prepared.model.key);

    // "Fields" fans the returned object out across the sibling columns the
    // dialog created; anything else lands whole in one generated output.
    if (schema && config.outputFormat === "fields" && result.value && typeof result.value === "object") {
      const returned = result.value as Record<string, unknown>;
      const outputs: CellValues = {};
      for (const field of config.outputs) {
        const columnKey = config.outputColumns[field.key];
        if (columnKey) outputs[columnKey] = returned[field.key] ?? null;
      }
      const hasResult = Object.values(outputs).some((v) => v !== null && v !== "");
      return {
        value: hasResult ? "Completed" : "No result",
        outputs,
        provider,
        outcome: hasResult ? "hit" : "miss",
        costCents: 0,
        latencyMs,
        request: result.request ?? { prompt, model: prepared.model.modelId },
        response: result.raw ?? result.value,
      };
    }

    const value = result.value;
    const outputColumnKey = config.outputColumns.response;
    const hasResult = value !== null && value !== "";
    return {
      value: hasResult ? "Completed" : "No result",
      outputs: outputColumnKey ? { [outputColumnKey]: value } : undefined,
      provider,
      outcome: hasResult ? "hit" : "miss",
      costCents: 0,
      latencyMs,
      request: result.request ?? { prompt, model: prepared.model.modelId },
      response: result.raw ?? value,
    };
  },

  estimateCost() {
    // Runs bill against the user's own provider key, so this app never sees a
    // currency amount. Credits in the catalog are a display unit, not money —
    // reporting them here would put fake dollars in the cost column.
    return 0;
  },
};
