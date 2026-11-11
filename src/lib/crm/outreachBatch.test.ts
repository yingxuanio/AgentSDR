import { describe, expect, test } from "bun:test";
import {
  auditDraftContent,
  detectSimplifiedBleedInTraditionalDraft,
  splitPersonName,
  validateProspectLeadStatic,
} from "./outreachBatch";
import {
  computeNextCodesFromExisting,
  inferCodePrefix,
  normalizeRootDomain,
} from "@/lib/leads/outreachCheck";

describe("outreachCheck helpers", () => {
  test("normalizes root domains cleanly", () => {
    expect(normalizeRootDomain("https://www.GoldenSun.com.hk/contact.html?x=1")).toBe("goldensun.com.hk");
    expect(normalizeRootDomain("anita@yuenkeeho.com")).toBe("yuenkeeho.com");
    expect(normalizeRootDomain("")).toBeNull();
  });

  test("computes sequential next codes while ignoring high test fixtures", () => {
    const next = computeNextCodesFromExisting(["HK01", "HK66", "HK67", "HK68", "HK97", "HK98", "HK999", "TW01", "TW47", "TW999"]);
    expect(next.HK).toBe("HK69");
    expect(next.TW).toBe("TW48");
    expect(next.CN).toBe("CN01");
  });

  test("infers regional prefix from region or TLD", () => {
    expect(inferCodePrefix({ companyRegion: "香港｜觀塘", companyDomain: "example.com" })).toBe("HK");
    expect(inferCodePrefix({ companyRegion: "台灣｜台中", companyDomain: "machinery.com.tw" })).toBe("TW");
    expect(inferCodePrefix({ companyDomain: "acme.hk" })).toBe("HK");
  });
});

describe("outreachBatch validation & draft lint", () => {
  test("rejects placeholder names, support emails, and tech vendors", () => {
    expect(
      validateProspectLeadStatic({
        fullName: "Corporate Inquiry Desk",
        title: "Admin",
        email: "info@acme.hk",
        companyName: "Acme Manufacturing Ltd",
        companyDomain: "acme.hk",
        leadReason: "傳統五金製造廠，需要海外產品型錄與詢盤系統支援。",
        verificationNote: "核驗自官網聯絡頁 https://acme.hk/contact",
      }).ok,
    ).toBe(false);

    expect(
      validateProspectLeadStatic({
        fullName: "Chan Tai Man",
        title: "Managing Director",
        email: "support@acme.hk",
        companyName: "Acme Manufacturing Ltd",
        companyDomain: "acme.hk",
        leadReason: "傳統五金製造廠，需要海外產品型錄與詢盤系統支援。",
        verificationNote: "核驗自官網聯絡頁 https://acme.hk/contact",
      }).ok,
    ).toBe(false);

    expect(
      validateProspectLeadStatic({
        fullName: "Chan Tai Man",
        title: "Founder",
        email: "chan@pantheon.hk",
        companyName: "Pantheon AI Solutions Limited",
        companyDomain: "pantheon.hk",
        leadReason: "企業項目合作交流，評估外部交付可能性。",
        verificationNote: "核驗自官網聯絡頁 https://pantheon.hk/about",
      }).ok,
    ).toBe(false);

    expect(
      validateProspectLeadStatic({
        fullName: "陳大文",
        title: "董事總經理",
        email: "chan@acmehardware.com.hk",
        companyName: "永興五金製品有限公司",
        companyDomain: "acmehardware.com.hk",
        leadReason: "傳統五金製造與出口商，具備海外B2B產品選型目錄與詢盤管理系統切入空間。",
        verificationNote: "姓名與職位及郵箱核驗自 https://acmehardware.com.hk/contact",
      }).ok,
    ).toBe(true);
  });

  test("splits Chinese and English person names", () => {
    expect(splitPersonName("黎顯輝")).toEqual({ fullName: "黎顯輝", firstName: "顯輝", lastName: "黎" });
    expect(splitPersonName("Anita Man")).toEqual({ fullName: "Anita Man", firstName: "Anita", lastName: "Man" });
  });

  test("detects Simplified Chinese character bleed in HK/TW Traditional drafts", () => {
    const cleanTrad = "陳董事您好：\n\n留意到貴司長期深耕精密五金製造與海外出口，面對不同市場的產品規格展示與客戶詢價往來，清晰的線上型錄有助提升跟進效率。英選團隊核心成員曾打造 AI Coding 產品 ClackyAI，透過 AI 深度參與開發與測試並移交完整源碼。\n\n此致\nIvan / 英選\nhttps://yingxuan.io/";
    expect(detectSimplifiedBleedInTraditionalDraft(cleanTrad)).toEqual([]);
    expect(
      auditDraftContent({
        subject: "關於永興五金海外產品型錄與詢價流程交流",
        bodyText: cleanTrad,
        fromEmail: "ivan@yingxuan.io",
        companyCode: "HK69",
      }).ok,
    ).toBe(true);

    const bleedDraft = cleanTrad.replace("貴司", "贵司").replace("團隊", "团队");
    const audit = auditDraftContent({
      subject: "關於永興五金業務交流",
      bodyText: bleedDraft,
      fromEmail: "ivan@yingxuan.io",
      companyCode: "HK69",
    });
    expect(audit.ok).toBe(false);
    expect(audit.simplifiedChars).toContain("贵");
    expect(audit.simplifiedChars).toContain("团");
  });
});
