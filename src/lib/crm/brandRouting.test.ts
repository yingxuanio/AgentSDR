import { describe, expect, test } from "bun:test";
import type { AiInstructionBlock } from "./ai/instructions";
import {
  classifyOutboundMarket,
  isClearlyNonChineseContactInChineseRegion,
  parseBrandRoutingInstructions,
  resolveOutboundEmailRouting,
  resolveRoutingCompanyCode,
} from "./brandRouting";

const LIVE_COMM_BRAND_ROUTING: readonly AiInstructionBlock[] = [
  {
    id: "comm_brand_routing",
    title: "双品牌与发件路由（华语地区中文优先）",
    content: [
      "品牌与发件不得擅自改写，且同一封信内严禁混用两个品牌：",
      "- 华语地区优先使用中文（香港 HK*、台湾 TW*、澳门及繁中语境统一使用自然道地的繁体中文；中国内地 CN* 使用简体中文）：品牌「英选」（繁体正文中品牌名亦保留「英选」）；发件 ivan@yingxuan.io；落款 Ivan / 英选。",
      "- 非华语地区（海外国际客户）及华语地区中明显外籍非华语联系人或纯英文语境：品牌 Linktion；正文英文；发件 ivan@linktion.cn；落款 Ivan / Linktion。",
      "- 若当前会话已绑定发件邮箱（sender.account），须与发件邮箱保持品牌与语言一致：发件为 ivan@yingxuan.io 时使用中文与「英选」；发件为 ivan@linktion.cn 时使用英文与 Linktion。",
    ].join("\n"),
  },
];

// Both orderings tested so routing never depends on Postgres tie-breaking order.
const TIED_CONNECTED_MAILBOXES = [
  { emailAddress: "ivan@linktion.cn", displayName: "Ivan / Linktion" },
  { emailAddress: "ivan@yingxuan.io", displayName: "Ivan / 英选" },
] as const;

