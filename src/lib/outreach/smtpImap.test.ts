import { describe, expect, it } from "bun:test";
import {
  decodeMimeWords,
  decodeQuotedPrintableToBuffer,
  parseRawEmailMessage,
} from "./smtpImap";

describe("smtpImap MIME and RFC 5322 parser", () => {
  it("decodes RFC 2047 UTF-8 Base64 and Quoted-Printable headers", () => {
    const b64Subject = `=?UTF-8?B?${Buffer.from("Re: 合作咨询 Linktion SDR", "utf8").toString("base64")}?=`;
    expect(decodeMimeWords(b64Subject)).toBe("Re: 合作咨询 Linktion SDR");

    const qpSubject = "=?UTF-8?Q?Re:_Exigo_migration_=E2=80=94_follow_up?=";
    expect(decodeMimeWords(qpSubject)).toBe("Re: Exigo migration — follow up");
  });

  it("decodes quoted-printable body with soft line breaks", () => {
    const qp = "Hello=20World=\r\n! This is a =E6=B5=8B=E8=AF=95.";
    expect(decodeQuotedPrintableToBuffer(qp).toString("utf8")).toBe("Hello World! This is a 测试.");
  });

  it("parses multipart/alternative inbound email and extracts headers, recipients, and threading", () => {
    const boundary = "----=_Part_12345_67890";
    const plainBody = Buffer.from("Hi Ivan,\n\nThanks for reaching out! Let's talk on Thursday.\n", "utf8").toString("base64");
    const htmlBody = Buffer.from("<p>Hi Ivan,</p><p>Thanks for reaching out! Let's talk on Thursday.</p>", "utf8").toString("base64");

    const rawMime = [
      `From: "Alex Rivera" <alex@example.com>`,
      `To: "Ivan" <sdr@linktion.cn>`,
      `Cc: "Team" <team@example.com>`,
      `Subject: =?UTF-8?B?${Buffer.from("Re: 迁移方案讨论", "utf8").toString("base64")}?=`,
      `Message-ID: <reply-999@example.com>`,
      `In-Reply-To: <initial-111@linktion.cn>`,
      `References: <root-000@linktion.cn> <initial-111@linktion.cn>`,
      `Date: Mon, 09 Nov 2026 10:15:00 +0800`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      ``,
      `--${boundary}`,
      `Content-Type: text/plain; charset="UTF-8"`,
      `Content-Transfer-Encoding: base64`,
      ``,
      plainBody,
      `--${boundary}`,
      `Content-Type: text/html; charset="UTF-8"`,
      `Content-Transfer-Encoding: base64`,
      ``,
      htmlBody,
      `--${boundary}--`,
      ``,
    ].join("\r\n");

    const parsed = parseRawEmailMessage(Buffer.from(rawMime, "latin1"), {
      uid: 42,
      mailboxEmail: "sdr@linktion.cn",
    });

    expect(parsed).not.toBeNull();
    expect(parsed?.gmailMessageId).toBe("imap-42");
    expect(parsed?.fromEmail).toBe("alex@example.com");
    expect(parsed?.fromName).toBe("Alex Rivera");
    expect(parsed?.toEmail).toBe("sdr@linktion.cn");
    expect(parsed?.ccEmails).toEqual(["team@example.com"]);
    expect(parsed?.subject).toBe("Re: 迁移方案讨论");
    expect(parsed?.messageId).toBe("<reply-999@example.com>");
    expect(parsed?.inReplyTo).toBe("<initial-111@linktion.cn>");
    expect(parsed?.threadId).toBe("<root-000@linktion.cn>");
    expect(parsed?.bodyText).toContain("Thanks for reaching out! Let's talk on Thursday.");
  });

  it("ignores self-sent messages while retaining auto-replies (left-company / OOO / DSN)", () => {
    const selfSent = [
      `From: <sdr@linktion.cn>`,
      `To: <alex@example.com>`,
      `Subject: Outbound`,
      ``,
      `Hello`,
    ].join("\r\n");
    expect(
      parseRawEmailMessage(Buffer.from(selfSent, "latin1"), {
        uid: 43,
        mailboxEmail: "sdr@linktion.cn",
      }),
    ).toBeNull();

    const autoReply = [
      `From: "Debbie Wut" <debbie@alphalogisticshk.com>`,
      `To: <sdr@linktion.cn>`,
      `Subject: Auto-Reply`,
      `Auto-Submitted: auto-replied`,
      `In-Reply-To: <68877b8d-8981-4ab6-ba77-15f6680f7538@linktion.cn>`,
      ``,
      `Dear Sender,\r\n\r\nPlease be informed that Ms. Debbie is no longer with Alpha Logistics HK Ltd.`,
    ].join("\r\n");
    const parsedAutoReply = parseRawEmailMessage(Buffer.from(autoReply, "latin1"), {
      uid: 44,
      mailboxEmail: "sdr@linktion.cn",
    });
    expect(parsedAutoReply).not.toBeNull();
    expect(parsedAutoReply?.fromEmail).toBe("debbie@alphalogisticshk.com");
    expect(parsedAutoReply?.threadId).toBe("<68877b8d-8981-4ab6-ba77-15f6680f7538@linktion.cn>");
    expect(parsedAutoReply?.bodyText).toContain("no longer with Alpha Logistics HK Ltd.");
  });
});
