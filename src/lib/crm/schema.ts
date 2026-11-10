import type { CrmChannel } from "./channels";
import type { AiInstructionBlock } from "./ai/instructions";
import {
  type AnyPgColumn,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { people } from "@/lib/leads/schema";
import { organizations } from "@/lib/auth/schema";

/** The four system-owned CRM category keys. */
export type CrmCategoryKey = "customer" | "interested" | "not_interested" | "other";

/** A pipeline is an independent CRM taxonomy and workflow namespace. */
export const crmPipelines = pgTable(
  "crm_pipelines",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("crm_pipelines_organization_idx").on(table.organizationId),
    uniqueIndex("crm_pipelines_org_name_uq").on(table.organizationId, table.name),
    uniqueIndex("crm_pipelines_org_one_default_uq")
      .on(table.organizationId)
      .where(sql`${table.isDefault} IS TRUE`),
    check("crm_pipelines_name_chk", sql`length(btrim(${table.name})) > 0`),
  ],
);

/** Fixed, system-owned top-level classification vocabulary. */
export const crmCategories = pgTable(
  "crm_categories",
  {
    key: text("key").primaryKey(),
    label: text("label").notNull(),
    sortOrder: integer("sort_order").notNull(),
    isSystem: boolean("is_system").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("crm_categories_label_uq").on(table.label),
    unique("crm_categories_sort_order_uq").on(table.sortOrder),
    check(
      "crm_categories_key_chk",
      sql`${table.key} IN ('customer', 'interested', 'not_interested', 'other')`,
    ),
    check("crm_categories_label_chk", sql`length(btrim(${table.label})) > 0`),
    check("crm_categories_is_system_chk", sql`${table.isSystem} IS TRUE`),
  ],
);

/**
 * A configurable classification outcome. key, pipeline_id, and category_key
 * are immutable after insert; the migration installs the database trigger
 * that enforces this invariant.
 */
export const crmSubcategories = pgTable(
  "crm_subcategories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pipelineId: uuid("pipeline_id").notNull(),
    categoryKey: text("category_key").notNull(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    classificationGuidance: text("classification_guidance"),
    active: boolean("active").notNull().default(true),
    reviewRequired: boolean("review_required").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    /**
     * Position in the sales funnel; NULL when the subcategory is not a funnel
     * stage. The AI may only move a ranked record to an equal or higher rank —
     * see `classificationApplicationDecision`. scripts/add-crm-stage-rank.ts.
     */
    stageRank: integer("stage_rank"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.pipelineId],
      foreignColumns: [crmPipelines.id],
      name: "crm_subcategories_pipeline_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.categoryKey],
      foreignColumns: [crmCategories.key],
      name: "crm_subcategories_category_fk",
    }).onDelete("restrict"),
    unique("crm_subcategories_pipeline_key_uq").on(table.pipelineId, table.key),
    unique("crm_subcategories_target_uq").on(table.id, table.pipelineId, table.categoryKey),
    index("crm_subcategories_pipeline_category_idx").on(table.pipelineId, table.categoryKey),
    check("crm_subcategories_key_chk", sql`${table.key} ~ '^[a-z][a-z0-9_]*$'`),
    check("crm_subcategories_name_chk", sql`length(btrim(${table.name})) > 0`),
    check("crm_subcategories_sort_order_chk", sql`${table.sortOrder} >= 0`),
    check("crm_subcategories_stage_rank_chk", sql`${table.stageRank} IS NULL OR ${table.stageRank} >= 1`),
  ],
);

/**
 * Per-pipeline classifier policy.
 *
 * `human_send_only` is still fixed on — the CRM drafts, a person sends.
 * `customer_requires_review` used to be pinned TRUE the same way; it is a
 * plain setting now (see scripts/relax-crm-classification-review.ts) because
 * an AI-applied category is only ever an input to a draft, and holding
 * classifications for a review nobody performed left records uncategorised.
 */
export const crmSettings = pgTable(
  "crm_settings",
  {
    pipelineId: uuid("pipeline_id").primaryKey(),
    autoApplyConfidence: numeric("auto_apply_confidence", { precision: 4, scale: 3 })
      .notNull()
      .default("0.85"),
    reviewOther: boolean("review_other").notNull().default(true),
    customerRequiresReview: boolean("customer_requires_review").notNull().default(true),
    humanSendOnly: boolean("human_send_only").notNull().default(true),
    /**
     * Operator guidance appended to every draft prompt, as titled blocks;
     * see src/lib/crm/ai/instructions.ts and scripts/crm-ai-instruction-blocks.ts.
     */
    draftInstructions: jsonb("draft_instructions").$type<AiInstructionBlock[]>(),
    /** Operator guidance appended to every classification prompt, as titled blocks. */
    classificationInstructions: jsonb("classification_instructions").$type<AiInstructionBlock[]>(),
    /**
     * How the AI voice agent runs a call, as titled blocks; null = the defaults
     * in src/lib/calls/callingInstructions.ts. scripts/add-crm-calling-instructions.ts.
     */
    callingInstructions: jsonb("calling_instructions").$type<AiInstructionBlock[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.pipelineId],
      foreignColumns: [crmPipelines.id],
      name: "crm_settings_pipeline_fk",
    }).onDelete("restrict"),
    check(
      "crm_settings_confidence_chk",
      sql`${table.autoApplyConfidence} >= 0 AND ${table.autoApplyConfidence} <= 1`,
    ),
    check("crm_settings_human_send_only_chk", sql`${table.humanSendOnly} IS TRUE`),
    check(
      "crm_settings_calling_instructions_shape_chk",
      sql`${table.callingInstructions} IS NULL OR (jsonb_typeof(${table.callingInstructions}) = 'array' AND length(${table.callingInstructions}::text) <= 60000)`,
    ),
    check(
      "crm_settings_instructions_shape_chk",
      sql`(${table.draftInstructions} IS NULL OR (jsonb_typeof(${table.draftInstructions}) = 'array' AND length(${table.draftInstructions}::text) <= 60000)) AND (${table.classificationInstructions} IS NULL OR (jsonb_typeof(${table.classificationInstructions}) = 'array' AND length(${table.classificationInstructions}::text) <= 60000))`,
    ),
  ],
);

