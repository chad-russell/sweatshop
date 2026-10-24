import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { createCodex } from "@ai-sdk/harness-codex";
import { createCursor } from "@ai-sdk/harness-cursor";
import { createPi } from "@ai-sdk/harness-pi";
import { isStepCount, type ToolSet } from "ai";
import { codexCredential } from "@/lib/harness-auth/codex";
import type { ModelInfo } from "@/lib/providers/catalog";
import { piProviderConfig } from "@/lib/providers/registry";
import type { HarnessRoute } from "@/lib/providers/route";
import { harnessBridgePort } from "@/lib/sandboxes/harness-bridge";

/**
 * The one HarnessAgent builder (0009 harness stages; the chat pi/claude
 * path since 0022; machine stages deleted by 0037 phase 5). Called
 * fresh inside every workflow step (Node-only; never imported by the
 * workflow body). `stopWhen: isStepCount(1)` makes one `stream()` = one
 * agent step — the semantic-step durability grain the doc decided.
 */

export interface BuildArgs {
  /** 0021: the resolved, validated route — decides harness, provider, model. */
  route: HarnessRoute;
  /** Harness session id (0010 chat: the conversation id; 0083: a lane's
   *  own distinct session id). */
  sessionId: string;
  /** 0083: a lane — rooted at this sandbox-relative dir instead of the
   *  sandbox cwd ("."). */
  dir?: string;
  /** 0083: the lane bridge port the claim granted (bridge-backed kinds
   *  only) — overrides the kind's fixed `HARNESS_BRIDGE_PORTS` entry. */
  port?: number;
  /** Host tools (create_pr, …). */
  tools: ToolSet;
  /** pi model sizing, when the caller knows it (catalog entry). */
  modelInfo?: ModelInfo;
  /** 0062: lifecycle taps. The workflow-harness UI stream drops each
   *  step's cache split and the harness's reported cost; these callbacks
   *  see the full `usage` + `providerMetadata` (settings-level, so they
   *  fire for every stream()/continueStream()). */
  onStepEnd?: (step: { usage?: unknown; providerMetadata?: unknown }) => void;
  onEnd?: (event: { totalUsage?: unknown; providerMetadata?: unknown }) => void;
  /** 0062: sees each stream()/continueStream() result. The terminal
   *  `finish` part's harness metadata (Claude's reported cost) is only
   *  exposed as the result's `providerMetadata` promise — the end
   *  callback carries the LAST finish-step's metadata instead. */
  onResult?: (result: { providerMetadata?: PromiseLike<unknown> }) => void;
}

/** Proxy that lets `onResult` see every stream result; everything else
 *  passes straight through (methods bound to the real agent). */
function tapResults<T extends object>(agent: T, onResult: BuildArgs["onResult"]): T {
  if (!onResult) return agent;
  return new Proxy(agent, {
    get(target, key) {
      const value = Reflect.get(target, key, target) as unknown;
      if (typeof value !== "function") return value;
      if (key === "stream" || key === "continueStream") {
        return async (...args: unknown[]) => {
          const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          onResult(result as never);
          return result;
        };
      }
      return value.bind(target);
    },
  });
}

/** pi provider ids are namespaced so they never collide with pi's built-ins. */
const PI_PROVIDER_PREFIX = "ss-";

export function buildHarnessAgent(args: BuildArgs) {
  return tapResults(buildAgent(args), args.onResult);
}

