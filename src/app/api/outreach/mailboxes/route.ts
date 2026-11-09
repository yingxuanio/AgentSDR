import { NextRequest, NextResponse } from "next/server";
import { listMailboxes, connectMailbox } from "@/lib/outreach/mailboxes";
import { withOrgContext, authContextErrorResponse } from "@/lib/auth/context";

// GET /api/outreach/mailboxes — list connected mailboxes.
export async function GET(request: NextRequest) {
  try {
    return await withOrgContext(request, async () => {
      const rows = await listMailboxes();
      return NextResponse.json({ mailboxes: rows });
    });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

// POST /api/outreach/mailboxes — connect a mailbox: { emailAddress, displayName?, signatureHtml? }
// No password/OAuth — just names the address; we test whether our service
// account's domain-wide delegation is authorized to impersonate it.
export async function POST(req: NextRequest) {
  try {
    return await withOrgContext(req, async () => {
      let body: {
        emailAddress?: string;
        displayName?: string;
        signatureHtml?: string;
        password?: string;
        smtpHost?: string;
        smtpPort?: string | number;
        imapHost?: string;
        imapPort?: string | number;
      };
      try {
        body = await req.json();
      } catch {
        return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
      }

      if (!body.emailAddress) {
        return NextResponse.json({ error: "emailAddress is required" }, { status: 400 });
      }

      const result = await connectMailbox({
        emailAddress: body.emailAddress,
        displayName: body.displayName,
        signatureHtml: body.signatureHtml,
        password: body.password,
        smtpHost: body.smtpHost,
        smtpPort: body.smtpPort,
        imapHost: body.imapHost,
        imapPort: body.imapPort,
      });
      if (!result.ok) {
        return NextResponse.json({ ok: false, error: result.error }, { status: 422 });
      }
      return NextResponse.json(result, { status: 201 });
    });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