/** A global, Person-owned communication policy (DNC applies to every channel). */
export const crmPersonContactPolicies = pgTable(
  "crm_person_contact_policies",
  {
    personId: uuid("person_id").primaryKey(),
    doNotContact: boolean("do_not_contact").notNull().default(false),
    reason: text("reason"),
    source: text("source").$type<"human" | "integration" | "inbound_request">(),
    setAt: timestamp("set_at", { withTimezone: true }),
    clearedAt: timestamp("cleared_at", { withTimezone: true }),
    reviewAfter: timestamp("review_after", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.personId],
      foreignColumns: [people.id],
      name: "crm_person_contact_policies_person_fk",
    }).onDelete("restrict"),
    check(
      "crm_person_contact_policies_source_chk",
      sql`${table.source} IS NULL OR ${table.source} IN ('human', 'integration', 'inbound_request')`,
    ),
    check(
      "crm_person_contact_policies_state_chk",
      sql`(${table.doNotContact} IS TRUE AND ${table.source} IS NOT NULL AND ${table.setAt} IS NOT NULL AND ${table.clearedAt} IS NULL)
        OR (${table.doNotContact} IS FALSE AND ${table.source} IS NOT NULL AND ${table.clearedAt} IS NOT NULL AND ${table.setAt} IS NOT NULL)
        OR (${table.doNotContact} IS FALSE AND ${table.source} IS NULL AND ${table.setAt} IS NULL AND ${table.clearedAt} IS NULL)`,
    ),
    check(
      "crm_person_contact_policies_reason_chk",
      sql`${table.reason} IS NULL OR length(btrim(${table.reason})) > 0`,
    ),
    check(
      "crm_person_contact_policies_timestamp_chk",
      sql`${table.setAt} IS NULL OR ${table.clearedAt} IS NULL OR ${table.clearedAt} >= ${table.setAt}`,
    ),
    index("crm_person_contact_policies_updated_idx").on(table.updatedAt),
  ],
);

/** Inbound identities that could not be resolved safely and require review. */
export const crmIdentityExceptions = pgTable(
  "crm_identity_exceptions",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    channel: text("channel").notNull().$type<CrmChannel>(),
    accountRef: text("account_ref").notNull(),
    sourceEventKey: text("source_event_key").notNull(),
    identityValue: text("identity_value"),
    reason: text("reason").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull().default("open").$type<"open" | "resolved" | "ignored">(),
    resolvedPersonId: uuid("resolved_person_id"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("crm_identity_exceptions_organization_idx").on(table.organizationId),
    foreignKey({
      columns: [table.resolvedPersonId],
      foreignColumns: [people.id],
      name: "crm_identity_exceptions_person_fk",
    }).onDelete("restrict"),
    unique("crm_identity_exceptions_event_uq").on(table.channel, table.accountRef, table.sourceEventKey),
    index("crm_identity_exceptions_status_created_idx").on(table.status, table.createdAt),
    check("crm_identity_exceptions_channel_chk", sql`${table.channel} IN ('email', 'linkedin', 'whatsapp')`),
    check("crm_identity_exceptions_status_chk", sql`${table.status} IN ('open', 'resolved', 'ignored')`),
    check("crm_identity_exceptions_reason_chk", sql`length(btrim(${table.reason})) > 0`),
    check("crm_identity_exceptions_resolution_chk", sql`
      (${table.status} = 'open' AND ${table.resolvedPersonId} IS NULL AND ${table.resolvedAt} IS NULL)
      OR (${table.status} = 'resolved' AND ${table.resolvedPersonId} IS NOT NULL AND ${table.resolvedAt} IS NOT NULL)
      OR (${table.status} = 'ignored' AND ${table.resolvedPersonId} IS NULL AND ${table.resolvedAt} IS NOT NULL)
    `),
  ],
);

export type CrmWorkflowState =
  | "unclassified"
  | "classifying"
  | "action_required"
  | "waiting"
  | "idle"
  | "paused"
  | "closed"
  | "error";

/**
 * Person state in a pipeline. A row is created only after the first inbound
 * reply, or when a rep speaks to the person on a call (getOrCreateCrmRecordForCall).
 */
