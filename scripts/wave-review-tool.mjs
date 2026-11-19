#!/usr/bin/env node
/**
 * AgentSDR Outreach Wave Review, Closed-Loop Retrospective, Multi-Touch & Experiment CLI
 *
 * Subcommands: retrospective | prepare-followups | import-referral | generate-briefs |
 *   s-tier-candidates | linkedin-l1 | mark-linkedin-sent | list-pending | get-prompts |
 *   put-instructions | patch-kb | regenerate | edit | discard | send-paced
 *
 * Required env for live API: AGENTSDR_URL, AGENTSDR_API_KEY, AGENTSDR_OWN_MAILBOXES
 * Optional: AGENTSDR_FROM_EMAIL_ZH, AGENTSDR_FROM_EMAIL_EN, OUTREACH_LEDGER_PATH,
 *   OUTREACH_WORKDIR, OUTREACH_BRIEFS_DIR, OUTREACH_LINKEDIN_L1_DOC
 * Never reads .env files. No example.com defaults for live runs. No silent loopback URL.
 */
import dns from "node:dns/promises";
import fs from "node:fs";
import path from "node:path";
import {
  loadOwnMailboxes,
  requireAgentsdrApiKey,
  requireAgentsdrUrl,
  resolvePath,
  resolveWorkdir,
} from "./outreach-cli/env.mjs";
import {
  assertDailyCapAllows,
  countCapConsumingDraftsToday,
  evaluateBounceRate,
  formatDateYmdShanghai,
} from "./outreach-cli/policy.mjs";

let AGENTSDR_URL = "";
let AGENTSDR_API_KEY = "";
const LEDGER_PATH = resolvePath("OUTREACH_LEDGER_PATH", "docs/outreach-experiment-ledger.json");
const TMP_LEDGER_PATH = path.join(resolveWorkdir(), "experiment-ledger.json");
const BRIEFS_DIR_DEFAULT = resolvePath("OUTREACH_BRIEFS_DIR", "docs/briefs");
const LINKEDIN_L1_DOC_PATH = resolvePath("OUTREACH_LINKEDIN_L1_DOC", "docs/linkedin-l1-queue.md");

/** @type {Set<string>} */
let OWN_MAILBOXES = new Set();
let FROM_EMAIL_ZH = null;
let FROM_EMAIL_EN = null;

