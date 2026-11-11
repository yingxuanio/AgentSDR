/**
 * End-to-end PostgreSQL + Next.js route integration test for:
 * 1. First-touch brand & sender (`fromEmail`) routing (HK, TW, and `.hk` regional exceptions)
 * 2. Official `PATCH /api/crm/drafts/{id}` sender rebind on unsent `awaiting_review` drafts
 * 3. Readback via `GET /api/crm/drafts/{id}` and `GET /api/crm/drafts`, body preservation, zero outbound mail
 * 4. Idempotent repeat rebind (`changed: false`, revision & timestamp preserved)
 * 5. Rejection (HTTP 409 `CONFLICT`) on `sent`, `sending`, and queued (`autoSendAt !== null` / send attempt) drafts
 *
 * Run against a local disposable PostgreSQL database initialized with the schema:
 *   DATABASE_URL=postgres://postgres:test@127.0.0.1:55439/agentsdr_e2e DATABASE_SSL=disable \
 *     bun run --conditions=react-server scripts/e2e/crm-draft-routing-rebind.ts
 */
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { and, count, eq } from "drizzle-orm";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(1);
}

const { db } = await import("@/lib/db");
const { members, organizations, users } = await import("@/lib/auth/schema");
const { createApiKey } = await import("@/lib/auth/api-keys");
const { companies, people } = await import("@/lib/leads/schema");
const { mailboxes } = await import("@/lib/outreach/schema");
const { runInOrganization } = await import("@/lib/tenancy/scope");
const { ensureCrmDefaults } = await import("@/lib/crm/defaults");
const { ensurePersonCrmRecord } = await import("@/lib/crm/records");
const { createOrGenerateInitialDraft } = await import("@/lib/crm/drafts");
const { withCrmTransaction } = await import("@/lib/crm/repository");
const { upsertConversationInTransaction } = await import("@/lib/crm/conversations");
const {
  crmCategories,
  crmConversations,
  crmDrafts,
  crmRecords,
  crmSendAttempts,
  crmSettings,
} = await import("@/lib/crm/schema");
const draftsCollectionRoute = await import("@/app/api/crm/drafts/route");
const draftByIdRoute = await import("@/app/api/crm/drafts/[id]/route");

type DraftCompletion = import("@/lib/crm/ai/draft").DraftCompletion;
type GenerateCrmDraftInput = import("@/lib/crm/ai/draft").GenerateCrmDraftInput;

type AiInstructionBlock = import("@/lib/crm/ai/instructions").AiInstructionBlock;

const LIVE_COMM_BRAND_ROUTING: AiInstructionBlock[] = [
  {
    id: "comm_brand_routing",
    title: "品牌、语言与发件身份路由（核心规则）",
    content: [
      "根据客户所在区域与语境选择统一品牌身份，同一封信内禁止混用两个品牌：",
      "1. 香港客户（HK*）及英文语境客户：统一使用英文品牌 Linktion，发件邮箱 ivan@linktion.cn，署名 Ivan / Linktion，官网与资料链接优先使用 https://www.linktion.io/en/engagement 或 https://www.linktion.io/en/process。",
      "2. 台湾客户（TW*）及繁中语境客户：统一使用品牌 英选，全信使用自然道地的繁体中文，发件邮箱 ivan@yingxuan.io，署名 Ivan / 英选，可附上宣传册链接 https://www.yingxuan.io/brochure-2026.pdf。",
      "3. 中国内地客户：统一使用品牌 英选，发件邮箱 ivan@yingxuan.io。",
    ].join("\n"),
  },
];

let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const token = crypto.randomUUID().slice(0, 8);
const orgId = crypto.randomUUID();
const userId = crypto.randomUUID();

await db
  .insert(crmCategories)
  .values([
    { key: "customer", label: "Customer", sortOrder: 10 },
    { key: "interested", label: "Interested", sortOrder: 20 },
    { key: "not_interested", label: "Not interested", sortOrder: 30 },
    { key: "other", label: "Other", sortOrder: 40 },
  ])
  .onConflictDoNothing();