export const crmRecords = pgTable(
  "crm_records",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    personId: uuid("person_id").notNull(),
    pipelineId: uuid("pipeline_id").notNull(),
    categoryKey: text("category_key"),
    subcategoryId: uuid("subcategory_id"),
    workflowState: text("workflow_state").notNull().default("unclassified").$type<CrmWorkflowState>(),
    categorySource: text("category_source").$type<"ai" | "human" | "integration">(),
    categoryLocked: boolean("category_locked").notNull().default(false),
    activeChannel: text("active_channel").$type<CrmRecordChannel>(),
    /** Validated against an inbound message on this record by the migration trigger. */
    latestInboundMessageId: uuid("latest_inbound_message_id"),
    contextVersion: integer("context_version").notNull().default(0),
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
    lastOutboundAt: timestamp("last_outbound_at", { withTimezone: true }),
    lastInteractionAt: timestamp("last_interaction_at", { withTimezone: true }),
    nextActionAt: timestamp("next_action_at", { withTimezone: true }),
    closedReason: text("closed_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("crm_records_organization_idx").on(table.organizationId),
    foreignKey({
      columns: [table.personId],
      foreignColumns: [people.id],
      name: "crm_records_person_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.pipelineId],
      foreignColumns: [crmPipelines.id],
      name: "crm_records_pipeline_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.categoryKey],
      foreignColumns: [crmCategories.key],
      name: "crm_records_category_fk",
    }).onDelete("restrict"),
    unique("crm_records_person_pipeline_uq").on(table.personId, table.pipelineId),
    unique("crm_records_id_person_uq").on(table.id, table.personId),
    unique("crm_records_id_pipeline_uq").on(table.id, table.pipelineId),
    foreignKey({
      columns: [table.subcategoryId, table.pipelineId, table.categoryKey],
      foreignColumns: [crmSubcategories.id, crmSubcategories.pipelineId, crmSubcategories.categoryKey],
      name: "crm_records_subcategory_target_fk",
    }).onDelete("restrict"),
    index("crm_records_pipeline_state_idx").on(table.pipelineId, table.workflowState),
    index("crm_records_person_idx").on(table.personId),
    check(
      "crm_records_workflow_state_chk",
      sql`${table.workflowState} IN ('unclassified', 'classifying', 'action_required', 'waiting', 'idle', 'paused', 'closed', 'error')`,
    ),
    check(
      "crm_records_category_source_chk",
      sql`${table.categorySource} IS NULL OR ${table.categorySource} IN ('ai', 'human', 'integration')`,
    ),
    check(
      "crm_records_active_channel_chk",
      sql`${table.activeChannel} IS NULL OR ${table.activeChannel} IN ('email', 'linkedin', 'whatsapp')`,
    ),
    check("crm_records_context_version_chk", sql`${table.contextVersion} >= 0`),
    check(
      "crm_records_subcategory_category_chk",
      sql`${table.subcategoryId} IS NULL OR ${table.categoryKey} IS NOT NULL`,
    ),
    check(
      "crm_records_category_source_presence_chk",
      sql`(${table.categoryKey} IS NULL) = (${table.categorySource} IS NULL)`,
    ),
    check(
      "crm_records_category_lock_chk",
      sql`${table.categoryLocked} IS FALSE OR ${table.categoryKey} IS NOT DISTINCT FROM 'customer'`,
    ),
    check(
      "crm_records_closed_reason_chk",
      sql`${table.closedReason} IS NULL OR length(btrim(${table.closedReason})) > 0`,
    ),
  ],
);

// The channel set lives in channels.ts (pure, client-safe); re-exported here
// because every table below is typed by it.
export { CRM_CHANNELS, type CrmChannel } from "./channels";
/** Where a record's work happens — the same set as CrmChannel. */
export type CrmRecordChannel = CrmChannel;

export const crmConversations = pgTable(
  "crm_conversations",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    crmRecordId: uuid("crm_record_id").notNull(),
    personId: uuid("person_id").notNull(),
    channel: text("channel").notNull().$type<CrmChannel>(),
    accountRef: text("account_ref").notNull(),
    providerThreadId: text("provider_thread_id"),
    providerContactId: text("provider_contact_id"),
    status: text("status").notNull().default("active").$type<"active" | "closed">(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("crm_conversations_organization_idx").on(table.organizationId),
    foreignKey({
      columns: [table.crmRecordId, table.personId],
      foreignColumns: [crmRecords.id, crmRecords.personId],
      name: "crm_conversations_record_person_fk",
    }).onDelete("restrict"),
    unique("crm_conversations_id_person_channel_account_uq").on(
      table.id,
      table.personId,
      table.channel,
      table.accountRef,
    ),
    unique("crm_conversations_id_record_uq").on(table.id, table.crmRecordId),
    uniqueIndex("crm_conversations_provider_thread_uq")
      .on(table.channel, table.accountRef, table.providerThreadId)
      .where(sql`${table.providerThreadId} IS NOT NULL`),
    index("crm_conversations_record_idx").on(table.crmRecordId),
    check("crm_conversations_channel_chk", sql`${table.channel} IN ('email', 'linkedin', 'whatsapp')`),
    check("crm_conversations_status_chk", sql`${table.status} IN ('active', 'closed')`),
    check("crm_conversations_account_ref_chk", sql`length(btrim(${table.accountRef})) > 0`),
  ],
);

export const crmConversationMessages = pgTable(
  "crm_conversation_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id").notNull(),
    personId: uuid("person_id").notNull(),
    channel: text("channel").notNull().$type<CrmChannel>(),
    accountRef: text("account_ref").notNull(),
    direction: text("direction").notNull().$type<"inbound" | "outbound">(),
    idempotencyKey: text("idempotency_key").notNull(),
    providerMessageId: text("provider_message_id"),
    subject: text("subject"),
    bodyText: text("body_text").notNull(),
    bodyHtml: text("body_html"),
    raw: jsonb("raw").$type<Record<string, unknown> | null>(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.conversationId, table.personId, table.channel, table.accountRef],
      foreignColumns: [
        crmConversations.id,
        crmConversations.personId,
        crmConversations.channel,
        crmConversations.accountRef,
      ],
      name: "crm_conversation_messages_conversation_identity_fk",
    }).onDelete("restrict"),
    unique("crm_conversation_messages_channel_account_idempotency_uq").on(
      table.channel,
      table.accountRef,
      table.idempotencyKey,
    ),
    uniqueIndex("crm_conversation_messages_provider_id_uq")
      .on(table.channel, table.accountRef, table.providerMessageId)
      .where(sql`${table.providerMessageId} IS NOT NULL`),
    index("crm_conversation_messages_conversation_idx").on(table.conversationId, table.sentAt),
    check("crm_conversation_messages_channel_chk", sql`${table.channel} IN ('email', 'linkedin', 'whatsapp')`),
    check("crm_conversation_messages_direction_chk", sql`${table.direction} IN ('inbound', 'outbound')`),
    check("crm_conversation_messages_idempotency_chk", sql`length(btrim(${table.idempotencyKey})) > 0`),
    check("crm_conversation_messages_body_chk", sql`length(btrim(${table.bodyText})) > 0`),
  ],
);

