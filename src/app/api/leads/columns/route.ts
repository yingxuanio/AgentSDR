import { NextRequest, NextResponse } from "next/server";
import { authContextErrorResponse, withOrgContext } from "@/lib/auth/context";
import { ColumnError, addColumn, listColumns } from "@/lib/leads/columns";
import {
  isLeadEntity,
  PG_TYPE_FOR_COLUMN_TYPE,
  type LeadColumnType,
  type LeadEntity,
} from "@/lib/leads/types";

import { columnErrorResponse } from "./errors";

// GET /api/leads/columns?entity=person&includeArchived=true
export async function GET(req: NextRequest) {
  try {
    return await withOrgContext(req, () => list(req));
  } catch (err) {
    return columnErrorResponse(err);
  }
}

async function list(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("entity");
  let entity: LeadEntity | undefined;
  if (raw !== null) {
    if (!isLeadEntity(raw)) {
      return NextResponse.json({ error: "entity must be 'person' or 'company'" }, { status: 400 });
    }
    entity = raw;
  }

  const columns = await listColumns(entity, {
    includeArchived: req.nextUrl.searchParams.get("includeArchived") === "true",
  });
  return NextResponse.json({ columns });
}

// POST /api/leads/columns — { entity, name, type }
export async function POST(req: NextRequest) {
  try {
    return await withOrgContext(req, () => create(req));
  } catch (err) {
    return columnErrorResponse(err);
  }
}

async function create(req: NextRequest) {
  let body: { entity?: string; name?: string; type?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.entity || !isLeadEntity(body.entity)) {
    return NextResponse.json({ error: "entity must be 'person' or 'company'" }, { status: 400 });
  }
  if (!body.name?.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  // Validate against the type map rather than a separate list, so adding a
  // type in one place cannot leave the other behind.
  if (!body.type || !(body.type in PG_TYPE_FOR_COLUMN_TYPE)) {
    return NextResponse.json({ error: `Unsupported column type: ${body.type}` }, { status: 400 });
  }

  try {
    const column = await addColumn({
      entity: body.entity,
      name: body.name,
      type: body.type as LeadColumnType,
    });
    return NextResponse.json({ column }, { status: 201 });
  } catch (err) {
    return columnErrorResponse(err);
  }
}
