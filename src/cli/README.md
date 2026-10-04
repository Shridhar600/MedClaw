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