await db.insert(organizations).values({
  id: orgId,
  name: `Test Org ${token}`,
  slug: `test-org-${token}`,
  createdAt: new Date(),
});
await db.insert(users).values({
  id: userId,
  name: "Test Operator",
  email: `operator-${token}@example.test`,
  emailVerified: true,
  createdAt: new Date(),
  updatedAt: new Date(),
});
await db.insert(members).values({
  id: crypto.randomUUID(),
  organizationId: orgId,
  userId,
  role: "owner",
  createdAt: new Date(),
});

const { pipelineId, apiKey } = await runInOrganization(orgId, async () => {
  const defaults = await ensureCrmDefaults();
  await db
    .update(crmSettings)
    .set({ draftInstructions: LIVE_COMM_BRAND_ROUTING, updatedAt: new Date() })
    .where(eq(crmSettings.pipelineId, defaults.pipelineId));

  // Insert both connected mailboxes with the exact same timestamp (matching live mini DB tie)
  // and `ivan@yingxuan.io` inserted first so naive `ORDER BY created_at DESC LIMIT 1` would pick yingxuan.
  const tiedAt = new Date("2026-11-04T12:22:21.601Z");
  await db.insert(mailboxes).values([
    {
      organizationId: orgId,
      emailAddress: "ivan@yingxuan.io",
      displayName: "Ivan / 英选",
      status: "connected",
      createdAt: tiedAt,
      updatedAt: tiedAt,
    },
    {
      organizationId: orgId,
      emailAddress: "ivan@linktion.cn",
      displayName: "Ivan / Linktion",
      status: "connected",
      createdAt: tiedAt,
      updatedAt: tiedAt,
    },
  ]);

  const createdKey = await createApiKey({
    name: "e2e-test-key",
    createdByUserId: userId,
    createdByEmail: `operator-${token}@example.test`,
  });

  return { pipelineId: defaults.pipelineId, apiKey: createdKey.secretKey };
});

