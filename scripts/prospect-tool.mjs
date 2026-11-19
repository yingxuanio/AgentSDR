#!/usr/bin/env node
/**
 * High-speed, low-token Exa + Local-First + AgentSDR Prospecting CLI for AGY workers.
 *
 * Commands:
 *   node prospect-tool.mjs --help
 *   node prospect-tool.mjs search "query 1" "query 2" ...
 *   node prospect-tool.mjs scrape "https://..." "https://..." ...
 *   node prospect-tool.mjs check "domain1.com" "domain2.com.hk" ...
 *   node prospect-tool.mjs submit /path/to/leads.json
 *
 * Delivery (submit): OUTREACH_DELIVERY_MODE defaults to draft_only.
 * Required for CRM: AGENTSDR_URL + AGENTSDR_API_KEY (no loopback default, no key fallback).
 * Never reads .env files from disk.
 */
import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import path from "node:path";
import {
  envTrim,
  requireAgentsdrApiKey,
  requireAgentsdrUrl,
  resolveDeliveryMode,
  resolveWorkdir,
} from "./outreach-cli/env.mjs";
import { deliveryEffects } from "./outreach-cli/policy.mjs";

function readEnvVar(name) {
  return envTrim(name);
}

const EXA_API_KEY = readEnvVar("EXA_API_KEY");
const FIRECRAWL_API_KEY = readEnvVar("FIRECRAWL_API_KEY");

