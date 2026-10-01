import { NextResponse } from "next/server";
import { MachineError } from "../../db/machines";

/** Map a machines-store error to JSON; unknown errors become 500. */
export function machineErrorResponse(err: unknown): NextResponse {
  if (err instanceof MachineError) {
    return NextResponse.json(
      { error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) },
      { status: err.code === "not-found" ? 404 : 400 },
    );
  }
  console.error("[machines] unexpected failure", err);
  return NextResponse.json({ error: "internal error" }, { status: 500 });
}

/** Parse a JSON object body; throws an `invalid` MachineError otherwise. */
export async function readMachineBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    if (body && typeof body === "object" && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  throw new MachineError("invalid", "expected a JSON object body");
}