function authHeaders(extra?: Record<string, string>): HeadersInit {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

const capturedPrompts: Array<{ systemPrompt: string; userPayload: Record<string, unknown> }> = [];
const fakeCompletion: DraftCompletion = async (req) => {
  const userPayload = req.snapshot as Record<string, unknown>;
  capturedPrompts.push({ systemPrompt: req.systemPrompt, userPayload });
  const sender = (userPayload.sender ?? {}) as { name?: string; account?: string };
  if (sender.account === "ivan@linktion.cn") {
    return {
      text: JSON.stringify({
        subject: "Exploring a software partnership — Linktion",
        bodyText: "Hi team,\n\nReaching out from Linktion (https://www.linktion.io/en/engagement).\n\nBest,\nIvan / Linktion",
        bodyHtml: "<p>Hi team,</p><p>Reaching out from Linktion (https://www.linktion.io/en/engagement).</p><p>Best,<br/>Ivan / Linktion</p>",
      }),
      provider: "openrouter",
      model: "test/model",
      request: { fixture: "hk" },
      response: { fixture: "hk" },
    };
  }
  return {
    text: JSON.stringify({
      subject: "關於數位產品開發合作的初步交流 — 英選",
      bodyText: "您好，\n\n我是英選團隊的 Ivan，附上簡介 https://www.yingxuan.io/brochure-2026.pdf。\n\n祝商祺\nIvan / 英选",
      bodyHtml: "<p>您好，</p><p>我是英選團隊的 Ivan。</p><p>Ivan / 英选</p>",
    }),
    provider: "openrouter",
    model: "test/model",
    request: { fixture: "tw" },
    response: { fixture: "tw" },
  };
};

console.log("Running CRM draft routing & sender-rebind integration checks...");

await check("1. New HK first-touch draft binds ivan@linktion.cn + English Linktion without passing fromEmail", async () => {
  await runInOrganization(orgId, async () => {
    const [hkCompany] = await db
      .insert(companies)
      .values({
        organizationId: orgId,
        name: "TAISEIMUSEN (H.K.) CO., LTD",
        domain: "taisei-musen.com.hk",
        custom: { x_code: "HK46" },
        raw: { country: "Hong Kong", company_code: "HK46" },
        source: "manual",
      })
      .returning();
    const [hkPerson] = await db
      .insert(people)
      .values({
        organizationId: orgId,
        companyId: hkCompany!.id,
        fullName: "TAISEIMUSEN (H.K.) CO., LTD",
        email: "info@taisei-musen.com.hk",
        custom: {},
        raw: { notes: "companyCode=HK46" },
        source: "manual",
      })
      .returning();

    capturedPrompts.length = 0;
    const result = await createOrGenerateInitialDraft(
      { personId: hkPerson!.id },
      "Test Operator",
      { complete: fakeCompletion },
    );
    assert.equal(result.created, true);
    assert.equal(result.draft.status, "awaiting_review");
    assert.equal(result.draft.autoSendAt, null);
    assert.match(result.draft.aiBodyText ?? "", /Ivan \/ Linktion/);

    // Prompt received Linktion sender + x_code in company attributes
    assert.equal(capturedPrompts.length, 1);
    const promptPayload = capturedPrompts[0]!.userPayload;
    assert.deepEqual(promptPayload.sender, {
      name: "Ivan / Linktion",
      account: "ivan@linktion.cn",
    });
    const companyInPrompt = promptPayload.company as { attributes?: Record<string, unknown> };
    assert.equal(companyInPrompt?.attributes?.x_code, "HK46");

    // Read back through official GET /api/crm/drafts/{id}
    const getRes = await draftByIdRoute.GET(
      new NextRequest(`http://localhost:3000/api/crm/drafts/${result.draft.id}`, {
        headers: authHeaders(),
      }),
      { params: Promise.resolve({ id: result.draft.id }) },
    );
    assert.equal(getRes.status, 200);
    const getBody = (await getRes.json()) as { draft: Record<string, unknown> };
    assert.equal(getBody.draft.fromEmail, "ivan@linktion.cn");
    assert.equal(getBody.draft.toEmail, "info@taisei-musen.com.hk");
    assert.equal(getBody.draft.status, "awaiting_review");
    assert.equal(getBody.draft.autoSendAt, null);

    // Repeat generate is idempotent (created: false, same draft id)
    const repeat = await createOrGenerateInitialDraft(
      { personId: hkPerson!.id },
      "Test Operator",
      { complete: fakeCompletion },
    );
    assert.equal(repeat.created, false);
    assert.equal(repeat.draft.id, result.draft.id);
  });
});

await check("2. TW first-touch draft remains Traditional Chinese + 英选 + ivan@yingxuan.io; .hk regional exception stays TW", async () => {
  await runInOrganization(orgId, async () => {
    const [twCompany] = await db
      .insert(companies)
      .values({
        organizationId: orgId,
        name: "台灣精密科技股份有限公司",
        domain: "tw-precision.com.tw",
        custom: { x_code: "TW18", x_region: "台湾｜台北" },
        raw: {},
        source: "manual",
      })
      .returning();
    const [twPerson] = await db
      .insert(people)
      .values({
        organizationId: orgId,
        companyId: twCompany!.id,
        fullName: "林經理",
        email: "contact@tw-precision.com.tw",
        custom: {},
        raw: {},
        source: "manual",
      })
      .returning();

    capturedPrompts.length = 0;
    const twRes = await createOrGenerateInitialDraft(
      { personId: twPerson!.id },
      "Test Operator",
      { complete: fakeCompletion },
    );
    assert.equal(twRes.created, true);
    assert.equal(twRes.draft.status, "awaiting_review");
    assert.match(twRes.draft.aiBodyText ?? "", /英選/);
    assert.deepEqual(capturedPrompts[0]!.userPayload.sender, {
      name: "Ivan / 英选",
      account: "ivan@yingxuan.io",
    });

    const getTw = await draftByIdRoute.GET(
      new NextRequest(`http://localhost:3000/api/crm/drafts/${twRes.draft.id}`, {
        headers: authHeaders(),
      }),
      { params: Promise.resolve({ id: twRes.draft.id }) },
    );
    const getTwBody = (await getTw.json()) as { draft: Record<string, unknown> };
    assert.equal(getTwBody.draft.fromEmail, "ivan@yingxuan.io");

    // Regional exception: Taiwan company operating on a .hk domain must NOT be forced to HK
    const [twOnHkDomain] = await db
      .insert(companies)
      .values({
        organizationId: orgId,
        name: "Formosa Holdings",
        domain: "formosa-ap.com.hk",
        custom: { x_code: "TW99" },
        raw: { country: "Taiwan" },
        source: "manual",
      })
      .returning();
    const [twOnHkPerson] = await db
      .insert(people)
      .values({
        organizationId: orgId,
        companyId: twOnHkDomain!.id,
        fullName: "Kevin Lin",
        email: "kevin@formosa-ap.com.hk",
        custom: {},
        raw: {},
        source: "manual",
      })
      .returning();

    const twExceptionRes = await createOrGenerateInitialDraft(
      { personId: twOnHkPerson!.id },
      "Test Operator",
      { complete: fakeCompletion },
    );
    const getException = await draftByIdRoute.GET(
      new NextRequest(`http://localhost:3000/api/crm/drafts/${twExceptionRes.draft.id}`, {
        headers: authHeaders(),
      }),
      { params: Promise.resolve({ id: twExceptionRes.draft.id }) },
    );
    const getExceptionBody = (await getException.json()) as { draft: Record<string, unknown> };
    assert.equal(getExceptionBody.draft.fromEmail, "ivan@yingxuan.io");
  });
});

let reboundDraftId = "";
let reboundRecordId = "";
const ORIGINAL_SUBJECT = "Exploring custom development support for Taisei Musen";
const ORIGINAL_AI_BODY_TEXT =
  "Dear Taisei Musen team,\n\nI am writing from Linktion regarding phase-one engineering collaboration.\n\nBest regards,\nIvan / Linktion";
const ORIGINAL_AI_BODY_HTML =
  "<p>Dear Taisei Musen team,</p><p>I am writing from Linktion regarding phase-one engineering collaboration.</p><p>Best regards,<br/>Ivan / Linktion</p>";

await check("3. PATCH /api/crm/drafts/{id} rebinds unsent awaiting_review draft fromEmail, preserves body verbatim, keeps awaiting_review, and sends nothing", async () => {
  await runInOrganization(orgId, async () => {
    // Seed an unsent awaiting_review draft in the exact pre-fix HK46 state:
    // revision 2, English Linktion body, bound to wrong conversation (`ivan@yingxuan.io`), autoSendAt null.
    const seeded = await withCrmTransaction(async (tx) => {
      const [comp] = await tx
        .insert(companies)
        .values({
          organizationId: orgId,
          name: "Legacy Misrouted HK Co., Ltd.",
          domain: "legacy-hk.com.hk",
          custom: { x_code: "HK90" },
          raw: { country: "Hong Kong" },
          source: "manual",
        })
        .returning();
      const [pers] = await tx
        .insert(people)
        .values({
          organizationId: orgId,
          companyId: comp!.id,
          fullName: "Legacy HK Contact",
          email: "info@legacy-hk.com.hk",
          custom: {},
          raw: {},
          source: "manual",
        })
        .returning();
      const { record } = await ensurePersonCrmRecord(tx, { personId: pers!.id });
      const { conversation: wrongConv } = await upsertConversationInTransaction(tx, {
        crmRecordId: record.id,
        personId: pers!.id,
        channel: "email",
        accountRef: "ivan@yingxuan.io",
      });
      const [draft] = await tx
        .insert(crmDrafts)
        .values({
          crmRecordId: record.id,
          conversationId: wrongConv.id,
          expectedContextVersion: record.contextVersion,
          revision: 2,
          channel: "email",
          subject: ORIGINAL_SUBJECT,
          aiBodyText: ORIGINAL_AI_BODY_TEXT,
          aiBodyHtml: ORIGINAL_AI_BODY_HTML,
          editedBodyText: null,
          editedBodyHtml: null,
          status: "awaiting_review",
          autoSendAt: null,
        })
        .returning();
      return { record, wrongConv, draft: draft! };
    });

    reboundDraftId = seeded.draft.id;
    reboundRecordId = seeded.record.id;

    const patchRes = await draftByIdRoute.PATCH(
      new NextRequest(`http://localhost:3000/api/crm/drafts/${reboundDraftId}`, {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({ fromEmail: "ivan@linktion.cn" }),
      }),
      { params: Promise.resolve({ id: reboundDraftId }) },
    );
    assert.equal(patchRes.status, 200);
    const patchBody = (await patchRes.json()) as {
      changed: boolean;
      previousFromEmail: string;
      draft: Record<string, unknown>;
    };
    assert.equal(patchBody.changed, true);
    assert.equal(patchBody.previousFromEmail, "ivan@yingxuan.io");
    assert.equal(patchBody.draft.id, reboundDraftId);
    assert.equal(patchBody.draft.status, "awaiting_review");
    assert.equal(patchBody.draft.autoSendAt, null);
    assert.equal(patchBody.draft.revision, 3);
    assert.equal(patchBody.draft.fromEmail, "ivan@linktion.cn");
    assert.equal(patchBody.draft.toEmail, "info@legacy-hk.com.hk");
    assert.equal(patchBody.draft.subject, ORIGINAL_SUBJECT);
    assert.equal(patchBody.draft.bodyText, ORIGINAL_AI_BODY_TEXT);
    assert.equal(patchBody.draft.aiBodyText, ORIGINAL_AI_BODY_TEXT);
    assert.equal(patchBody.draft.aiBodyHtml, ORIGINAL_AI_BODY_HTML);
    assert.equal(patchBody.draft.editedBodyText, null);
    assert.equal(patchBody.draft.editedBodyHtml, null);

    // Readback via GET /api/crm/drafts/{id}
    const getRes = await draftByIdRoute.GET(
      new NextRequest(`http://localhost:3000/api/crm/drafts/${reboundDraftId}`, {
        headers: authHeaders(),
      }),
      { params: Promise.resolve({ id: reboundDraftId }) },
    );
    assert.equal(getRes.status, 200);
    const getBody = (await getRes.json()) as { draft: Record<string, unknown> };
    assert.equal(getBody.draft.fromEmail, "ivan@linktion.cn");
    assert.equal(getBody.draft.status, "awaiting_review");
    assert.equal(getBody.draft.autoSendAt, null);
    assert.equal(getBody.draft.bodyText, ORIGINAL_AI_BODY_TEXT);

    // Readback via GET /api/crm/drafts?status=awaiting_review
    const listRes = await draftsCollectionRoute.GET(
      new NextRequest("http://localhost:3000/api/crm/drafts?status=awaiting_review", {
        headers: authHeaders(),
      }),
    );
    assert.equal(listRes.status, 200);
    const listBody = (await listRes.json()) as { drafts: Array<Record<string, unknown>> };
    const inList = listBody.drafts.find((d) => d.id === reboundDraftId);
    assert(inList, "rebound draft must appear in awaiting_review list");
    assert.equal(inList.fromEmail, "ivan@linktion.cn");
    assert.equal(inList.bodyText, ORIGINAL_AI_BODY_TEXT);

    // Verify no duplicate draft, orphaned old conversation removed, no outbound send
    const [[draftCountRow], [recordRow], [attemptCountRow], convRows] = await Promise.all([
      db.select({ total: count() }).from(crmDrafts).where(eq(crmDrafts.crmRecordId, reboundRecordId)),
      db.select().from(crmRecords).where(eq(crmRecords.id, reboundRecordId)),
      db.select({ total: count() }).from(crmSendAttempts).where(eq(crmSendAttempts.draftId, reboundDraftId)),
      db.select().from(crmConversations).where(eq(crmConversations.crmRecordId, reboundRecordId)),
    ]);
    assert.equal(Number(draftCountRow?.total ?? 0), 1);
    assert.equal(recordRow?.lastOutboundAt, null);
    assert.equal(Number(attemptCountRow?.total ?? 0), 0);
    assert.equal(convRows.length, 1);
    assert.equal(convRows[0]?.accountRef, "ivan@linktion.cn");
  });
});

await check("4. Repeat PATCH /api/crm/drafts/{id} with same fromEmail is idempotent (changed: false, revision & updatedAt preserved)", async () => {
  const beforeRes = await draftByIdRoute.GET(
    new NextRequest(`http://localhost:3000/api/crm/drafts/${reboundDraftId}`, {
      headers: authHeaders(),
    }),
    { params: Promise.resolve({ id: reboundDraftId }) },
  );
  const beforeBody = (await beforeRes.json()) as { draft: Record<string, unknown> };

  const repeatRes = await draftByIdRoute.PATCH(
    new NextRequest(`http://localhost:3000/api/crm/drafts/${reboundDraftId}`, {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ fromEmail: "IVAN@LINKTION.CN", revision: 3 }),
    }),
    { params: Promise.resolve({ id: reboundDraftId }) },
  );
  assert.equal(repeatRes.status, 200);
  const repeatBody = (await repeatRes.json()) as {
    changed: boolean;
    draft: Record<string, unknown>;
  };
  assert.equal(repeatBody.changed, false);
  assert.equal(repeatBody.draft.revision, 3);
  assert.equal(repeatBody.draft.fromEmail, "ivan@linktion.cn");
  assert.equal(repeatBody.draft.bodyText, ORIGINAL_AI_BODY_TEXT);
  assert.equal(repeatBody.draft.updatedAt, beforeBody.draft.updatedAt);
});

