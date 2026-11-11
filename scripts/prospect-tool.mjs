#!/usr/bin/env node
/**
 * High-speed, low-token Firecrawl + AgentSDR Prospecting CLI for AGY workers.
 *
 * Commands:
 *   node prospect-tool.mjs search "query 1" "query 2" ...
 *   node prospect-tool.mjs scrape "https://..." "https://..." ...
 *   node prospect-tool.mjs check "domain1.com" "domain2.com.hk" ...
 *   node prospect-tool.mjs submit /path/to/leads.json
 */
import fs from "node:fs";

const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY || (() => {
  try {
    const envText = fs.readFileSync("/Users/ivan/projects/lumina-labs-agent/.env.local", "utf8");
    const m = envText.match(/^FIRECRAWL_API_KEY=(.+)$/m);
    return m ? m[1].trim().replace(/^['"]|['"]$/g, "") : "";
  } catch {
    return "";
  }
})();

const AGENTSDR_URL = process.env.AGENTSDR_URL || "http://127.0.0.1:13031";
const AGENTSDR_API_KEY = process.env.AGENTSDR_API_KEY || "agentsdr_test_api_key_for_automation_2026";
const EVIDENCE_FILE = process.env.PROSPECT_EVIDENCE_FILE || "/tmp/agy-prospect-evidence.ndjson";
const DELIVERY_MODE = process.env.OUTREACH_DELIVERY_MODE || "send_paced";
const PACE_MS = Number(process.env.OUTREACH_PACE_MS ?? 8000);

const DIRECTORY_OR_MEDIA_DOMAINS = new Set([
  "hkmma.org.hk", "fhki.org.hk", "hktdc.com", "cma.org.hk", "hkpc.org", "hkstp.org", "cyberport.hk",
  "taiwantrade.com", "tami.org.tw", "tmdia.org.tw", "twtc.com.tw", "cens.com", "asiannet.com",
  "linkedin.com", "facebook.com", "instagram.com", "youtube.com", "wikipedia.org", "zhihu.com",
  "104.com.tw", "1111.com.tw", "jobsdb.com", "ctgoodjobs.hk", "gov.hk", "gov.tw", "findcompany.com.tw",
  "twincn.com", "opendata.vip", "companydata.hk", "Webb-site.com", "webb-site.com",
]);

function normalizeDomain(raw) {
  if (!raw || typeof raw !== "string") return null;
  let v = raw.trim().toLowerCase();
  if (v.includes("@") && !v.includes("/")) v = v.split("@").pop() || "";
  v = v.replace(/^[a-z]+:\/\//i, "").split("/")[0].split("?")[0].split("#")[0].split(":")[0];
  v = v.replace(/^www\./i, "").replace(/\.+$/, "");
  return v && v.includes(".") ? v : null;
}

function extractEmails(text) {
  if (!text) return [];
  const matches = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,12}/g) || [];
  const cleaned = new Set();
  for (const m of matches) {
    const lower = m.toLowerCase().replace(/[.,;:)\]}>'"]+$/, "");
    if (/\.(png|jpg|jpeg|gif|svg|webp|css|js|woff|woff2|ttf)$/i.test(lower)) continue;
    if (lower.includes("sentry.io") || lower.includes("example.com") || lower.includes("wixpress.com")) continue;
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

async function searchOne(query) {
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, limit: 6 }),
      signal: AbortSignal.timeout(14000),
    });
    const data = await res.json();
    const hits = (data.data ?? []).map((r) => {
      const text = `${r.title ?? ""} ${r.description ?? ""}`;
      const emails = extractEmails(text);
      if (r.url && emails.length) recordEvidence(r.url, emails, text);
      return {
        title: (r.title ?? "").slice(0, 90),
        url: r.url ?? "",
        domain: normalizeDomain(r.url),
        desc: (r.description ?? "").slice(0, 140),
        emails: emails.length ? emails : undefined,
      };
    });
    return { query, hits };
  } catch (err) {
    return { query, error: String(err?.message ?? err), hits: [] };
  }
}

