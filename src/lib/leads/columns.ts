/**
 * User-defined fields on `people` and `companies`, stored as JSON.
 *
 * A custom field's VALUE lives in the row's `custom` jsonb
 * (`people.custom`, `companies.custom`), under the registry row's `key`.
 * Its DEFINITION — label, type, order, archived — is a row in
 * `entity_columns`, and every organization has its own registry. There is
 * no DDL anywhere in this app: adding, renaming, retyping or removing a
 * field never alters a table, so one organization's settings can never
 * change another's schema (docs/multi-tenancy/conventions.md §4).
 *
 * The earlier design added real `x_*` columns with ALTER TABLE. No such
 * column was ever created in the live database (people/companies carry only
 * their core columns), so there is no data to migrate. check-lead-column-drift
 * still flags a stray physical `x_*` column in case one appears.
 *
 * Rules that keep this safe:
 *
 *   1. Keys are GENERATED, never user-supplied, and prefixed `x_`, so they
 *      cannot collide with a core column or the reserved names. (./types.ts)
 *   2. `key` never changes, so a rename touches only the registry row.
 *   3. Only the storage kinds in LeadPgType are offered; each has a defined
 *      JSON shape and a guarded cast for filtering (customFieldSql).
 *   4. A key reaches SQL only as a bound parameter, and only after the
 *      registry has vouched for it (assertKnownColumns).
 *   5. Delete is soft; the permanent delete removes the key from the org's
 *      rows in the same transaction that deletes the registry row.
 *   6. Every query is scoped to the current organization.
 */
