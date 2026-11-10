import { normalizeEmail } from "@/lib/leads/identity";
import type { AiInstructionBlock } from "./ai/instructions";

export type OutboundBrandMarket = "hk" | "tw" | "cn" | "intl";

export type BrandRoutingSignals = {
  companyCode?: string | null;
  company?: {
    name?: string | null;
    domain?: string | null;
    custom?: Record<string, unknown> | null;
    raw?: Record<string, unknown> | null;
  } | null;
  person?: {
    fullName?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    email?: string | null;
    title?: string | null;
    custom?: Record<string, unknown> | null;
    raw?: Record<string, unknown> | null;
  } | null;
};

export type ConnectedMailboxCandidate = {
  emailAddress: string;
  displayName?: string | null;
};

export type ParsedInstructionRouting = {
  hkEmail: string | null;
  twEmail: string | null;
  cnEmail: string | null;
  intlEmail: string | null;
};

export type ResolvedOutboundEmailRouting = {
  market: OutboundBrandMarket;
  brand: "Linktion" | "英选" | null;
  language: "en" | "zh-Hant" | "zh-Hans" | null;
  fromEmail: string;
};

const EMAIL_IN_TEXT = /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

const TRADITIONAL_DISTINCTIVE_HAN =
  /[臺灣實業發開際電機製專體網訊資處會長門車馬魚鳥龍龜東義禮樂醫藥餐飲裝修運輸聯統銷購顧問數據優質創藝傳媒廣場樓區縣鎮鄉裡對與為無從來後個們這說請讓還進過達遠選邊關間閱]/u;

const ANY_HAN = /[\u4e00-\u9fff]/u;

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function extractCompanyCodeFromNotes(notes: unknown): string | null {
  const text = cleanString(notes);
  if (!text) return null;
  const match = text.match(/(?:^|[;\s,])(?:companyCode|x_code|company_code)\s*=\s*([A-Za-z0-9_-]+)/i);
  return match?.[1]?.trim() || null;
}

export function resolveRoutingCompanyCode(signals: BrandRoutingSignals): string | null {
  const companyCustom = (signals.company?.custom ?? {}) as Record<string, unknown>;
  const companyRaw = (signals.company?.raw ?? {}) as Record<string, unknown>;
  const personCustom = (signals.person?.custom ?? {}) as Record<string, unknown>;
  const personRaw = (signals.person?.raw ?? {}) as Record<string, unknown>;

  for (const candidate of [
    signals.companyCode,
    companyCustom.x_code,
    companyCustom.company_code,
    companyRaw.x_code,
    companyRaw.company_code,
    personCustom.x_company_code,
    personCustom.company_code,
    personRaw.x_company_code,
    personRaw.company_code,
    extractCompanyCodeFromNotes(personRaw.notes),
  ]) {
    const cleaned = cleanString(candidate);
    if (cleaned) return cleaned;
  }
  return null;
}

function classifyByCompanyCode(code: string | null): OutboundBrandMarket | null {
  if (!code) return null;
  const upper = code.trim().toUpperCase();
  if (/^HK(?:\d|[-_\s]|$)/.test(upper)) return "hk";
  if (/^TW(?:\d|[-_\s]|$)/.test(upper)) return "tw";
  if (/^(?:CN|ML|SH|SZ|BJ|GZ)(?:\d|[-_\s]|$)/.test(upper)) return "cn";
  if (/^(?:SG|US|UK|GB|AU|NZ|CA|EU|DE|FR|NL|JP|KR|MY|IN|AE|INTL|GLOBAL)(?:\d|[-_\s]|$)/.test(upper)) {
    return "intl";
  }
  return null;
}

function classifyLocationValue(rawValue: unknown, isCountryField = false): OutboundBrandMarket | null {
  const text = cleanString(rawValue);
  if (!text) return null;

  if (
    /台湾|臺灣|台北|臺北|新北|桃园|桃園|台中|臺中|台南|臺南|高雄|新竹|基隆|嘉义|嘉義|彰化|\btaiwan\b|\btaipei\b|\btaoyuan\b|\btaichung\b|\btainan\b|\bkaohsiung\b|\bhsinchu\b/i.test(
      text,
    ) ||
    (isCountryField && /^TW$/i.test(text))
  ) {
    return "tw";
  }

  const mentionsMainland =
    /内地|內地|中国大陆|中國大陸|\bmainland\s*china\b/i.test(text) ||
    (isCountryField && /^(?:CN|CHN|PRC|China|中国|中國)$/i.test(text));
  if (mentionsMainland) {
    return "cn";
  }

  if (
    /香港|九龙|九龍|新界|\bhong\s*kong\b|\bhksar\b|\bkowloon\b/i.test(text) ||
    (isCountryField && /^HK$/i.test(text))
  ) {
    return "hk";
  }

  if (
    /\bchina\b|\bprc\b|中国|中國|上海|深圳|北京|广州|廣州|杭州|苏州|蘇州|\bshanghai\b|\bshenzhen\b|\bbeijing\b|\bguangzhou\b|\bhangzhou\b|\bsuzhou\b/i.test(
      text,
    )
  ) {
    return "cn";
  }

  if (isCountryField && /[A-Za-z]/.test(text)) {
    return "intl";
  }

  return null;
}

