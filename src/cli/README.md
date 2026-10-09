# cli

**Purpose:** The local operator surface. Turns argv into a call on an installation service and prints
the result. It decides nothing about identity, leases or ownership — it resolves which installation
the operator selected, then hands over.

This module is the TOP of the dependency stack. Nothing in `src/` imports it.

## Public surface

`index.ts` is the executable entry point (`bin/medclaw`, run via `require.main === module`), not a
re-export barrel. It exports:

- `runCli(argv, io?)` — the whole command router. Returns an exit code and never throws for an
  expected refusal. `io` is injected (`stdout`/`stderr`), so every command is testable without a TTY.
- `CliIO` (from `prompts.ts`) — the output seam.

The commands are `onboard`/`init`, `status`, `config show`, `config set`, `profile show`,
`user summary`, `heartbeats list`, and `pairing issue`.

Everything else here is private: `admin.ts` (inspection and the `config set` writer),
`setup-config.ts` (argument/config building shared by the wizard and the service entry),
`service-onboarding.ts` (non-interactive entry), `setup-wizard.ts` + `wizard-*.ts` (interactive),
`setup-readiness.ts` (readiness summary lines).

## Configuration selection happens exactly once

`runCli` resolves the selected configuration document a single time, via `selectConfigPath`, before
dispatching any command, and passes the resolved absolute path down explicitly.

This is load-bearing, not tidiness. The locked precedence is
`--config > REDACTED_CONFIG_PATH > ~/.redacted/config.json`, and the CLI used to re-derive it by hand
as `configPath ?? defaultRuntimeConfigPath()` at eight call sites across this module and `admin.ts`.
That expression silently skips the environment step, so a daemon could serve one installation while
`status`, `config show`, `config set` and `pairing issue` read or mutated another. `onboard` went
further and manufactured a `--config` flag containing the default, which by the precedence outranked
the environment outright.

Consequences of the single resolution point:

- Every downstream helper takes a **required** resolved path, so there is no second place to
  reintroduce a fallback.
- In `admin.ts`, any function still called without a path resolves via `selectConfigPath()` rather
  than the home default, so direct callers honour the environment too.
- A present-but-empty `--config` is a usage error, and a relative value resolves against the cwd.
  Both used to fall through silently.

`tests/cli/config-selection.test.ts` proves this through the real `runCli` with two complete
installations on disk.

## Setup parsing is strict, and refuses before touching disk

`parseArgs` (`setup-config.ts`) is the only parser for the setup command. It refuses, naming the
field and the reason and never the supplied value:

- an unknown option;
- an unexpected bare token;
- a missing, blank, or option-shaped value (`--config --yes`, a trailing `--config`);
- an explicit provider outside `ollama|openai|openrouter`, an unparseable boolean, or a
  non-http(s) endpoint.

Every one of those refusals happens **before** the wizard, and before any lease, directory,
template, record or config write. That is why `runServiceOnboarding` parses first and branches to
the wizard second.

A malformed later `--config` must refuse rather than clear the selection: the injected
`--config <selected>` from `runCli` must never be overwritten with "absent", because
`resolveSetupValues` would then fall back to the home default. A *valid* later `--config` is still
honoured, so the last explicit occurrence wins.

Global parsing throws, so `runCli` calls `parseGlobalOptions` and `selectConfigPath` **inside** its
try/catch. Outside it, an operator typo produced an unhandled rejection instead of an exit code.

## Provider roles are independent selections

Main, medical and embeddings are three separate roles with separate provider, model, endpoint and
key. The relevant rules, enforced in one place (`buildProviderRole` in `setup-config.ts`):

- embeddings default to the **local Ollama** role even when main is cloud. They are not dragged
  along by the chat provider;
- each cloud role uses its own explicit key, then that provider's own environment variable. Main and
  embeddings never share a key. The one exception is the MEDICAL role: opting it into a cloud provider
  reuses the operator's `--api-key` (inherited forka #11 behavior, preserved by this slice and
  reported as a known cross-provider key reuse rather than fixed here);
- `--ollama-url` is the LOCAL role control. It never becomes a cloud role's endpoint;
- an explicit `--embedding-url` wins for the embedding role; otherwise a local embedding role uses
  `--ollama-url`/the local default and a cloud embedding role uses its own provider default;
- OpenRouter's router endpoint is pinned for the MAIN and EMBEDDING roles when either selects
  OpenRouter, because it has no SDK default of its own. The MEDICAL role does not pin it; the
  adapter resolves the router URL itself at runtime, so a medical OpenRouter document simply omits
  `baseUrl`.

The wizard has a separate **Embedding role** step and a separate "Edit embeddings" review action, so
choosing embeddings is never a side effect of answering the chat-provider step. Changing the main
provider does not touch the embedding role; changing the embedding provider drops the previous
role's endpoint and key so nothing role-incompatible survives.

## Public exports added

`src/providers/index.ts` exists solely to publish `OPENROUTER_DEFAULT_BASE_URL`. Setup needs the
OpenRouter endpoint, and importing `providers/openai.ts` directly from the CLI pulled a private
adapter module across a public boundary.

## Coordination

Setup is additive and never overwrites. It refuses a pre-existing config document, owner record or
non-empty owner workspace, and it does all of that **while holding both installation leases** — the
work lives in `InstallationService.setup()` (`src/runtime/installation.ts`), not here.

`persistSetupArtifacts` in `setup-config.ts` is a thin adapter over that service: CLI in, CLI
refusal text out. No writer logic belongs in this module. Both callers need it — `service-onboarding`
prints the refusal, and `setup-wizard`'s retry loop catches it, reports it and lets the operator
adjust the target.

`config set` and `pairing issue` take the config/owner leases the same way, so a running daemon
refuses the command rather than two writers racing on the same document.

Setup publishes the configuration document LAST and only after the required owner record was confirmed
created. A record outcome that is not a confirmed `created` stops setup with no config document and no
success line. It is `incomplete` when setup reached a real attempt and could not confirm it — a
publication that may or may not have happened, or a refusal to write into a target that was fresh — and
`not-fresh` when there was pre-existing owner evidence to protect, which covers an `exists` or
`unavailable` record. Either way the operator is told to inspect rather than given a fresh-install
reset. `pairing issue` describes only what it knows: a definite pre-publication refusal prints that the
previous record is unchanged, while an unconfirmed publication asserts NEITHER direction, because the
same lost-acknowledgement case can mean the record was replaced or that nothing was written at all. It
never shows a code.

`src/cli/` must stay acyclic (`no-circular-cli` in `.dependency-cruiser.cjs`). `setup-config.ts`
exists so the wizard and the service entry never import each other.

## Dependencies

`../runtime` (installation services, config selection, lease adapters), `../config` (decode, defaults,
field validation), `../profiles` (owner identity and admission), `../ports`, `../security`, and legacy
core only where a command genuinely needs it. This module sits above all of them.

## Extraction notes

Copy `src/cli/` plus `src/runtime/`, `src/config/`, `src/profiles/`, `src/ports/`, `src/security/` and
`../workspace/bootstrap`. The CLI is the composition surface for local administration, so it is
expected to know about the services it drives — but it holds no policy of its own. If a rule starts
being enforced here rather than in the service behind it, that rule is in the wrong module.

The proper shared-core REPL is deferred to P3. The obsolete dev chat writer was removed once the
verified Telegram owner cutover landed, so there is deliberately no interactive chat surface here
today — `handleTestMessage` on the Gateway is a test seam, not a CLI channel, and it still runs the
same admission policy as a transport.