import { and, asc, eq, isNull, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { entityColumns } from "./schema";
import {
  CORE_COLUMN_DEFS,
  CORE_COLUMN_KEYS,
  PG_TYPE_FOR_COLUMN_TYPE,
  RESERVED_COLUMN_NAMES,
  isUserColumn,
  uniquePhysicalColumnName,
  type LeadColumn,
  type LeadColumnType,
  type LeadEntity,
  type LeadPgType,
} from "./types";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";

/** The table behind each entity. A closed map — never interpolated from input. */
const TABLE_FOR_ENTITY: Record<LeadEntity, "people" | "companies"> = {
  person: "people",
  company: "companies",
};

export class ColumnError extends Error {}

/** The transaction handle drizzle hands to db.transaction(). */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

type ColumnRow = typeof entityColumns.$inferSelect;

function toLeadColumn(row: ColumnRow): LeadColumn {
  return {
    id: row.id,
    entity: row.entity,
    key: row.key,
    name: row.name,
    type: row.type,
    pgType: row.pgType,
    config: row.config,
    isCore: row.isCore,
    position: row.position,
    archivedAt: row.archivedAt,
  };
}

/** Organizations whose core rows this process has already confirmed. */
const coreEnsured = new Set<string>();
const prospectingEnsured = new Set<string>();

export const PROSPECTING_COLUMN_DEFS: readonly {
  entity: LeadEntity;
  key: string;
  name: string;
  type: LeadColumnType;
}[] = [
  { entity: "company", key: "x_code", name: "项目编号", type: "text" },
  { entity: "company", key: "x_region", name: "地区/城市", type: "text" },
  { entity: "company", key: "x_lead_reason", name: "录入理由与切入方案", type: "text" },
  { entity: "person", key: "x_verification_note", name: "联系人核验依据", type: "text" },
];

/**
 * Get-or-create the organization's core registry rows (the 11 built-in
 * People/Company fields). Idempotent and race-safe: the insert targets the
 * per-organization unique, so concurrent first reads converge on one set.
 */
export async function ensureCoreColumns(): Promise<void> {
  const organizationId = currentOrganizationId();
  if (coreEnsured.has(organizationId)) return;

  await db
    .insert(entityColumns)
    .values(
      CORE_COLUMN_DEFS.map((def, i) => ({
        organizationId,
        entity: def.entity,
        key: def.key,
        name: def.name,
        type: def.type,
        pgType: PG_TYPE_FOR_COLUMN_TYPE[def.type],
        isCore: true,
        position: i + 1,
      })),
    )
    .onConflictDoNothing({ target: [entityColumns.organizationId, entityColumns.entity, entityColumns.key] });

  coreEnsured.add(organizationId);
}

/**
 * Ensure the streamlined prospecting context columns exist in `entity_columns`
 * when API imports write `x_code`, `x_region`, `x_lead_reason`, or `x_verification_note`.
 */
export async function ensureProspectingColumns(
  executor: Pick<typeof db, "insert"> = db,
): Promise<void> {
  const organizationId = currentOrganizationId();
  if (prospectingEnsured.has(organizationId)) return;

  await executor
    .insert(entityColumns)
    .values(
      PROSPECTING_COLUMN_DEFS.map((def, i) => ({
        organizationId,
        entity: def.entity,
        key: def.key,
        name: def.name,
        type: def.type,
        pgType: PG_TYPE_FOR_COLUMN_TYPE[def.type],
        isCore: false,
        position: 100 + i,
      })),
    )
    .onConflictDoNothing({ target: [entityColumns.organizationId, entityColumns.entity, entityColumns.key] });

  prospectingEnsured.add(organizationId);
}

/**
 * The registry, in display order.
 *
 * This is the ONE list the settings UI, the mapping catalog and the query
 * builder all read — none of them needs to know which columns are core.
 */
export async function listColumns(
  entity?: LeadEntity,
  opts: { includeArchived?: boolean } = {},
): Promise<LeadColumn[]> {
  await ensureCoreColumns();
  const filters = [
    inOrg(entityColumns),
    entity ? eq(entityColumns.entity, entity) : undefined,
    opts.includeArchived ? undefined : isNull(entityColumns.archivedAt),
  ].filter(Boolean);

  const rows = await db
    .select()
    .from(entityColumns)
    .where(and(...filters))
    .orderBy(asc(entityColumns.entity), asc(entityColumns.position));

  return rows.map(toLeadColumn);
}

/** One column by id, or null. Archived columns are included. Another organization's id is simply not found. */
export async function getColumn(id: string): Promise<LeadColumn | null> {
  const [row] = await db
    .select()
    .from(entityColumns)
    .where(and(inOrg(entityColumns), eq(entityColumns.id, id)))
    .limit(1);
  return row ? toLeadColumn(row) : null;
}

/**
 * The allowlist gate.
 *
 * Every code path that filters, sorts or writes a custom field must resolve
 * the key through here first. A key that is not in this organization's
 * registry never reaches the database.
 */
export async function assertKnownColumns(entity: LeadEntity, keys: string[]): Promise<LeadColumn[]> {
  if (!keys.length) return [];
  const known = await listColumns(entity);
  const byKey = new Map(known.map((c) => [c.key, c]));

  const resolved: LeadColumn[] = [];
  for (const key of keys) {
    const column = byKey.get(key);
    if (!column) throw new ColumnError(`Unknown ${entity} column: ${key}`);
    resolved.push(column);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Filtering and sorting by a custom field
// ---------------------------------------------------------------------------

/**
 * A typed SQL expression for one custom field, for WHERE / ORDER BY:
 *
 *   const [field] = await assertKnownColumns("person", [key]);
 *   db.select().from(people).where(and(inOrg(people), gt(customFieldSql(people.custom, field), 5)))
 *
 * `customColumn` is `people.custom` or `companies.custom`. The key is a bound
 * parameter. Values that do not have the registered JSON shape (a leftover
 * from before a type change) evaluate to NULL instead of raising a cast error.
 * Core columns are real columns, not custom — callers handle those directly.
 */
export function customFieldSql(
  customColumn: AnyColumn,
  field: Pick<LeadColumn, "key" | "pgType" | "isCore">,
): SQL {
  if (field.isCore) throw new ColumnError(`"${field.key}" is a built-in column, not a custom field`);
  const key = field.key;
  const text = sql`(${customColumn} ->> ${key}::text)`;
  const json = sql`(${customColumn} -> ${key}::text)`;
  switch (field.pgType) {
    case "numeric":
      return sql`(CASE WHEN jsonb_typeof(${json}) = 'number' THEN ${text}::numeric END)`;
    case "boolean":
      return sql`(CASE WHEN jsonb_typeof(${json}) = 'boolean' THEN ${text}::boolean END)`;
    case "timestamptz":
      return sql`(CASE WHEN jsonb_typeof(${json}) = 'string' AND ${text} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN ${text}::timestamptz END)`;
    case "text[]":
    case "jsonb":
      return json;
    default:
      return text;
  }
}

// ---------------------------------------------------------------------------
// Writes — registry only
// ---------------------------------------------------------------------------

/** Fractional index: append after the last column without renumbering. */
function nextPosition(existing: { position: number }[]): number {
  if (!existing.length) return 1;
  return Math.max(...existing.map((c) => c.position)) + 1;
}

/**
 * Adds a field: one registry row, no DDL.
 *
 * The org-scoped advisory lock serializes concurrent adds inside this
 * organization so two requests cannot both pick the same generated key (the
 * per-organization unique would otherwise reject the second with an opaque
 * error).
 */
export async function addColumn(input: {
  entity: LeadEntity;
  name: string;
  type: LeadColumnType;
}): Promise<LeadColumn> {
  const name = input.name.trim();
  if (!name) throw new ColumnError("Column name is required");

  const pgType = PG_TYPE_FOR_COLUMN_TYPE[input.type];
  if (!pgType) throw new ColumnError(`Unsupported column type: ${input.type}`);

  await ensureCoreColumns();
  const organizationId = currentOrganizationId();

  return db.transaction(async (tx: Tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`entity_columns:${organizationId}:${input.entity}`}, 0))`,
    );

    const existing = await tx
      .select({ key: entityColumns.key, name: entityColumns.name, position: entityColumns.position })
      .from(entityColumns)
      .where(and(inOrg(entityColumns), eq(entityColumns.entity, input.entity)));

    if (existing.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      throw new ColumnError(`A column named "${name}" already exists`);
    }

    const taken = new Set([...existing.map((c) => c.key), ...RESERVED_COLUMN_NAMES, ...CORE_COLUMN_KEYS[input.entity]]);
    const key = uniquePhysicalColumnName(name, taken);

    const [row] = await tx
      .insert(entityColumns)
      .values({
        organizationId,
        entity: input.entity,
        key,
        name,
        type: input.type,
        pgType,
        isCore: false,
        position: nextPosition(existing),
      })
      .returning();

    return toLeadColumn(row);
  });
}

/** Renames a column. Touches one registry row; `key` never changes. */
export async function renameColumn(id: string, name: string): Promise<LeadColumn> {
  const trimmed = name.trim();
  if (!trimmed) throw new ColumnError("Column name is required");

  const column = await getColumn(id);
  if (!column) throw new ColumnError("Column not found");

  const siblings = await listColumns(column.entity, { includeArchived: true });
  if (siblings.some((c) => c.id !== id && c.name.toLowerCase() === trimmed.toLowerCase())) {
    throw new ColumnError(`A column named "${trimmed}" already exists`);
  }

  const [row] = await db
    .update(entityColumns)
    .set({ name: trimmed, updatedAt: new Date() })
    .where(and(inOrg(entityColumns), eq(entityColumns.id, id)))
    .returning();

  return toLeadColumn(row);
}

/**
 * Soft delete: the field disappears from the UI, the mapping catalog and
 * queries, but the values survive in `custom`. This is what "Remove column" does.
 */
export async function archiveColumn(id: string): Promise<LeadColumn> {
  const column = await getColumn(id);
  if (!column) throw new ColumnError("Column not found");
  if (column.isCore) throw new ColumnError(`"${column.name}" is a built-in column and cannot be removed`);

  const [row] = await db
    .update(entityColumns)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(and(inOrg(entityColumns), eq(entityColumns.id, id)))
    .returning();

  return toLeadColumn(row);
}

export async function unarchiveColumn(id: string): Promise<LeadColumn> {
  const [row] = await db
    .update(entityColumns)
    .set({ archivedAt: null, updatedAt: new Date() })
    .where(and(inOrg(entityColumns), eq(entityColumns.id, id)))
    .returning();

  if (!row) throw new ColumnError("Column not found");
  return toLeadColumn(row);
}

/**
 * Permanently deletes a field and its values. Irreversible.
 *
 * Requires the field to be archived first, so a destructive action always
 * takes two deliberate steps. The values are removed from this
 * organization's rows (`custom - key`) in the same transaction that deletes
 * the registry row. No DDL.
 */
export async function dropColumn(id: string): Promise<void> {
  const column = await getColumn(id);
  if (!column) throw new ColumnError("Column not found");
  if (column.isCore) throw new ColumnError(`"${column.name}" is a built-in column and cannot be dropped`);
  if (!isUserColumn(column.key)) {
    throw new ColumnError(`"${column.name}" is not a user-added column and cannot be dropped`);
  }
  if (!column.archivedAt) {
    throw new ColumnError("Remove the column before deleting it permanently");
  }

  await db.transaction(async (tx: Tx) => {
    await tx.execute(
      sql`UPDATE ${sql.identifier(TABLE_FOR_ENTITY[column.entity])}
          SET custom = custom - ${column.key}::text
          WHERE organization_id = ${currentOrganizationId()} AND custom ? ${column.key}::text`,
    );
    await tx.delete(entityColumns).where(and(inOrg(entityColumns), eq(entityColumns.id, id)));
  });
}

/** Reorders a column. Registry-only; fractional index, so one row is touched. */
export async function moveColumn(id: string, position: number): Promise<LeadColumn> {
  const [row] = await db
    .update(entityColumns)
    .set({ position, updatedAt: new Date() })
    .where(and(inOrg(entityColumns), eq(entityColumns.id, id)))
    .returning();

  if (!row) throw new ColumnError("Column not found");
  return toLeadColumn(row);
}

// ---------------------------------------------------------------------------
// Type changes
// ---------------------------------------------------------------------------

/**
 * The new JSON value for a field's existing value, as a SQL expression that
 * is NULL when the value cannot be converted. Written against the row's
 * `custom` column.
 *
 * Offered conversions: anything -> text (the value's text form), and
 * text -> numeric | boolean | timestamptz | text[]. Everything else (numeric ->
 * boolean, jsonb -> timestamptz, ...) is not a conversion users mean; the
 * honest answer is a new field plus a re-import. Regex guards rather than
 * try-casts, so it behaves the same on any Postgres version.
 */
function convertedValueSql(key: string, from: LeadPgType, to: LeadPgType): SQL | null {
  if (from === to) return null;
  const text = sql`(custom ->> ${key}::text)`;
  if (to === "text") return sql`to_jsonb(${text})`;
  if (from !== "text") return null;

  switch (to) {
    case "numeric":
      return sql`(CASE WHEN ${text} ~ '^-?[0-9]+([.][0-9]+)?$' THEN to_jsonb(${text}::numeric) END)`;
    case "boolean":
      return sql`(CASE WHEN lower(${text}) IN ('true','t','yes','y','1') THEN to_jsonb(true)
                       WHEN lower(${text}) IN ('false','f','no','n','0') THEN to_jsonb(false) END)`;
    case "timestamptz":
      return sql`(CASE WHEN ${text} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN to_jsonb(${text}) END)`;
    case "text[]":
      return sql`to_jsonb(string_to_array(${text}, ','))`;
    default:
      return null;
  }
}

/** A value is "populated" when the key exists and is not JSON null. */
function populatedSql(key: string): SQL {
  return sql`(custom ? ${key}::text AND jsonb_typeof(custom -> ${key}::text) <> 'null')`;
}

export type TypeChangePreview = {
  /** Rows with a value in this field today. */
  populated: number;
  /** Of those, how many cannot be converted to the new type. */
  incompatible: number;
};

/** Counts what a type change would not convert, WITHOUT changing anything. */
export async function previewTypeChange(
  id: string,
  nextType: LeadColumnType,
): Promise<TypeChangePreview> {
  const column = await getColumn(id);
  if (!column) throw new ColumnError("Column not found");
  if (column.isCore) {
    throw new ColumnError(`"${column.name}" is a built-in column and its type cannot be changed`);
  }

  const to = PG_TYPE_FOR_COLUMN_TYPE[nextType];
  const convert = convertedValueSql(column.key, column.pgType, to);
  if (!convert) {
    throw new ColumnError(
      `Cannot convert "${column.name}" from ${column.pgType} to ${to}. ` +
        `Add a new column and re-import instead.`,
    );
  }

  const rows = await db.execute<{ populated: string; incompatible: string }>(
    sql`SELECT
          count(*) FILTER (WHERE ${populatedSql(column.key)})::text AS populated,
          count(*) FILTER (WHERE ${populatedSql(column.key)} AND (${convert}) IS NULL)::text AS incompatible
        FROM ${sql.identifier(TABLE_FOR_ENTITY[column.entity])}
        WHERE organization_id = ${currentOrganizationId()}`,
  );

  return {
    populated: Number(rows[0]?.populated ?? 0),
    incompatible: Number(rows[0]?.incompatible ?? 0),
  };
}

/**
 * Changes a field's type.
 *
 * Existing JSON values are converted in place (this organization's rows
 * only) and the registry row is updated, in one transaction. If ANY value
 * cannot be converted the change is REFUSED and nothing is touched — the old
 * design nulled incompatible values, which loses data silently. The user
 * fixes or clears those values, or adds a new field. No DDL, no table lock.
 */
export async function changeColumnType(id: string, nextType: LeadColumnType): Promise<LeadColumn> {
  const column = await getColumn(id);
  if (!column) throw new ColumnError("Column not found");
  if (column.isCore) {
    throw new ColumnError(`"${column.name}" is a built-in column and its type cannot be changed`);
  }

  const to = PG_TYPE_FOR_COLUMN_TYPE[nextType];
  const convert = convertedValueSql(column.key, column.pgType, to);
  if (!convert) {
    throw new ColumnError(
      `Cannot convert "${column.name}" from ${column.pgType} to ${to}. ` +
        `Add a new column and re-import instead.`,
    );
  }

  const table = sql.identifier(TABLE_FOR_ENTITY[column.entity]);
  const organizationId = currentOrganizationId();

  return db.transaction(async (tx: Tx) => {
    const [{ incompatible }] = await tx.execute<{ incompatible: string }>(
      sql`SELECT count(*)::text AS incompatible FROM ${table}
          WHERE organization_id = ${organizationId} AND ${populatedSql(column.key)} AND (${convert}) IS NULL`,
    );
    if (Number(incompatible) > 0) {
      throw new ColumnError(
        `${incompatible} value${Number(incompatible) === 1 ? "" : "s"} in "${column.name}" cannot be converted to ${nextType}. ` +
          `Clear or fix them first, or add a new column.`,
      );
    }

    await tx.execute(
      sql`UPDATE ${table}
          SET custom = jsonb_set(custom, ARRAY[${column.key}::text], ${convert})
          WHERE organization_id = ${organizationId} AND ${populatedSql(column.key)}`,
    );

    const [row] = await tx
      .update(entityColumns)
      .set({ type: nextType, pgType: to, updatedAt: new Date() })
      .where(and(inOrg(entityColumns), eq(entityColumns.id, id)))
      .returning();

    return toLeadColumn(row);
  });
}

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

export type ColumnDrift = {
  entity: LeadEntity;
  /** Keys present in rows' `custom` that have no registry row. Invisible to the app. */
  unregisteredKeys: string[];
  /** Registered fields that no row uses — informational, not an error. */
  unusedKeys: string[];
};

/**
 * Compares the current organization's registry against the keys its rows
 * actually carry in `custom`. (scripts/check-lead-column-drift.ts does the
 * same across every organization, plus the stray-physical-column check.)
 */
export async function checkDrift(): Promise<ColumnDrift[]> {
  const registered = await listColumns(undefined, { includeArchived: true });
  const out: ColumnDrift[] = [];

  for (const entity of ["person", "company"] as const) {
    const used = await db.execute<{ key: string }>(
      sql`SELECT DISTINCT jsonb_object_keys(custom) AS key
          FROM ${sql.identifier(TABLE_FOR_ENTITY[entity])}
          WHERE organization_id = ${currentOrganizationId()}`,
    );
    const usedKeys = new Set(used.map((r) => r.key));
    const registeredKeys = new Set(registered.filter((c) => c.entity === entity && !c.isCore).map((c) => c.key));

    out.push({
      entity,
      unregisteredKeys: [...usedKeys].filter((k) => !registeredKeys.has(k)).sort(),
      unusedKeys: [...registeredKeys].filter((k) => !usedKeys.has(k)).sort(),
    });
  }

  return out;
}
