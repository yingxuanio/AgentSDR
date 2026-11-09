import { NextRequest, NextResponse } from "next/server";
import { authContextErrorResponse, withOrgContext } from "@/lib/auth/context";
import { getMailbox } from "@/lib/outreach/mailboxes";
import { syncMailboxInbox } from "@/lib/outreach/gmailSync";

// POST /api/outreach/mailboxes/[id]/sync — trigger an immediate inbox sync for this mailbox.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    return await withOrgContext(_req, async () => {
      const { id } = await params;
      const mailbox = await getMailbox(id);
      if (!mailbox) {
        return NextResponse.json({ ok: false, error: "Mailbox not found" }, { status: 404 });
      }
      const res = await syncMailboxInbox(id);
      return NextResponse.json({
        ok: true,
        synced: res.synced,
        fetched: "fetched" in res ? res.fetched : res.synced,
      });
    });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Sync failed" },
      { status: 422 },
    );
  }
}
