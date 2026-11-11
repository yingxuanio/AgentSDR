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
  /[臺灣實業發開際電機製專體網訊資處會長門車馬魚鳥龍龜東義禮樂醫藥餐飲裝修運輸聯統銷購顧問數據優質創藝傳媒廣場樓區縣鎮鄉裡對與為無從來後個們這說請讓還進過達遠選邊關間閱潤昇鋼鐵機械號]/u;

const ANY_HAN = /[\u4e00-\u9fff]/u;

const ROLE_OR_ENTITY_NAME_PATTERNS =
  /\b(?:desk|team|office|department|dept|inquiry|enquiry|inquiries|enquiries|sales|support|service|customer|corporate|engineering|product|marketing|admin|administration|operations|procurement|purchasing|info|contact|general|hr|recruitment|limited|ltd|co|company|corp|corporation|inc|incorporated|group|holdings|enterprise|enterprises|industrial|international|technology|machinery|trading|hardware|electronics)\b/i;

/**
 * Common Romanized Chinese surnames across Hong Kong (Cantonese Government Romanization),
 * Taiwan (Wade-Giles / Tongyong / Hokkien), Mainland China (Pinyin), and overseas Chinese spellings.
 * Used so Romanized Chinese contacts in HK/TW/CN (e.g. Anita Man, Jimmy Kwok, Hin Fai Lai, Christen Ma)
 * stay prioritized in Chinese while clearly Western/foreign expat contacts on English-only entities
 * (e.g. Sam Cooper at CCW Global Limited) can route to English.
 */
