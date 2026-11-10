import { describe, expect, test } from "bun:test";
import type { AiInstructionBlock } from "./ai/instructions";
import {
  classifyOutboundMarket,
  parseBrandRoutingInstructions,
  resolveOutboundEmailRouting,
  resolveRoutingCompanyCode,
} from "./brandRouting";

const LIVE_COMM_BRAND_ROUTING: readonly AiInstructionBlock[] = [
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

// Same order Postgres returned when created_at tied on mini (`ivan@yingxuan.io` first).
const TIED_CONNECTED_MAILBOXES = [
  { emailAddress: "ivan@yingxuan.io", displayName: "Ivan / 英选" },
  { emailAddress: "ivan@linktion.cn", displayName: "Ivan / Linktion" },
] as const;

describe("resolveOutboundEmailRouting — HK, TW, CN & regional exceptions", () => {
  test("HK46 (TAISEIMUSEN (H.K.) CO., LTD / taisei-musen.com.hk) routes to Linktion + ivan@linktion.cn without explicit fromEmail", () => {
    const routing = resolveOutboundEmailRouting({
      company: {
        name: "TAISEIMUSEN (H.K.) CO., LTD",
        domain: "taisei-musen.com.hk",
        custom: { x_code: "HK46" },
        raw: { country: "Hong Kong", company_code: "HK46" },
      },
      person: {
        fullName: "TAISEIMUSEN (H.K.) CO., LTD",
        email: "info@taisei-musen.com.hk",
        raw: { notes: "companyCode=HK46; verified via contact page" },
      },
      draftInstructions: LIVE_COMM_BRAND_ROUTING,
      connectedMailboxes: TIED_CONNECTED_MAILBOXES,
    });

    expect(routing).toEqual({
      market: "hk",
      brand: "Linktion",
      language: "en",
      fromEmail: "ivan@linktion.cn",
    });
  });

  test("HK leads with .com/.net domains or Chinese company names + HK* code still route to Linktion", () => {
    const hkCom = resolveOutboundEmailRouting({
      company: {
        name: "CCW Global Limited",
        domain: "ccw-global.com",
        custom: { x_code: "HK02", x_region: "香港｜上环" },
      },
      person: { email: "info@ccw-global.com" },
      draftInstructions: LIVE_COMM_BRAND_ROUTING,
      connectedMailboxes: TIED_CONNECTED_MAILBOXES,
    });
    expect(hkCom.market).toBe("hk");
    expect(hkCom.brand).toBe("Linktion");
    expect(hkCom.fromEmail).toBe("ivan@linktion.cn");

    // HK45 has a Chinese company name AND prose warning mentioning "China szsales@pic.com.hk" in notes.
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
        raw: {
          notes: "HK office email verified; do not use overseas sales@pic.com.hk or China szsales@pic.com.hk",
        },
      },
      draftInstructions: LIVE_COMM_BRAND_ROUTING,
      connectedMailboxes: TIED_CONNECTED_MAILBOXES,
    });
    expect(hk45.market).toBe("hk");
    expect(hk45.brand).toBe("Linktion");
    expect(hk45.fromEmail).toBe("ivan@linktion.cn");
  });

  test("HK lead without companyCode routes via explicit Hong Kong metadata or (H.K.) entity marker", () => {
    const byRegion = resolveOutboundEmailRouting({
      company: {
        name: "Harbour Logistics Ltd",
        domain: "harbourlogistics.com",
        custom: { x_region: "香港｜尖沙咀" },
      },
      person: { email: "hello@harbourlogistics.com" },
      draftInstructions: LIVE_COMM_BRAND_ROUTING,
      connectedMailboxes: TIED_CONNECTED_MAILBOXES,
    });
    expect(byRegion.market).toBe("hk");
    expect(byRegion.fromEmail).toBe("ivan@linktion.cn");

    const byEntityName = resolveOutboundEmailRouting({
      company: {
        name: "PACIFIC TRADE (H.K.) LIMITED",
        domain: "pacifictrade.example",
      },
      person: { email: "contact@pacifictrade.example" },
      draftInstructions: LIVE_COMM_BRAND_ROUTING,
      connectedMailboxes: TIED_CONNECTED_MAILBOXES,
    });
    expect(byEntityName.market).toBe("hk");
    expect(byEntityName.fromEmail).toBe("ivan@linktion.cn");
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
      connectedMailboxes: [
        // Even if Linktion mailbox comes first, TW must still bind ivan@yingxuan.io!
        { emailAddress: "ivan@linktion.cn", displayName: "Ivan / Linktion" },
        { emailAddress: "ivan@yingxuan.io", displayName: "Ivan / 英选" },
      ],
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

  test("does NOT apply a blanket .hk -> HK rule when regional signals indicate TW or Mainland China", () => {
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
    expect(twWithHkDomain.fromEmail).toBe("ivan@yingxuan.io");

    // 2. Taiwan country/region metadata with a .hk domain and no company code
    const twRegionWithHkDomain = resolveOutboundEmailRouting({
      company: {
        name: "Apex Electronics",
        domain: "apex-asia.hk",
        raw: { country: "Taiwan" },
      },
      person: { email: "sales@apex-asia.hk" },
      draftInstructions: LIVE_COMM_BRAND_ROUTING,
      connectedMailboxes: TIED_CONNECTED_MAILBOXES,
    });
    expect(twRegionWithHkDomain.market).toBe("tw");
    expect(twRegionWithHkDomain.fromEmail).toBe("ivan@yingxuan.io");

    // 3. Traditional Chinese entity name without HK markers on a .hk domain
    const tradChineseOnHkDomain = classifyOutboundMarket({
      company: {
        name: "精機實業股份有限公司",
        domain: "jingji.hk",
      },
      person: { email: "info@jingji.hk" },
    });
    expect(tradChineseOnHkDomain).toBe("tw");

    // 4. Mainland China client with mixed region ("内地 / 香港", country "China") or .hk domain (like CLIENT04)
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
    expect(client04.fromEmail).toBe("ivan@yingxuan.io");

    // 5. Simplified Chinese company name without HK markers on a .hk domain
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
    expect(simplifiedOnHkDomain.fromEmail).toBe("ivan@yingxuan.io");
  });

  test("parses custom operator sender addresses from comm_brand_routing and falls back safely for generic orgs", () => {
    const customBlocks: AiInstructionBlock[] = [
      {
        id: "comm_brand_routing",
        title: "Routing",
        content: [
          "HK* and English leads: Linktion via hk-team@linktion.io",
          "TW* Traditional Chinese leads: 英选 via tw-team@yingxuan.io",
        ].join("\n"),
      },
    ];
    const parsed = parseBrandRoutingInstructions(customBlocks);
    expect(parsed.hkEmail).toBe("hk-team@linktion.io");
    expect(parsed.twEmail).toBe("tw-team@yingxuan.io");

    const routedCustom = resolveOutboundEmailRouting({
      companyCode: "HK99",
      draftInstructions: customBlocks,
      connectedMailboxes: [
        { emailAddress: "tw-team@yingxuan.io", displayName: "TW Team" },
        { emailAddress: "hk-team@linktion.io", displayName: "HK Team" },
      ],
    });
    expect(routedCustom.fromEmail).toBe("hk-team@linktion.io");

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