function bootLiveEnv() {
  try {
    AGENTSDR_URL = requireAgentsdrUrl();
    AGENTSDR_API_KEY = requireAgentsdrApiKey();
    const mb = loadOwnMailboxes({ requireForLive: true });
    OWN_MAILBOXES = mb.set;
    FROM_EMAIL_ZH = mb.fromZh;
    FROM_EMAIL_EN = mb.fromEn;
    if (!FROM_EMAIL_ZH || !FROM_EMAIL_EN) {
      const arr = [...OWN_MAILBOXES];
      FROM_EMAIL_ZH = FROM_EMAIL_ZH || arr[0] || null;
      FROM_EMAIL_EN = FROM_EMAIL_EN || arr[1] || arr[0] || null;
    }
    if (!FROM_EMAIL_ZH || !FROM_EMAIL_EN) {
      throw new Error("Set AGENTSDR_FROM_EMAIL_ZH and AGENTSDR_FROM_EMAIL_EN (or at least two AGENTSDR_OWN_MAILBOXES).");
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
const LEGACY_ISP_DOMAINS = new Set(["biznetvigator.com", "netvigator.com"]);
const FREEMAIL_DOMAINS = new Set([
  "gmail.com",
  "yahoo.com",
  "yahoo.com.hk",
  "yahoo.com.tw",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "icloud.com",
  "me.com",
  "163.com",
  "126.com",
  "qq.com",
  "hibox.hinet.net",
  "ms1.hinet.net",
  "msa.hinet.net",
]);
const GENERIC_ROLE_PREFIX_RE =
  /^(info|sale|sales|enquir(y|ies)?|inquir(y|ies)?|service|services|contact|corporate|cs|office|admin|export|mkt|marketing|general|mail|business|order|orders|b2b)([._-].*)?@|^[a-z0-9._-]*service@|_inquiry@/i;
const PLACEHOLDER_PERSON_RE = /(desk|team|admin|info|sales|enquiry|inquiry|窗口|客服|前台|總機)/i;
const NON_SALES_ROLE_PREFIX_RE =
  /^(accounting|billing|finance|ap|ar|accounts|hr|jobs|careers|recruit|cslog|warehouse|support|help|noreply|no-reply|donotreply|postmaster|mailer-daemon)([._-].*)?@/i;

function authHeaders() {
  return {
    Authorization: `Bearer ${AGENTSDR_API_KEY}`,
    "Content-Type": "application/json",
  };
}

async function apiJson(pathname, init = {}) {
  const res = await fetch(`${AGENTSDR_URL}${pathname}`, {
    ...init,
    headers: { ...authHeaders(), ...(init.headers || {}) },
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${pathname}: ${JSON.stringify(data)}`);
  }
  return data;
}

function getFlagValue(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

function stripFlags(args, flagsWithValues, booleanFlags = []) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (flagsWithValues.includes(args[i])) {
      i += 1;
      continue;
    }
    if (booleanFlags.includes(args[i])) continue;
    out.push(args[i]);
  }
  return out;
}

function classifyInboxTier(email) {
  const clean = String(email ?? "").trim().toLowerCase();
  const domain = clean.split("@")[1] ?? "";
  if (LEGACY_ISP_DOMAINS.has(domain)) return "legacy_isp";
  if (FREEMAIL_DOMAINS.has(domain)) return "freemail";
  if (GENERIC_ROLE_PREFIX_RE.test(clean) || NON_SALES_ROLE_PREFIX_RE.test(clean)) return "generic_role";
  return "named_corporate";
}

function inferRegionGroup(code, domain) {
  const upperCode = String(code ?? "").trim().toUpperCase();
  const lowerDomain = String(domain ?? "").trim().toLowerCase();
  if (upperCode.startsWith("HK") || upperCode.startsWith("MO") || lowerDomain.endsWith(".hk")) return "HK";
  if (upperCode.startsWith("TW") || lowerDomain.endsWith(".tw")) return "TW";
  return "EN_OR_OTHER";
}

function extractRequestField(reqObj, key) {
  try {
    const raw = String(reqObj?.input ?? "");
    const re = new RegExp(`"${key}":\\s*"((?:\\\\.|[^"\\\\])*)"`);
    const m = raw.match(re);
    return m ? JSON.parse(`"${m[1]}"`) : null;
  } catch {
    return null;
  }
}

function inspectDraftMetrics({ draft, sentCountForRecord, verificationNote }) {
  const body = String(draft.bodyText ?? "");
  const httpUrls = body.match(/https?:\/\/[^\s)>"'，。；、]+/gi) || [];
  const hasPdfLink = httpUrls.some((u) => /\.pdf(\?|#|$)/i.test(u));
  const vNote = String(verificationNote ?? "");
  let touchType = "touch_1_cold";
  if (draft.replyForMessageId) {
    touchType = "inbound_reply_draft";
  } else if (sentCountForRecord >= 1) {
    touchType = "touch_2_followup";
  } else if (/轉介|referral|自動回覆/i.test(`${vNote}\n${body}`)) {
    touchType = "warm_referral";
  }

  return {
    touchType,
    inboxTier: classifyInboxTier(draft.toEmail),
    charCount: body.replace(/\s+/g, "").length,
    httpUrls,
    httpLinkCount: httpUrls.length,
    hasPdfLink,
  };
}

async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) break;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}

async function loadCrmSnapshot() {
  const allPeople = [];
  let offset = 0;
  let total = Infinity;
  while (allPeople.length < total) {
    const page = await apiJson(`/api/leads/people?limit=200&offset=${offset}`);
    const batch = page.people ?? [];
    total = Number(page.total ?? batch.length);
    allPeople.push(...batch);
    if (batch.length === 0) break;
    offset += batch.length;
  }

  const [{ drafts = [] }, overview] = await Promise.all([
    apiJson("/api/crm/drafts?status=all"),
    apiJson("/api/crm/overview"),
  ]);

  const sentDraftsByRecord = new Map();
  const pendingDraftsByRecord = new Map();
  for (const d of drafts) {
    if (d.status === "sent") {
      const arr = sentDraftsByRecord.get(d.crmRecordId) ?? [];
      arr.push(d);
      sentDraftsByRecord.set(d.crmRecordId, arr);
    } else if (d.status === "awaiting_review") {
      const arr = pendingDraftsByRecord.get(d.crmRecordId) ?? [];
      arr.push(d);
      pendingDraftsByRecord.set(d.crmRecordId, arr);
    }
  }

  const peopleByEmail = new Map();
  const personByRecordId = new Map();
  for (const entry of allPeople) {
    const email = entry.person?.email?.trim().toLowerCase();
    if (email) peopleByEmail.set(email, entry);
    if (entry.crm?.recordId) personByRecordId.set(entry.crm.recordId, entry);
  }

  return {
    allPeople,
    drafts,
    overview,
    sentDraftsByRecord,
    pendingDraftsByRecord,
    peopleByEmail,
    personByRecordId,
  };
}

function readLedger() {
  try {
    if (fs.existsSync(LEDGER_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
      if (!parsed.linkedinL1 || typeof parsed.linkedinL1 !== "object") parsed.linkedinL1 = {};
      return parsed;
    }
  } catch {
    // ignore corrupt ledger
  }
  return {
    schemaVersion: 1,
    updatedAt: null,
    waves: [],
    linkedinL1: {},
    latestSnapshot: null,
  };
}

function writeLedgerFile({ latestSnapshot, appendWave, linkedinOutreachUpdate }) {
  const ledger = readLedger();
  if (latestSnapshot) ledger.latestSnapshot = latestSnapshot;
  if (appendWave) {
    if (!Array.isArray(ledger.waves)) ledger.waves = [];
    ledger.waves.push(appendWave);
  }
  if (linkedinOutreachUpdate?.recordId) {
    if (!ledger.linkedinL1 || typeof ledger.linkedinL1 !== "object") ledger.linkedinL1 = {};
    ledger.linkedinL1[linkedinOutreachUpdate.recordId] = linkedinOutreachUpdate.entry;
  }
  ledger.updatedAt = new Date().toISOString();

  for (const target of [LEDGER_PATH, TMP_LEDGER_PATH]) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(ledger, null, 2));
  }
  return ledger;
}

const TRACK_A_HIRING_RE =
  /(招募|招聘|誠徵|誠聘|在招|職缺|职缺|約聘|约聘|定期合約|定期合约|兼職|兼职|全端|全棧|全栈|前端|後端|后端|程式員|程序员|程式設計|系統工程師|系統分析師|開發工程師|資訊專員|full[- ]?stack|front[- ]?end|back[- ]?end|software\s*(?:engineer|developer)|web\s*developer|system\s*(?:analyst|developer|engineer)|it\s*officer|agentic\s*ai|part[- ]?time|hiring)/i;

function normalizePersonLinkedinUrl(raw) {
  const v = String(raw ?? "").trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  if (/linkedin\.com\/in\//i.test(v)) return `https://${v.replace(/^\/+/, "")}`;
  return `https://www.linkedin.com/in/${encodeURIComponent(v.replace(/^\/+/, ""))}`;
}

function normalizeCompanyLinkedinUrl(raw) {
  const v = String(raw ?? "").trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  if (/linkedin\.com\/company\//i.test(v)) return `https://${v.replace(/^\/+/, "")}`;
  return `https://www.linkedin.com/company/${encodeURIComponent(v.replace(/^\/+/, ""))}`;
}

function normalizeLocaleVocab(text, region) {
  const raw = String(text ?? "");
  if (region === "HK") {
    return raw
      .replace(/數位化/g, "數碼化")
      .replace(/數位/g, "數碼")
      .replace(/軟體/g, "軟件")
      .replace(/原始碼/g, "源碼")
      .replace(/聯繫/g, "聯絡")
      .replace(/洽詢/g, "查詢")
      .replace(/英選/g, "英选");
  }
  if (region === "TW") {
    return raw
      .replace(/數碼化/g, "數位化")
      .replace(/數碼/g, "數位")
      .replace(/軟件/g, "軟體")
      .replace(/源碼/g, "原始碼")
      .replace(/聯絡/g, "聯繫")
      .replace(/查詢/g, "洽詢")
      .replace(/英選/g, "英选");
  }
  return raw;
}

function extractEntryMeta(entry) {
  const company = entry.company ?? {};
  const person = entry.person ?? {};
  const crm = entry.crm ?? {};
  const code = company.custom?.x_code ?? company.raw?.x_code ?? company.raw?.company_code ?? null;
  const domain = company.domain ?? null;
  const region = inferRegionGroup(code, domain);
  const leadReason = company.custom?.x_lead_reason ?? "";
  const verificationNote = person.custom?.x_verification_note ?? "";
  const isTrackA = TRACK_A_HIRING_RE.test(leadReason);
  const email = person.email ?? null;
  const inboxTier = classifyInboxTier(email);

  return {
    recordId: crm.recordId ?? null,
    personId: person.id ?? null,
    code,
    region,
    companyName: company.name ?? "Unknown Company",
    domain,
    companyRegion: company.custom?.x_region ?? null,
    personName: person.fullName ?? "",
    firstName: person.firstName ?? "",
    lastName: person.lastName ?? "",
    title: person.title ?? "",
    email,
    inboxTier,
    phone: person.phone ?? null,
    personLinkedinUrl: normalizePersonLinkedinUrl(person.linkedinUrl),
    companyLinkedinUrl: normalizeCompanyLinkedinUrl(company.linkedinUrl),
    leadReason,
    verificationNote,
    isTrackA,
    bounced: Boolean(crm.bounced),
    dnc: Boolean(crm.dnc ?? entry.dnc),
    closed: Boolean(crm.closed ?? entry.closed),
    categoryKey: crm.categoryKey ?? null,
    subcategory: crm.subcategory ?? null,
    lastOutboundAt: crm.lastOutboundAt ?? null,
    lastInboundAt: crm.lastInboundAt ?? null,
  };
}

function buildSchemeAChecklistContent(meta) {
  const isTrackA = meta.isTrackA;
  const signalSummary = meta.leadReason
    ? normalizeLocaleVocab(meta.leadReason, meta.region)
    : `${meta.companyName}（${meta.domain || "-"}）`;

  if (meta.region === "EN_OR_OTHER" && !/[\u4e00-\u9fff]/.test(`${meta.companyName}${meta.personName}`)) {
    const firstName = meta.firstName || meta.personName || "there";
    return [
      `# Phase-1 Delivery Scope & Source Handover Checklist`,
      ``,
      `- **Prepared for**: ${meta.personName} (${meta.title || "Decision Maker"}) — ${meta.companyName} (${meta.domain || "-"})`,
      `- **CRM Code**: ${meta.code || "-"} | **Signal Basis**: ${isTrackA ? "Track A Active Tech/System Hiring" : "Workflow & Buyer-Path Review"}`,
      `- **Prepared by**: Ivan / Linktion (yingxuan.io — Former ClackyAI Core Engineering Team)`,
      ``,
      `> Even if ${meta.companyName} ultimately hires in-house rather than engaging an external partner, you can hand this 1-page checklist directly to your engineer as a **probation acceptance standard** so the system launches cleanly and stays maintainable.`,
      ``,
      `## Context Observed`,
      `${meta.leadReason || `${meta.companyName} workflow modernization scope.`}`,
      ``,
      `## 1. Phase-1 Independent Scope (2–4 Weeks to Working Preview)`,
      `- **Ship First (Standalone Sprint Pack)**: Isolate one high-frequency business workflow (catalog/RFQ portal, internal ops dashboard, or ERP sync bridge) without rewriting core legacy databases.`,
      `- **Defer to Phase 2**: Low-frequency admin settings, multi-tier legacy data migrations, and secondary cosmetic pages.`,
      ``,
      `## 2. Human x Agent Execution & Sign-Off Gates ("Agent Works, Engineers Gate")`,
      `- **AI-Assisted Execution**: Spec decomposition, typed UI/API scaffolding, automated test suites, and deployment runbooks.`,
      `- **Mandatory Human Sign-Off**: Pricing rules, permission boundaries, staging walkthrough via Working Preview, and production go-live approval.`,
      ``,
      `## 3. Five-Point Handover & Zero-Lock-In Audit (You Own Everything)`,
      `- [ ] **Live Staging Working Preview**: Clickable environment reviewed before final payment.`,
      `- [ ] **Automated Quality Gates**: Build, typecheck, and regression tests pass prior to every release.`,
      `- [ ] **100% Source Code & Git History**: Full repository ownership transferred to ${meta.companyName}.`,
      `- [ ] **Business Context & Prompts Included**: All workflow rules, specs, and Agent runbooks documented.`,
      `- [ ] **Model & Maintainer Portability**: Standard stack deployable cleanly on your own infra with no vendor lock-in.`,
      ``,
      `---`,
      `Hi ${firstName} — happy to walk through any single line item above, or share a 2–3 screen clickable concept preview tailored to this workflow.`,
    ].join("\n");
  }

  const isHK = meta.region === "HK";
  const wDigital = isHK ? "數碼" : "數位";
  const wSoftware = isHK ? "軟件" : "軟體";
  const wSource = isHK ? "源碼" : "原始碼";
  const wContact = isHK ? "聯絡" : "聯繫";

  const scopeLine1 = isTrackA
    ? `- **優先上線一期工作包（2–4 週交付可點按 Working Preview）**：從貴司在招崗位對應的需求中，抽出 1 條最急迫的獨立業務閉環先跑通（例如：客戶／經銷商自助詢價訂貨入口、內部審批／報表自動化，或透過標準 API 外掛銜接現有 ERP），**不動既有核心系統**。`
    : `- **優先上線一期工作包（2–4 週交付可點按 Working Preview）**：聚焦單一高摩擦業務場景（例如：將靜態型錄或人工表格改為客戶線上自助篩選與自動詢價明細），透過獨立外掛模組上線，**無需推翻重做整套舊官網／舊系統**。`;

  return [
    `# 一期獨立驗收邊界與${wSource}移交核對單`,
    ``,
    `- **專屬對象**：${meta.companyName}｜${meta.personName}（${meta.title || "負責人"}）｜編號 \`${meta.code || "-"}\``,
    `- **觀察依據**：${isTrackA ? "戰線 A｜近期技術／系統崗位招聘替代評估" : `${wDigital}化業務工作流梳理`}`,
    `- **整理方**：Ivan / 英选（yingxuan.io｜前 ClackyAI 核心工程團隊）`,
    ``,
    `> **無需填表、無綁定說明**：這是一份已按貴司公開業務背景整理好的獨立清單。**即使貴司最後仍決定自招${wSoftware}人員或交由其他供應商製作，也可直接拿去當作試用期／第一階段驗收標準**，避免系統上線後改不動或後續交接斷層。`,
    ``,
    `## 觀察摘要`,
    `${signalSummary}`,
    ``,
    `## 一、建議一期獨立上線邊界（2–4 週可驗收）`,
    scopeLine1,
    `- **建議延後二期事項**：低頻後台統計、全歷史舊帳大規模遷移與非關鍵視覺特效，待一期真實跑通產生業務價值後再決定是否加選。`,
    ``,
    `## 二、「Agent 幹活，英选把關」協作與安全邊界`,
    `- **Agent 參與加速環節**：需求邊界結構化拆解、前後端模組實作、自動化回歸測試用例與部署文檔整理。`,
    `- **人類資深工程師與貴司確認節點**：權限與報價口徑定義、獨立預發布環境（Staging）點擊驗收、每次上線前自動品質門禁檢查、正式發布放行。`,
    ``,
    `## 三、「能上線、改得動、始終歸你」五項驗收硬指標`,
    `- [ ] **可操作預覽（Working Preview）**：第 2–4 週先在預發布環境實際點擊走通真實業務流程，確認符合預期再驗收。`,
    `- [ ] **上線前自動品質門禁**：任何小改動必須通過測試與構建門禁才允許發布，杜絕改完 A 壞 B。`,
    `- [ ] **100% 完整${wSource}與倉庫歸屬**：完整代碼倉庫與 Git 提交紀錄全數移交貴司帳戶，不留黑盒。`,
    `- [ ] **業務上下文與部署說明齊全**：系統規格、資料庫結構、環境變數與部署步驟完整交接，後續自招工程師也能 1 小時接手。`,
    `- [ ] **零模型與乙方綁定**：標準架構可部署於貴司自有伺服器或雲環境，未來可自由更換模型或維護團隊。`,
    ``,
    `---`,
    `如需針對其中任一模組進一步討論，或想先看一版貼合貴司風格的 2–3 屏可點按概念預覽，隨時回覆郵件或${wContact} \`${FROM_EMAIL_ZH}\`。`,
  ].join("\n");
}

function scoreSTierCandidate(meta, { sentCount, pendingCount, nowMs, minDays, maxDays }) {
  if (meta.bounced || meta.dnc || meta.closed || meta.categoryKey === "not_interested") {
    return { eligible: false, score: -1, reasons: [] };
  }
  if (
    PLACEHOLDER_PERSON_RE.test(meta.personName || "") ||
    meta.inboxTier === "legacy_isp" ||
    NON_SALES_ROLE_PREFIX_RE.test(meta.email || "")
  ) {
    return { eligible: false, score: -1, reasons: [] };
  }

  let score = 0;
  const reasons = [];

  if (meta.isTrackA) {
    score += 40;
    reasons.push("Track A active hiring/role signal (+40)");
  }
  if (meta.inboxTier === "named_corporate") {
    score += 25;
    reasons.push("Verified named corporate email (+25)");
  } else if (meta.inboxTier === "freemail") {
    score += 10;
    reasons.push("Direct founder/GM freemail (+10)");
  }
  if (meta.phone) {
    score += 15;
    reasons.push("Verified direct/office phone (+15)");
  }
  if (meta.personLinkedinUrl || meta.companyLinkedinUrl) {
    score += 10;
    reasons.push("LinkedIn URL captured (+10)");
  }
  if (meta.categoryKey === "interested") {
    score += 35;
    reasons.push("CRM marked interested (+35)");
  }

  const ageDays = meta.lastOutboundAt ? (nowMs - Date.parse(meta.lastOutboundAt)) / 86_400_000 : null;
  if (sentCount === 1 && ageDays !== null && ageDays >= minDays && ageDays <= maxDays) {
    score += 18;
    reasons.push(`Touch #2 timing window (${ageDays.toFixed(1)}d) (+18)`);
  } else if (sentCount === 0 && pendingCount > 0) {
    score += 15;
    reasons.push("Warm pending draft ready (+15)");
  }

  if (sentCount >= 2 && !meta.lastInboundAt) {
    score -= 25;
    reasons.push("Email Two-Touch cap reached — use LinkedIn/Phone instead (-25)");
  }

  return {
    eligible: score > 0,
    score,
    ageDays: ageDays !== null && Number.isFinite(ageDays) ? Number(ageDays.toFixed(1)) : null,
    reasons,
  };
}

function buildLinkedInCopy(meta) {
  const firstName = meta.firstName || meta.personName || "there";
  const surname = meta.lastName || meta.personName.slice(0, 1);
  const titleShort = meta.title || (meta.region === "EN_OR_OTHER" ? "Leader" : "總");
  const greetingZh = /^[A-Za-z\s.-]+$/.test(meta.personName || "")
    ? `${meta.firstName || meta.personName} 您好`
    : `${surname}${/董事長|總經理|董事|經理|創辦人|總監/.test(titleShort) ? titleShort.replace(/兼.*/, "") : "總"}您好`;

  const topicHint = meta.isTrackA
    ? meta.region === "HK"
      ? "留意到貴司近期在擴充技術／系統開發人手"
      : "留意到貴司近期在招募系統／網站開發人手"
    : meta.region === "HK"
      ? "留意到貴司海外業務與產品線發展迅速"
      : "留意到貴司外銷產品線與客戶服務十分紮實";

  if (meta.region === "EN_OR_OTHER" && !/[\u4e00-\u9fff]/.test(`${meta.companyName}${meta.personName}`)) {
    const connNote = meta.isTrackA
      ? `Hi ${firstName}, noticed ${meta.companyName} is hiring on systems/dev work. I lead engineering at Linktion (ex-ClackyAI) — happy to connect.`
      : `Hi ${firstName}, came across ${meta.companyName}'s B2B work. I lead AI-assisted engineering at Linktion (ex-ClackyAI) — great to connect.`;
    const dm = meta.isTrackA
      ? `Noticed ${meta.companyName} is hiring for dev/system buildout — for Phase 1, are you trying to ship a client portal/quoting flow or automate internal ERP ops first?`
      : `Quick question on ${meta.companyName}'s digital workflow: do overseas B2B buyers mostly request quotes via email right now, or use an online selector?`;
    const followUpVoice = `25s voice/video script: "Hi ${firstName}, Ivan from Linktion here — we built a quick 1-page Phase-1 scope & handover checklist for ${meta.companyName} based on your team's focus, useful even for an in-house hire. Want me to drop it over?"`;
    return {
      connectionNote: connNote.slice(0, 160),
      firstDmSms: dm,
      followUpVoiceOrAsset: followUpVoice,
    };
  }

  const isHK = meta.region === "HK";
  const wSoftware = isHK ? "軟件" : "軟體";
  const wSource = isHK ? "源碼" : "原始碼";

  const connectionNote = `${greetingZh}，${topicHint}。我是英选 Ivan（前 ClackyAI 核心工程團隊，專注企業「能上線、始終歸你」的${wSoftware}工作包交付），希望能與您連線交流。`.slice(0, 150);

  const firstDmSms = meta.isTrackA
    ? `${greetingZh}，${topicHint}，這階段最想先跑通的是對外客戶詢價／官網門戶，還是內部 ERP 與表單自動化這塊？`
    : `${greetingZh}，${topicHint}，目前海外或經銷客戶看規格與詢價時，主要是靠業務人工來回對接，還是已有線上自助選型入口？`;

  const followUpVoiceOrAsset = meta.isTrackA
    ? `25 秒語音／短視頻腳本（不推銷手冊）：「${greetingZh}，我是英选 Ivan。我按貴司近期職缺範圍順手拆了一頁《一期獨立驗收邊界與${wSource}移交核對單》，即使你們最終決定自招人手也能直接拿去當試用期驗收標準，方便我貼連結或截圖給您參考嗎？」`
    : `25 秒語音／短視頻腳本：「${greetingZh}，我是英选 Ivan。我們團隊用工程工作流替同業做了免改舊站的 2–3 屏線上選型詢價預覽，方便發您看一下實機示意嗎？」`;

  return {
    connectionNote,
    firstDmSms,
    followUpVoiceOrAsset,
  };
}

function formatDateYmd(date) {
  return formatDateYmdShanghai(date);
}

function extractReferralCandidates({ bodyText, originalEmail, companyDomain, peopleByEmail }) {
  const rawMatches = String(bodyText ?? "").match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,12}/g) || [];
  const seen = new Set();
  const candidates = [];

  for (const raw of rawMatches) {
    const email = raw.toLowerCase().replace(/[.,;:)\]}>'"]+$/, "");
    if (seen.has(email)) continue;
    seen.add(email);
    if (email === originalEmail || OWN_MAILBOXES.has(email)) continue;

    const idx = String(bodyText ?? "").toLowerCase().indexOf(email);
    const contextBefore = idx > 0 ? String(bodyText).slice(Math.max(0, idx - 60), idx).toLowerCase() : "";
    const isPrivateFallback = /(private contact|personal email|私信|私人)/i.test(contextBefore);
    const isNonBusinessDept =
      NON_SALES_ROLE_PREFIX_RE.test(email) ||
      /(accounting|warehouse|hr|billing|support|administration)\s*:/i.test(contextBefore);
    const emailDomain = email.split("@")[1] ?? "";
    const sameDomain = companyDomain && (emailDomain === companyDomain || emailDomain.endsWith(`.${companyDomain}`));
    const alreadyInCrm = peopleByEmail.has(email);

    let roleType = "business_referral";
    if (isPrivateFallback) roleType = "private_contact";
    else if (isNonBusinessDept) roleType = "non_sales_role";
    else if (GENERIC_ROLE_PREFIX_RE.test(email)) roleType = "generic_dept_email";

    candidates.push({
      email,
      sameDomain: Boolean(sameDomain),
      roleType,
      alreadyInCrm,
    });
  }
  return candidates;
}

