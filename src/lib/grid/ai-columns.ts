import { db } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import { getAiModel } from "@/lib/ai/catalog";
import { getByokSettings } from "@/lib/ai/byok";
import { getAiConnection, getAiCredentials } from "@/lib/ai/connections";
import { listOpenRouterByokCatalog } from "@/lib/ai/server/openrouter";
import { gridColumns, type GridColumn } from "./schema";
import { inOrgTables, tableInOrganization } from "./scope";
import { assertNoCycle, listColumns, uniqueColumnKey, uniqueColumnName, validateColumnConfig } from "./columns";
import { insertionPositions } from "./enrichments";
import { promptColumnKeys } from "@/lib/ai/catalog";
import type { AiConfig, AiExample, AiOutputConfig, AiOutputField, AiUseCase } from "./types";

export type AiColumnInput = {
  tableId: string;
  useCase: AiUseCase;
  providerKey: string;
  modelKey: string;
  upstreamProvider?: string;
  connectionId: string;
  prompt: string;
  outputFormat: "fields" | "json_schema";
  outputs: AiOutputField[];
  jsonSchema?: Record<string, unknown>;
  examples?: AiExample[];
  autoRun: boolean;
  runCondition?: string;
  delaySeconds?: number;
  afterColumnId?: string;
  beforeColumnId?: string;
};

async function assertUsable(input: AiColumnInput) {
  const model = getAiModel(input.providerKey, input.modelKey, input.useCase);
  if (!model) throw new Error("Select an AI model");
  const connection = await getAiConnection(input.connectionId);
  if (!connection || connection.providerKey !== input.providerKey || !connection.verified) {
    throw new Error("Connect a verified account for this provider before saving");
  }
  if (input.providerKey === "openai" || input.providerKey === "anthropic") {
    const credentials = await getAiCredentials(connection.id);
    if (!credentials?.apiKey) {
      throw new Error(`Reconnect ${input.providerKey === "openai" ? "OpenAI Responses" : "Anthropic Messages"} in AI Settings`);
    }
    return model;
  }
  if (input.providerKey === "openrouter") {
    const settings = await getByokSettings();
    if (!input.upstreamProvider || !settings.modelsByProvider[input.upstreamProvider]?.includes(input.modelKey)) {
      throw new Error("Select a model enabled for a BYOK provider in AI Settings");
    }
    if (!settings.byokOnlyConfirmed) throw new Error("Confirm BYOK-only routing in AI Settings");
    if (settings.connectionId !== input.connectionId) {
      throw new Error("This AI column must use the OpenRouter connection selected in AI Settings");
    }
    const credentials = await getAiCredentials(connection.id);
    if (!credentials?.apiKey || !credentials.managementKey) {
      throw new Error("Reconnect OpenRouter in AI Settings");
    }
    const catalog = await listOpenRouterByokCatalog(credentials.managementKey);
    const liveModel = catalog
      .find((provider) => provider.slug === input.upstreamProvider)
      ?.models.find((candidate) => candidate.id === input.modelKey);
    if (!liveModel) throw new Error("That model is no longer available through the selected BYOK provider");
    const modalities = liveModel.outputModalities ?? ["text"];
    const requiredModality = input.useCase === "image-generation" ? "image" : "text";
    if (!modalities.includes(requiredModality)) {
      throw new Error(`${liveModel.name} does not support this use case`);
    }
    return {
      ...model,
      name: liveModel.name,
      description: liveModel.description ?? model.description,
      producesImages: requiredModality === "image",
    };
  }
  return model;
}

function resultFields(input: AiColumnInput, producesImages: boolean): AiOutputField[] {
  if (producesImages) {
    return [{ key: "response", name: "Generated image", type: "image" }];
  }
  if (input.outputFormat === "json_schema") {
    return [{ key: "response", name: "AI response", type: "json" }];
  }
  return input.outputs;
}

/**
 * Creates the AI column, plus one column per output field.
 *
 * Same two-tier shape as an enrichment: the AI column is what runs and what
 * holds only run status, and each output column is a generated landing spot
 * the runner writes into. Single-result JSON and image runs get one output too.
 */