async function scrapeOne(url) {
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        formats: ["markdown", "links"],
        onlyMainContent: false,
        timeout: 10000,
      }),
      signal: AbortSignal.timeout(14000),
    });
    const data = await res.json();
    const md = data?.data?.markdown ?? "";
    const links = Array.isArray(data?.data?.links) ? data.data.links : [];
    const mailtoEmails = links
      .filter((l) => typeof l === "string" && /^mailto:/i.test(l))
      .flatMap((l) => extractEmails(decodeURIComponent(l.replace(/^mailto:/i, ""))));
    const textEmails = extractEmails(md);
    const allEmails = Array.from(new Set([...mailtoEmails, ...textEmails]));

    const linkedinUrls = Array.from(
      new Set(
        links.filter((l) => typeof l === "string" && /^https?:\/\/([a-z]+\.)?linkedin\.com\/(in|company)\//i.test(l)),
      ),
    ).slice(0, 6);

    const internalContactLinks = Array.from(
      new Set(
        links.filter(
          (l) =>
            typeof l === "string" &&
            /^https?:\/\//i.test(l) &&
            /(contact|about|profile|management|team|company|leadership|director|聯絡|聯繫|關於|公司簡介|團隊|我們)/i.test(l),
        ),
      ),
    ).slice(0, 6);

    const keyRe = /(director|founder|ceo|owner|chairman|president|manager|partner|董事|負責人|總經理|創辦人|東主|社長|代表人|經理|聯絡|電話|電郵|信箱|email|e-mail|tel|@)/i;
    const executiveHints = md
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length >= 4 && l.length <= 180 && keyRe.test(l))
      .slice(0, 22);

    recordEvidence(url, allEmails, executiveHints.join(" | "));

    return {
      url,
      ok: Boolean(data?.success && (md || allEmails.length)),
      title: data?.data?.metadata?.title ?? "",
      emails: allEmails,
      phones: extractPhones(md),
      linkedinUrls: linkedinUrls.length ? linkedinUrls : undefined,
      contactPages: internalContactLinks.length ? internalContactLinks : undefined,
      executiveHints: executiveHints.slice(0, 14),
      excerpt: md.replace(/\n{3,}/g, "\n\n").slice(0, 900),
    };
  } catch (err) {
    return { url, ok: false, error: String(err?.message ?? err) };
  }
}

const [, , cmd, ...args] = process.argv;

if (cmd === "search") {
  if (!FIRECRAWL_API_KEY) {
    console.error("Missing FIRECRAWL_API_KEY");
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
    for (const h of g.hits) {
      if (!h.domain) continue;
      if (DIRECTORY_OR_MEDIA_DOMAINS.has(h.domain)) {
        h.type = "directory_or_platform";
      } else {
        h.alreadyInCrm = matchedSet.has(h.domain);
      }
    }
  }
  console.log(JSON.stringify({ nextCodes: crmCheck.nextCodes, searches: groups }, null, 2));
} else if (cmd === "scrape") {
  if (!FIRECRAWL_API_KEY) {
    console.error("Missing FIRECRAWL_API_KEY");
    process.exit(1);
  }
  const out = await Promise.all(args.map(scrapeOne));
  console.log(JSON.stringify(out, null, 2));
} else if (cmd === "check") {
  const out = await checkDomainsInCrm(args);
  console.log(JSON.stringify(out, null, 2));
} else if (cmd === "submit") {
  const arg = args[0];
  if (!arg) {
    console.error("Usage: prospect-tool.mjs submit <path-to-json | inline-json>");
    process.exit(1);
  }
  const rawJson = fs.existsSync(arg) ? fs.readFileSync(arg, "utf8") : arg;
  const parsed = JSON.parse(rawJson);
  const leads = Array.isArray(parsed) ? parsed : parsed.leads;
  if (!Array.isArray(leads) || leads.length === 0) {
    console.error("Expected non-empty array of leads");
    process.exit(1);
  }

  // Zero-hallucination email provenance check: every submitted email MUST appear in scraped evidence
  // (or on the URLs cited in verificationNote, which we auto-scrape on cache miss!)
  let evidence = loadEvidence();
  const validLeads = [];
  const provenanceRejected = [];

  for (const lead of leads) {
    const email = (lead.email ?? "").trim().toLowerCase();
    if (!email) {
      provenanceRejected.push({ companyName: lead.companyName, email, error: "Empty email" });
      continue;
    }
    if (!evidence.emails[email]) {
      const citedUrls = ((lead.verificationNote ?? "").match(/https?:\/\/[^\s)>"'，。；、]+/g) || []).slice(0, 3);
      if (citedUrls.length > 0 && FIRECRAWL_API_KEY) {
        await Promise.all(citedUrls.map(scrapeOne));
        evidence = loadEvidence();
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
    skippedDuplicate: apiSummary.skippedDuplicate ?? 0,
    rejected: (apiSummary.rejected ?? 0) + provenanceRejected.length,
    failed: apiSummary.failed ?? 0,
    results: [...provenanceRejected, ...(apiSummary.results ?? [])],
  };
  console.log(JSON.stringify(combined, null, 2));
} else {
  console.error("Usage: prospect-tool.mjs <search|scrape|check|submit> <args...>");
  process.exit(1);
}