async function computeRetrospective({ days = 14, minDays = 3, maxDays = 8, syncMailboxes = false }) {
  const mailboxSync = [];
  if (syncMailboxes) {
    try {
      const { mailboxes = [] } = await apiJson("/api/outreach/mailboxes");
      const syncRes = await Promise.all(
        mailboxes
          .filter((m) => m.status === "connected")
          .map(async (m) => {
            try {
              await apiJson(`/api/outreach/mailboxes/${m.id}/sync`, {
                method: "POST",
                signal: AbortSignal.timeout(8000),
              });
              return { emailAddress: m.emailAddress, ok: true };
            } catch (err) {
              return { emailAddress: m.emailAddress, ok: false, note: String(err?.message ?? err) };
            }
          }),
      );
      mailboxSync.push(...syncRes);
    } catch (err) {
      mailboxSync.push({ ok: false, note: `Failed to list mailboxes: ${err?.message ?? err}` });
    }
  }

  const now = new Date();
  const fromDate = new Date(now.getTime() - days * 86_400_000);
  const toDate = new Date(now.getTime() + 86_400_000);

  const [snapshot, emailAnalytics] = await Promise.all([
    loadCrmSnapshot(),
    apiJson(`/api/analytics/email?from=${formatDateYmd(fromDate)}&to=${formatDateYmd(toDate)}&tz=Asia/Shanghai`),
  ]);

  const { allPeople, drafts, sentDraftsByRecord, pendingDraftsByRecord, peopleByEmail } = snapshot;

  // Fetch timelines only for inbound or bounced records to inspect ground-truth text
  const inspectTargets = allPeople.filter((e) => Boolean(e.crm?.lastInboundAt) || Boolean(e.crm?.bounced));
  const recordWorkspaces = await mapWithConcurrency(inspectTargets, 5, async (entry) => {
    try {
      const ws = await apiJson(`/api/crm/records/${entry.crm.recordId}`);
      return { entry, ws };
    } catch {
      return { entry, ws: null };
    }
  });

  const sentDrafts = drafts.filter((d) => d.status === "sent");
  const touchedRecords = allPeople.filter((e) => Boolean(e.crm?.lastOutboundAt));
  const touch1OnlyCount = touchedRecords.filter((e) => (sentDraftsByRecord.get(e.crm.recordId)?.length ?? 0) === 1).length;
  const touch2PlusCount = touchedRecords.filter((e) => (sentDraftsByRecord.get(e.crm.recordId)?.length ?? 0) >= 2).length;
  const unrepliedWithPhoneCount = touchedRecords.filter(
    (e) => !e.crm?.bounced && !e.crm?.dnc && !e.crm?.lastInboundAt && Boolean(e.person?.phone),
  ).length;

  // Deliverability & regional breakdown
  const byRegion = {
    HK: { contacted: 0, bounced: 0, bounceRatePct: 0, humanReplies: 0 },
    TW: { contacted: 0, bounced: 0, bounceRatePct: 0, humanReplies: 0 },
    EN_OR_OTHER: { contacted: 0, bounced: 0, bounceRatePct: 0, humanReplies: 0 },
  };
  const inboxTierCounts = { named_corporate: 0, generic_role: 0, legacy_isp: 0, freemail: 0 };
  const bouncedDetails = [];

  for (const entry of touchedRecords) {
    const code = entry.company?.custom?.x_code ?? entry.company?.raw?.company_code ?? null;
    const region = inferRegionGroup(code, entry.company?.domain);
    const tier = classifyInboxTier(entry.person?.email);
    inboxTierCounts[tier] += 1;
    byRegion[region].contacted += 1;
    if (entry.crm?.bounced) {
      byRegion[region].bounced += 1;
      bouncedDetails.push({
        code,
        company: entry.company?.name ?? null,
        domain: entry.company?.domain ?? null,
        email: entry.person?.email ?? null,
        inboxTier: tier,
        lastOutboundAt: entry.crm?.lastOutboundAt ?? null,
      });
    }
  }
  for (const rg of Object.values(byRegion)) {
    rg.bounceRatePct = rg.contacted > 0 ? Number(((rg.bounced / rg.contacted) * 100).toFixed(2)) : 0;
  }

  // Copy telemetry across sent drafts
  let totalChars = 0;
  const linkMix = { zeroHttpLinks: 0, singleCleanUrl: 0, multiUrlOrPdf: 0 };
  for (const d of sentDrafts) {
    const metrics = inspectDraftMetrics({
      draft: d,
      sentCountForRecord: sentDraftsByRecord.get(d.crmRecordId)?.length ?? 0,
      verificationNote: "",
    });
    totalChars += metrics.charCount;
    if (metrics.httpLinkCount === 0) linkMix.zeroHttpLinks += 1;
    else if (metrics.httpLinkCount === 1 && !metrics.hasPdfLink) linkMix.singleCleanUrl += 1;
    else linkMix.multiUrlOrPdf += 1;
  }

  // Inbound classification & referral extraction
  const inboundHumanReplies = [];
  const leftCompanyThreads = [];
  const autoReceipts = [];
  const unactionedReferrals = [];

  for (const { entry, ws } of recordWorkspaces) {
    if (!entry.crm?.lastInboundAt) continue;
    const inboundMsgs = (ws?.timeline ?? []).filter((m) => m.direction === "inbound");
    const latestInbound = inboundMsgs[inboundMsgs.length - 1] ?? null;
    const subject = latestInbound?.subject ?? "";
    const bodyText = latestInbound?.bodyText ?? "";
    const combined = `${subject}\n${bodyText}`;
    const code = entry.company?.custom?.x_code ?? null;
    const region = inferRegionGroup(code, entry.company?.domain);

    const isLeftCompany =
      entry.crm?.subcategory === "Left Company" ||
      /no longer (work|with|employed)|left (?:the )?company|resigned|離職|已離職/i.test(combined);
    const isAutoReceipt =
      entry.crm?.subcategory === "Auto-Reply" ||
      /auto[- ]?reply|auto[- ]?receipt|automatic reply|out of office|自動回覆|系統自動|收悉/i.test(combined);

    if (isLeftCompany) {
      const candidates = extractReferralCandidates({
        bodyText,
        originalEmail: entry.person?.email?.toLowerCase(),
        companyDomain: entry.company?.domain?.toLowerCase(),
        peopleByEmail,
      });
      const pendingDrafts = pendingDraftsByRecord.get(entry.crm.recordId) ?? [];
      const item = {
        recordId: entry.crm.recordId,
        code,
        company: entry.company?.name ?? null,
        domain: entry.company?.domain ?? null,
        oldPerson: entry.person?.fullName ?? null,
        oldEmail: entry.person?.email ?? null,
        phone: entry.person?.phone ?? null,
        crmClosed: Boolean(entry.crm?.closed),
        hasStaleAwaitingDraft: pendingDrafts.length > 0,
        staleDraftId: pendingDrafts[0]?.id ?? null,
        candidates,
      };
      leftCompanyThreads.push(item);

      const actionableEmail = candidates.find(
        (c) => c.roleType === "business_referral" && c.sameDomain && !c.alreadyInCrm,
      );
      if (!entry.crm?.closed && (actionableEmail || pendingDrafts.length > 0)) {
        unactionedReferrals.push({
          ...item,
          recommendedReferralEmail: actionableEmail?.email ?? null,
        });
      }
    } else if (isAutoReceipt) {
      autoReceipts.push({
        recordId: entry.crm.recordId,
        code,
        company: entry.company?.name ?? null,
        email: entry.person?.email ?? null,
        subject,
      });
    } else {
      byRegion[region].humanReplies += 1;
      inboundHumanReplies.push({
        recordId: entry.crm.recordId,
        code,
        company: entry.company?.name ?? null,
        email: entry.person?.email ?? null,
        subject,
        excerpt: bodyText.slice(0, 200),
      });
    }
  }

  // Due Touch #2 candidates
  const nowMs = Date.now();
  const minMs = minDays * 86_400_000;
  const maxMs = maxDays * 86_400_000;
  const cadenceCandidates = [];

  for (const entry of touchedRecords) {
    const recId = entry.crm?.recordId;
    if (!recId) continue;
    if (entry.crm.bounced || entry.crm.dnc || entry.crm.closed || entry.crm.lastInboundAt) continue;
    const sents = sentDraftsByRecord.get(recId) ?? [];
    const pendings = pendingDraftsByRecord.get(recId) ?? [];
    if (sents.length !== 1 || pendings.length > 0) continue;

    const email = entry.person?.email ?? "";
    const tier = classifyInboxTier(email);
    if (tier === "legacy_isp") continue;
    const personName = entry.person?.fullName?.trim() || "";
    if (!personName) continue;

    const outboundMs = Date.parse(entry.crm.lastOutboundAt);
    if (!Number.isFinite(outboundMs)) continue;
    const ageMs = nowMs - outboundMs;
    if (ageMs < minMs || ageMs > maxMs) continue;

    const code = entry.company?.custom?.x_code ?? entry.company?.raw?.company_code ?? null;
    cadenceCandidates.push({
      recordId: recId,
      code,
      company: entry.company?.name ?? null,
      domain: entry.company?.domain ?? null,
      person: personName,
      title: entry.person?.title ?? null,
      email,
      inboxTier: tier,
      phone: entry.person?.phone ?? null,
      leadReason: entry.company?.custom?.x_lead_reason ?? "",
      firstSubject: sents[0]?.subject ?? null,
      lastOutboundAt: entry.crm.lastOutboundAt,
      ageDays: Number((ageMs / 86_400_000).toFixed(1)),
    });
  }

  cadenceCandidates.sort((a, b) => {
    const trackADiff = Number(TRACK_A_HIRING_RE.test(b.leadReason || "")) - Number(TRACK_A_HIRING_RE.test(a.leadReason || ""));
    if (trackADiff !== 0) return trackADiff;
    const isRealPerson = (p) => !PLACEHOLDER_PERSON_RE.test(p || "");
    const realDiff = Number(isRealPerson(b.person)) - Number(isRealPerson(a.person));
    if (realDiff !== 0) return realDiff;
    const tierScore = (t) => (t === "named_corporate" ? 0 : t === "freemail" ? 1 : 2);
    const diffTier = tierScore(a.inboxTier) - tierScore(b.inboxTier);
    if (diffTier !== 0) return diffTier;
    const phoneDiff = Number(Boolean(b.phone)) - Number(Boolean(a.phone));
    if (phoneDiff !== 0) return phoneDiff;
    return Date.parse(a.lastOutboundAt) - Date.parse(b.lastOutboundAt);
  });

  const analyticsBouncedCount = Number(emailAnalytics?.kpis?.bounced?.value ?? 0);
  const bouncedCount = Math.max(bouncedDetails.length, analyticsBouncedCount);
  const contactedCount = touchedRecords.length;
  const bounceRatePct = contactedCount > 0 ? Number(((bouncedCount / contactedCount) * 100).toFixed(2)) : 0;
  const ledger = readLedger();
  const lastWave = ledger.waves?.[ledger.waves.length - 1] ?? null;
  const recommendedExperimentArm =
    lastWave?.experimentArm === "A_permission_0link" ? "B_clean_root_url" : "A_permission_0link";

  const todayYmd = formatDateYmd(now);
  const sentTodayCount = drafts.filter((d) => {
    const isSentOrQueued = d.status === "sent" || (d.status === "awaiting_review" && Boolean(d.autoSendAt));
    if (!isSentOrQueued) return false;
    const ts = new Date(d.sentAt || d.updatedAt || 0);
    return Number.isFinite(ts.getTime()) && formatDateYmd(ts) === todayYmd;
  }).length;
  const dailyQuotaLimit = 10;
  const dailyRemainingQuota = Math.max(0, dailyQuotaLimit - sentTodayCount);

  const warmReferralsToAction = Math.min(
    dailyRemainingQuota,
    unactionedReferrals.filter((r) => Boolean(r.recommendedReferralEmail)).length,
  );
  const afterRef = Math.max(0, dailyRemainingQuota - warmReferralsToAction);
  const touch2Quota = Math.min(4, cadenceCandidates.length, afterRef);
  const afterT2 = Math.max(0, afterRef - touch2Quota);
  const touch1DiscoveryQuota = dailyRemainingQuota === 0 ? 0 : Math.min(8, afterT2);

  const notes = [];
  const bounceEval = evaluateBounceRate(bounceRatePct);
  if (bounceEval.band === "circuit_breaker") {
    notes.push(`DELIVERABILITY_ALERT: ${bounceEval.note} Keep strict MX-only guard and block @biznetvigator.com/@netvigator.com.`);
  } else if (bounceEval.band === "conservative_hold") {
    notes.push(`DELIVERABILITY_HOLD: ${bounceEval.note}`);
  }
  const multiTouchSharePct = contactedCount > 0 ? Number(((touch2PlusCount / contactedCount) * 100).toFixed(1)) : 0;
  if (multiTouchSharePct < 10) {
    notes.push(`CADENCE_GAP: Only ${multiTouchSharePct}% of contacted leads received Touch #2. Allocate ${touch2Quota} Touch #2 follow-ups (delivering Scheme A/C takeaways directly in body).`);
  }
  if (contactedCount > 0 && inboxTierCounts.generic_role / contactedCount > 0.45) {
    notes.push(`INBOX_TIER_GAP: ${Math.round((inboxTierCounts.generic_role / contactedCount) * 100)}% of sends went to generic role inboxes; use Track A named emails + LinkedIn L1 workbench.`);
  }
  if (sentDrafts.length > 0 && linkMix.multiUrlOrPdf / sentDrafts.length > 0.5) {
    notes.push(`COPY_MONOCULTURE: ${linkMix.multiUrlOrPdf}/${sentDrafts.length} historical sends carried 2+ links / .pdf; switch Touch #1 to Track A ${recommendedExperimentArm} with zero-homework Scheme A hook.`);
  }

  return {
    generatedAt: now.toISOString(),
    windowDays: days,
    sentTodayCount,
    dailyQuotaLimit,
    dailyRemainingQuota,
    mailboxSync: mailboxSync.length ? mailboxSync : undefined,
    analyticsKpis: emailAnalytics?.kpis ?? null,
    funnel: {
      totalLeads: allPeople.length,
      contactedLeads: contactedCount,
      sentEmailsTotal: sentDrafts.length,
      touch1OnlyLeads: touch1OnlyCount,
      touch2PlusLeads: touch2PlusCount,
      multiTouchSharePct,
      humanRepliesCount: inboundHumanReplies.length,
      humanReplyRatePct: contactedCount > 0 ? Number(((inboundHumanReplies.length / contactedCount) * 100).toFixed(2)) : 0,
      unrepliedWithPhoneCount,
    },
    deliverability: {
      bouncedLeadsCount: bouncedCount,
      bounceRatePct,
      circuitBreakerTriggered: bounceEval.circuitBreakerTriggered,
      bounceBand: bounceEval.band,
      allowAutoColdSend: bounceEval.allowAutoColdSend,
      byRegion,
      bouncedDetails,
    },
    inboxTierMix: {
      counts: inboxTierCounts,
      genericRoleSharePct: contactedCount > 0 ? Number(((inboxTierCounts.generic_role / contactedCount) * 100).toFixed(1)) : 0,
    },
    copyTelemetry: {
      analyzedSentDrafts: sentDrafts.length,
      avgChars: sentDrafts.length > 0 ? Math.round(totalChars / sentDrafts.length) : 0,
      linkMix,
    },
    inboundAnalysis: {
      humanReplies: inboundHumanReplies,
      leftCompanyThreads,
      autoReceiptsCount: autoReceipts.length,
      unactionedReferrals,
    },
    cadencePool: {
      window: { minDays, maxDays },
      followUpsDueCount: cadenceCandidates.length,
      topCandidates: cadenceCandidates.slice(0, 12),
    },
    recommendedNextWavePlan: {
      targetTotal: 10,
      warmReferralsToAction,
      touch2Quota,
      touch1DiscoveryQuota,
      recommendedExperimentArm,
      blockedDomainsOrSuffixes: Array.from(LEGACY_ISP_DOMAINS),
      notes,
    },
  };
}