export async function createAiColumns(input: AiColumnInput): Promise<GridColumn[]> {
  const model = await assertUsable(input);
  if (!(await tableInOrganization(input.tableId))) throw new Error("That table no longer exists");
  const existing = await listColumns(input.tableId);

  const fields = resultFields(input, Boolean(model.producesImages));

  const taken = new Set(existing.map((column) => column.key));
  const takenNames = existing.map((column) => column.name);
  // Two "Claude (AI)" columns (or an output named like one) must stay
  // distinguishable, so the AI column itself gets a free name first.
  const aiColumnName = uniqueColumnName(model.producesImages ? model.name : `${model.name} (AI)`, takenNames);
  takenNames.push(aiColumnName);
  const outputColumns = new Map<string, string>();
  const outputNames = new Map<string, string>();
  for (const field of fields) {
    const key = uniqueColumnKey(field.name, taken);
    taken.add(key);
    outputColumns.set(field.key, key);
    // An output named like an existing column ("Email") must not be
    // indistinguishable from it in the header.
    const name = uniqueColumnName(field.name, takenNames);
    takenNames.push(name);
    outputNames.set(field.key, name);
  }

  const aiColumnKey = uniqueColumnKey(model.name, taken);
  taken.add(aiColumnKey);

  const config: AiConfig = {
    useCase: input.useCase,
    providerKey: input.providerKey,
    modelKey: input.modelKey,
    upstreamProvider: input.upstreamProvider,
    connectionId: input.connectionId,
    prompt: input.prompt,
    outputFormat: input.outputFormat,
    outputs: input.outputs,
    jsonSchema: input.jsonSchema,
    outputColumns: Object.fromEntries(outputColumns),
    examples: input.examples?.length ? input.examples : undefined,
    runCondition: input.runCondition?.trim() || undefined,
    delaySeconds: input.delaySeconds,
  };
  validateColumnConfig("ai", config, existing);

  const positions = insertionPositions(
    existing,
    fields.length + 1,
    input.beforeColumnId,
    input.afterColumnId,
  );
  const dependsOn = promptColumnKeys(input.prompt);

  const values = [
    {
      tableId: input.tableId,
      key: aiColumnKey,
      name: aiColumnName,
      type: "ai" as const,
      config,
      dependsOn,
      position: positions[0],
      autoRun: input.autoRun,
    },
    ...fields.map((field, index) => {
      const outputConfig: AiOutputConfig = {
        sourceColumnKey: aiColumnKey,
        outputKey: field.key,
        valueType: field.type,
      };
      return {
        tableId: input.tableId,
        key: outputColumns.get(field.key)!,
        name: outputNames.get(field.key)!,
        type: "ai_output" as const,
        config: outputConfig,
        dependsOn: [aiColumnKey],
        position: positions[index + 1],
        // Written by the AI column's run, never executed on its own.
        autoRun: false,
      };
    }),
  ];

  return db.insert(gridColumns).values(values).returning();
}

/** Output columns this AI column owns: back-referencing ai_output columns plus its stored mapping. */
function ownOutputColumns(target: GridColumn, existing: GridColumn[]): GridColumn[] {
  const mapped = new Set(Object.values((target.config as AiConfig).outputColumns ?? {}));
  return existing.filter(
    (column) =>
      column.id !== target.id &&
      (mapped.has(column.key) ||
        (column.type === "ai_output" && (column.config as AiOutputConfig).sourceColumnKey === target.key)),
  );
}

/**
 * Pairs each requested output field with the column that should keep holding
 * its data. In order of trust:
 *   1. the column the field key already maps to (the dialog keeps a saved
 *      field's key when it is renamed, so a rename lands here);
 *   2. an unclaimed output column of this AI column with the same name.
 * A field with a new key is otherwise a new field: guessing that it replaces
 * a removed one would hand it the removed field's data.
 * Columns that are not this AI column's outputs are never candidates, so an
 * output named "Email" can no longer swallow the user's own "Email" column.
 */
export function pairOutputsWithColumns(
  fields: AiOutputField[],
  previousFields: AiOutputField[],
  previousMapping: Record<string, string>,
  owned: Pick<GridColumn, "key" | "name">[],
): Map<string, string> {
  const ownedByKey = new Map(owned.map((column) => [column.key, column]));
  const paired = new Map<string, string>(); // field key -> column key
  const claimed = new Set<string>();

  for (const field of fields) {
    const columnKey = previousMapping[field.key];
    if (columnKey && ownedByKey.has(columnKey) && !claimed.has(columnKey)) {
      paired.set(field.key, columnKey);
      claimed.add(columnKey);
    }
  }

  for (const field of fields) {
    if (paired.has(field.key)) continue;
    const byName = owned.find(
      (column) => !claimed.has(column.key) && column.name.trim().toLowerCase() === field.name.trim().toLowerCase(),
    );
    if (byName) {
      paired.set(field.key, byName.key);
      claimed.add(byName.key);
    }
  }
  return paired;
}