export type CrmClassificationStatus =
  | "proposed"
  | "auto_applied"
  | "accepted"
  | "rejected"
  | "overridden"
  | "stale"
  | "failed";

export const crmClassifications = pgTable(
  "crm_classifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    crmRecordId: uuid("crm_record_id").notNull(),
    messageId: uuid("message_id").notNull(),
    expectedContextVersion: integer("expected_context_version").notNull(),
    previousCategoryKey: text("previous_category_key"),
    previousSubcategoryId: uuid("previous_subcategory_id"),
    proposedCategoryKey: text("proposed_category_key"),
    proposedSubcategoryId: uuid("proposed_subcategory_id"),
    appliedCategoryKey: text("applied_category_key"),
    appliedSubcategoryId: uuid("applied_subcategory_id"),
    confidence: numeric("confidence", { precision: 5, scale: 4 }),
    reasoning: text("reasoning"),
    status: text("status").notNull().$type<CrmClassificationStatus>(),
    provider: text("provider"),
    model: text("model"),
    request: jsonb("request").$type<Record<string, unknown> | null>(),
    response: jsonb("response").$type<Record<string, unknown> | null>(),
    error: text("error"),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.crmRecordId],
      foreignColumns: [crmRecords.id],
      name: "crm_classifications_record_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.messageId],
      foreignColumns: [crmConversationMessages.id],
      name: "crm_classifications_message_fk",
    }).onDelete("restrict"),
    foreignKey({ columns: [table.previousCategoryKey], foreignColumns: [crmCategories.key], name: "crm_classifications_previous_category_fk" }).onDelete("restrict"),
    foreignKey({ columns: [table.proposedCategoryKey], foreignColumns: [crmCategories.key], name: "crm_classifications_proposed_category_fk" }).onDelete("restrict"),
    foreignKey({ columns: [table.appliedCategoryKey], foreignColumns: [crmCategories.key], name: "crm_classifications_applied_category_fk" }).onDelete("restrict"),
    foreignKey({ columns: [table.previousSubcategoryId], foreignColumns: [crmSubcategories.id], name: "crm_classifications_previous_subcategory_fk" }).onDelete("restrict"),
    foreignKey({ columns: [table.proposedSubcategoryId], foreignColumns: [crmSubcategories.id], name: "crm_classifications_proposed_subcategory_fk" }).onDelete("restrict"),
    foreignKey({ columns: [table.appliedSubcategoryId], foreignColumns: [crmSubcategories.id], name: "crm_classifications_applied_subcategory_fk" }).onDelete("restrict"),
    unique("crm_classifications_message_context_uq").on(table.messageId, table.expectedContextVersion),
    index("crm_classifications_record_created_idx").on(table.crmRecordId, table.createdAt),
    check("crm_classifications_status_chk", sql`${table.status} IN ('proposed', 'auto_applied', 'accepted', 'rejected', 'overridden', 'stale', 'failed')`),
    check("crm_classifications_context_version_chk", sql`${table.expectedContextVersion} >= 0`),
    check("crm_classifications_confidence_chk", sql`${table.confidence} IS NULL OR (${table.confidence} >= 0 AND ${table.confidence} <= 1)`),
    check("crm_classifications_failed_confidence_chk", sql`${table.status} = 'failed' OR ${table.confidence} IS NOT NULL`),
  ],
);

export const crmEvents = pgTable(
  "crm_events",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    personId: uuid("person_id").notNull(),
    crmRecordId: uuid("crm_record_id"),
    pipelineId: uuid("pipeline_id"),
    eventType: text("event_type").notNull(),
    actorType: text("actor_type").notNull().$type<"ai" | "human" | "system" | "integration" | "authenticated_operator">(),
    actorRef: text("actor_ref"),
    fromData: jsonb("from_data").$type<Record<string, unknown> | null>(),
    toData: jsonb("to_data").$type<Record<string, unknown> | null>(),
    meta: jsonb("meta").$type<Record<string, unknown> | null>(),
    contextVersion: integer("context_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("crm_events_organization_idx").on(table.organizationId),
    foreignKey({
      columns: [table.personId],
      foreignColumns: [people.id],
      name: "crm_events_person_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.pipelineId],
      foreignColumns: [crmPipelines.id],
      name: "crm_events_pipeline_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.crmRecordId, table.personId],
      foreignColumns: [crmRecords.id, crmRecords.personId],
      name: "crm_events_record_person_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.crmRecordId, table.pipelineId],
      foreignColumns: [crmRecords.id, crmRecords.pipelineId],
      name: "crm_events_record_pipeline_fk",
    }).onDelete("restrict"),
    index("crm_events_person_created_idx").on(table.personId, table.createdAt),
    index("crm_events_record_created_idx").on(table.crmRecordId, table.createdAt),
    check("crm_events_event_type_chk", sql`length(btrim(${table.eventType})) > 0`),
    check("crm_events_actor_type_chk", sql`${table.actorType} IN ('ai', 'human', 'system', 'integration', 'authenticated_operator')`),
    check("crm_events_context_version_chk", sql`${table.contextVersion} IS NULL OR ${table.contextVersion} >= 0`),
    check(
      "crm_events_record_scope_chk",
      sql`(${table.crmRecordId} IS NULL AND ${table.pipelineId} IS NULL)
        OR (${table.crmRecordId} IS NOT NULL AND ${table.pipelineId} IS NOT NULL)`,
    ),
  ],
);