const CHINESE_ROMANIZED_SURNAMES = new Set([
  // HK / Cantonese
  "au", "auyeung", "chan", "chau", "cheuk", "cheung", "chiang", "chik", "chim", "chin",
  "ching", "chiu", "cho", "choi", "chong", "chow", "choy", "chu", "chui", "chun", "chung",
  "choy", "fan", "fok", "fong", "fu", "fung", "ha", "hau", "ho", "hon", "hung", "hui",
  "ip", "kam", "kan", "keung", "ko", "kong", "koo", "ku", "kung", "kwan", "kwai", "kwok",
  "kwong", "lai", "lam", "lau", "law", "lee", "leung", "li", "ling", "lo", "lok", "lu",
  "lui", "luk", "lung", "ma", "mak", "man", "mo", "mok", "mui", "nam", "ng", "ngai",
  "ngan", "pak", "pang", "poon", "pun", "sham", "shek", "shum", "sin", "sit", "siu", "so",
  "suen", "sum", "sung", "sze", "szeto", "tai", "tam", "tang", "tin", "to", "tong", "tsang",
  "tse", "tsoi", "tsui", "uen", "wai", "wan", "wat", "wong", "woo", "wu", "yam", "yan",
  "yap", "yau", "yeung", "yim", "yin", "yip", "yiu", "yu", "yue", "yuen", "yung",
  // Mainland Pinyin & Taiwan Wade-Giles / Hokkien
  "ai", "an", "bai", "bao", "bi", "bian", "bu", "cai", "cao", "cen", "chai", "chang",
  "chao", "chen", "cheng", "chi", "chien", "chou", "chuang", "chueh", "cui", "dai", "deng",
  "ding", "dong", "dou", "du", "duan", "fang", "fei", "feng", "fu", "gan", "gao", "ge",
  "geng", "gong", "gou", "gu", "guan", "guo", "han", "hao", "he", "hong", "hou", "hsia",
  "hsiao", "hsieh", "hsin", "hsing", "hsiung", "hsu", "hsueh", "hu", "hua", "huang", "huo",
  "hwang", "jen", "ji", "jia", "jian", "jiang", "jiao", "jin", "jing", "ju", "kang", "kao",
  "ke", "kong", "kou", "kuan", "kuang", "kuei", "kuo", "lan", "lei", "leng", "li", "lian",
  "liang", "liao", "lim", "lin", "liu", "long", "lou", "lu", "luan", "luo", "lv", "lyu",
  "mao", "mei", "meng", "miao", "min", "ming", "mou", "mu", "ni", "nie", "ning", "niu",
  "ong", "ou", "ouyang", "pai", "pan", "pei", "peng", "pi", "ping", "pu", "qi", "qian",
  "qiang", "qiao", "qin", "qiu", "qu", "quan", "que", "ran", "rao", "ren", "rong", "ru",
  "ruan", "sang", "sha", "shan", "shang", "shao", "shen", "sheng", "shi", "shih", "shu",
  "shui", "sim", "song", "su", "sun", "tan", "tao", "tay", "teng", "teo", "teoh", "tian",
  "tien", "ting", "tsai", "tsao", "tseng", "tsou", "tu", "tuan", "tung", "tzeng", "wang",
  "wei", "wen", "weng", "wu", "xi", "xia", "xiang", "xiao", "xie", "xin", "xing", "xiong",
  "xu", "xuan", "xue", "xun", "yang", "yao", "ye", "yeh", "yen", "yi", "yin", "ying",
  "you", "yuan", "yue", "yun", "zang", "zeng", "zha", "zhai", "zhan", "zhang", "zhao",
  "zheng", "zhong", "zhou", "zhu", "zhuang", "zhuo", "zong", "zou", "zu", "zuo",
]);

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
  if (/^(?:HK|MO)(?:\d|[-_\s]|$)/.test(upper)) return "hk";
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
    /香港|九龙|九龍|新界|澳门|澳門|\bhong\s*kong\b|\bhksar\b|\bkowloon\b|\bmacau\b|\bmacao\b/i.test(text) ||
    (isCountryField && /^(?:HK|MO|HKG|MAC)$/i.test(text))
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
  if (/\(\s*H\.?\s*K\.?\s*\)|（\s*香港\s*）|\bHong\s*Kong\b|香港|\bMacau\b|\bMacao\b|澳門|澳门/i.test(text)) {
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
 * as a blanket Hong Kong override before TW/Mainland regional signals are checked.
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

  // 4. Language/script & TLD context (checked only after TW/CN explicit signals so TW/CN entities on `.hk` stay in TW/CN).
  const domain = normalizedDomain(signals.company?.domain, signals.person?.email);
  const combinedNames = [signals.company?.name, signals.person?.fullName]
    .map((v) => cleanString(v))
    .filter((v): v is string => Boolean(v))
    .join(" ");

  if (ANY_HAN.test(combinedNames)) {
    if (domain && (domain.endsWith(".hk") || domain.includes(".com.hk") || domain.endsWith(".mo") || domain.includes(".com.mo"))) {
      return TRADITIONAL_DISTINCTIVE_HAN.test(combinedNames) ? "hk" : "cn";
    }
    if (TRADITIONAL_DISTINCTIVE_HAN.test(combinedNames) || (domain && (domain.endsWith(".tw") || domain.includes(".com.tw")))) {
      return "tw";
    }
    return "cn";
  }

  if (domain && (domain.endsWith(".tw") || domain.includes(".com.tw"))) {
    return "tw";
  }
  if (domain && (domain.endsWith(".hk") || domain.includes(".com.hk") || domain.endsWith(".mo") || domain.includes(".com.mo"))) {
    return "hk";
  }
  if (domain && (domain.endsWith(".cn") || domain.includes(".com.cn"))) {
    return "cn";
  }

  return "intl";
}

function resolveExplicitLanguageOverride(
  signals: BrandRoutingSignals,
  market: OutboundBrandMarket,
): "en" | "zh-Hant" | "zh-Hans" | null {
  const companyCustom = (signals.company?.custom ?? {}) as Record<string, unknown>;
  const companyRaw = (signals.company?.raw ?? {}) as Record<string, unknown>;
  const personCustom = (signals.person?.custom ?? {}) as Record<string, unknown>;
  const personRaw = (signals.person?.raw ?? {}) as Record<string, unknown>;

  for (const candidate of [
    personCustom.x_language,
    personCustom.language,
    personRaw.x_language,
    personRaw.language,
    companyCustom.x_language,
    companyCustom.language,
    companyRaw.x_language,
    companyRaw.language,
  ]) {
    const text = cleanString(candidate);
    if (!text) continue;
    if (/^(?:en|eng|english)\b/i.test(text)) return "en";
    if (/^(?:zh[-_]?hant|zh[-_]?hk|zh[-_]?tw|zh[-_]?mo|trad|traditional|繁中|繁体|繁體)/i.test(text)) {
      return "zh-Hant";
    }
    if (/^(?:zh[-_]?hans|zh[-_]?cn|simp|simplified|简中|简体|簡體)/i.test(text)) {
      return "zh-Hans";
    }
    if (/^(?:zh|chinese|中文|华语|華語)/i.test(text)) {
      return market === "cn" ? "zh-Hans" : "zh-Hant";
    }
  }
  return null;
}