function classifyByCompanyEntityName(name: string | null | undefined): OutboundBrandMarket | null {
  const text = cleanString(name);
  if (!text) return null;

  if (/台灣|臺灣|\(\s*Taiwan\s*\)|（\s*台湾\s*）|（\s*臺灣\s*）|\bTaiwan\b/i.test(text)) {
    return "tw";
  }
  if (
    /\(\s*(?:China|PRC|Shenzhen|Shanghai|Beijing|Guangzhou)\s*\)|（\s*(?:中国|內地|内地|深圳|上海|北京|广州)\s*）/i.test(
      text,
    )
  ) {
    return "cn";
  }
  if (/\(\s*H\.?\s*K\.?\s*\)|（\s*香港\s*）|\bHong\s*Kong\b|香港/i.test(text)) {
    return "hk";
  }
  return null;
}

function normalizedDomain(domain: string | null | undefined, email: string | null | undefined): string | null {
  const direct = cleanString(domain)?.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "") ?? null;
  if (direct) return direct;
  const normalizedAddr = normalizeEmail(email ?? null);
  if (!normalizedAddr) return null;
  return normalizedAddr.split("@")[1]?.toLowerCase() ?? null;
}

/**
 * Classify a lead's target market according to the product's real business rules
 * (`comm_brand_routing` + lead/company metadata), without treating `.hk` domains
 * as a blanket Hong Kong rule (regional exceptions such as TW/Mainland companies
 * operating on `.hk` domains are respected via code, region/country, and language context).
 */
export function classifyOutboundMarket(signals: BrandRoutingSignals): OutboundBrandMarket {
  // 1. Explicit company code (e.g. HK46 -> hk, TW30 -> tw, CN01 -> cn).
  // Non-geographic codes like CLIENT01 fall through to explicit region/country metadata.
  const codeMarket = classifyByCompanyCode(resolveRoutingCompanyCode(signals));
  if (codeMarket) return codeMarket;

  // 2. Explicit structured country / region / location metadata on company or person.
  const companyCustom = (signals.company?.custom ?? {}) as Record<string, unknown>;
  const companyRaw = (signals.company?.raw ?? {}) as Record<string, unknown>;
  const personCustom = (signals.person?.custom ?? {}) as Record<string, unknown>;
  const personRaw = (signals.person?.raw ?? {}) as Record<string, unknown>;

  const locationCandidates: ReadonlyArray<{ value: unknown; isCountry?: boolean }> = [
    { value: companyCustom.country, isCountry: true },
    { value: companyRaw.country, isCountry: true },
    { value: companyCustom.x_region },
    { value: companyCustom.region },
    { value: companyRaw.x_region },
    { value: companyRaw.region },
    { value: personCustom.country, isCountry: true },
    { value: personRaw.country, isCountry: true },
    { value: personCustom.x_region },
    { value: personCustom.x_location },
    { value: personRaw.x_location },
    { value: personRaw.location },
    { value: companyRaw.city },
    { value: personRaw.city },
  ];

  for (const candidate of locationCandidates) {
    const market = classifyLocationValue(candidate.value, Boolean(candidate.isCountry));
    if (market) return market;
  }

  // 3. Explicit geographic markers in the company's legal/display name (e.g. "(H.K.)", "Hong Kong", "台灣").
  const entityMarket = classifyByCompanyEntityName(signals.company?.name);
  if (entityMarket) return entityMarket;

  // 4. Language/script context (Traditional Chinese -> tw, Simplified Chinese -> cn, English/international -> intl).
  // Note: `.hk` is intentionally NOT used as a blanket override here so TW/CN entities with `.hk` domains stay in their market.
  const domain = normalizedDomain(signals.company?.domain, signals.person?.email);
  const combinedNames = [signals.company?.name, signals.person?.fullName]
    .map((v) => cleanString(v))
    .filter((v): v is string => Boolean(v))
    .join(" ");

  if (ANY_HAN.test(combinedNames)) {
    if (TRADITIONAL_DISTINCTIVE_HAN.test(combinedNames) || (domain && (domain.endsWith(".tw") || domain.includes(".com.tw")))) {
      return "tw";
    }
    return "cn";
  }

  if (domain && (domain.endsWith(".tw") || domain.includes(".com.tw"))) {
    return "tw";
  }

  return "intl";
}

/**
 * Extract brand-to-sender email mappings from `crm_settings.draft_instructions`
 * (specifically `comm_brand_routing` and any operator routing blocks).
 */