export type CrmSequenceStatus = "active" | "archived";
export type CrmSequenceVersionStatus = "draft" | "published";

/** Reusable reply/follow-up workflow. The conversation determines delivery channel. */
export const crmSequences = pgTable(
  "crm_sequences",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("active").$type<CrmSequenceStatus>(),
    /** The circular version pointers are DEFERRABLE in the hand-written DDL. */
    draftVersionId: uuid("draft_version_id")
      .notNull()
      .references((): AnyPgColumn => crmSequenceVersions.id, { onDelete: "restrict" }),
    latestPublishedVersionId: uuid("latest_published_version_id").references(
      (): AnyPgColumn => crmSequenceVersions.id,
      { onDelete: "restrict" },
    ),
    /**
     * Follow-up drafts of this sequence go out on their own, paced per sending
     * account (src/lib/crm/autoFollowUps.ts); the immediate reply always waits
     * for a person. Not versioned: switching it needs no re-publish.
     * scripts/add-crm-auto-follow-ups.ts.
     */
    autoSendFollowUps: boolean("auto_send_follow_ups").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("crm_sequences_organization_idx").on(table.organizationId),
    unique("crm_sequences_id_draft_version_uq").on(table.id, table.draftVersionId),
    index("crm_sequences_status_name_idx").on(table.status, table.name),
    check("crm_sequences_name_chk", sql`length(btrim(${table.name})) > 0`),
    check("crm_sequences_status_chk", sql`${table.status} IN ('active', 'archived')`),
  ],
);

/** Immutable once published; each sequence retains exactly one mutable draft. */
export const crmSequenceVersions = pgTable(
  "crm_sequence_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sequenceId: uuid("sequence_id").notNull(),
    version: integer("version").notNull(),
    status: text("status").notNull().default("draft").$type<CrmSequenceVersionStatus>(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.sequenceId],
      foreignColumns: [crmSequences.id],
      name: "crm_sequence_versions_sequence_fk",
    }).onDelete("restrict"),
    unique("crm_sequence_versions_sequence_version_uq").on(table.sequenceId, table.version),
    unique("crm_sequence_versions_id_sequence_uq").on(table.id, table.sequenceId),
    uniqueIndex("crm_sequence_versions_one_draft_uq")
      .on(table.sequenceId)
      .where(sql`${table.status} = 'draft'`),
    check("crm_sequence_versions_version_chk", sql`${table.version} > 0`),
    check("crm_sequence_versions_status_chk", sql`${table.status} IN ('draft', 'published')`),
    check(
      "crm_sequence_versions_published_at_chk",
      sql`(${table.status} = 'draft' AND ${table.publishedAt} IS NULL)
        OR (${table.status} = 'published' AND ${table.publishedAt} IS NOT NULL)`,
    ),
  ],
);

export const crmSequenceSteps = pgTable(
  "crm_sequence_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sequenceVersionId: uuid("sequence_version_id").notNull(),
    position: integer("position").notNull(),
    stepType: text("step_type").notNull().$type<"reply" | "follow_up">(),
    name: text("name").notNull(),
    delayMinutes: integer("delay_minutes").notNull(),
    subjectTemplate: text("subject_template"),
    bodyTemplate: text("body_template"),
    aiInstructions: text("ai_instructions").notNull(),
    knowledgeTags: text("knowledge_tags").array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.sequenceVersionId],
      foreignColumns: [crmSequenceVersions.id],
      name: "crm_sequence_steps_version_fk",
    }).onDelete("restrict"),
    unique("crm_sequence_steps_version_position_uq").on(table.sequenceVersionId, table.position),
    unique("crm_sequence_steps_id_version_uq").on(table.id, table.sequenceVersionId),
    check("crm_sequence_steps_position_chk", sql`${table.position} > 0`),
    check("crm_sequence_steps_delay_chk", sql`${table.delayMinutes} >= 0`),
    check("crm_sequence_steps_name_chk", sql`length(btrim(${table.name})) > 0`),
    check("crm_sequence_steps_ai_instructions_chk", sql`length(btrim(${table.aiInstructions})) > 0`),
    check(
      "crm_sequence_steps_semantics_chk",
      sql`(${table.position} = 1 AND ${table.stepType} = 'reply' AND ${table.delayMinutes} = 0)
        OR (${table.position} > 1 AND ${table.stepType} = 'follow_up')`,
    ),
  ],
);

/** At most one channel-neutral default sequence per subcategory. */
export const crmSubcategorySequenceAssignments = pgTable(
  "crm_subcategory_sequence_assignments",
  {
    subcategoryId: uuid("subcategory_id").notNull(),
    sequenceId: uuid("sequence_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.subcategoryId],
      name: "crm_subcategory_sequence_assignments_pk",
    }),
    foreignKey({
      columns: [table.subcategoryId],
      foreignColumns: [crmSubcategories.id],
      name: "crm_subcategory_sequence_assignments_subcategory_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.sequenceId],
      foreignColumns: [crmSequences.id],
      name: "crm_subcategory_sequence_assignments_sequence_fk",
    }).onDelete("restrict"),
    index("crm_subcategory_sequence_assignments_sequence_idx").on(table.sequenceId),
  ],
);