/**
 * Determine whether a contact in a Chinese-speaking region (`hk`, `tw`, `cn`) is
 * clearly a non-Chinese expatriate on an English-only company (e.g. `Sam Cooper` at
 * `CCW Global Limited`). All local Chinese contacts, Romanized Chinese names
 * (`Anita Man`, `Jimmy Kwok Ngok-wing`, `Hin Fai Lai`, `Christen Ma`), companies with
 * Chinese names, and generic role desks in Chinese-speaking regions stay prioritized in Chinese.
 */
export function isClearlyNonChineseContactInChineseRegion(signals: BrandRoutingSignals): boolean {
  const companyName = cleanString(signals.company?.name) ?? "";
  const personFull =
    cleanString(signals.person?.fullName) ??
    cleanString([signals.person?.firstName, signals.person?.lastName].filter(Boolean).join(" ")) ??
    "";

  if (!personFull) return false;
  if (ANY_HAN.test(companyName) || ANY_HAN.test(personFull)) return false;

  const normalizeComparable = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (companyName && normalizeComparable(personFull) === normalizeComparable(companyName)) {
    return false;
  }

  // Role desks or company placeholders (e.g. "Enquiry Desk", "Sales Team", "... Co., Ltd.") default to Chinese in HK/TW/CN.
  if (ROLE_OR_ENTITY_NAME_PATTERNS.test(personFull)) {
    return false;
  }

  // Hyphenated two-syllable Romanized Chinese given names (e.g. "Ngok-wing", "Ka-wai", "Chih-ming").
  const rawWords = personFull
    .replace(/[(),./]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  for (const word of rawWords) {
    if (/^[A-Za-z]{2,6}-[A-Za-z]{2,6}$/.test(word)) {
      const [partA, partB] = word.toLowerCase().split("-");
      if (
        (partA && CHINESE_ROMANIZED_SURNAMES.has(partA)) ||
        (partB && CHINESE_ROMANIZED_SURNAMES.has(partB)) ||
        /^(?:wing|wai|ming|ling|fong|fung|kit|kin|hin|fai|wah|wan|yin|yan|yue|yu|chi|tsz|ka|ho|lok|man|chun|hung|keung|kwong|cheong|shing|tak|tat|tim|sum|yi|yee|mei|hsin|hsing|chih|chia|wei|wen|chen|cheng|hao|yu)$/.test(
          partB ?? "",
        )
      ) {
        return false;
      }
    }
  }

  const alphaTokens = personFull
    .toLowerCase()
    .replace(/[^a-z\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((t) => t.length >= 2);

  // Single-word names without surname context are ambiguous; prioritize Chinese in Chinese-speaking regions.
  if (alphaTokens.length < 2) return false;

  for (const token of alphaTokens) {
    if (CHINESE_ROMANIZED_SURNAMES.has(token)) {
      return false;
    }
  }

  return true;
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
      // Skip conditional sender-consistency reminder lines that list multiple mailboxes in one sentence.
      if (/sender\.account|当前会话已绑定发件邮箱/i.test(line)) continue;

      const matches = [...line.matchAll(EMAIL_IN_TEXT)]
        .map((m) => normalizeEmail(m[1] ?? null))
        .filter((email): email is string => Boolean(email));
      if (matches.length === 0) continue;
      const email = matches[0]!;

      const mentionsExpatException = /非华语|外籍|\bnon-chinese\b|\bexpat/i.test(line);
      const mentionsLinktionOrEnglish =
        /英文语境|品牌\s*Linktion|\bLinktion\b|\bEnglish\b|\bInternational\b|国际客户|海外/i.test(line);
      const mentionsHk = /\bHK\*?|\bHong\s*Kong\b|香港|港澳/i.test(line);
      const mentionsTw = /\bTW\*?|\bTaiwan\b|台湾|臺灣|繁中|繁体|繁體|港澳台/i.test(line);
      const mentionsCn = /\bCN\*?|内地|內地|中国大陆|中國大陸|\bMainland\s*China\b/i.test(line);
      const mentionsChineseRegion = /华语地区|華語地區|中文市场/i.test(line);
      const mentionsYingxuan = /英选|英選|\bYingxuan\b/i.test(line);

      if (mentionsExpatException || (mentionsLinktionOrEnglish && !mentionsYingxuan)) {
        result.intlEmail ??= email;
        if (mentionsHk && !mentionsExpatException && !mentionsChineseRegion && !mentionsTw) {
          result.hkEmail ??= email;
        }
        continue;
      }

      if (mentionsChineseRegion || mentionsYingxuan) {
        if (mentionsHk || mentionsChineseRegion) result.hkEmail ??= email;
        if (mentionsTw || mentionsChineseRegion) result.twEmail ??= email;
        if (mentionsCn || mentionsChineseRegion) result.cnEmail ??= email;
      } else {
        if (mentionsHk) result.hkEmail ??= email;
        if (mentionsTw) result.twEmail ??= email;
        if (mentionsCn) result.cnEmail ??= email;
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
 *
 * Chinese-speaking regions (`hk`, `tw`, `cn`) prioritize Chinese (`zh-Hant` for HK/TW,
 * `zh-Hans` for Mainland China) + `英选` (`ivan@yingxuan.io`), falling back to English
 * (`Linktion` / `ivan@linktion.cn`) only for `intl` leads, explicit `language=en` overrides,
 * or clearly non-Chinese expatriate contacts on English-only entities.
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

  const explicitLanguage = resolveExplicitLanguageOverride(signals, market);
  let targetLanguage: "en" | "zh-Hant" | "zh-Hans";
  if (explicitLanguage) {
    targetLanguage = explicitLanguage;
  } else if (market === "intl") {
    targetLanguage = "en";
  } else if (isClearlyNonChineseContactInChineseRegion(signals)) {
    targetLanguage = "en";
  } else {
    targetLanguage = market === "cn" ? "zh-Hans" : "zh-Hant";
  }

  // Respect explicit custom operator HK mailbox overrides if an org specifically mapped HK* to a custom non-Yingxuan mailbox.
  const operatorExplicitEnglishHkOverride =
    market === "hk" &&
    !explicitLanguage &&
    parsed.hkEmail !== null &&
    /\blinktion\b|@linktion\./i.test(parsed.hkEmail) &&
    parsed.hkEmail !== parsed.twEmail;

  if (targetLanguage === "en" || operatorExplicitEnglishHkOverride) {
    const preferredEnTarget =
      operatorExplicitEnglishHkOverride ? parsed.hkEmail : (parsed.intlEmail ?? parsed.hkEmail);
    const linktionEmail =
      matchConnectedMailbox(connected, preferredEnTarget) ??
      findMailboxByPattern(connected, /\blinktion\b|@linktion\./i) ??
      (connected.length === 0 ? preferredEnTarget : null);

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

  const preferredZhTarget =
    market === "cn"
      ? (parsed.cnEmail ?? parsed.twEmail ?? parsed.hkEmail)
      : market === "hk"
        ? (parsed.hkEmail ?? parsed.twEmail ?? parsed.cnEmail)
        : (parsed.twEmail ?? parsed.hkEmail ?? parsed.cnEmail);

  const yingxuanEmail =
    matchConnectedMailbox(connected, preferredZhTarget) ??
    findMailboxByPattern(connected, /\byingxuan\b|@yingxuan\.|英选|英選/i) ??
    (connected.length === 0 ? preferredZhTarget : null);

  if (yingxuanEmail) {
    return {
      market,
      brand: "英选",
      language: targetLanguage,
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
    language: targetLanguage,
    fromEmail: "ivan@yingxuan.io",
  };
}
