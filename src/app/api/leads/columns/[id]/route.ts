import { NextRequest, NextResponse } from "next/server";
import { withOrgContext } from "@/lib/auth/context";
import {
  archiveColumn,
  changeColumnType,
  dropColumn,
  moveColumn,
  renameColumn,
  unarchiveColumn,
} from "@/lib/leads/columns";
import { PG_TYPE_FOR_COLUMN_TYPE, type LeadColumnType } from "@/lib/leads/types";
import { columnErrorResponse } from "../errors";

/**
 * PATCH /api/leads/columns/[id]
 *   { name }      rename — registry only
 *   { type }      retype — converts stored values, refused if any cannot convert; preview it first
 *   { position }  reorder — registry only
 *   { archived }  soft delete / restore
 *
 * One field at a time: a rename and a retype have very different costs and
 * failure modes, and batching them would hide which one failed.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let body: { name?: string; type?: string; position?: number; archived?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  try {
    return await withOrgContext(req, async () => {
      if (typeof body.name === "string") {
        return NextResponse.json({ column: await renameColumn(id, body.name) });
      }
      if (typeof body.type === "string") {
        if (!(body.type in PG_TYPE_FOR_COLUMN_TYPE)) {
          return NextResponse.json({ error: `Unsupported column type: ${body.type}` }, { status: 400 });
        }
        return NextResponse.json({ column: await changeColumnType(id, body.type as LeadColumnType) });
      }
      if (typeof body.position === "number") {
        return NextResponse.json({ column: await moveColumn(id, body.position) });
      }
      if (typeof body.archived === "boolean") {
        const column = body.archived ? await archiveColumn(id) : await unarchiveColumn(id);
        return NextResponse.json({ column });
      }
      return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
    });
  } catch (err) {
    return columnErrorResponse(err);
  }
}

/**
 * DELETE /api/leads/columns/[id]?permanent=true
 *
 * Without the flag this is a no-op guard rather than a soft delete: removing a
 * column is a PATCH { archived: true }, and DELETE is reserved for the
 * irreversible permanent delete. Making the destructive verb require an explicit
 * flag means a stray DELETE cannot destroy a column's data.
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  if (req.nextUrl.searchParams.get("permanent") !== "true") {
    return NextResponse.json(
      { error: "Use PATCH { archived: true } to remove a column, or pass ?permanent=true to delete its values" },
      { status: 400 },
    );
  }

  try {
    return await withOrgContext(req, async () => {
      await dropColumn(id);
      return NextResponse.json({ ok: true });
    });
  } catch (err) {
    return columnErrorResponse(err);
  }
}
