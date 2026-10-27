# 0085 — Dependency refresh

Status: approved and implemented in chat, 2026-10-26.

## Scope

Update all direct npm dependencies and development dependencies to their
current `latest` releases, regenerate `package-lock.json`, and make only
the compatibility changes required to preserve existing behavior. Preserve
exact pins where the manifest already uses them and caret ranges elsewhere.
Refresh the pinned sandbox tools and GitHub CLI in the container files too.
Do not add features or change the Node 24 runtime. After the first install
exposed upstream TypeScript 7 / ESLint incompatibilities, the owner approved
replacing ESLint with Biome in chat. This supersedes the ESLint upgrade
target below and authorizes adding `@biomejs/biome` 2.6.3 while removing
`eslint`, `eslint-config-next`, and their configuration.

Biome runs through the existing `npm run lint` gate. Disable its formatter,
assist/import sorting, and style-only rules to avoid a repository-wide
rewrite. Preserve generated/vendor exclusions and the component-to-database
import restriction. Retain useful correctness, React, and accessibility
checks, documenting deliberate compatibility exceptions. Keep TypeScript 7
without introducing a TypeScript 6 compatibility alias. Biome is not an
exact replacement for every Next/React Compiler ESLint rule; document that
coverage difference rather than claiming parity.

## Release targets

Registry metadata checked on 2026-10-26. The coupled runtime packages move
together:

| Package | Current | Target |
| --- | --- | --- |
| `ai` | 7.0.130 | 7.0.154 |
| `@ai-sdk/react` | ^4.0.116 | ^4.0.158 |
| `@ai-sdk/provider-utils` | 5.0.56 | 5.0.69 |
| `@ai-sdk/openai-compatible` | 3.0.59 | 3.0.79 |
| `@ai-sdk/harness` | 1.0.141 | 1.0.165 |
| `@ai-sdk/harness-claude-code` | 1.0.145 | 1.0.169 |
| `@ai-sdk/harness-codex` | 1.0.143 | 1.0.167 |
| `@ai-sdk/harness-cursor` | 1.0.55 | 1.0.79 |
| `@ai-sdk/harness-pi` | 1.0.143 | 1.0.168 |
| `@ai-sdk/workflow-harness` | 1.0.141 | 1.0.165 |
| `@ai-sdk/workflow` | 2.0.62 | 2.0.86 |
| `workflow` | 5.0.0-beta.58 | 5.2.3 |
| `@workflow/builders` | 5.0.0-beta.58 | 5.0.6 |
| `@earendil-works/pi-coding-agent` | 0.85.1 | 1.4.0 |

Other notable updates: Next.js to 16.4.3, React and
React DOM to 19.3.1, TypeScript to 7.0.2, Biome to 2.6.3, Motion to
14.6.0, `@streamdown/code` to 2.0.0, and `@types/node` to 26.6.5.
The Node types update does not authorize using APIs absent from Node 24.
Remaining direct dependencies also move to `latest` unless already there.
Container tool targets: pnpm 12.15.0, agent-browser 0.39.4, GitHub CLI
2.103.3. Base images retain the existing Node 24 tag.

## Compatibility constraints

- Latest harness adapters share harness 1.0.165, AI SDK 7.0.154, and
  provider-utils 5.0.69. Keep that line aligned rather than overriding
  incompatible peer requirements.
- Latest Workflow integrations require `workflow ^5.1.0`; the stable
  5.2.3 release satisfies them. Inspect installed migration notes and
  version-matched source for durable-stream and serialization changes.
   Do not run migrations against application data or initialize existing
   Workflow state as part of verification. See the accepted deployment
   caveat below for the old-layout journals.
- Latest pi adapter declares `pi-coding-agent ^1.0.3`, admitting 1.4.0.
  The old 0.85.1 pin protected an older adapter's imports, not this new
  line. Verify the adapter imports and existing pi tests after installation.
- Inspect TypeScript 7, Biome, Motion 14, and Streamdown code 2
  changes before adapting callers or configuration. Do not suppress checks
  or weaken tests to get the upgrade through.
