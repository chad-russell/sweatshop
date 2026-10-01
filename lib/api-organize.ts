import { NextResponse } from "next/server";
import { OrganizeError } from "../db/organize";

const STATUS = {
  "not-found": 404,
  invalid: 400,
  "cross-group": 409,
  cycle: 409,
  "duplicate-name": 409,
} as const;

/** Map a store error to a JSON response; unknown errors become 500. */
export function organizeErrorResponse(err: unknown): NextResponse {
  if (err instanceof OrganizeError) {
    return NextResponse.json(
      { error: err.message, code: err.code },
      { status: STATUS[err.code] },
    );
  }
  console.error("[organize] unexpected failure", err);
  return NextResponse.json({ error: "internal error" }, { status: 500 });
}

/** Parse a JSON object body; throws an `invalid` OrganizeError otherwise. */
export async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    if (body && typeof body === "object" && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  throw new OrganizeError("invalid", "expected a JSON object body");
}

/** string | null (explicit null clears); undefined = key absent. */
export function nullableString(
  body: Record<string, unknown>,
  key: string,
): string | null | undefined {
  if (!(key in body)) return undefined;
  const value = body[key];
  if (value === null) return null;
  if (typeof value === "string") return value;
  throw new OrganizeError("invalid", `${key} must be a string or null`);
}

export function optionalBoolean(
  body: Record<string, unknown>,
  key: string,
): boolean | undefined {
  if (!(key in body)) return undefined;
  if (typeof body[key] === "boolean") return body[key] as boolean;
  throw new OrganizeError("invalid", `${key} must be a boolean`);
}