await check("5. Sent, sending, and queued drafts reject fromEmail changes with HTTP 409 CONFLICT (and unconnected mailbox returns 400)", async () => {
  const fixtures = await runInOrganization(orgId, async () => {
    return withCrmTransaction(async (tx) => {
      const [pers] = await tx
        .insert(people)
        .values({
          organizationId: orgId,
          fullName: "Locked Drafts Contact",
          email: "locked@example.test",
          custom: {},
          raw: {},
          source: "manual",
        })
        .returning();
      const { record } = await ensurePersonCrmRecord(tx, { personId: pers!.id });
      const { conversation } = await upsertConversationInTransaction(tx, {
        crmRecordId: record.id,
        personId: pers!.id,
        channel: "email",
        accountRef: "ivan@yingxuan.io",
      });

      const [sentDraft] = await tx
        .insert(crmDrafts)
        .values({
          crmRecordId: record.id,
          conversationId: conversation.id,
          expectedContextVersion: record.contextVersion,
          revision: 1,
          channel: "email",
          subject: "Already Sent",
          aiBodyText: "Sent body",
          status: "sent",
        })
        .returning();

      const [queuedDraft] = await tx
        .insert(crmDrafts)
        .values({
          crmRecordId: record.id,
          conversationId: conversation.id,
          expectedContextVersion: record.contextVersion,
          revision: 1,
          channel: "email",
          subject: "Queued Auto-Send",
          aiBodyText: "Queued body",
          status: "awaiting_review",
          autoSendAt: new Date(),
        })
        .returning();

      const [attemptLockedDraft] = await tx
        .insert(crmDrafts)
        .values({
          crmRecordId: record.id,
          conversationId: conversation.id,
          expectedContextVersion: record.contextVersion,
          revision: 1,
          channel: "email",
          subject: "Attempt Prepared",
          aiBodyText: "Attempt body",
          status: "awaiting_review",
          autoSendAt: null,
        })
        .returning();

      await tx.insert(crmSendAttempts).values({
        draftId: attemptLockedDraft!.id,
        idempotencyKey: `idem-${token}`,
        status: "prepared",
        actorType: "authenticated_operator",
        requestId: `req-${token}`,
        provider: "gmail",
        accountRef: "ivan@yingxuan.io",
      });

      return {
        conversationId: conversation.id,
        sentDraftId: sentDraft!.id,
        queuedDraftId: queuedDraft!.id,
        attemptLockedDraftId: attemptLockedDraft!.id,
      };
    });
  });

  // 5a. Sent draft rejected on PATCH /api/crm/drafts/{id} -> 409 CONFLICT
  const sentPatch = await draftByIdRoute.PATCH(
    new NextRequest(`http://localhost:3000/api/crm/drafts/${fixtures.sentDraftId}`, {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ fromEmail: "ivan@linktion.cn" }),
    }),
    { params: Promise.resolve({ id: fixtures.sentDraftId }) },
  );
  assert.equal(sentPatch.status, 409);
  const sentErr = (await sentPatch.json()) as { code: string; error: string };
  assert.equal(sentErr.code, "CONFLICT");

  // 5b. Sent draft also rejected on batch PATCH /api/crm/drafts -> 409 CONFLICT
  const sentBatchPatch = await draftsCollectionRoute.PATCH(
    new NextRequest("http://localhost:3000/api/crm/drafts", {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ id: fixtures.sentDraftId, fromEmail: "ivan@linktion.cn" }),
    }),
  );
  assert.equal(sentBatchPatch.status, 409);

  // 5c. Queued auto-send draft (`autoSendAt !== null`) rejected -> 409 CONFLICT
  const queuedPatch = await draftByIdRoute.PATCH(
    new NextRequest(`http://localhost:3000/api/crm/drafts/${fixtures.queuedDraftId}`, {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ fromEmail: "ivan@linktion.cn" }),
    }),
    { params: Promise.resolve({ id: fixtures.queuedDraftId }) },
  );
  assert.equal(queuedPatch.status, 409);
  const queuedErr = (await queuedPatch.json()) as { code: string; error: string };
  assert.equal(queuedErr.code, "CONFLICT");

  // 5d. Draft with existing send attempt rejected -> 409 CONFLICT
  const attemptPatch = await draftByIdRoute.PATCH(
    new NextRequest(`http://localhost:3000/api/crm/drafts/${fixtures.attemptLockedDraftId}`, {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ fromEmail: "ivan@linktion.cn" }),
    }),
    { params: Promise.resolve({ id: fixtures.attemptLockedDraftId }) },
  );
  assert.equal(attemptPatch.status, 409);

  // Verify none of the locked drafts changed conversationId
  const lockedRows = await db
    .select({ id: crmDrafts.id, conversationId: crmDrafts.conversationId })
    .from(crmDrafts)
    .where(and(eq(crmDrafts.conversationId, fixtures.conversationId)));
  assert.equal(lockedRows.length, 3);

  // 5e. Unconnected mailbox rejected with 400 VALIDATION_ERROR
  const badMailboxRes = await draftByIdRoute.PATCH(
    new NextRequest(`http://localhost:3000/api/crm/drafts/${reboundDraftId}`, {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ fromEmail: "ivan@unconnected-domain.example" }),
    }),
    { params: Promise.resolve({ id: reboundDraftId }) },
  );
  assert.equal(badMailboxRes.status, 400);
  const badMailboxErr = (await badMailboxRes.json()) as { code: string };
  assert.equal(badMailboxErr.code, "VALIDATION_ERROR");
});

void pipelineId;
console.log(`\nPassed ${passed} CRM draft routing & sender-rebind integration checks.`);
process.exit(0);