export function parseBrandRoutingInstructions(
  blocks: readonly AiInstructionBlock[] | null | undefined,
): ParsedInstructionRouting {
  const result: ParsedInstructionRouting = {
    hkEmail: null,
    twEmail: null,
    cnEmail: null,
    intlEmail: null,
  };
  if (!Array.isArray(blocks) || blocks.length === 0) return result;

  // Prioritize explicit `comm_brand_routing` block first, then remaining blocks.
  const ordered = [
    ...blocks.filter((b) => b?.id === "comm_brand_routing"),
    ...blocks.filter((b) => b?.id !== "comm_brand_routing"),
  ];

  for (const block of ordered) {
    if (!block || typeof block.content !== "string") continue;
    for (const rawLine of block.content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const matches = [...line.matchAll(EMAIL_IN_TEXT)]
        .map((m) => normalizeEmail(m[1] ?? null))
        .filter((email): email is string => Boolean(email));
      if (matches.length === 0) continue;
      const email = matches[0]!;

      const mentionsHkOrLinktion = /\bHK\*?|\bHong\s*Kong\b|香港|英文语境|品牌\s*Linktion|\bLinktion\b/i.test(line);
      const mentionsTw = /\bTW\*?|\bTaiwan\b|台湾|臺灣|繁中|繁体|繁體/i.test(line);
      const mentionsCn = /内地|內地|中国大陆|中國大陸|\bMainland\s*China\b/i.test(line);
      const mentionsYingxuan = /英选|英選|\bYingxuan\b/i.test(line);

      if (mentionsHkOrLinktion && !mentionsTw) {
        result.hkEmail ??= email;
        result.intlEmail ??= email;
      }
      if ((mentionsTw || mentionsYingxuan) && !mentionsHkOrLinktion) {
        result.twEmail ??= email;
        result.cnEmail ??= email;
      }
      if (mentionsCn && !mentionsHkOrLinktion) {
        result.cnEmail ??= email;
      }
    }
  }

  return result;
}

function matchConnectedMailbox(
  connectedMailboxes: readonly ConnectedMailboxCandidate[],
  targetEmail: string | null,
): string | null {
  const normalizedTarget = normalizeEmail(targetEmail);
  if (!normalizedTarget) return null;
  if (connectedMailboxes.length === 0) return normalizedTarget;
  const found = connectedMailboxes.find(
    (m) => normalizeEmail(m.emailAddress) === normalizedTarget,
  );
  return found ? found.emailAddress.trim() : null;
}

function findMailboxByPattern(
  connectedMailboxes: readonly ConnectedMailboxCandidate[],
  pattern: RegExp,
): string | null {
  const found = connectedMailboxes.find(
    (m) => pattern.test(m.emailAddress) || (m.displayName ? pattern.test(m.displayName) : false),
  );
  return found ? found.emailAddress.trim() : null;
}

/**
 * Resolve the outbound sender mailbox and brand context for a first-touch draft
 * when the caller did not explicitly pass `fromEmail`.
 */
export function resolveOutboundEmailRouting(
  signals: BrandRoutingSignals & {
    draftInstructions?: readonly AiInstructionBlock[] | null;
    connectedMailboxes?: readonly ConnectedMailboxCandidate[];
  },
): ResolvedOutboundEmailRouting {
  const market = classifyOutboundMarket(signals);
  const connected = signals.connectedMailboxes ?? [];
  const parsed = parseBrandRoutingInstructions(signals.draftInstructions);

  const linktionEmail =
    matchConnectedMailbox(connected, market === "intl" ? (parsed.intlEmail ?? parsed.hkEmail) : parsed.hkEmail) ??
    findMailboxByPattern(connected, /\blinktion\b|@linktion\./i) ??
    (connected.length === 0 ? (parsed.hkEmail ?? parsed.intlEmail) : null);

  const yingxuanEmail =
    matchConnectedMailbox(connected, market === "cn" ? (parsed.cnEmail ?? parsed.twEmail) : parsed.twEmail) ??
    findMailboxByPattern(connected, /\byingxuan\b|@yingxuan\.|英选|英選/i) ??
    (connected.length === 0 ? (parsed.twEmail ?? parsed.cnEmail) : null);

  if (market === "hk" || market === "intl") {
    if (linktionEmail) {
      return {
        market,
        brand: "Linktion",
        language: "en",
        fromEmail: linktionEmail,
      };
    }
    if (connected.length > 0) {
      return {
        market,
        brand: null,
        language: null,
        fromEmail: connected[0]!.emailAddress.trim(),
      };
    }
    return {
      market,
      brand: "Linktion",
      language: "en",
      fromEmail: "ivan@linktion.cn",
    };
  }

  // market === "tw" || market === "cn"
  const chineseLanguage = market === "tw" ? "zh-Hant" : "zh-Hans";
  if (yingxuanEmail) {
    return {
      market,
      brand: "英选",
      language: chineseLanguage,
      fromEmail: yingxuanEmail,
    };
  }
  if (connected.length > 0) {
    return {
      market,
      brand: null,
      language: null,
      fromEmail: connected[0]!.emailAddress.trim(),
    };
  }
  return {
    market,
    brand: "英选",
    language: chineseLanguage,
    fromEmail: "ivan@yingxuan.io",
  };
}
