import { NextResponse } from "next/server";
import { authContextErrorResponse } from "@/lib/auth/context";
import { ColumnError } from "@/lib/leads/columns";

/**
 * A ColumnError is a message written for the user — a name collision, a busy
 * table, a protected core column. Anything else is a bug and must not have
 * its message forwarded, because driver errors inline the failing SQL.
 */
export function columnErrorResponse(err: unknown) {
  const auth = authContextErrorResponse(err);
  if (auth) return auth;
  if (err instanceof ColumnError) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  console.error("[leads/columns]", err);
  return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
}