/** A record-specific future-run selection; historical cleared rows are retained. */
export const crmRecordSequenceOverrides = pgTable(
  "crm_record_sequence_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    crmRecordId: uuid("crm_record_id").notNull(),
    sequenceId: uuid("sequence_id").notNull(),
    source: text("source").notNull().$type<"human" | "integration">(),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull().defaultNow(),
    clearedAt: timestamp("cleared_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.crmRecordId],
      foreignColumns: [crmRecords.id],
      name: "crm_record_sequence_overrides_record_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.sequenceId],
      foreignColumns: [crmSequences.id],
      name: "crm_record_sequence_overrides_sequence_fk",
    }).onDelete("restrict"),
    uniqueIndex("crm_record_sequence_overrides_active_uq")
      .on(table.crmRecordId)
      .where(sql`${table.clearedAt} IS NULL`),
    index("crm_record_sequence_overrides_record_idx").on(table.crmRecordId),
    check("crm_record_sequence_overrides_source_chk", sql`${table.source} IN ('human', 'integration')`),
    check(
      "crm_record_sequence_overrides_time_chk",
      sql`${table.clearedAt} IS NULL OR ${table.clearedAt} >= ${table.effectiveAt}`,
    ),
  ],
);

export type CrmSequenceRunStatus = "active" | "interrupted" | "paused" | "completed" | "cancelled";

export const crmSequenceRuns = pgTable(
  "crm_sequence_runs",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    crmRecordId: uuid("crm_record_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    sequenceId: uuid("sequence_id").notNull(),
    sequenceVersionId: uuid("sequence_version_id").notNull(),
    subcategoryId: uuid("subcategory_id").notNull(),
    status: text("status").notNull().default("active").$type<CrmSequenceRunStatus>(),
    currentStepPosition: integer("current_step_position").notNull().default(1),
    startStepPosition: integer("start_step_position").notNull().default(1),
    startedBy: text("started_by").notNull().$type<"ai_assignment" | "human_override">(),
    triggerMessageId: uuid("trigger_message_id").notNull(),
    lastInboundAtStart: timestamp("last_inbound_at_start", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("crm_sequence_runs_organization_idx").on(table.organizationId),
    foreignKey({
      columns: [table.crmRecordId],
      foreignColumns: [crmRecords.id],
      name: "crm_sequence_runs_record_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.conversationId, table.crmRecordId],
      foreignColumns: [crmConversations.id, crmConversations.crmRecordId],
      name: "crm_sequence_runs_conversation_record_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.sequenceVersionId, table.sequenceId],
      foreignColumns: [crmSequenceVersions.id, crmSequenceVersions.sequenceId],
      name: "crm_sequence_runs_version_sequence_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.subcategoryId],
      foreignColumns: [crmSubcategories.id],
      name: "crm_sequence_runs_subcategory_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.triggerMessageId],
      foreignColumns: [crmConversationMessages.id],
      name: "crm_sequence_runs_trigger_message_fk",
    }).onDelete("restrict"),
    uniqueIndex("crm_sequence_runs_one_active_uq")
      .on(table.crmRecordId)
      .where(sql`${table.status} = 'active'`),
    index("crm_sequence_runs_record_created_idx").on(table.crmRecordId, table.createdAt),
    check("crm_sequence_runs_status_chk", sql`${table.status} IN ('active', 'interrupted', 'paused', 'completed', 'cancelled')`),
    check("crm_sequence_runs_positions_chk", sql`${table.startStepPosition} > 0 AND ${table.currentStepPosition} >= ${table.startStepPosition}`),
    check("crm_sequence_runs_started_by_chk", sql`${table.startedBy} IN ('ai_assignment', 'human_override')`),
  ],
);

export type CrmSequenceStepRunStatus =
  | "scheduled"
  | "drafting"
  | "awaiting_review"
  | "sent"
  | "skipped"
  | "cancelled"
  | "failed";

export const crmSequenceStepRuns = pgTable(
  "crm_sequence_step_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sequenceRunId: uuid("sequence_run_id").notNull(),
    sequenceStepId: uuid("sequence_step_id").notNull(),
    status: text("status").notNull().default("scheduled").$type<CrmSequenceStepRunStatus>(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    draftId: uuid("draft_id").references((): AnyPgColumn => crmDrafts.id, { onDelete: "restrict" }),
    sentMessageId: uuid("sent_message_id"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    expectedContextVersion: integer("expected_context_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.sequenceRunId],
      foreignColumns: [crmSequenceRuns.id],
      name: "crm_sequence_step_runs_run_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.sequenceStepId],
      foreignColumns: [crmSequenceSteps.id],
      name: "crm_sequence_step_runs_step_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.sentMessageId],
      foreignColumns: [crmConversationMessages.id],
      name: "crm_sequence_step_runs_sent_message_fk",
    }).onDelete("restrict"),
    unique("crm_sequence_step_runs_run_step_uq").on(table.sequenceRunId, table.sequenceStepId),
    unique("crm_sequence_step_runs_id_run_uq").on(table.id, table.sequenceRunId),
    uniqueIndex("crm_sequence_step_runs_draft_uq")
      .on(table.draftId)
      .where(sql`${table.draftId} IS NOT NULL`),
    index("crm_sequence_step_runs_due_idx").on(table.status, table.dueAt),
    check("crm_sequence_step_runs_status_chk", sql`${table.status} IN ('scheduled', 'drafting', 'awaiting_review', 'sent', 'skipped', 'cancelled', 'failed')`),
    check("crm_sequence_step_runs_attempts_chk", sql`${table.attemptCount} >= 0`),
    check("crm_sequence_step_runs_context_chk", sql`${table.expectedContextVersion} >= 0`),
    check("crm_sequence_step_runs_sent_message_chk", sql`${table.status} <> 'sent' OR ${table.sentMessageId} IS NOT NULL`),
  ],
);

export type CrmDraftStatus =
  | "generating"
  | "awaiting_review"
  | "sending"
  | "sent"
  | "discarded"
  | "stale"
  | "failed"
  | "delivery_uncertain";

export const crmDrafts = pgTable(
  "crm_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    crmRecordId: uuid("crm_record_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    replyForMessageId: uuid("reply_for_message_id"),
    sequenceStepRunId: uuid("sequence_step_run_id"),
    expectedContextVersion: integer("expected_context_version").notNull(),
    revision: integer("revision").notNull().default(1),
    channel: text("channel").notNull().$type<CrmChannel>(),
    subject: text("subject"),
    aiBodyText: text("ai_body_text"),
    aiBodyHtml: text("ai_body_html"),
    editedBodyText: text("edited_body_text"),
    editedBodyHtml: text("edited_body_html"),
    status: text("status").notNull().default("generating").$type<CrmDraftStatus>(),
    provider: text("provider"),
    model: text("model"),
    request: jsonb("request").$type<Record<string, unknown> | null>(),
    response: jsonb("response").$type<Record<string, unknown> | null>(),
    error: text("error"),
    /**
     * Set on a follow-up draft whose sequence sends automatically: from this
     * time the sender may send it when its account's turn comes. Cleared when
     * a person takes it over ("Review before sending"). Kept after the send.
     */
    autoSendAt: timestamp("auto_send_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.crmRecordId],
      foreignColumns: [crmRecords.id],
      name: "crm_drafts_record_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.conversationId, table.crmRecordId],
      foreignColumns: [crmConversations.id, crmConversations.crmRecordId],
      name: "crm_drafts_conversation_record_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.replyForMessageId],
      foreignColumns: [crmConversationMessages.id],
      name: "crm_drafts_reply_message_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.sequenceStepRunId],
      foreignColumns: [crmSequenceStepRuns.id],
      name: "crm_drafts_step_run_fk",
    }).onDelete("restrict"),
    uniqueIndex("crm_drafts_step_run_uq")
      .on(table.sequenceStepRunId)
      .where(sql`${table.sequenceStepRunId} IS NOT NULL`),
    index("crm_drafts_record_status_idx").on(table.crmRecordId, table.status),
    index("crm_drafts_auto_send_idx")
      .on(table.autoSendAt)
      .where(sql`${table.autoSendAt} IS NOT NULL AND ${table.status} = 'awaiting_review'`),
    check("crm_drafts_context_chk", sql`${table.expectedContextVersion} >= 0`),
    check("crm_drafts_revision_chk", sql`${table.revision} > 0`),
    check("crm_drafts_channel_chk", sql`${table.channel} IN ('email', 'linkedin', 'whatsapp')`),
    check("crm_drafts_linkedin_subject_chk", sql`${table.channel} <> 'linkedin' OR ${table.subject} IS NULL`),
    check("crm_drafts_whatsapp_subject_chk", sql`${table.channel} <> 'whatsapp' OR ${table.subject} IS NULL`),
    check("crm_drafts_status_chk", sql`${table.status} IN ('generating', 'awaiting_review', 'sending', 'sent', 'discarded', 'stale', 'failed', 'delivery_uncertain')`),
  ],
);