function buildTouch2Feedback(candidate, previewUrl = null) {
  const region = inferRegionGroup(candidate.code, candidate.domain);
  const firstSubject = candidate.firstSubject || "貴司系統與業務推進交流";
  const isGenericInbox = candidate.inboxTier === "generic_role";

  if (region === "EN_OR_OTHER" && !/[\u4e00-\u9fff]/.test(candidate.firstSubject || "")) {
    return [
      `Touch #2 value-add follow-up (do NOT nag or say "just checking in" or attach generic company PDFs).`,
      `Keep reply thread context and use Subject: "Re: ${firstSubject}".`,
      `Write 80–120 concise English words in 2–3 short paragraphs as Ivan / Linktion (ex-ClackyAI engineering team).`,
      isGenericInbox
        ? `Because recipient "${candidate.email}" is a generic team inbox, politely open with a 1-line routing note asking the team to forward to ${candidate.person || "the head of operations"}.`
        : `Address ${candidate.person} naturally.`,
      `Directly deliver 3 ready-to-use acceptance checkpoints inside the email body (zero links/forms required from reader): 1) Isolate a 2–4 week Phase-1 Working Preview boundary without touching legacy core systems; 2) Automated build/test gates before every staging release; 3) 100% source code + deployment runbook handover.`,
      previewUrl
        ? `Include ONE clean Working Preview concept link: ${previewUrl} (explicitly note it is an interactive concept preview).`
        : `End with one zero-pressure question asking whether seeing a 2–3 screen clickable concept preview tailored to their workflow would be useful.`,
    ].join(" ");
  }

  const isHK = region === "HK";
  const wSource = isHK ? "源碼" : "原始碼";
  const localeRules = isHK
    ? `必須 100% 使用地道香港繁體詞彙（數碼／軟件／源碼／聯絡／查詢，嚴禁出現台灣詞彙「數位／軟體／原始碼／聯繫」），零簡體字。`
    : `必須 100% 使用地道台灣繁體詞彙（數位／軟體／原始碼／聯繫／洽詢，嚴禁出現香港詞彙「數碼／軟件／源碼／聯絡」），零簡體字。`;

  const greetingRule = isGenericInbox
    ? `收件信箱（${candidate.email}）為公共職能信箱，首句必須禮貌寫「您好，煩請協助將此補充核對清單轉交 ${candidate.person} ${candidate.title || ""}：」。`
    : `收件信箱為實名郵箱，直接按 ${candidate.person} 的真實姓氏與職稱對等稱呼。`;

  const valueRule = previewUrl
    ? `直接把已為貴司準備好的 2–3 屏可點按概念預覽（${previewUrl}，註明概念示意）與「先拆 2–4 週一期獨立驗收邊界 / 上線前自動門禁檢查 / 移交 100% ${wSource}與部署說明」寫入正文。`
    : `不要貼 13 頁 PDF 連結，也不要叫客戶自己填表！直接在郵件正文精簡交付「一期獨立驗收與${wSource}移交」最關鍵的 3 條硬核對點（客戶免點擊就能看完）：1) 先切 2–4 週可獨立驗收的一期工作包邊界（不動現有核心庫）；2) 「Agent 幹活，英选把關」——獨立預發布環境＋上線前自動門禁檢查；3) 驗收移交 100% 完整${wSource}與部署說明，確保「能上線、改得動、始終歸你」。`;

  return [
    `本封為【第 2 封直接交付價值跟進信（Touch #2）】，主旨固定寫：「Re: ${firstSubject}」。`,
    `字數嚴控在 115–165 字（2–3 個短段），語氣平實克制，絕對禁止寫「不知您是否收到上封信」「再次打擾」等催促套話，亦禁止使用「全自動／賦能／閉環／MVP」。`,
    localeRules,
    greetingRule,
    `品牌名固定寫「英选」（切勿寫成「英選」），落款包含「Ivan / 英选 (yingxuan.io)」。`,
    valueRule,
    `結尾僅保留一句極低門檻提問：詢問是否方便由我針對貴司該業務流程先補一組 2–3 屏可點按概念預覽（Working Preview）供團隊參考？`,
  ].join(" ");
}