describe("resolveOutboundEmailRouting — Chinese-first for HK/TW/CN & English fallback for non-Chinese", () => {
  test("HK Chinese-owned companies and Romanized Cantonese contacts (HK66–HK68, HK45) prioritize Traditional Chinese + 英选 + ivan@yingxuan.io", () => {
    const hk66 = resolveOutboundEmailRouting({
      company: {
        name: "潤記號機械設備有限公司 (Yuen Kee Ho Machinery Limited)",
        domain: "yuenkeeho.com",
        custom: { x_code: "HK66", x_region: "香港｜紅磡" },
      },
      person: {
        fullName: "Anita Man",
        email: "anita@yuenkeeho.com",
      },
      draftInstructions: LIVE_COMM_BRAND_ROUTING,
      connectedMailboxes: TIED_CONNECTED_MAILBOXES,
    });
    expect(hk66).toEqual({
      market: "hk",
      brand: "英选",
      language: "zh-Hant",
      fromEmail: "ivan@yingxuan.io",
    });

    const hk67 = resolveOutboundEmailRouting({
      company: {
        name: "金昇家品有限公司 (Golden Sun Home Products Ltd.)",
        domain: "goldensun.com.hk",
        custom: { x_code: "HK67", x_region: "香港｜新蒲崗" },
      },
      person: {
        fullName: "Jimmy Kwok Ngok-wing",
        email: "jimi@goldensun.com.hk",
      },
      draftInstructions: LIVE_COMM_BRAND_ROUTING,
      connectedMailboxes: TIED_CONNECTED_MAILBOXES,
    });
    expect(hk67).toEqual({
      market: "hk",
      brand: "英选",
      language: "zh-Hant",
      fromEmail: "ivan@yingxuan.io",
    });

    const hk68 = resolveOutboundEmailRouting({
      company: {
        name: "和利鋼鐵有限公司 (Wo Lee Steel Co. Ltd.)",
        domain: "wolee.com",
        custom: { x_code: "HK68", x_region: "香港｜大角咀" },
      },
      person: {
        fullName: "Hin Fai Lai",
        email: "hinfai@wolee.com",
      },
      draftInstructions: LIVE_COMM_BRAND_ROUTING,
      connectedMailboxes: TIED_CONNECTED_MAILBOXES,
    });
    expect(hk68).toEqual({
      market: "hk",
      brand: "英选",
      language: "zh-Hant",
      fromEmail: "ivan@yingxuan.io",
    });

    const hk45 = resolveOutboundEmailRouting({
      company: {
        name: "日進工業有限公司",
        domain: "pic.com.hk",
        custom: { x_code: "HK45" },
        raw: { country: "Hong Kong", company_code: "HK45" },
      },
      person: {
        fullName: "日進工業有限公司",
        email: "hksales@pic.com.hk",
      },
      draftInstructions: LIVE_COMM_BRAND_ROUTING,
      connectedMailboxes: TIED_CONNECTED_MAILBOXES,
    });
    expect(hk45).toEqual({
      market: "hk",
      brand: "英选",
      language: "zh-Hant",
      fromEmail: "ivan@yingxuan.io",
    });
  });

  test("HK leads with English company names still prioritize Traditional Chinese when contact is Chinese or a generic HK role desk", () => {
    const romanizedChineseContact = resolveOutboundEmailRouting({
      company: {
        name: "eeVoices Limited",
        domain: "eevoices.com",
        custom: { x_code: "HK03", x_region: "香港｜九龙湾" },
      },
      person: { fullName: "Christen Ma", email: "info@eevoices.com" },
      draftInstructions: LIVE_COMM_BRAND_ROUTING,
      connectedMailboxes: TIED_CONNECTED_MAILBOXES,
    });
    expect(romanizedChineseContact).toEqual({
      market: "hk",
      brand: "英选",
      language: "zh-Hant",
      fromEmail: "ivan@yingxuan.io",
    });

    const hkRoleDesk = resolveOutboundEmailRouting({
      company: {
        name: "Harbour Logistics Ltd",
        domain: "harbourlogistics.com",
        custom: { x_region: "香港｜尖沙咀" },
      },
      person: { fullName: "Enquiry Desk", email: "hello@harbourlogistics.com" },
      draftInstructions: LIVE_COMM_BRAND_ROUTING,
      connectedMailboxes: TIED_CONNECTED_MAILBOXES,
    });
    expect(hkRoleDesk).toEqual({
      market: "hk",
      brand: "英选",
      language: "zh-Hant",
      fromEmail: "ivan@yingxuan.io",
    });
  });

  test("clearly non-Chinese expatriate contacts on English-only HK companies or international leads route to English + Linktion + ivan@linktion.cn", () => {
    const expatInHk = resolveOutboundEmailRouting({
      company: {
        name: "CCW Global Limited",
        domain: "ccw-global.com",
        custom: { x_code: "HK01", x_region: "香港｜上环" },
      },
      person: { fullName: "Sam Cooper", email: "sdc@ccw-global.com" },
      draftInstructions: LIVE_COMM_BRAND_ROUTING,
      connectedMailboxes: [
        { emailAddress: "ivan@yingxuan.io", displayName: "Ivan / 英选" },
        { emailAddress: "ivan@linktion.cn", displayName: "Ivan / Linktion" },
      ],
    });
    expect(isClearlyNonChineseContactInChineseRegion({
      company: { name: "CCW Global Limited" },
      person: { fullName: "Sam Cooper" },
    })).toBe(true);
    expect(expatInHk).toEqual({
      market: "hk",
      brand: "Linktion",
      language: "en",
      fromEmail: "ivan@linktion.cn",
    });

    const explicitLanguageOverride = resolveOutboundEmailRouting({
      company: {
        name: "TAISEIMUSEN (H.K.) CO., LTD",
        domain: "taisei-musen.com.hk",
        custom: { x_code: "HK46", x_language: "en" },
      },
      person: { email: "info@taisei-musen.com.hk" },
      draftInstructions: LIVE_COMM_BRAND_ROUTING,
      connectedMailboxes: TIED_CONNECTED_MAILBOXES,
    });
    expect(explicitLanguageOverride).toEqual({
      market: "hk",
      brand: "Linktion",
      language: "en",
      fromEmail: "ivan@linktion.cn",
    });

    const intlLead = resolveOutboundEmailRouting({
      company: {
        name: "Northstar Manufacturing Inc.",
        domain: "northstar-mfg.com",
        custom: { x_code: "US01" },
      },
      person: { fullName: "Rachel Bennett", email: "rachel@northstar-mfg.com" },
      draftInstructions: LIVE_COMM_BRAND_ROUTING,
      connectedMailboxes: [
        { emailAddress: "ivan@yingxuan.io", displayName: "Ivan / 英选" },
        { emailAddress: "ivan@linktion.cn", displayName: "Ivan / Linktion" },
      ],
    });
    expect(intlLead).toEqual({
      market: "intl",
      brand: "Linktion",
      language: "en",
      fromEmail: "ivan@linktion.cn",
    });
  });

  test("TW leads keep Traditional Chinese + 英选 + ivan@yingxuan.io across .com.tw and .com domains", () => {
    const tw01 = resolveOutboundEmailRouting({
      company: {
        name: "某台灣品牌股份有限公司",
        domain: "brand.com.tw",
        custom: { x_code: "TW01", x_region: "台湾｜台北" },
      },
      person: { fullName: "陳經理", email: "service@brand.com.tw" },
      draftInstructions: LIVE_COMM_BRAND_ROUTING,
      connectedMailboxes: TIED_CONNECTED_MAILBOXES,
    });
    expect(tw01).toEqual({
      market: "tw",
      brand: "英选",
      language: "zh-Hant",
      fromEmail: "ivan@yingxuan.io",
    });

    const twCom = resolveOutboundEmailRouting({
      company: {
        name: "Adata Tech",
        domain: "adata-example.com",
        raw: { country: "Taiwan", company_code: "TW30" },
      },
      person: { email: "sales@adata-example.com" },
      draftInstructions: LIVE_COMM_BRAND_ROUTING,
      connectedMailboxes: TIED_CONNECTED_MAILBOXES,
    });
    expect(twCom.market).toBe("tw");
    expect(twCom.brand).toBe("英选");
    expect(twCom.language).toBe("zh-Hant");
    expect(twCom.fromEmail).toBe("ivan@yingxuan.io");
  });

  test("does NOT apply a blanket .hk -> HK rule before TW or Mainland China signals are evaluated", () => {
    // 1. TW company code with a .hk domain
    const twWithHkDomain = resolveOutboundEmailRouting({
      company: {
        name: "Formosa Precision Co.",
        domain: "formosa-group.com.hk",
        custom: { x_code: "TW88" },
      },
      person: { email: "info@formosa-group.com.hk" },
      draftInstructions: LIVE_COMM_BRAND_ROUTING,
      connectedMailboxes: TIED_CONNECTED_MAILBOXES,
    });
    expect(twWithHkDomain.market).toBe("tw");
    expect(twWithHkDomain.brand).toBe("英选");
    expect(twWithHkDomain.language).toBe("zh-Hant");
    expect(twWithHkDomain.fromEmail).toBe("ivan@yingxuan.io");

    // 2. Mainland China client with mixed region ("内地 / 香港", country "China") or .hk domain (like CLIENT04) -> Simplified Chinese
    const client04 = resolveOutboundEmailRouting({
      company: {
        name: "星河跨境供应链有限公司",
        domain: "xinghe-group.com.hk",
        custom: { x_code: "CLIENT04", x_region: "内地 / 香港" },
        raw: { country: "China" },
      },
      person: { email: "bd@xinghe-group.com.hk" },
      draftInstructions: LIVE_COMM_BRAND_ROUTING,
      connectedMailboxes: TIED_CONNECTED_MAILBOXES,
    });
    expect(client04.market).toBe("cn");
    expect(client04.brand).toBe("英选");
    expect(client04.language).toBe("zh-Hans");
    expect(client04.fromEmail).toBe("ivan@yingxuan.io");

    // 3. Simplified Chinese company name without HK markers on a .hk domain -> cn + zh-Hans
    const simplifiedOnHkDomain = resolveOutboundEmailRouting({
      company: {
        name: "深圳华创智能科技有限公司",
        domain: "huachuang.hk",
      },
      person: { email: "contact@huachuang.hk" },
      draftInstructions: LIVE_COMM_BRAND_ROUTING,
      connectedMailboxes: TIED_CONNECTED_MAILBOXES,
    });
    expect(simplifiedOnHkDomain.market).toBe("cn");
    expect(simplifiedOnHkDomain.language).toBe("zh-Hans");
    expect(simplifiedOnHkDomain.fromEmail).toBe("ivan@yingxuan.io");

    // 4. HK domain with no TW/CN signals defaults to HK Traditional Chinese
    const pureHkDomain = classifyOutboundMarket({
      company: {
        name: "Golden Sun Home Products Ltd.",
        domain: "goldensun.com.hk",
      },
      person: { email: "jimi@goldensun.com.hk" },
    });
    expect(pureHkDomain).toBe("hk");
  });

  test("parses custom operator sender addresses from comm_brand_routing and falls back safely for generic orgs", () => {
    const parsedLive = parseBrandRoutingInstructions(LIVE_COMM_BRAND_ROUTING);
    expect(parsedLive).toEqual({
      hkEmail: "ivan@yingxuan.io",
      twEmail: "ivan@yingxuan.io",
      cnEmail: "ivan@yingxuan.io",
      intlEmail: "ivan@linktion.cn",
    });

    const customBlocks: AiInstructionBlock[] = [
      {
        id: "comm_brand_routing",
        title: "Routing",
        content: [
          "华语地区（HK*, TW*, CN*）: 英选 via zh-team@yingxuan.io",
          "International and English leads: Linktion via en-team@linktion.io",
        ].join("\n"),
      },
    ];
    const parsedCustom = parseBrandRoutingInstructions(customBlocks);
    expect(parsedCustom.hkEmail).toBe("zh-team@yingxuan.io");
    expect(parsedCustom.twEmail).toBe("zh-team@yingxuan.io");
    expect(parsedCustom.intlEmail).toBe("en-team@linktion.io");

    const routedCustom = resolveOutboundEmailRouting({
      companyCode: "HK99",
      draftInstructions: customBlocks,
      connectedMailboxes: [
        { emailAddress: "en-team@linktion.io", displayName: "EN Team" },
        { emailAddress: "zh-team@yingxuan.io", displayName: "ZH Team" },
      ],
    });
    expect(routedCustom.fromEmail).toBe("zh-team@yingxuan.io");
    expect(routedCustom.language).toBe("zh-Hant");

    // Generic self-hosted org with a single custom mailbox
    const genericOrg = resolveOutboundEmailRouting({
      company: { name: "Acme Corp", domain: "acme.example" },
      connectedMailboxes: [{ emailAddress: "founder@acme-sdr.example", displayName: "Founder" }],
    });
    expect(genericOrg.fromEmail).toBe("founder@acme-sdr.example");
  });

  test("resolveRoutingCompanyCode extracts companyCode from structured fields or structured notes key=value", () => {
    expect(
      resolveRoutingCompanyCode({
        person: { raw: { notes: "source=import; companyCode=HK46; verified" } },
      }),
    ).toBe("HK46");
    expect(
      resolveRoutingCompanyCode({
        company: { custom: {}, raw: { company_code: "TW12" } },
      }),
    ).toBe("TW12");
  });
});
