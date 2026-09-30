import { notFound, permanentRedirect } from "next/navigation";
import { getHarnessRun } from "@/lib/harness-events";

export const dynamic = "force-dynamic";

/**
 * Legacy one-segment /h/<eveSessionId> (0005, when pi was the only
 * harness): permanent-redirect to /h/pi/<id> when a pi run exists.
 * Canonical URLs are two segments — see [sessionId]/page.tsx.
 */
export default async function LegacyHarnessPage({
  params,
}: {
  params: Promise<{ harness: string }>;
}) {
  const { harness: legacySessionId } = await params;
  if (getHarnessRun(legacySessionId, "pi")) {
    permanentRedirect(`/h/pi/${legacySessionId}`);
  }
  notFound();
}
