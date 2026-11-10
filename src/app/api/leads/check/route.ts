import { NextRequest, NextResponse } from "next/server";
import { listPeoplePage } from "@/lib/leads/records";
import { authContextErrorResponse, withOrgContext } from "@/lib/auth/context";

export async function GET(req: NextRequest) {
  try {
    return await withOrgContext(req, () => checkLead(req));
  } catch (error) {
    const auth = authContextErrorResponse(error);
    if (auth) return auth;
    throw error;
  }
}

async function checkLead(req: NextRequest) {
  const email = req.nextUrl.searchParams.get("email")?.trim();
  const domain = req.nextUrl.searchParams.get("domain")?.trim() ?? req.nextUrl.searchParams.get("companyDomain")?.trim();
  const company = req.nextUrl.searchParams.get("company")?.trim() ?? req.nextUrl.searchParams.get("companyName")?.trim();

  if (!email && !domain && !company) {
    return NextResponse.json(
      { error: "At least one search criterion (email, domain, or company) is required" },
      { status: 400 },
    );
  }

  const result = await listPeoplePage({
    email: email || undefined,
    domain: domain || undefined,
    company: company || undefined,
    limit: 10,
  });

  if (result.total === 0) {
    return NextResponse.json({ match: false, total: 0 });
  }

  const primary = result.rows[0];
  return NextResponse.json({
    match: true,
    total: result.total,
    person: primary.person,
    company: primary.company,
    crm: primary.crm,
    contactPolicy: primary.contactPolicy,
    dnc: primary.dnc,
    closed: primary.closed,
    lastOutboundAt: primary.lastOutboundAt,
    lastInboundAt: primary.lastInboundAt,
    lastInteractionAt: primary.lastInteractionAt,
    leads: result.rows,
  });
}
