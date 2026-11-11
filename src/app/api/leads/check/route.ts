import { NextRequest, NextResponse } from "next/server";
import { listPeoplePage } from "@/lib/leads/records";
import { checkBatchLeads } from "@/lib/leads/outreachCheck";
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

export async function POST(req: NextRequest) {
  try {
    return await withOrgContext(req, async () => {
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return NextResponse.json({ error: "JSON object body is required" }, { status: 400 });
      }
      const result = await checkBatchLeads({
        domains: Array.isArray(body.domains) ? body.domains : undefined,
        emails: Array.isArray(body.emails) ? body.emails : undefined,
        companies: Array.isArray(body.companies) ? body.companies : undefined,
      });
      return NextResponse.json(result);
    });
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