function buildReferralFeedback({ oldPersonName, newPersonName, newTitle, region, note }) {
  const isChinese = /[\u4e00-\u9fff]/.test(newPersonName) || region === "HK" || region === "TW";
  if (!isChinese && region === "EN_OR_OTHER") {
    return [
      `This is a warm Left-Company Referral outreach.`,
      `Open naturally mentioning that we previously wrote to ${oldPersonName}, whose auto-reply directed enquiries to ${newPersonName} (${newTitle}).`,
      `Keep 110–150 words, English, Ivan / Linktion, NO .pdf link, optionally 1 clean link https://yingxuan.io/en/process .`,
      note ? `Context: ${note}` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  const localeRules =
    region === "HK"
      ? `必須 100% 使用地道香港繁體詞彙（數碼／數碼化／軟件／源碼／聯絡／查詢），嚴禁混用台灣詞彙「數位／數位化／軟體／原始碼／聯繫」或簡體字（即使公司內部備註寫了「數位化」，對外信也必須改寫為「數碼化」）！`
      : `必須 100% 使用地道台灣繁體詞彙（數位／數位化／軟體／原始碼／聯繫／洽詢），嚴禁混用香港詞彙「數碼／數碼化／軟件／源碼／聯絡」或簡體字！`;

  return [
    `本封為【前同事離職自動回覆轉介破冰信（Warm Referral Touch #1）】，語氣自然真誠。`,
    `開頭第一段必須自然說明：日前致信貴司前同仁 ${oldPersonName}，收到其離職自動回覆指示相關海外業務對接由 ${newPersonName}（${newTitle}）負責，故特地轉信致意。`,
    localeRules,
    `篇幅精煉控制在 160–215 字（3 短段），聚焦該公司海外 B2B 買家詢盤與經銷商補貨的具體摩擦，簡述英选由前 ClackyAI 核心工程團隊透過 AI 參與需求拆解與測試把關，2–4 週先交付可操作預覽並於驗收時移交完整${region === "HK" ? "源碼" : "原始碼"}。`,
    `【連結紀律】首封轉介信嚴禁放入 .pdf 手冊直鏈！僅於文末自然詢問是否方便發送一頁針對該業務流程整理的《一期獨立驗收邊界與${region === "HK" ? "源碼" : "原始碼"}移交核對單》供參考，並以「Ivan / 英选 (yingxuan.io)」或單一官網根連結 https://yingxuan.io/ 落款；品牌名一律寫「英选」而非「英選」。`,
    note ? `補充核驗背景：${note}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

const [, , cmd, ...rawArgs] = process.argv;

if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
  console.log(`Usage: node scripts/wave-review-tool.mjs <command> [options]

Commands: retrospective | prepare-followups | import-referral | generate-briefs |
  s-tier-candidates | linkedin-l1 | mark-linkedin-sent | list-pending | get-prompts |
  put-instructions | patch-kb | regenerate | edit | discard | send-paced

Required env (live API): AGENTSDR_URL, AGENTSDR_API_KEY, AGENTSDR_OWN_MAILBOXES
Optional: AGENTSDR_FROM_EMAIL_ZH, AGENTSDR_FROM_EMAIL_EN, OUTREACH_LEDGER_PATH,
  OUTREACH_WORKDIR, OUTREACH_BRIEFS_DIR, OUTREACH_LINKEDIN_L1_DOC

--sync-mailboxes / --write-ledger have write side effects. send-paced is blocked
when bounce band is circuit_breaker or conservative_hold unless
--force-send-despite-breaker is set (still requires human approval).`);
  process.exit(cmd ? 0 : 1);
}

bootLiveEnv();

if (cmd === "retrospective") {
  const days = Number(getFlagValue(rawArgs, "--days") ?? 14);
  const minDays = Number(getFlagValue(rawArgs, "--min-days") ?? 3);
  const maxDays = Number(getFlagValue(rawArgs, "--max-days") ?? 8);
  const syncMailboxes = rawArgs.includes("--sync-mailboxes");
  const writeLedger = rawArgs.includes("--write-ledger");

  const report = await computeRetrospective({ days, minDays, maxDays, syncMailboxes });
  if (writeLedger) {
    writeLedgerFile({ latestSnapshot: report });
    report.ledgerSavedTo = [LEDGER_PATH, TMP_LEDGER_PATH];
  }
  console.log(JSON.stringify(report, null, 2));
} else if (cmd === "prepare-followups") {
  const limit = Number(getFlagValue(rawArgs, "--limit") ?? 4);
  const minDays = Number(getFlagValue(rawArgs, "--min-days") ?? 3);
  const maxDays = Number(getFlagValue(rawArgs, "--max-days") ?? 8);
  const previewUrl = getFlagValue(rawArgs, "--preview-url");

  const retro = await computeRetrospective({ days: Math.max(14, maxDays + 5), minDays, maxDays, syncMailboxes: false });
  const selected = (retro.cadencePool?.topCandidates ?? []).slice(0, limit);
  const prepared = [];
  const errors = [];

  for (const candidate of selected) {
    try {
      const feedback = buildTouch2Feedback(candidate, previewUrl);
      const res = await apiJson("/api/crm/drafts", {
        method: "POST",
        body: JSON.stringify({
          action: "generate",
          recordId: candidate.recordId,
          feedback,
        }),
      });
      prepared.push({
        created: res.created,
        draftId: res.draft?.id,
        recordId: candidate.recordId,
        code: candidate.code,
        company: candidate.company,
        person: candidate.person,
        toEmail: res.draft?.toEmail ?? candidate.email,
        fromEmail: res.draft?.fromEmail,
        inboxTier: candidate.inboxTier,
        ageDays: candidate.ageDays,
        subject: res.draft?.subject,
        bodyText: res.draft?.bodyText,
      });
    } catch (err) {
      errors.push({
        recordId: candidate.recordId,
        code: candidate.code,
        company: candidate.company,
        error: String(err?.message ?? err),
      });
    }
  }

  console.log(
    JSON.stringify(
      {
        eligiblePoolCount: retro.cadencePool?.followUpsDueCount ?? 0,
        requestedLimit: limit,
        preparedCount: prepared.length,
        prepared,
        errors,
      },
      null,
      2,
    ),
  );
} else if (cmd === "import-referral") {
  const fromRecordId = getFlagValue(rawArgs, "--from-record");
  const fullName = getFlagValue(rawArgs, "--name");
  const title = getFlagValue(rawArgs, "--title") || "Overseas Sales Contact";
  const email = (getFlagValue(rawArgs, "--email") ?? "").trim().toLowerCase();
  const note = getFlagValue(rawArgs, "--note") || "";

  if (!fromRecordId || !fullName || !email) {
    console.error(
      'Usage: wave-review-tool.mjs import-referral --from-record <recordId> --name "<Full Name>" --title "<Title>" --email "<email>" [--note "<context>"]',
    );
    process.exit(1);
  }

  const emailDomain = email.split("@")[1] ?? "";
  if (!emailDomain || LEGACY_ISP_DOMAINS.has(emailDomain)) {
    throw new Error(`Invalid or blocked referral email domain: ${email}`);
  }
  const mxRecords = await dns.resolveMx(emailDomain).catch(() => []);
  if (!Array.isArray(mxRecords) || !mxRecords.some((r) => Boolean(r?.exchange && r.exchange.trim() !== "."))) {
    throw new Error(`Referral email domain "${emailDomain}" has no valid MX record`);
  }

  const ws = await apiJson(`/api/crm/records/${fromRecordId}`);
  const oldPerson = ws.person ?? {};
  const company = ws.company ?? {};
  const xCode = company.custom?.x_code ?? company.raw?.x_code ?? company.raw?.company_code ?? null;
  const xRegion = company.custom?.x_region ?? null;
  const xLeadReason = company.custom?.x_lead_reason ?? `${company.name} referral contact`;
  const region = inferRegionGroup(xCode, company.domain);

  // 1. Discard any stale awaiting_review reply drafts on the ex-employee's record
  const discardedDraftIds = [];
  for (const d of ws.drafts ?? []) {
    if (d.status === "awaiting_review") {
      await apiJson(`/api/crm/drafts/${d.id}/discard`, { method: "POST" });
      discardedDraftIds.push(d.id);
    }
  }

  // 2. Mark old left-company person DNC if not already set
  let dncUpdated = false;
  if (!ws.dnc && oldPerson.id) {
    await apiJson(`/api/crm/people/${oldPerson.id}/dnc`, {
      method: "POST",
      body: JSON.stringify({
        enabled: true,
        reason: `Left company (auto-reply referred inquiries to ${email})`,
      }),
    });
    dncUpdated = true;
  }

  // 3. Create / upsert new referral contact under the same company
  const verificationNote = [
    `離職自動回覆轉介聯絡人：致信前同事 ${oldPerson.fullName || oldPerson.email}（${oldPerson.email}）收到自動回覆明確轉介 ${fullName}（${email}）`,
    note,
  ]
    .filter(Boolean)
    .join("；");

  const importRes = await apiJson("/api/leads/people", {
    method: "POST",
    body: JSON.stringify({
      email,
      fullName,
      title,
      phone: oldPerson.phone ?? null,
      companyName: company.name,
      companyDomain: company.domain,
      companyCode: xCode,
      companyRegion: xRegion,
      leadReason: xLeadReason,
      verificationNote,
      workflowState: "idle",
      createCrmRecord: true,
    }),
  });

  const newPersonId = importRes.personId;
  if (!newPersonId) {
    throw new Error(`Failed to obtain new personId from /api/leads/people: ${JSON.stringify(importRes)}`);
  }

  // 4. Generate warm referral Touch #1 draft in awaiting_review
  const feedback = buildReferralFeedback({
    oldPersonName: oldPerson.fullName || "貴司同事",
    newPersonName: fullName,
    newTitle: title,
    region,
    note,
  });

  const draftRes = await apiJson("/api/crm/drafts", {
    method: "POST",
    body: JSON.stringify({
      action: "generate",
      personId: newPersonId,
      fromEmail: region === "EN_OR_OTHER" && !/[\u4e00-\u9fff]/.test(fullName) ? FROM_EMAIL_EN : FROM_EMAIL_ZH,
      feedback,
    }),
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        fromRecordId,
        discardedStaleDraftIds: discardedDraftIds,
        oldPersonMarkedDnc: dncUpdated,
        newPersonCreated: Boolean(importRes.created),
        newPersonId,
        newRecordId: importRes.crmRecord?.id ?? draftRes.draft?.crmRecordId ?? null,
        code: xCode,
        company: company.name,
        draft: draftRes.draft,
      },
      null,
      2,
    ),
  );
} else if (cmd === "list-pending") {
  const reportPath = getFlagValue(rawArgs, "--report");
  const includeFollowups = rawArgs.includes("--include-followups");
  let waveDomains = null;
  if (reportPath && fs.existsSync(reportPath)) {
    const rep = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    waveDomains = new Set((rep.leads || []).map((l) => (l.domain || "").toLowerCase()).filter(Boolean));
  }

  const [{ drafts: awaitingDrafts = [] }, { drafts: sentDrafts = [] }] = await Promise.all([
    apiJson("/api/crm/drafts?status=awaiting_review"),
    apiJson("/api/crm/drafts?status=sent"),
  ]);

  const sentCountByRecord = new Map();
  for (const s of sentDrafts) {
    sentCountByRecord.set(s.crmRecordId, (sentCountByRecord.get(s.crmRecordId) ?? 0) + 1);
  }

  const filtered = waveDomains
    ? awaitingDrafts.filter((d) => {
        if (!d.company?.domain || waveDomains.has(d.company.domain.toLowerCase())) return true;
        if (includeFollowups) {
          const hasPriorSent = (sentCountByRecord.get(d.crmRecordId) ?? 0) >= 1;
          return hasPriorSent || !waveDomains.has(d.company.domain.toLowerCase());
        }
        return false;
      })
    : awaitingDrafts;

  const detailed = await mapWithConcurrency(filtered, 5, async (item) => {
    const detail = await apiJson(`/api/crm/drafts/${item.id}`);
    const d = detail.draft;
    const leadReason = extractRequestField(d.request, "x_lead_reason");
    const verificationNote = extractRequestField(d.request, "x_verification_note");
    const metrics = inspectDraftMetrics({
      draft: d,
      sentCountForRecord: sentCountByRecord.get(d.crmRecordId) ?? 0,
      verificationNote,
    });
    return {
      draftId: d.id,
      crmRecordId: d.crmRecordId,
      isInboundReplyDraft: Boolean(d.replyForMessageId),
      touchType: metrics.touchType,
      inboxTier: metrics.inboxTier,
      charCount: metrics.charCount,
      httpLinkCount: metrics.httpLinkCount,
      hasPdfLink: metrics.hasPdfLink,
      autoSendAt: d.autoSendAt,
      code: detail.company?.code ?? item.company?.code ?? null,
      company: detail.company?.name ?? item.company?.name ?? null,
      domain: detail.company?.domain ?? item.company?.domain ?? null,
      person: detail.person?.fullName ?? item.person?.fullName ?? null,
      title: detail.person?.title ?? item.person?.title ?? null,
      toEmail: d.toEmail,
      fromEmail: d.fromEmail,
      leadReason,
      verificationNote,
      subject: d.subject,
      bodyText: d.bodyText,
    };
  });

  console.log(JSON.stringify({ count: detailed.length, drafts: detailed }, null, 2));
} else if (cmd === "get-prompts") {
  const [aiInstructions, knowledge] = await Promise.all([
    apiJson("/api/crm/settings/ai-instructions"),
    apiJson("/api/crm/knowledge"),
  ]);
  console.log(JSON.stringify({ aiInstructions, knowledge }, null, 2));
} else if (cmd === "put-instructions") {
  const file = rawArgs[0];
  if (!file || !fs.existsSync(file)) {
    console.error("Usage: wave-review-tool.mjs put-instructions <json-file>");
    process.exit(1);
  }
  const payload = JSON.parse(fs.readFileSync(file, "utf8"));
  const out = await apiJson("/api/crm/settings/ai-instructions", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
  console.log(JSON.stringify({ ok: true, pipelineId: out.pipelineId, blocks: out.draftInstructions?.length ?? 0 }, null, 2));
} else if (cmd === "patch-kb") {
  const [docId, file] = rawArgs;
  if (!docId || !file || !fs.existsSync(file)) {
    console.error("Usage: wave-review-tool.mjs patch-kb <docId> <json-file>");
    process.exit(1);
  }
  const payload = JSON.parse(fs.readFileSync(file, "utf8"));
  const out = await apiJson(`/api/crm/knowledge/${docId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
  console.log(JSON.stringify({ ok: true, id: out.document?.id, latestVersion: out.document?.latestVersion }, null, 2));
} else if (cmd === "regenerate") {
  const [draftId, feedback] = rawArgs;
  if (!draftId) {
    console.error('Usage: wave-review-tool.mjs regenerate <draftId> "<feedback>"');
    process.exit(1);
  }
  await apiJson(`/api/crm/drafts/${draftId}/regenerate`, {
    method: "POST",
    body: JSON.stringify({ feedback: feedback || null }),
  });
  const detail = await apiJson(`/api/crm/drafts/${draftId}`);
  const metrics = inspectDraftMetrics({
    draft: detail.draft,
    sentCountForRecord: 0,
    verificationNote: "",
  });
  console.log(
    JSON.stringify(
      {
        draftId,
        code: detail.company?.code,
        company: detail.company?.name,
        person: detail.person?.fullName,
        title: detail.person?.title,
        toEmail: detail.draft.toEmail,
        inboxTier: metrics.inboxTier,
        charCount: metrics.charCount,
        httpLinkCount: metrics.httpLinkCount,
        hasPdfLink: metrics.hasPdfLink,
        subject: detail.draft.subject,
        bodyText: detail.draft.bodyText,
      },
      null,
      2,
    ),
  );
} else if (cmd === "edit") {
  const subject = getFlagValue(rawArgs, "--subject");
  const bodyFile = getFlagValue(rawArgs, "--body-file");
  const positional = stripFlags(rawArgs, ["--subject", "--body-file"]);
  const draftId = positional[0];
  if (!draftId || !bodyFile || !fs.existsSync(bodyFile)) {
    console.error('Usage: wave-review-tool.mjs edit <draftId> [--subject "..."] --body-file <txt-file>');
    process.exit(1);
  }
  const bodyText = fs.readFileSync(bodyFile, "utf8").trim();
  const payload = { bodyText, ...(subject ? { subject } : {}) };
  const out = await apiJson(`/api/crm/drafts/${draftId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
  console.log(
    JSON.stringify(
      {
        draftId,
        revision: out.draft?.revision,
        subject: out.draft?.subject,
        bodyText: out.draft?.bodyText,
      },
      null,
      2,
    ),
  );
} else if (cmd === "discard") {
  if (rawArgs.length === 0) {
    console.error("Usage: wave-review-tool.mjs discard <draftId1> [draftId2 ...]");
    process.exit(1);
  }
  const results = [];
  for (const id of rawArgs) {
    try {
      await apiJson(`/api/crm/drafts/${id}/discard`, { method: "POST" });
      results.push({ draftId: id, ok: true, status: "discarded" });
    } catch (err) {
      results.push({ draftId: id, ok: false, error: String(err?.message ?? err) });
    }
  }
  console.log(JSON.stringify(results, null, 2));
} else if (cmd === "send-paced") {
  const paceMs = Number(getFlagValue(rawArgs, "--pace-ms") ?? 8000);
  const reportPath = getFlagValue(rawArgs, "--report");
  const experimentArm = getFlagValue(rawArgs, "--experiment-arm");
  const scheduleInWorkingHours = rawArgs.includes("--schedule-working-hours");
  const writeLedger = rawArgs.includes("--write-ledger");
  const allowExceedCap = rawArgs.includes("--allow-exceed-cap");
  const forceDespiteBreaker = rawArgs.includes("--force-send-despite-breaker");
  const draftIds = stripFlags(
    rawArgs,
    ["--pace-ms", "--report", "--experiment-arm"],
    ["--schedule-working-hours", "--write-ledger", "--allow-exceed-cap", "--force-send-despite-breaker"],
  );

  if (draftIds.length === 0) {
    console.error(
      "Usage: wave-review-tool.mjs send-paced [--pace-ms 8000] [--schedule-working-hours] [--report <path>] [--experiment-arm <arm>] [--write-ledger] [--allow-exceed-cap] [--force-send-despite-breaker] <draftId1> ...",
    );
    process.exit(1);
  }

  // Historical ledger bounce (fixture may be stale — refresh before real send).
  try {
    if (fs.existsSync(LEDGER_PATH)) {
      const ledgerSnap = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
      const pct = Number(ledgerSnap?.latestSnapshot?.deliverability?.bounceRatePct);
      if (Number.isFinite(pct)) {
        const ev = evaluateBounceRate(pct);
        if (!ev.allowAutoColdSend && !forceDespiteBreaker) {
          console.error(
            `send-paced blocked: ${ev.note} Refresh retrospective first. Override only with --force-send-despite-breaker after human approval.`,
          );
          process.exit(1);
        }
      }
    }
  } catch (err) {
    console.warn(`[safety] could not read ledger bounce: ${err?.message ?? err}`);
  }

  // Guard daily <= 10 send cap (Asia/Shanghai) — draft_only does not count.
  const todayYmd = formatDateYmd(new Date());
  const { drafts: allDraftsForCap = [] } = await apiJson("/api/crm/drafts?status=all");
  const sentTodayCount = countCapConsumingDraftsToday(allDraftsForCap, todayYmd, formatDateYmd);
  const cap = assertDailyCapAllows(sentTodayCount, draftIds.length, { allowExceedCap });
  if (!cap.ok) {
    console.error(cap.error);
    process.exit(1);
  }

  // Snapshot prior sent drafts once so we can classify touchType cleanly
  let sentCountByRecord = new Map();
  try {
    const { drafts: sentBefore = [] } = await apiJson("/api/crm/drafts?status=sent");
    for (const s of sentBefore) {
      sentCountByRecord.set(s.crmRecordId, (sentCountByRecord.get(s.crmRecordId) ?? 0) + 1);
    }
  } catch {
    // ignore classification lookup failure
  }

  const results = [];
  for (let i = 0; i < draftIds.length; i++) {
    const id = draftIds[i];
    if (i > 0 && !scheduleInWorkingHours && paceMs > 0) {
      await new Promise((r) => setTimeout(r, paceMs));
    }
    try {
      const detailBefore = await apiJson(`/api/crm/drafts/${id}`);
      const d = detailBefore.draft;
      const metrics = inspectDraftMetrics({
        draft: d,
        sentCountForRecord: sentCountByRecord.get(d.crmRecordId) ?? 0,
        verificationNote: extractRequestField(d.request, "x_verification_note") ?? "",
      });
      const sendRes = await apiJson(`/api/crm/drafts/${id}/send`, {
        method: "POST",
        body: JSON.stringify(scheduleInWorkingHours ? { scheduleInWorkingHours: true } : {}),
      });
      const finalStatus = sendRes.scheduled ? "queued" : "sent";
      console.log(
        `[${i + 1}/${draftIds.length}] ${finalStatus.toUpperCase()} (${metrics.touchType}) | ${detailBefore.company?.code ?? "-"} ${detailBefore.company?.name ?? ""} -> ${d.toEmail}`,
      );
      results.push({
        draftId: id,
        ok: true,
        status: finalStatus,
        touchType: metrics.touchType,
        inboxTier: metrics.inboxTier,
        charCount: metrics.charCount,
        httpLinkCount: metrics.httpLinkCount,
        hasPdfLink: metrics.hasPdfLink,
        code: detailBefore.company?.code ?? null,
        company: detailBefore.company?.name ?? null,
        person: detailBefore.person?.fullName ?? null,
        title: detailBefore.person?.title ?? null,
        toEmail: d.toEmail,
        fromEmail: d.fromEmail,
        subject: d.subject,
      });
    } catch (err) {
      console.error(`[${i + 1}/${draftIds.length}] FAILED | ${id}: ${err?.message ?? err}`);
      results.push({ draftId: id, ok: false, status: "failed", error: String(err?.message ?? err) });
    }
  }

  let reportObj = null;
  if (reportPath && fs.existsSync(reportPath)) {
    try {
      const rep = JSON.parse(fs.readFileSync(reportPath, "utf8"));
      const byEmail = new Map();
      for (const r of results) {
        if (r.toEmail) byEmail.set(r.toEmail.toLowerCase(), r);
      }
      for (const lead of rep.leads || []) {
        const match = lead.toEmail ? byEmail.get(lead.toEmail.toLowerCase()) : null;
        if (match && match.ok) {
          lead.status = match.status;
          lead.touchType = match.touchType;
          if (match.subject) lead.subject = match.subject;
        }
      }
      rep.counts = {
        sent: (rep.leads || []).filter((l) => l.status === "sent").length,
        queued: (rep.leads || []).filter((l) => l.status === "queued").length,
        awaitingReview: (rep.leads || []).filter((l) => l.status === "awaiting_review").length,
        failed: (rep.leads || []).filter((l) => l.status === "failed").length,
      };
      rep.reviewedAndSentAt = new Date().toISOString();
      if (experimentArm) rep.experimentArm = experimentArm;
      fs.writeFileSync(reportPath, JSON.stringify(rep, null, 2));
      reportObj = rep;
    } catch (err) {
      console.error("Warning: failed to update wave-report.json:", err?.message ?? err);
    }
  }

  if (writeLedger) {
    const succeeded = results.filter((r) => r.ok);
    const waveEntry = {
      timestamp: new Date().toISOString(),
      reportPath: reportPath || null,
      experimentArm: experimentArm || reportObj?.experimentArm || "unspecified",
      totalSentOrQueued: succeeded.length,
      failed: results.filter((r) => !r.ok).length,
      byTouchType: {
        touch_1_cold: succeeded.filter((r) => r.touchType === "touch_1_cold").length,
        touch_2_followup: succeeded.filter((r) => r.touchType === "touch_2_followup").length,
        warm_referral: succeeded.filter((r) => r.touchType === "warm_referral").length,
        other: succeeded.filter((r) => !["touch_1_cold", "touch_2_followup", "warm_referral"].includes(r.touchType)).length,
      },
      byInboxTier: {
        named_corporate: succeeded.filter((r) => r.inboxTier === "named_corporate").length,
        generic_role: succeeded.filter((r) => r.inboxTier === "generic_role").length,
        freemail: succeeded.filter((r) => r.inboxTier === "freemail").length,
      },
      avgChars:
        succeeded.length > 0
          ? Math.round(succeeded.reduce((sum, r) => sum + (r.charCount ?? 0), 0) / succeeded.length)
          : 0,
    };
    writeLedgerFile({ appendWave: waveEntry });
  }

  const summary = {
    totalRequested: draftIds.length,
    experimentArm: experimentArm || reportObj?.experimentArm || null,
    sent: results.filter((r) => r.status === "sent").length,
    queued: results.filter((r) => r.status === "queued").length,
    failed: results.filter((r) => r.status === "failed").length,
    results,
  };
  console.log(JSON.stringify(summary, null, 2));
} else if (cmd === "generate-briefs") {
  const targetRecordId = getFlagValue(rawArgs, "--record");
  const pendingOnly = rawArgs.includes("--pending");
  const outDir = getFlagValue(rawArgs, "--out-dir") || BRIEFS_DIR_DEFAULT;
  fs.mkdirSync(outDir, { recursive: true });

  const targets = [];
  if (targetRecordId) {
    const ws = await apiJson(`/api/crm/records/${targetRecordId}`);
    targets.push({
      person: ws.person ?? {},
      company: ws.company ?? {},
      crm: {
        recordId: targetRecordId,
        dnc: Boolean(ws.dnc),
        bounced: Boolean(ws.bounced),
        closed: Boolean(ws.closed),
      },
    });
  } else {
    const snapshot = await loadCrmSnapshot();
    const pendingRecordIds = new Set(snapshot.pendingDraftsByRecord.keys());
    if (pendingOnly) {
      for (const recId of pendingRecordIds) {
        const entry = snapshot.personByRecordId.get(recId);
        if (entry) targets.push(entry);
      }
    } else {
      const seen = new Set();
      for (const recId of pendingRecordIds) {
        const entry = snapshot.personByRecordId.get(recId);
        if (entry) {
          targets.push(entry);
          seen.add(recId);
        }
      }
      const trackAEntries = snapshot.allPeople.filter((e) => {
        if (!e.crm?.recordId || seen.has(e.crm.recordId)) return false;
        const m = extractEntryMeta(e);
        return m.isTrackA && !m.dnc && !m.bounced && !m.closed;
      });
      targets.push(...trackAEntries.slice(0, 8));
    }
  }

  const files = [];
  for (const entry of targets) {
    const meta = extractEntryMeta(entry);
    const safeCode = (meta.code || meta.recordId?.slice(0, 8) || "LEAD").replace(/[^A-Za-z0-9_-]/g, "");
    const safeDomain = (meta.domain || "unknown").replace(/[^A-Za-z0-9.-]/g, "_");
    const filename = `${safeCode}-${safeDomain}.md`;
    const filePath = path.join(outDir, filename);
    const content = buildSchemeAChecklistContent(meta);
    fs.writeFileSync(filePath, `${content}\n`);
    files.push({
      recordId: meta.recordId,
      code: meta.code,
      company: meta.companyName,
      person: meta.personName,
      region: meta.region,
      isTrackA: meta.isTrackA,
      filePath,
    });
  }

  console.log(JSON.stringify({ count: files.length, outDir, files }, null, 2));
} else if (cmd === "s-tier-candidates") {
  const limit = Number(getFlagValue(rawArgs, "--limit") ?? 5);
  const minDays = Number(getFlagValue(rawArgs, "--min-days") ?? 3);
  const maxDays = Number(getFlagValue(rawArgs, "--max-days") ?? 8);
  const nowMs = Date.now();

  const snapshot = await loadCrmSnapshot();
  const scored = [];
  for (const entry of snapshot.allPeople) {
    const meta = extractEntryMeta(entry);
    if (!meta.recordId) continue;
    const sentCount = snapshot.sentDraftsByRecord.get(meta.recordId)?.length ?? 0;
    const pendingCount = snapshot.pendingDraftsByRecord.get(meta.recordId)?.length ?? 0;
    const verdict = scoreSTierCandidate(meta, { sentCount, pendingCount, nowMs, minDays, maxDays });
    if (!verdict.eligible) continue;

    const safeCode = (meta.code || meta.recordId.slice(0, 8)).replace(/[^A-Za-z0-9_-]/g, "");
    const safeDomain = (meta.domain || "preview").replace(/[^A-Za-z0-9.-]/g, "_");
    scored.push({
      score: verdict.score,
      recordId: meta.recordId,
      code: meta.code,
      company: meta.companyName,
      domain: meta.domain,
      region: meta.region,
      person: meta.personName,
      title: meta.title,
      email: meta.email,
      inboxTier: meta.inboxTier,
      phone: meta.phone,
      linkedinUrl: meta.personLinkedinUrl,
      companyLinkedinUrl: meta.companyLinkedinUrl,
      isTrackA: meta.isTrackA,
      sentCount,
      ageDays: verdict.ageDays,
      reasons: verdict.reasons,
      suggestedPreviewPath: `docs/previews/${safeCode}-${safeDomain}.html`,
      leadReason: meta.leadReason.slice(0, 220),
    });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit);
  console.log(JSON.stringify({ totalEligible: scored.length, limit, candidates: top }, null, 2));
} else if (cmd === "linkedin-l1") {
  const limit = Number(getFlagValue(rawArgs, "--limit") ?? 12);
  const writeDoc = rawArgs.includes("--write-doc");
  const includeSent = rawArgs.includes("--include-sent");
  const nowMs = Date.now();

  const [snapshot, ledger] = await Promise.all([loadCrmSnapshot(), Promise.resolve(readLedger())]);
  const sentMap = ledger.linkedinL1 ?? {};
  const ranked = [];

  for (const entry of snapshot.allPeople) {
    const meta = extractEntryMeta(entry);
    if (!meta.recordId) continue;
    if (meta.dnc || meta.bounced || meta.closed || meta.categoryKey === "not_interested") continue;
    if (PLACEHOLDER_PERSON_RE.test(meta.personName || "")) continue;
    if (!includeSent && sentMap[meta.recordId]) continue;

    const sentEmails = snapshot.sentDraftsByRecord.get(meta.recordId)?.length ?? 0;
    const hasPendingEmail = (snapshot.pendingDraftsByRecord.get(meta.recordId)?.length ?? 0) > 0;
    const emailFollowupStalled = sentEmails >= 1 && !meta.lastInboundAt;
    const isGenericEmail = meta.inboxTier === "generic_role";

    let priority = 0;
    const tags = [];
    if (meta.isTrackA) {
      priority += 45;
      tags.push("TrackA招聘");
    }
    if (meta.personLinkedinUrl) {
      priority += 30;
      tags.push("已含個人LinkedIn");
    } else if (meta.companyLinkedinUrl) {
      priority += 12;
      tags.push("含公司LinkedIn");
    }
    if (meta.categoryKey === "interested") {
      priority += 35;
      tags.push("高意向");
    }
    if (hasPendingEmail) {
      priority += 20;
      tags.push("待發溫熱線索");
    }
    if (emailFollowupStalled && isGenericEmail) {
      priority += 18;
      tags.push("突破公共信箱");
    } else if (emailFollowupStalled) {
      priority += 10;
      tags.push("郵件未回雙打");
    }
    if (meta.phone) {
      priority += 5;
      tags.push("含電話");
    }
    if (priority < 15) continue;

    const copy = buildLinkedInCopy(meta);
    const peopleSearchUrl = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(
      `${meta.personName} ${meta.companyName}`,
    )}`;
    const companySearchUrl = `https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(
      meta.companyName,
    )}`;

    ranked.push({
      priority,
      tags,
      recordId: meta.recordId,
      code: meta.code,
      company: meta.companyName,
      domain: meta.domain,
      region: meta.region,
      person: meta.personName,
      title: meta.title,
      email: meta.email,
      inboxTier: meta.inboxTier,
      sentEmails,
      linkedinSentRecord: sentMap[meta.recordId] ?? null,
      profileUrl: meta.personLinkedinUrl,
      companyLinkedinUrl: meta.companyLinkedinUrl,
      peopleSearchUrl,
      companySearchUrl,
      leadReason: normalizeLocaleVocab(meta.leadReason, meta.region).slice(0, 200),
      copy,
      markSentCommand: `node scripts/wave-review-tool.mjs mark-linkedin-sent ${meta.recordId}`,
    });
  }

  ranked.sort((a, b) => b.priority - a.priority);
  const queue = ranked.slice(0, limit);

  if (writeDoc) {
    const lines = [
      `# LinkedIn L1 半自動雙打工作台（零 Unipile · 安全人肉發送隊列）`,
      ``,
      `> 生成時間：${new Date(nowMs).toISOString()}｜嚴守紀律：**不掛載 Unipile / 不群發推銷模板**，每則私訊控制在 1–2 行短信級（1 個具體觀察 + 1 個開放式提問）。已發送後執行每張卡片末端的 \`mark-linkedin-sent\` 指令回寫台帳，避免重複觸達。`,
      ``,
    ];
    if (queue.length === 0) {
      lines.push(`目前隊列為空（所有符合條件的高優線索均已標記處理）。`);
    } else {
      queue.forEach((item, idx) => {
        lines.push(`## ${idx + 1}. [${item.code || "-"}] ${item.company} — ${item.person}（${item.title || "Decision Maker"}）`);
        lines.push(`- **優先級標籤**：\`${item.priority}\` 分（${item.tags.join(" · ")}）｜郵件狀態：已發 ${item.sentEmails} 封（\`${item.inboxTier}\`）`);
        lines.push(
          `- **直達入口**：${
            item.profileUrl ? `[個人主頁](${item.profileUrl})` : `[一鍵搜個人檔案](${item.peopleSearchUrl})`
          } ｜ ${
            item.companyLinkedinUrl ? `[公司主頁](${item.companyLinkedinUrl})` : `[搜公司主頁](${item.companySearchUrl})`
          }`,
        );
        lines.push(`- **業務觀察**：${item.leadReason || item.domain || "-"}`);
        lines.push(``);
        lines.push(`**① 好友申請備註（Connection Note，<=150 字，零推銷）**：`);
        lines.push("```text");
        lines.push(item.copy.connectionNote);
        lines.push("```");
        lines.push(`**② 通過後首條短信級私訊（1 個觀察 + 1 個開放提問）**：`);
        lines.push("```text");
        lines.push(item.copy.firstDmSms);
        lines.push("```");
        lines.push(`**③ 跟進語音／短視頻話術（Pattern Interrupt）**：`);
        lines.push(`> ${item.copy.followUpVoiceOrAsset}`);
        lines.push(``);
        lines.push(`**發送後回寫台帳命令**（如順便找到個人主頁可加 \`--url <linkedin_profile_url>\`）：`);
        lines.push("```bash");
        lines.push(item.markSentCommand);
        lines.push("```");
        lines.push(``);
      });
    }
    fs.mkdirSync(path.dirname(LINKEDIN_L1_DOC_PATH), { recursive: true });
    fs.writeFileSync(LINKEDIN_L1_DOC_PATH, `${lines.join("\n")}\n`);
  }

  console.log(
    JSON.stringify(
      {
        totalCandidatePool: ranked.length,
        count: queue.length,
        docPath: writeDoc ? LINKEDIN_L1_DOC_PATH : null,
        queue,
      },
      null,
      2,
    ),
  );
} else if (cmd === "mark-linkedin-sent") {
  const urlArg = getFlagValue(rawArgs, "--url");
  const noteArg = getFlagValue(rawArgs, "--note") || "Sent manually via LinkedIn L1 queue";
  const positional = stripFlags(rawArgs, ["--url", "--note"]);
  const recordId = positional[0];
  if (!recordId) {
    console.error('Usage: wave-review-tool.mjs mark-linkedin-sent <recordId> [--url <linkedinUrl>] [--note "<context>"]');
    process.exit(1);
  }

  const ws = await apiJson(`/api/crm/records/${recordId}`);
  const person = ws.person ?? {};
  const company = ws.company ?? {};
  const code = company.custom?.x_code ?? company.raw?.x_code ?? company.raw?.company_code ?? null;

  let personUpdated = false;
  if (urlArg && /linkedin\.com\/in\//i.test(urlArg) && person.email) {
    await apiJson("/api/leads/people", {
      method: "POST",
      body: JSON.stringify({
        email: person.email,
        linkedinUrl: urlArg.trim(),
        fullName: person.fullName,
        title: person.title,
        companyName: company.name,
        companyDomain: company.domain,
      }),
    });
    personUpdated = true;
  }

  writeLedgerFile({
    linkedinOutreachUpdate: {
      recordId,
      entry: {
        sentAt: new Date().toISOString(),
        code,
        company: company.name ?? null,
        person: person.fullName ?? null,
        linkedinUrl: urlArg?.trim() || person.linkedinUrl || null,
        note: noteArg,
      },
    },
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        recordId,
        code,
        company: company.name ?? null,
        person: person.fullName ?? null,
        personLinkedinUpdated: personUpdated,
        ledgerSavedTo: [LEDGER_PATH, TMP_LEDGER_PATH],
      },
      null,
      2,
    ),
  );
} else {
  console.error(
    "Usage: wave-review-tool.mjs <retrospective|prepare-followups|import-referral|generate-briefs|s-tier-candidates|linkedin-l1|mark-linkedin-sent|list-pending|get-prompts|put-instructions|patch-kb|regenerate|edit|discard|send-paced> ...",
  );
  process.exit(1);
}