function buildAgent({ route, sessionId, tools, modelInfo, onStepEnd, onEnd, dir, port }: BuildArgs) {
  const lifecycle = {
    ...(onStepEnd ? { onStepEnd: onStepEnd as never } : {}),
    ...(onEnd ? { onEnd: onEnd as never } : {}),
  };
  // 0083: a lane runs rooted at its own sandbox-relative dir instead of
  // the sandbox cwd; the default lane keeps "." bit-identical to pre-0083.
  const workDir = dir ?? ".";
  if (route.harness === "pi") {
    // 0021: only the route's provider is registered, with the model
    // declared explicitly — pi never needs its built-in catalog to know
    // a Gloo or OpenRouter id.
    const piProvider = `${PI_PROVIDER_PREFIX}${route.provider}`;
    return new HarnessAgent({
      harness: createPi({
        providers: { [piProvider]: piProviderConfig(route.provider, route.model, modelInfo) as never },
        thinkingLevel: route.thinking ?? "low",
        // No Gloo tool-description fix needed here: harness-pi already
        // gives every host tool a description (verified live, 2026-10-08 —
        // pi on Gloo with an undescribed host tool round-trips).
      }),
      id: `pi-${sessionId}`,
      model: `${piProvider}/${route.model}`,
      // Without a workDir the harness gives every session a private
      // `<harness>-<sessionId>` directory — sessions would not see each
      // other's work. "." = the sandbox cwd, the workspace root.
      sandboxConfig: { workDir },
      tools,
      ...lifecycle,
      stopWhen: isStepCount(1),
    });
  }
  if (route.harness === "cursor") {
    // 0038: subscription only — the browser-login auth.json is planted in
    // the sandbox by the call step (lib/harness-auth/cursor.ts), and the
    // CLI authenticates from that file. Default `auth` (auto) on purpose —
    // it is what the 0038 spike proved; `direct` makes the adapter MORE
    // eager to resolve its native subscription (forwarding the access
    // token as CURSOR_API_KEY, which the CLI rejects), and warns. With no
    // CURSOR_API_KEY in this process env the shortcut finds nothing to
    // forward, so the planted file is what authenticates. The route
    // contributes only the model.
    return new HarnessAgent({
      harness: createCursor({ port: port ?? harnessBridgePort("cursor") }),
      id: `cursor-${sessionId}`,
      ...(route.model ? { model: route.model } : {}),
      sandboxConfig: { workDir },
      tools,
      ...lifecycle,
      stopWhen: isStepCount(1),
    });
  }
  if (route.harness === "codex") {
    // 0050: read the credential fresh per call — a 401-stale file fails
    // here, value-shaped, instead of as an opaque bridge error later.
    // Auth is env-carried: the adapter resolves the ChatGPT subscription
    // from CODEX_HOME/auth.json (refreshed in place, wiring lives in
    // instrumentation-node) and forwards CODEX_API_KEY/OPENAI_BASE_URL
    // to the bridge. No file is planted in the sandbox (unlike cursor).
    // `auth` left default (auto): with no OPENAI_API_KEY/CODEX_API_KEY/
    // AI_GATEWAY_API_KEY in this process, auto resolves to the native
    // subscription — the only mode we offer, and (0050 review) a
    // checked fact: the guard below fails fast if any shadowing key
    // IS set.
    const shadowing = ["OPENAI_API_KEY", "CODEX_API_KEY", "AI_GATEWAY_API_KEY", "VERCEL_OIDC_TOKEN"].filter(
      (name) => process.env[name],
    );
    if (shadowing.length > 0) {
      throw new Error(
        `${shadowing.join(", ")} ${shadowing.length === 1 ? "is" : "are"} set — codex runs on the ChatGPT login; unset ${shadowing.length === 1 ? "it" : "them"} (they shadow the subscription; docs/0050)`,
      );
    }
    const credential = codexCredential();
    if (!credential.ok) throw new Error(credential.message);
    return new HarnessAgent({
      harness: createCodex({
        port: port ?? harnessBridgePort("codex"),
        ...(route.effort ? { reasoningEffort: route.effort } : {}),
      }),
      id: `codex-${sessionId}`,
      // Unset model would send the adapter's stale DEFAULT_CODEX_MODEL
      // (gpt-5.5), which the backend rejects on ChatGPT subscriptions
      // (live 2026-10-19) — the route default pins gpt-5.6-sol, and
      // validation rejects a bare codex route, so this spread is a
      // defensive shape, not the way a route runs.
      ...(route.model ? { model: route.model } : {}),
      // The enterprise account header: the adapter's own injection path
      // (sandbox addRequestTransformations) does not exist on our network
      // session, but the agent's `headers` is the designed seam — they
      // ride the bridge start message (verified in adapter source).
      ...(credential.accountId ? { headers: { "ChatGPT-Account-ID": credential.accountId } } : {}),
      sandboxConfig: { workDir },
      tools,
      ...lifecycle,
      stopWhen: isStepCount(1),
    });
  }
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) {
    throw new Error("claude is not configured — set CLAUDE_CODE_OAUTH_TOKEN (claude setup-token)");
  }
  return new HarnessAgent({
    // 0006 amendment: setup-token through the env channel, direct route.
    // The bridge endpoint comes from the network sandbox session's
    // getPortEndpoint (0013) — joined to the harness network on demand.
    // 0021: subscription only — the route contributes model/effort, never
    // an endpoint.
    harness: createClaudeCode({
      auth: "direct",
      port: port ?? harnessBridgePort("claude"),
      env: { CLAUDE_CODE_OAUTH_TOKEN: token },
      ...(route.effort ? { effort: route.effort } : {}),
    }),
    id: `claude-${sessionId}`,
    ...(route.model ? { model: route.model } : {}),
    // "." = the sandbox cwd, the workspace root (shared across calls).
    sandboxConfig: { workDir },
    tools,
    ...lifecycle,
    stopWhen: isStepCount(1),
  });
}