export type CrmSendAttemptStatus =
  | "prepared"
  | "sending"
  | "sent"
  | "failed"
  | "delivery_uncertain"
  | "reconciled";

export type CrmSendActorType = "authenticated_operator" | "system";

export const crmSendAttempts = pgTable(
  "crm_send_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    draftId: uuid("draft_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").notNull().default("prepared").$type<CrmSendAttemptStatus>(),
    /** system: the automatic follow-up sender (src/lib/crm/autoFollowUps.ts). */
    actorType: text("actor_type").notNull().default("authenticated_operator").$type<CrmSendActorType>(),
    requestId: text("request_id").notNull(),
    provider: text("provider").notNull(),
    accountRef: text("account_ref").notNull(),
    providerRequestId: text("provider_request_id"),
    providerMessageId: text("provider_message_id"),
    request: jsonb("request").$type<Record<string, unknown> | null>(),
    response: jsonb("response").$type<Record<string, unknown> | null>(),
    error: text("error"),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    reconciliationNote: text("reconciliation_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.draftId],
      foreignColumns: [crmDrafts.id],
      name: "crm_send_attempts_draft_fk",
    }).onDelete("restrict"),
    unique("crm_send_attempts_idempotency_uq").on(table.idempotencyKey),
    uniqueIndex("crm_send_attempts_one_terminal_uq")
      .on(table.draftId)
      .where(sql`${table.status} IN ('sent', 'delivery_uncertain', 'reconciled')`),
    index("crm_send_attempts_draft_created_idx").on(table.draftId, table.createdAt),
    check("crm_send_attempts_idempotency_chk", sql`length(btrim(${table.idempotencyKey})) > 0`),
    check("crm_send_attempts_status_chk", sql`${table.status} IN ('prepared', 'sending', 'sent', 'failed', 'delivery_uncertain', 'reconciled')`),
    check("crm_send_attempts_actor_chk", sql`${table.actorType} IN ('authenticated_operator', 'system')`),
    index("crm_send_attempts_system_account_idx")
      .on(table.accountRef, table.createdAt)
      .where(sql`${table.actorType} = 'system'`),
    check("crm_send_attempts_request_id_chk", sql`length(btrim(${table.requestId})) > 0`),
    check("crm_send_attempts_provider_chk", sql`length(btrim(${table.provider})) > 0`),
    check("crm_send_attempts_account_chk", sql`length(btrim(${table.accountRef})) > 0`),
    check(
      "crm_send_attempts_reconciliation_chk",
      sql`${table.status} <> 'reconciled' OR (${table.reconciledAt} IS NOT NULL AND length(btrim(${table.reconciliationNote})) > 0)`,
    ),
  ],
);

export type CrmKnowledgeKind =
  | "company"
  | "product"
  | "pricing"
  | "faq"
  | "case_study"
  | "objection"
  | "scheduling"
  | "custom";

