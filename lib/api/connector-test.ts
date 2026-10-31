/** 0090 §2: the connector [Test] endpoint. */

import { apiFetch, jsonInit } from "./core";

export interface ConnectorTestResult {
  ok: boolean;
  detail: string;
}

export type ConnectorTestResponse = ConnectorTestResult | { error: string };

export async function testConnectorRequest(connector: string): Promise<ConnectorTestResponse> {
  const res = await apiFetch<ConnectorTestResult>("/api/settings/test", jsonInit("POST", { connector }));
  if (res.ok && res.body) return res.body;
  const error = (res.body as { error?: string } | null)?.error;
  return { error: error ?? `test failed (${res.status})` };
}