- Update the current packaging contract in `AGENTS.md` after verification;
  historical numbered design documents remain unchanged.

## Verification and stop condition

Install and run checks inside the existing container workflow (`./dev`).
Run `npm run typecheck`, `npm run lint`, `npm run test`, and a production
build. Tests use existing mock models and temporary databases; do not
enable credentialed live spikes. Report any live harness or browser
behavior that these checks cannot verify.

Check that all direct dependencies match the selected latest releases and
that the lockfile resolves without forced or legacy peer installation.
Stop when checks pass and changes are limited to dependency updates,
necessary compatibility fixes, and the packaging documentation. If a
release needs a broader redesign or cannot preserve current behavior,
report the blocker and seek a decision rather than silently retaining an
older version or expanding scope. No deployment or merge is included.

## Storage-layout deployment caveat

Latest `@workflow/world-local` stores events and steps under per-run
subdirectories. Its `initDataDir` deletes an existing directory containing
only old flat-layout files; it does not migrate them. This violates the
original preserve-journals goal. No migration or deletion of application
data has been run.

The owner explicitly chose to continue the upgrade without offline
migration infrastructure after being informed of this deletion behavior
(chat, 2026-10-26). No migration or startup guard is added. Initializing the
new SDK against an old-layout directory will clear that Workflow store;
this does not migrate or delete the SQLite chat history, but live runs and
durable streams in the old journal will be lost. Back up the Workflow data
directory before deployment if those journals need to be retained.

The attachment canary test inspects the new per-run event directory while
keeping its positive controls and no-image-bytes assertions unchanged.

## Compatibility changes and verification

- Containerized gate passes: typecheck, Biome lint (27 warnings on existing
  code), and 1,330 tests (123 files; 16 opt-in tests skipped). The production
  build passes with build-time typechecking enabled. Credentialed model,
  harness, and host spikes remain off.
- WorkflowAgent now preserves URLs during workflow-side prompt conversion
  and passes custom download callbacks into the model step. Remove the
  redundant inline `experimental_download` callback, which is not
  serializable; keep `SerializableChatModel.supportedUrls` and resolve
  attachment bytes only inside the model step. Attachment, usage, approval,
  steering, loop-guard and durable-stream regression tests pass.
- Externalize Codex, Cursor/ACP and ssh2 in Next and the test executor, just
  like the existing harness packages: their bridge assets/native binaries
  cannot be bundled by Turbopack.
- Biome retains the recommended correctness/suspicious/accessibility checks
  and the component/store boundary. Style/complexity presets, formatting,
  import sorting and semantic-element rewrites are disabled. Configure
  shadcn input components for label analysis; preserve existing local hook
  and image suppressions in Biome syntax. New stricter checks on existing
  UI/test code remain warnings rather than requiring unrelated rewrites.
  ANSI control-character regexes and exhaustive TypeScript union switches
  receive narrow exceptions. Six regression tests exercise the real Biome
  CLI to prove store imports (including deep and type-only imports) fail in
  components and read-model/server imports remain allowed.
- Registry verification: all 51 direct dependencies resolve to `latest`.
  Compatible transitive updates move DOMPurify to 3.4.17, fast-uri to 3.1.9,
  ip-address to 10.7.5, and zhipu's undici to 6.29.1. No forced peer
  installation, security overrides, or dependency downgrades are used.
- `npm audit --omit=dev` still reports 34 affected entries (24 high, 3
  moderate, 7 low; zero critical). Root advisories remain in upstream-pinned
  undici/Zod versions and KaTeX (no published fix); fixing those requires
  upstream releases or a separately considered override, not `audit fix
  --force` downgrades of the runtime.
- The dev image builds successfully. Native Linux ARM64 sandbox builds stop
  at `agent-browser install`: Chrome for Testing publishes no Linux ARM64
  binary. This is a platform limitation, not a package-resolution failure.
  The deployment's Linux AMD64 sandbox builds successfully, including Chrome
  installation and the bundled browser skill; its pnpm and agent-browser
  version commands confirm 12.15.0 and 0.39.4 respectively.