let AGENTSDR_URL = "";
let AGENTSDR_API_KEY = "";
const EVIDENCE_FILE = process.env.PROSPECT_EVIDENCE_FILE || path.join(resolveWorkdir(), "agy-prospect-evidence.ndjson");
const CLAIMS_DIR = process.env.PROSPECT_CLAIMS_DIR || "";
const SHARD_ID = process.env.PROSPECT_SHARD_ID || "standalone";
let DELIVERY_MODE;
try {
  DELIVERY_MODE = resolveDeliveryMode(process.env.OUTREACH_DELIVERY_MODE || "draft_only");
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
const PACE_MS = Number(process.env.OUTREACH_PACE_MS ?? 8000);

function requireCrmEnv() {
  try {
    AGENTSDR_URL = requireAgentsdrUrl();
    AGENTSDR_API_KEY = requireAgentsdrApiKey();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

function printHelp() {
  console.log(`Usage: node prospect-tool.mjs <search|scrape|check|submit|--help> ...

Delivery (submit): OUTREACH_DELIVERY_MODE=draft_only (default) | queue_working_hours | send_now | send_paced
CRM env: AGENTSDR_URL, AGENTSDR_API_KEY (required for check/submit; no silent loopback)
Search: EXA_API_KEY and/or FIRECRAWL_API_KEY`);
}

const DIRECTORY_OR_MEDIA_DOMAINS = new Set([
  "hkmma.org.hk", "fhki.org.hk", "hktdc.com", "cma.org.hk", "hkpc.org", "hkstp.org", "cyberport.hk",
  "haffa.com.hk", "hkfmp.org.hk", "hketa.org.hk", "hkjewellery.org", "hkplastic.org.hk",
  "taiwantrade.com", "tami.org.tw", "tmdia.org.tw", "twtc.com.tw", "cens.com", "asiannet.com",
  "linkedin.com", "facebook.com", "instagram.com", "youtube.com", "wikipedia.org", "zhihu.com",
  "104.com.tw", "1111.com.tw", "jobsdb.com", "ctgoodjobs.hk", "cake.me", "cakeresume.com",
  "yourator.co", "yes123.com.tw", "518.com.tw", "moovup.com", "indeed.com", "hk.indeed.com",
  "tw.indeed.com", "glassdoor.com", "glassdoor.com.hk", "openjobs.com.hk", "offertoday.com",
  "jobs.gov.hk", "cpjobs.com", "ecjobsonline.com", "gov.hk", "gov.tw", "findcompany.com.tw",
  "twincn.com", "opendata.vip", "companydata.hk", "Webb-site.com", "webb-site.com",
]);

const MULTI_PART_TLDS = new Set([
  "com.hk", "org.hk", "net.hk", "edu.hk", "gov.hk", "idv.hk",
  "com.tw", "org.tw", "net.tw", "edu.tw", "gov.tw", "idv.tw",
  "com.cn", "net.cn", "org.cn", "gov.cn", "com.mo",
  "co.uk", "org.uk", "co.jp", "com.sg", "com.my", "com.au",
]);

function normalizeDomain(raw) {
  if (!raw || typeof raw !== "string") return null;
  let v = raw.trim().toLowerCase();
  if (v.includes("@") && !v.includes("/")) v = v.split("@").pop() || "";
  v = v.replace(/^[a-z]+:\/\//i, "").split("/")[0].split("?")[0].split("#")[0].split(":")[0];
  v = v.replace(/^www\./i, "").replace(/\.+$/, "");
  if (!v || !v.includes(".")) return null;
  const parts = v.split(".");
  if (parts.length >= 3) {
    const lastTwo = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
    if (MULTI_PART_TLDS.has(lastTwo)) {
      return parts.slice(-3).join(".");
    }
    return parts.slice(-2).join(".");
  }
  return v;
}

function claimFilePathForKey(lockKey) {
  if (!CLAIMS_DIR) return null;
  const safe = lockKey.replace(/[^a-z0-9._-]+/gi, "_").slice(0, 140);
  return path.join(CLAIMS_DIR, `${safe}.json`);
}

function lockKeyForUrlOrDomain(urlOrDomain) {
  const domain = normalizeDomain(urlOrDomain);
  if (!domain) return null;
  if (!DIRECTORY_OR_MEDIA_DOMAINS.has(domain)) {
    return `domain__${domain}`;
  }
  // For directory detail URLs (e.g. hkmma.org.hk/co-detail-en.php?id=88), lock the exact normalized URL
  if (/^https?:\/\//i.test(urlOrDomain)) {
    try {
      const u = new URL(urlOrDomain);
      if (u.pathname && u.pathname !== "/") {
        const canonical = `${domain}${u.pathname}${u.search}`.toLowerCase();
        const hash = crypto.createHash("sha1").update(canonical).digest("hex").slice(0, 16);
        return `dirurl__${domain}__${hash}`;
      }
    } catch {
      // ignore invalid URL
    }
  }
  return null;
}

function readClaimOwner(lockKey) {
  const fp = claimFilePathForKey(lockKey);
  if (!fp || !fs.existsSync(fp)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(fp, "utf8"));
    return data?.shard || null;
  } catch {
    return null;
  }
}

/**
 * Atomically claims a company root domain (or directory detail URL) for SHARD_ID using O_CREAT | O_EXCL ("wx").
 * Re-entrant for the same SHARD_ID (so scraping / + /about + /contact of the same company succeeds),
 * while immediately blocking other concurrent shards from wasting Firecrawl scrapes on the same company.
 */
function tryAcquireClaim(urlOrDomain) {
  if (!CLAIMS_DIR) return { allowed: true, owner: SHARD_ID };
  const lockKey = lockKeyForUrlOrDomain(urlOrDomain);
  if (!lockKey) return { allowed: true, owner: SHARD_ID };
  const fp = claimFilePathForKey(lockKey);
  if (!fp) return { allowed: true, owner: SHARD_ID };

  try {
    fs.mkdirSync(CLAIMS_DIR, { recursive: true });
    const fd = fs.openSync(fp, "wx");
    try {
      fs.writeFileSync(fd, JSON.stringify({ shard: SHARD_ID, key: lockKey, ref: urlOrDomain, ts: Date.now() }));
    } finally {
      fs.closeSync(fd);
    }
    return { allowed: true, owner: SHARD_ID };
  } catch (err) {
    if (err?.code === "EEXIST") {
      const owner = readClaimOwner(lockKey);
      if (!owner || owner === SHARD_ID) {
        return { allowed: true, owner: owner || SHARD_ID };
      }
      return { allowed: false, owner };
    }
    return { allowed: true, owner: SHARD_ID };
  }
}

const GENERIC_ROLE_PREFIX_RE =
  /^(info|sale|sales|enquir(y|ies)?|inquir(y|ies)?|service|services|contact|corporate|cs|office|admin|export|mkt|marketing|general|mail|business|order|orders|b2b)([._-].*)?@|^[a-z0-9._-]*service@|_inquiry@/i;

const LEGACY_HIGH_BOUNCE_ISP_DOMAINS = new Set([
  "biznetvigator.com",
  "netvigator.com",
]);

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

const mxVerifyCache = new Map();

function classifyInboxTier(email) {
  const clean = (email ?? "").trim().toLowerCase();
  const domain = clean.split("@")[1] ?? "";
  if (LEGACY_HIGH_BOUNCE_ISP_DOMAINS.has(domain)) return "legacy_isp";
  if (FREEMAIL_DOMAINS.has(domain)) return "freemail";
  if (GENERIC_ROLE_PREFIX_RE.test(clean)) return "generic_role";
  return "named_corporate";
}

async function resolveMxWithTimeout(resolver, domain, timeoutMs) {
  const records = await Promise.race([
    resolver.resolveMx(domain),
    new Promise((_, reject) => setTimeout(() => reject(new Error("mx_timeout")), timeoutMs)),
  ]);
  const validRecords = Array.isArray(records)
    ? records.filter((r) => Boolean(r?.exchange && r.exchange.trim() && r.exchange.trim() !== "."))
    : [];
  return validRecords.length > 0
    ? { domain, ok: true, mxHosts: validRecords.map((r) => r.exchange).slice(0, 3) }
    : { domain, ok: false, reason: "no_mx_records" };
}

async function verifyEmailDomainMx(emailOrDomain) {
  const raw = (emailOrDomain ?? "").trim().toLowerCase();
  const domain = raw.includes("@") ? (raw.split("@")[1] ?? "") : normalizeDomain(raw);
  if (!domain) return { domain: "", ok: false, reason: "missing_domain" };
  if (mxVerifyCache.has(domain)) return mxVerifyCache.get(domain);

  let result;
  try {
    result = await resolveMxWithTimeout(dns, domain, 3500);
  } catch (err) {
    const code = err?.code || err?.message || "mx_lookup_failed";
    if (code === "ENOTFOUND" || code === "ENODATA") {
      result = { domain, ok: false, reason: code };
    } else {
      try {
        const fallbackResolver = new dns.Resolver();
        fallbackResolver.setServers(["223.5.5.5", "1.1.1.1"]);
        result = await resolveMxWithTimeout(fallbackResolver, domain, 4500);
      } catch (err2) {
        result = { domain, ok: false, reason: err2?.code || err2?.message || code };
      }
    }
  }
  mxVerifyCache.set(domain, result);
  return result;
}

function extractB2bSignals({ text = "", links = [], emails = [] }) {
  const emailTiers = emails.map((email) => ({ email, tier: classifyInboxTier(email) }));
  const linkStr = Array.isArray(links) ? links.join(" ") : "";
  const hasPdfCatalog =
    /\.pdf(\?|#|$|\s)/i.test(`${text} ${linkStr}`) ||
    /(型錄|目錄下載|電子型錄|產品手冊|Catalog|Brochure|Download PDF)/i.test(text);
  const hasInquiryOrRfq = /(詢價|報價|線上詢盤|聯絡我們|RFQ|Inquiry|Enquiry|Request a Quote|Get a Quote)/i.test(text);
  const hasMultiLang =
    /(\/en\/|\/en$|\/tc\/|\/zh-hant\/|lang=en)/i.test(linkStr) ||
    /(繁體中文|English|日本語|繁中|簡中)/i.test(text);
  const hasTradeShowOrExport =
    /(參展|展覽|展覽會|Exhibitor|HKTDC|TIMTOS|Taipei Pack|Automechanika|Food Expo|Canton Fair|外銷|OEM|ODM|Export|Distributor|Overseas)/i.test(text);
  const hasHiringSignal = /(誠徵|人才招募|職缺|徵才|Join Us|Careers|We are hiring|Hiring)/i.test(text);

  const techRoleRe =
    /(full[- ]?stack|front[- ]?end|back[- ]?end|software\s*(?:engineer|developer)|web\s*developer|system\s*(?:analyst|developer|engineer)|application\s*developer|programmer|e-?commerce\s*(?:developer|specialist|manager)|it\s*(?:officer|specialist|manager|engineer)|erp|crm|ai\s*engineer|全端|前端|後端|軟體工程師|軟件工程師|系統工程師|系統分析師|程式設計師|網站開發|電商工程師|資訊工程師|資訊專員|ERP|自動化工程師)/i;
  const contractRe =
    /(contract|fixed[- ]?term|part[- ]?time|freelance|project[- ]?based|outsourc|合約|定期合約|兼職|約聘|專案外包|短期支援)/i;

  const isHiringTechRole = techRoleRe.test(text);
  const isContractOrFlexible = contractRe.test(text);
  const roleSnippets = Array.from(
    new Set(
      String(text || "")
        .split(/\r?\n/)
        .map((l) => l.replace(/\s+/g, " ").trim())
        .filter((l) => l.length >= 8 && l.length <= 160 && (techRoleRe.test(l) || contractRe.test(l))),
    ),
  ).slice(0, 6);

  const empMatch = String(text || "").match(
    /(?:員工人數|員工|Employees|Company\s*size)\s*[:：]?\s*([0-9][0-9,]{0,6})\s*(?:人|名|位|employees|\+)?/i,
  );
  const employeeCountHint = empMatch ? Number(empMatch[1].replace(/,/g, "")) : null;
  const overSizeWarning = Number.isFinite(employeeCountHint) && employeeCountHint > 150;

  return {
    emailTiers,
    hasPdfCatalog,
    hasInquiryOrRfq,
    hasMultiLang,
    hasTradeShowOrExport,
    hasHiringSignal,
    employeeCountHint,
    overSizeWarning,
    hiringSignals: {
      isHiringTechRole,
      isContractOrFlexible,
      roleSnippets,
    },
  };
}

function extractNavAndLinkedinLinks(links = []) {
  const cleanLinks = (Array.isArray(links) ? links : []).filter((l) => typeof l === "string");
  const personLinkedinUrls = Array.from(
    new Set(cleanLinks.filter((l) => /^https?:\/\/(?:[a-z0-9-]+\.)?linkedin\.com\/in\//i.test(l))),
  ).slice(0, 5);
  const companyLinkedinUrls = Array.from(
    new Set(cleanLinks.filter((l) => /^https?:\/\/(?:[a-z0-9-]+\.)?linkedin\.com\/company\//i.test(l))),
  ).slice(0, 4);
  const linkedinUrls = Array.from(new Set([...personLinkedinUrls, ...companyLinkedinUrls])).slice(0, 6);

  const internalContactLinks = Array.from(
    new Set(
      cleanLinks.filter(
        (l) =>
          /^https?:\/\//i.test(l) &&
          /(contact|about|profile|management|team|company|leadership|director|聯絡|聯繫|關於|公司簡介|團隊|我們)/i.test(l),
      ),
    ),
  ).slice(0, 6);

  const careerPages = Array.from(
    new Set(
      cleanLinks.filter(
        (l) =>
          /^https?:\/\//i.test(l) &&
          /(career|careers|job|jobs|join|recruit|talent|vacancy|vacancies|人才招募|職缺|徵才|誠徵|加入我們|招聘)/i.test(l),
      ),
    ),
  ).slice(0, 6);

  return {
    personLinkedinUrls,
    companyLinkedinUrls,
    linkedinUrls,
    internalContactLinks,
    careerPages,
  };
}

function extractEmails(text) {
  if (!text) return [];
  const matches = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,12}/g) || [];
  const cleaned = new Set();
  for (const m of matches) {
    const lower = m.toLowerCase().replace(/[.,;:)\]}>'"]+$/, "");
    if (/\.(png|jpg|jpeg|gif|svg|webp|css|js|woff|woff2|ttf)$/i.test(lower)) continue;
    if (lower.includes("sentry") || lower.includes("example.com") || lower.includes("wixpress.com") || lower.includes("myshopline")) continue;
    cleaned.add(lower);
  }
  return Array.from(cleaned);
}

function extractPhones(text) {
  if (!text) return [];
  const matches = text.match(/(?:\+?852|\+?886|\(0\d\)|0\d)[-\s.]?\d{3,4}[-\s.]?\d{3,4}/g) || [];
  return Array.from(new Set(matches.map((p) => p.trim()))).slice(0, 8);
}

function loadEvidence() {
  const store = { emails: {}, urls: {} };
  try {
    if (!fs.existsSync(EVIDENCE_FILE)) return store;
    const lines = fs.readFileSync(EVIDENCE_FILE, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (!entry?.url) continue;
        store.urls[entry.url] = entry;
        for (const e of entry.emails ?? []) {
          if (!store.emails[e]) store.emails[e] = [];
          if (!store.emails[e].includes(entry.url)) store.emails[e].push(entry.url);
        }
      } catch {
        // skip malformed line
      }
    }
  } catch {
    // ignore read errors
  }
  return store;
}

function recordEvidence(sourceUrl, emails, snippet = "") {
  try {
    const line = JSON.stringify({ ts: Date.now(), url: sourceUrl, emails, snippet: snippet.slice(0, 300) }) + "\n";
    fs.appendFileSync(EVIDENCE_FILE, line);
  } catch {
    // ignore append errors
  }
}

async function checkDomainsInCrm(domains) {
  if (!domains.length) return { matchedDomains: [], nextCodes: {} };
  try {
    const res = await fetch(`${AGENTSDR_URL}/api/leads/check`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AGENTSDR_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ domains }),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return { matchedDomains: [], nextCodes: {} };
    return await res.json();
  } catch {
    return { matchedDomains: [], nextCodes: {} };
  }
}

async function fetchExaWithRetry(endpoint, payload, timeoutMs = 15000) {
  let lastErr = "unknown";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      const waitMs = (1500 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 800);
      await new Promise((r) => setTimeout(r, waitMs));
    }
    try {
      const res = await fetch(`https://api.exa.ai/${endpoint}`, {
        method: "POST",
        headers: {
          "x-api-key": EXA_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = `Exa HTTP ${res.status}`;
        continue;
      }
      const data = await res.json();
      return { ok: res.ok, status: res.status, data };
    } catch (err) {
      lastErr = String(err?.message ?? err);
    }
  }
  throw new Error(lastErr);
}

function parseQueryForExa(rawQuery) {
  let query = String(rawQuery || "").trim();
  let category;
  const includeDomains = [];
  let needTw = false;
  let needHk = false;

  if (/\bsite:linkedin\.com\/in\S*/i.test(query)) {
    category = "linkedin profile";
    query = query.replace(/\bsite:linkedin\.com\/in\S*/gi, " ");
  }
  if (/\bsite:linkedin\.com\/jobs\S*/i.test(query)) {
    includeDomains.push("linkedin.com");
    query = query.replace(/\bsite:linkedin\.com\/jobs\S*/gi, " jobs ");
  }

  query = query.replace(/\bsite:([^\s)]+)/gi, (_, target) => {
    const clean = String(target || "").trim().toLowerCase().replace(/^["']|["')]+$/g, "").replace(/^www\./, "");
    if (/^\.(?:com\.tw|tw)$/i.test(clean)) {
      needTw = true;
      return " ";
    }
    if (/^\.(?:com\.hk|hk)$/i.test(clean)) {
      needHk = true;
      return " ";
    }
    if (!clean.startsWith(".") && clean.includes(".")) {
      const slashIdx = clean.indexOf("/");
      const domainPart = slashIdx >= 0 ? clean.slice(0, slashIdx) : clean;
      const pathPart = slashIdx >= 0 ? clean.slice(slashIdx + 1) : "";
      includeDomains.push(domainPart);
      if (pathPart) {
        return ` ${pathPart.replace(/[/_-]+/g, " ")} `;
      }
    }
    return " ";
  });

  // Strip Google-style negative exclusions and boolean operators for Exa auto search
  query = query
    .replace(/(?:^|\s)-"[^"]+"/g, " ")
    .replace(/(?:^|\s)-[a-z0-9_.-]+/gi, " ")
    .replace(/\bOR\b/g, " ")
    .replace(/[()"]/g, " ")
    .replace(/(?:^|\s)@(?=\s|$)/g, " email contact ");

  if (needTw && !/台灣|Taiwan/i.test(query)) query += " 台灣";
  if (needHk && !/Hong Kong|香港/i.test(query)) query += " Hong Kong";

  query = query.replace(/\s+/g, " ").trim();
  if (!query && includeDomains.length > 0) {
    query = "about contact company";
  }
  const dedupedDomains = Array.from(new Set(includeDomains));
  return {
    query,
    ...(category ? { category } : {}),
    ...(dedupedDomains.length ? { includeDomains: dedupedDomains } : {}),
  };
}

function formatSearchHit({ title, url, bodyText = "", descText = "" }) {
  const fullText = `${title ?? ""} ${bodyText} ${descText}`;
  const emails = extractEmails(fullText);
  const urlStr = String(url ?? "");
  if (urlStr && emails.length) recordEvidence(urlStr, emails, fullText);
  const linkedinMatch = /^https?:\/\/(?:[a-z0-9-]+\.)?linkedin\.com\/(?:in|company)\//i.test(urlStr)
    ? urlStr
    : fullText.match(/https?:\/\/(?:[a-z0-9-]+\.)?linkedin\.com\/(?:in|company)\/[^\s)>"']+/i)?.[0] || null;
  return {
    title: String(title ?? "").slice(0, 90),
    url: urlStr,
    domain: normalizeDomain(urlStr),
    desc: String(descText || bodyText || "").replace(/\s+/g, " ").trim().slice(0, 220),
    emails: emails.length ? emails : undefined,
    linkedinUrl: linkedinMatch || undefined,
  };
}

let firecrawlCreditsExhausted = false;

async function fetchFirecrawlWithRetry(endpoint, payload, timeoutMs = 15000) {
  if (firecrawlCreditsExhausted) {
    throw new Error("Firecrawl credits exhausted (skipped)");
  }
  let lastErr = "unknown";
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) {
      const waitMs = (2500 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 1200);
      await new Promise((r) => setTimeout(r, waitMs));
    }
    try {
      const res = await fetch(`https://api.firecrawl.dev/v1/${endpoint}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 402) {
        firecrawlCreditsExhausted = true;
        const body = await res.json().catch(() => ({}));
        throw new Error(String(body?.error || "Firecrawl HTTP 402 Insufficient credits"));
      }
      if (res.status === 429 || res.status >= 500) {
        lastErr = `Firecrawl HTTP ${res.status}`;
        continue;
      }
      const data = await res.json();
      if (data?.success === false && /insufficient\s*credits|0\s*left/i.test(String(data?.error ?? ""))) {
        firecrawlCreditsExhausted = true;
        throw new Error(String(data.error));
      }
      if (data?.success === false && /rate\s*limit|too\s*many/i.test(String(data?.error ?? ""))) {
        lastErr = String(data.error);
        continue;
      }
      return { ok: res.ok, status: res.status, data };
    } catch (err) {
      lastErr = String(err?.message ?? err);
      if (/insufficient\s*credits|0\s*left/i.test(lastErr)) {
        firecrawlCreditsExhausted = true;
        break;
      }
    }
  }
  throw new Error(lastErr);
}

async function searchOne(query) {
  let exaError = null;
  if (EXA_API_KEY) {
    try {
      const parsed = parseQueryForExa(query);
      const payload = {
        query: parsed.query,
        type: "auto",
        numResults: 8,
        ...(parsed.category ? { category: parsed.category } : {}),
        ...(parsed.includeDomains ? { includeDomains: parsed.includeDomains } : {}),
        ...(!parsed.category ? { contents: { highlights: { numSentences: 2, highlightsPerUrl: 1 } } } : {}),
      };
      const { ok, status, data } = await fetchExaWithRetry("search", payload, 15000);
      if (ok && Array.isArray(data?.results)) {
        const hits = data.results.map((r) => {
          const highlightsText = Array.isArray(r.highlights) ? r.highlights.join(" ") : "";
          return formatSearchHit({
            title: r.title,
            url: r.url,
            bodyText: `${highlightsText} ${r.text ?? ""}`,
            descText: highlightsText || r.text || "",
          });
        });
        return { query, provider: "exa", hits };
      }
      exaError = data?.error ? String(data.error) : `Exa HTTP ${status}`;
    } catch (err) {
      exaError = String(err?.message ?? err);
    }
  }

  if (FIRECRAWL_API_KEY && !firecrawlCreditsExhausted) {
    try {
      const { data } = await fetchFirecrawlWithRetry("search", { query, limit: 8 }, 15000);
      const hits = (data?.data ?? []).map((r) =>
        formatSearchHit({
          title: r.title,
          url: r.url,
          bodyText: r.description ?? "",
          descText: r.description ?? "",
        }),
      );
      return {
        query,
        provider: "firecrawl",
        hits,
        ...(data?.success === false ? { error: data?.error } : {}),
      };
    } catch (err) {
      const fcErr = String(err?.message ?? err);
      return { query, error: exaError ? `Exa: ${exaError}; Firecrawl: ${fcErr}` : fcErr, hits: [] };
    }
  }

  return { query, error: exaError || "No search provider configured", hits: [] };
}

function buildScrapeResult({ url, source, title = "", text = "", rawLinks = [], extraEmails = [] }) {
  const inlineUrls = text.match(/https?:\/\/[^\s)>"'\]]+/gi) || [];
  const allLinks = Array.from(new Set([...(Array.isArray(rawLinks) ? rawLinks : []), ...inlineUrls]));
  const mailtoEmails = allLinks
    .filter((l) => typeof l === "string" && /^mailto:/i.test(l))
    .flatMap((l) => extractEmails(decodeURIComponent(l.replace(/^mailto:/i, ""))));
  const textEmails = extractEmails(text);
  const allEmails = Array.from(new Set([...extraEmails, ...mailtoEmails, ...textEmails]));

  const {
    personLinkedinUrls,
    companyLinkedinUrls,
    linkedinUrls,
    internalContactLinks,
    careerPages,
  } = extractNavAndLinkedinLinks(allLinks);

  const keyRe = /(director|founder|ceo|owner|chairman|president|manager|partner|董事|負責人|總經理|創辦人|東主|社長|代表人|經理|聯絡|電話|電郵|信箱|email|e-mail|tel|@|工程師|開發|系統|recruit|hiring|contract)/i;
  const executiveHints = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length >= 4 && l.length <= 180 && keyRe.test(l))
    .slice(0, 22);

  recordEvidence(url, allEmails, executiveHints.join(" | "));
  const b2bSignals = extractB2bSignals({ text, links: allLinks, emails: allEmails });

  return {
    url,
    source,
    ok: Boolean(allEmails.length || String(text).trim().length > 0),
    title: String(title || "").replace(/\s+/g, " ").trim(),
    emails: allEmails,
    phones: extractPhones(text),
    b2bSignals,
    linkedinUrls: linkedinUrls.length ? linkedinUrls : undefined,
    personLinkedinUrls: personLinkedinUrls.length ? personLinkedinUrls : undefined,
    companyLinkedinUrls: companyLinkedinUrls.length ? companyLinkedinUrls : undefined,
    contactPages: internalContactLinks.length ? internalContactLinks : undefined,
    careerPages: careerPages.length ? careerPages : undefined,
    executiveHints: executiveHints.slice(0, 14),
    excerpt: String(text || "").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim().slice(0, 900),
  };
}

async function scrapeViaDirectHttp(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-TW,zh-HK,zh;q=0.9,en;q=0.8",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(10000),
  });
  const html = await res.text();
  const mailtoEmails = Array.from(html.matchAll(/href=["']mailto:([^"'>?]+)/gi))
    .map((m) => decodeURIComponent(m[1]))
    .flatMap((m) => extractEmails(m));
  const rawHtmlEmails = extractEmails(html);
  const hrefLinks = Array.from(html.matchAll(/href=["']([^"']+)["']/gi)).map((m) => {
    try {
      return new URL(m[1], url).toString();
    } catch {
      return m[1];
    }
  });
  const strippedText = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "\n")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "\n")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const cleanLength = strippedText.replace(/\s+/g, " ").trim().length;
  const isInterstitial =
    /Just a moment\.\.\.|Enable JavaScript and cookies to continue|Checking your browser|Attention Required/i.test(strippedText) &&
    mailtoEmails.length === 0 &&
    rawHtmlEmails.length === 0;
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";

  const result = buildScrapeResult({
    url,
    source: "direct_http",
    title,
    text: strippedText,
    rawLinks: hrefLinks,
    extraEmails: [...mailtoEmails, ...rawHtmlEmails],
  });
  const sufficient = res.ok && !isInterstitial && (result.emails.length > 0 || cleanLength >= 280);
  return {
    sufficient,
    status: res.status,
    result,
    partial: { hrefLinks, extraEmails: result.emails, title },
  };
}

async function scrapeViaExaContents(url, partial = {}) {
  const { ok, status, data } = await fetchExaWithRetry(
    "contents",
    { urls: [url], text: { maxCharacters: 4500 } },
    15000,
  );
  if (!ok || !Array.isArray(data?.results) || !data.results[0]?.text) {
    throw new Error(data?.error ? String(data.error) : `Exa contents HTTP ${status} returned empty text`);
  }
  const r0 = data.results[0];
  return buildScrapeResult({
    url,
    source: "exa_contents",
    title: r0.title || partial.title || "",
    text: r0.text,
    rawLinks: partial.hrefLinks || [],
    extraEmails: partial.extraEmails || [],
  });
}

async function scrapeViaFirecrawl(url, partial = {}) {
  const { data } = await fetchFirecrawlWithRetry(
    "scrape",
    {
      url,
      formats: ["markdown", "links"],
      onlyMainContent: false,
      timeout: 10000,
    },
    16000,
  );
  if (!data?.success || !data?.data) {
    throw new Error(data?.error || "Firecrawl returned unsuccessful scrape");
  }
  const md = data?.data?.markdown ?? "";
  const links = Array.isArray(data?.data?.links) ? data.data.links : [];
  return buildScrapeResult({
    url,
    source: "firecrawl",
    title: data?.data?.metadata?.title || partial.title || "",
    text: md,
    rawLinks: [...(partial.hrefLinks || []), ...links],
    extraEmails: partial.extraEmails || [],
  });
}

async function scrapeOne(url) {
  const claim = tryAcquireClaim(url);
  if (!claim.allowed) {
    return {
      url,
      ok: false,
      skippedClaimedByShard: claim.owner,
      error: `Skipped: already claimed in-flight by parallel shard "${claim.owner}"`,
    };
  }

  const errors = [];
  let partial = {};
  let directResult = null;

  // Step A: Local Direct HTTP first (zero API credits)
  try {
    const direct = await scrapeViaDirectHttp(url);
    partial = direct.partial;
    directResult = direct.result;
    if (direct.sufficient) {
      return direct.result;
    }
    errors.push(`DirectFetch HTTP ${direct.status} insufficient`);
  } catch (err) {
    errors.push(`DirectFetch: ${err?.message || err}`);
  }

  // Step B: Exa contents fallback for JS-rendered SPAs / thin shells / 403s
  if (EXA_API_KEY) {
    try {
      return await scrapeViaExaContents(url, partial);
    } catch (err) {
      errors.push(`ExaContents: ${err?.message || err}`);
    }
  }

  // Step C: Firecrawl fallback
  if (FIRECRAWL_API_KEY && !firecrawlCreditsExhausted) {
    try {
      return await scrapeViaFirecrawl(url, partial);
    } catch (err) {
      errors.push(`Firecrawl: ${err?.message || err}`);
    }
  }

  if (directResult?.ok) {
    return { ...directResult, fallbackWarnings: errors };
  }
  return { url, ok: false, error: errors.join("; ") };
}

const [, , cmd, ...args] = process.argv;

if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
  printHelp();
  process.exit(cmd ? 0 : 1);
}

const effects = deliveryEffects(DELIVERY_MODE);
if (!effects.ok) {
  console.error(effects.error);
  process.exit(1);
}


if (cmd === "search") {
  if (!EXA_API_KEY && !FIRECRAWL_API_KEY) {
    console.error("Missing EXA_API_KEY or FIRECRAWL_API_KEY");
    process.exit(1);
  }
  const groups = await Promise.all(args.map(searchOne));
  const candidateDomains = [];
  for (const g of groups) {
    for (const h of g.hits) {
      if (h.domain && !DIRECTORY_OR_MEDIA_DOMAINS.has(h.domain)) {
        candidateDomains.push(h.domain);
      }
    }
  }
  const crmCheck = await checkDomainsInCrm(candidateDomains);
  const matchedSet = new Set(crmCheck.matchedDomains ?? []);

  for (const g of groups) {
    const freshHits = [];
    const skipped = [];
    for (const h of g.hits) {
      if (!h.domain) continue;
      const lockKey = lockKeyForUrlOrDomain(h.url || h.domain);
      const claimOwner = lockKey ? readClaimOwner(lockKey) : null;
      if (claimOwner && claimOwner !== SHARD_ID) {
        skipped.push(`${h.domain} (claimed:${claimOwner})`);
        continue;
      }
      if (DIRECTORY_OR_MEDIA_DOMAINS.has(h.domain)) {
        h.type = "directory_or_platform";
        freshHits.push(h);
      } else if (matchedSet.has(h.domain)) {
        skipped.push(`${h.domain} (alreadyInCrm)`);
      } else {
        h.alreadyInCrm = false;
        freshHits.push(h);
      }
    }
    g.hits = freshHits;
    if (skipped.length > 0) g.skipped = skipped;
  }
  console.log(JSON.stringify({ nextCodes: crmCheck.nextCodes, searches: groups }, null, 2));
} else if (cmd === "scrape") {
  const out = await Promise.all(args.map(scrapeOne));
  console.log(JSON.stringify(out, null, 2));
} else if (cmd === "check") {
  requireCrmEnv();
  const normalized = args.map(normalizeDomain).filter(Boolean);
  const [out, mxChecks] = await Promise.all([
    checkDomainsInCrm(normalized),
    Promise.all(args.map((raw) => verifyEmailDomainMx(raw))),
  ]);
  const claimedByOtherShards = [];
  for (const raw of args) {
    const lockKey = lockKeyForUrlOrDomain(raw);
    const owner = lockKey ? readClaimOwner(lockKey) : null;
    if (owner && owner !== SHARD_ID) {
      claimedByOtherShards.push({ ref: raw, domain: normalizeDomain(raw), owner });
    }
  }
  console.log(JSON.stringify({ ...out, claimedByOtherShards, mxChecks }, null, 2));
} else if (cmd === "submit") {
  requireCrmEnv();
  if (!effects.isDraftOnly && effects.sendsImmediately) {
    console.warn(`[safety] OUTREACH_DELIVERY_MODE=${DELIVERY_MODE} will send — requires approval.`);
  }
  const allowLegacyIsp = args.includes("--allow-legacy-isp");
  const cleanArgs = args.filter((a) => a !== "--allow-legacy-isp");
  const arg = cleanArgs[0];
  if (!arg) {
    console.error("Usage: prospect-tool.mjs submit [--allow-legacy-isp] <path-to-json | inline-json>");
    process.exit(1);
  }
  const rawJson = fs.existsSync(arg) ? fs.readFileSync(arg, "utf8") : arg;
  const parsed = JSON.parse(rawJson);
  const leads = Array.isArray(parsed) ? parsed : parsed.leads;
  if (!Array.isArray(leads) || leads.length === 0) {
    console.error("Expected non-empty array of leads");
    process.exit(1);
  }

  // Zero-hallucination email provenance + strict MX/ISP hygiene checks
  // (also auto-scrapes URLs cited in verificationNote on cache miss!)
  let evidence = loadEvidence();
  const validLeads = [];
  const provenanceRejected = [];
  const localClaimSkipped = [];

  for (const lead of leads) {
    const email = (lead.email ?? "").trim().toLowerCase();
    if (!email) {
      provenanceRejected.push({ companyName: lead.companyName, email, error: "Empty email" });
      continue;
    }
    if (/\.(con\.(cn|hk|tw)|cmo|ocm|comm|gamil\.com|gmial\.com|hotmial\.com)$/i.test(email)) {
      provenanceRejected.push({
        ok: false,
        status: "rejected_typo_domain",
        companyName: lead.companyName,
        email,
        error: `Suspected webpage typo in email domain: "${email}"`,
      });
      continue;
    }
    const emailDomain = email.split("@")[1] ?? "";
    if (!allowLegacyIsp && LEGACY_HIGH_BOUNCE_ISP_DOMAINS.has(emailDomain)) {
      provenanceRejected.push({
        ok: false,
        status: "rejected_high_bounce_isp",
        companyName: lead.companyName,
        email,
        error: `High-bounce legacy ISP domain blocked ("${emailDomain}" had ~50% bounce rate). Find corporate domain email or pick another prospect.`,
      });
      continue;
    }
    const mxVerdict = await verifyEmailDomainMx(email);
    if (!mxVerdict.ok) {
      provenanceRejected.push({
        ok: false,
        status: "rejected_no_mx",
        companyName: lead.companyName,
        email,
        error: `Recipient domain "${mxVerdict.domain}" has no valid MX record (${mxVerdict.reason})`,
      });
      continue;
    }
    if (lead.companyCode && !/^(auto|(HK|TW|CN|MO|SG|MY|JP|US|EU|GLOBAL)\d+)$/i.test(String(lead.companyCode).trim())) {
      lead.companyCode = "auto";
    }
    const domainClaim = tryAcquireClaim(lead.companyDomain || email);
    if (!domainClaim.allowed) {
      localClaimSkipped.push({
        ok: false,
        status: "skipped_duplicate",
        companyName: lead.companyName,
        companyDomain: lead.companyDomain,
        email,
        error: `Domain already claimed in-flight by parallel shard "${domainClaim.owner}"`,
      });
      continue;
    }
    if (!evidence.emails[email]) {
      const citedUrls = ((lead.verificationNote ?? "").match(/https?:\/\/[^\s)>"'，。；、]+/g) || []).slice(0, 3);
      const urlsToTry = [...citedUrls];
      if (lead.companyDomain) {
        urlsToTry.push(`https://${lead.companyDomain}`);
        urlsToTry.push(`https://${lead.companyDomain}/contact`);
        urlsToTry.push(`https://${lead.companyDomain}/contact-us`);
        urlsToTry.push(`https://${lead.companyDomain}/contact.html`);
        urlsToTry.push(`http://${lead.companyDomain}`);
      }
      for (const u of urlsToTry) {
        if (evidence.emails[email]) break;
        try {
          await scrapeOne(u);
          evidence = loadEvidence();
        } catch {
          // ignore
        }
      }
    }
    if (!evidence.emails[email]) {
      const citedUrls = ((lead.verificationNote ?? "").match(/https?:\/\/[^\s)>"'，。；、]+/g) || []).slice(0, 3);
      const foundOnCited = citedUrls.flatMap((u) => evidence.urls[u]?.emails ?? []);
      provenanceRejected.push({
        ok: false,
        status: "rejected_unverified_email",
        companyName: lead.companyName,
        email,
        error: `Email "${email}" was NOT found verbatim on any scraped page! Never guess emails. Emails actually found on cited URLs: [${foundOnCited.join(", ") || "none"}]`,
      });
      continue;
    }
    validLeads.push(lead);
  }

  let apiSummary = { total: 0, sent: 0, queued: 0, awaitingReview: 0, skippedDuplicate: 0, rejected: 0, failed: 0, results: [] };
  if (validLeads.length > 0) {
    const res = await fetch(`${AGENTSDR_URL}/api/crm/outreach/batch`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AGENTSDR_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        leads: validLeads,
        delivery: DELIVERY_MODE,
        paceMs: PACE_MS,
      }),
      signal: AbortSignal.timeout(600_000),
    });
    apiSummary = await res.json();
    if (!res.ok) {
      console.error("Batch API error:", JSON.stringify(apiSummary));
      process.exit(1);
    }
  }

  const combined = {
    deliveryMode: DELIVERY_MODE,
    sent: apiSummary.sent ?? 0,
    queued: apiSummary.queued ?? 0,
    awaitingReview: apiSummary.awaitingReview ?? 0,
    skippedDuplicate: (apiSummary.skippedDuplicate ?? 0) + localClaimSkipped.length,
    rejected: (apiSummary.rejected ?? 0) + provenanceRejected.length,
    failed: apiSummary.failed ?? 0,
    results: [...localClaimSkipped, ...provenanceRejected, ...(apiSummary.results ?? [])],
  };
  console.log(JSON.stringify(combined, null, 2));
} else {
  console.error("Unknown command. Run: node prospect-tool.mjs --help");
  process.exit(1);
}