export const crmKnowledgeDocuments = pgTable(
  "crm_knowledge_documents",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    kind: text("kind").notNull().$type<CrmKnowledgeKind>(),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    alwaysInclude: boolean("always_include").notNull().default(false),
    active: boolean("active").notNull().default(true),
    latestVersion: integer("latest_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("crm_knowledge_documents_organization_idx").on(table.organizationId),
    // The composite latest-version FK is circular and is installed DEFERRABLE
    // by scripts/create-people-crm-workflow.ts.
    index("crm_knowledge_documents_active_kind_idx").on(table.active, table.kind),
    check("crm_knowledge_documents_title_chk", sql`length(btrim(${table.title})) > 0`),
    check("crm_knowledge_documents_kind_chk", sql`${table.kind} IN ('company', 'product', 'pricing', 'faq', 'case_study', 'objection', 'scheduling', 'custom')`),
    check("crm_knowledge_documents_latest_version_chk", sql`${table.latestVersion} > 0`),
  ],
);

/** Authored Knowledge is append-only; edits insert a new numbered version. */
export const crmKnowledgeDocumentVersions = pgTable(
  "crm_knowledge_document_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id").notNull(),
    version: integer("version").notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.documentId],
      foreignColumns: [crmKnowledgeDocuments.id],
      name: "crm_knowledge_document_versions_document_fk",
    }).onDelete("restrict"),
    unique("crm_knowledge_document_versions_document_version_uq").on(table.documentId, table.version),
    unique("crm_knowledge_document_versions_id_document_uq").on(table.id, table.documentId),
    check("crm_knowledge_document_versions_version_chk", sql`${table.version} > 0`),
    check("crm_knowledge_document_versions_content_chk", sql`length(btrim(${table.content})) > 0`),
  ],
);

export const crmDraftKnowledgeCitations = pgTable(
  "crm_draft_knowledge_citations",
  {
    draftId: uuid("draft_id").notNull(),
    documentVersionId: uuid("document_version_id").notNull(),
    excerpt: text("excerpt").notNull(),
    excerptHash: text("excerpt_hash").notNull(),
    rank: numeric("rank").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.draftId, table.documentVersionId, table.excerptHash],
      name: "crm_draft_knowledge_citations_pk",
    }),
    foreignKey({
      columns: [table.draftId],
      foreignColumns: [crmDrafts.id],
      name: "crm_draft_knowledge_citations_draft_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.documentVersionId],
      foreignColumns: [crmKnowledgeDocumentVersions.id],
      name: "crm_draft_knowledge_citations_version_fk",
    }).onDelete("restrict"),
    check("crm_draft_knowledge_citations_excerpt_chk", sql`length(btrim(${table.excerpt})) > 0`),
    check("crm_draft_knowledge_citations_hash_chk", sql`length(btrim(${table.excerptHash})) > 0`),
    check("crm_draft_knowledge_citations_rank_chk", sql`${table.rank} >= 0`),
  ],
);

export type CrmJobKind = "classification" | "initial_draft" | "due_followup_draft";
export type CrmJobStatus = "queued" | "running" | "succeeded" | "failed";

/** Durable AI-only work queue. No job kind has permission to send. */
export const crmJobs = pgTable(
  "crm_jobs",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull().$type<CrmJobKind>(),
    status: text("status").notNull().default("queued").$type<CrmJobStatus>(),
    entityType: text("entity_type").notNull().$type<"message" | "classification" | "sequence_step_run">(),
    entityId: uuid("entity_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    payload: jsonb("payload").notNull().$type<Record<string, unknown>>().default({}),
    priority: integer("priority").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("crm_jobs_organization_idx").on(table.organizationId),
    unique("crm_jobs_idempotency_uq").on(table.idempotencyKey),
    unique("crm_jobs_entity_uq").on(table.kind, table.entityType, table.entityId),
    index("crm_jobs_claim_idx").on(table.status, table.runAfter, table.priority),
    index("crm_jobs_stale_claim_idx").on(table.status, table.lockedAt),
    check("crm_jobs_kind_chk", sql`${table.kind} IN ('classification', 'initial_draft', 'due_followup_draft')`),
    check("crm_jobs_status_chk", sql`${table.status} IN ('queued', 'running', 'succeeded', 'failed')`),
    check("crm_jobs_entity_type_chk", sql`${table.entityType} IN ('message', 'classification', 'sequence_step_run')`),
    check(
      "crm_jobs_kind_entity_chk",
      sql`(${table.kind} = 'classification' AND ${table.entityType} = 'message')
        OR (${table.kind} = 'initial_draft' AND ${table.entityType} = 'classification')
        OR (${table.kind} = 'due_followup_draft' AND ${table.entityType} = 'sequence_step_run')`,
    ),
    check("crm_jobs_idempotency_chk", sql`length(btrim(${table.idempotencyKey})) > 0`),
    check("crm_jobs_attempts_chk", sql`${table.attempts} >= 0 AND ${table.maxAttempts} > 0 AND ${table.attempts} <= ${table.maxAttempts}`),
    check(
      "crm_jobs_lock_chk",
      sql`(${table.status} = 'running' AND ${table.lockedAt} IS NOT NULL AND ${table.lockedBy} IS NOT NULL AND ${table.startedAt} IS NOT NULL)
        OR (${table.status} <> 'running' AND ${table.lockedAt} IS NULL AND ${table.lockedBy} IS NULL)`,
    ),
    check(
      "crm_jobs_completion_chk",
      sql`(${table.status} IN ('succeeded', 'failed')) = (${table.completedAt} IS NOT NULL)`,
    ),
    check(
      "crm_jobs_failure_chk",
      sql`(${table.status} = 'failed') = (${table.failedAt} IS NOT NULL)
        AND (${table.status} <> 'failed' OR length(btrim(${table.lastError})) > 0)`,
    ),
  ],
);