/**
 * Rewrites an existing AI column in place.
 *
 * Output columns this AI column already owns are reused (see
 * pairOutputsWithColumns) so the data in them survives an edit; only
 * genuinely new fields get a new column. Removing a field leaves its column
 * alone rather than dropping it — silently deleting a populated column because
 * a field was renamed would lose user data.
 */
export async function updateAiColumns(
  input: AiColumnInput & { columnId: string },
): Promise<GridColumn[]> {
  const model = await assertUsable(input);

  const existing = await listColumns(input.tableId);
  const target = existing.find((column) => column.id === input.columnId);
  if (!target || target.type !== "ai") throw new Error("That AI column no longer exists");

  const previous = target.config as AiConfig;
  const fields = resultFields(input, Boolean(model.producesImages));

  const owned = ownOutputColumns(target, existing);
  const paired = pairOutputsWithColumns(fields, previous.outputs ?? [], previous.outputColumns ?? {}, owned);
  const ownedByKey = new Map(owned.map((column) => [column.key, column]));

  const taken = new Set(existing.map((column) => column.key));
  const takenNames = existing.map((column) => column.name);
  const outputColumns = new Map<string, string>();
  const created: typeof gridColumns.$inferInsert[] = [];
  const reused: Array<{ id: string; name?: string; config: AiOutputConfig }> = [];

  const positions = insertionPositions(existing, fields.length + 1);
  let positionIndex = 1;

  for (const field of fields) {
    const reusable = ownedByKey.get(paired.get(field.key) ?? "");
    const config: AiOutputConfig = { sourceColumnKey: target.key, outputKey: field.key, valueType: field.type };

    if (reusable) {
      outputColumns.set(field.key, reusable.key);
      // Follow a renamed field, unless the new name would collide with a column.
      const rename =
        reusable.name.trim().toLowerCase() !== field.name.trim().toLowerCase() &&
        !takenNames.some((name) => name.trim().toLowerCase() === field.name.trim().toLowerCase());
      if (rename) takenNames.push(field.name.trim());
      reused.push({ id: reusable.id, name: rename ? field.name.trim() : undefined, config });
      continue;
    }
    const key = uniqueColumnKey(field.name, taken);
    taken.add(key);
    outputColumns.set(field.key, key);
    const name = uniqueColumnName(field.name, takenNames);
    takenNames.push(name);
    created.push({
      tableId: input.tableId,
      key,
      name,
      type: "ai_output",
      config,
      dependsOn: [target.key],
      position: positions[positionIndex++],
      autoRun: false,
    });
  }

  const config: AiConfig = {
    useCase: input.useCase,
    providerKey: input.providerKey,
    modelKey: input.modelKey,
    upstreamProvider: input.upstreamProvider,
    connectionId: input.connectionId,
    prompt: input.prompt,
    outputFormat: input.outputFormat,
    outputs: input.outputs,
    jsonSchema: input.jsonSchema,
    outputColumns: Object.fromEntries(outputColumns),
    examples: input.examples?.length ? input.examples : undefined,
    runCondition: input.runCondition?.trim() || undefined,
    delaySeconds: input.delaySeconds,
  };
  validateColumnConfig("ai", config, existing);

  // A prompt that reads this column's own outputs would re-run itself forever,
  // spending on every pass.
  const dependsOn = promptColumnKeys(input.prompt);
  const ownKeys = new Set([target.key, ...owned.map((column) => column.key), ...outputColumns.values()]);
  const selfReference = dependsOn.find((key) => ownKeys.has(key));
  if (selfReference) {
    throw new Error(`The prompt cannot reference this column's own output: {{${selfReference}}}`);
  }
  assertNoCycle(existing, { key: target.key, dependsOn });

  return db.transaction(async (tx) => {
    await tx
      .update(gridColumns)
      .set({
        config,
        dependsOn,
        autoRun: input.autoRun,
        updatedAt: new Date(),
      })
      .where(and(inOrgTables(gridColumns.tableId), eq(gridColumns.id, target.id)));

    if (created.length) await tx.insert(gridColumns).values(created);
    for (const output of reused) {
      await tx.update(gridColumns).set({
        type: "ai_output",
        ...(output.name ? { name: output.name } : {}),
        config: output.config,
        dependsOn: [target.key],
        autoRun: false,
        updatedAt: new Date(),
      }).where(and(inOrgTables(gridColumns.tableId), eq(gridColumns.id, output.id)));
    }
    return listColumns(input.tableId);
  });
}
