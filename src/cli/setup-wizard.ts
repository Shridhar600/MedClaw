import * as fs from 'fs';
import * as path from 'path';
import { buildReadinessSummaryLines, printableEndpoint, showRedactedConfigSummary } from './admin';
import type { CliIO } from './prompts';
import { askYesNo } from './prompts';
import {
  buildConfigFromArgs,
  collectSetupErrors,
  modelDefaultsForProvider,
  persistSetupArtifacts,
  providerLabel,
  requireHttpEndpoint,
  SUPPORTED_ONBOARDING_PROVIDERS,
  requireOwnerId,
  resolveNonInteractiveArgs,
  resolveSetupPath,
  requiredCloudEnv,
} from './setup-config';
import { OPENROUTER_DEFAULT_BASE_URL } from '../providers';
import { LOCAL_OLLAMA_BASE_URL } from '../config';
import {
  getMissingOllamaModels,
  verifyTelegramRuntime,
  type SetupReadinessDependencies,
} from './setup-readiness';
import { askCompletionAction, askReviewAction, askSecret, askChoice, askValue } from './wizard-prompts';
import {
  renderCompletionDivider,
  renderSectionHeader,
  renderStatus,
  renderStepHeader,
  renderSummaryRows,
  renderWizardBanner,
  writeLine,
} from './wizard-render';
import type { SetupWizardState, CompletionAction, ReviewAction } from './wizard-types';
import { checkSystemReadiness } from '../providers/healthcheck';
import { probeOllamaCatalog } from '../providers/healthcheck';
import { validateConfig } from '../config/validation';
import type { EffectiveConfig, ProviderConfig } from '../config/types';
import { listWorkspaceTemplateFiles } from '../workspace/bootstrap';
import { resolveOwnerPaths } from '../profiles';

const TOTAL_STEPS = 5;

function shouldRunLiveChecks(io: CliIO, options?: SetupReadinessDependencies): boolean {
  if (options?.fetchImpl) {
    return true; // caller injected a fetch — checks are hermetic
  }
  if (io.input) {
    return false; // injected IO (unit tests / programmatic callers)
  }
  // Live network checks only for a real interactive terminal. A piped stdin
  // (scripted onboard, CI) cannot answer validation re-prompts, and the
  // checks would make non-interactive runs depend on network reachability.
  return process.stdin.isTTY === true;
}

function validateWritablePath(targetPath: string, kind: 'state' | 'config'): string[] {
  const errors: string[] = [];
  try {
    const directory = kind === 'state' ? targetPath : path.dirname(targetPath);
    let probeDirectory = directory;
    while (!fs.existsSync(probeDirectory)) {
      const parent = path.dirname(probeDirectory);
      if (parent === probeDirectory) {
        break;
      }
      probeDirectory = parent;
    }
    const stat = fs.statSync(probeDirectory);
    if (!stat.isDirectory()) {
      throw new Error(`${probeDirectory} is not a directory`);
    }
    fs.accessSync(probeDirectory, fs.constants.W_OK);
  } catch (error) {
    errors.push(
      `${kind === 'state' ? 'Owner state' : 'Config directory'} is not writable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return errors;
}

function stateToArgs(state: SetupWizardState) {
  return resolveNonInteractiveArgs({
    configPath: state.configPath,
    stateRoot: state.stateRoot,
    ownerId: state.ownerId,
    provider: state.provider,
    mainModel: state.mainModel,
    medicalModel: state.medicalModel,
    // The whole R05 round trip: provider, endpoint and key travel with the state, so an explicit
    // embedding selection survives resolution, build, serialization and reload. Before this,
    // `stateToArgs` carried only `embeddingModel`, and the role's provider/endpoint/key were lost
    // the moment the operator pressed Apply.
    embeddingProvider: state.embeddingProvider,
    embeddingModel: state.embeddingModel,
    embeddingUrl: state.embeddingUrl,
    embeddingApiKey: state.embeddingApiKey,
    ollamaUrl: state.ollamaUrl,
    apiKey: state.apiKey,
    telegramEnabled: state.telegramEnabled,
    telegramToken: state.telegramToken,
    timezone: state.timezone,
    heartbeatsEnabled: state.heartbeatsEnabled,
  });
}

async function buildReviewStateWithOptions(
  state: SetupWizardState,
  allowNetworkChecks: boolean,
  options: SetupReadinessDependencies = {},
): Promise<{
  args: ReturnType<typeof stateToArgs>;
  config: EffectiveConfig;
  validation: ReturnType<typeof validateConfig>;
  readiness: Awaited<ReturnType<typeof checkSystemReadiness>>;
  errors: string[];
}> {
  const args = stateToArgs(state);
  const config = buildConfigFromArgs(args);
  return {
    args,
    config,
    validation: validateConfig(config),
    readiness: await checkSystemReadiness(config, {
      allowNetworkChecks,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    }),
    errors: collectSetupErrors(args, config),
  };
}

async function runEnvironmentStep(io: CliIO, state: SetupWizardState): Promise<void> {
  renderStepHeader(io, 1, TOTAL_STEPS, 'Environment Check');
  renderStatus(io, 'INFO', `Config path: ${state.configPath}`);
  renderStatus(io, 'INFO', `Node.js found: ${process.version}`);
  renderStatus(io, 'OK', 'Setup wizard is ready');
}

/**
 * The owner chooses the STATE ROOT and the OWNER ID. Everything else about their location is
 * derived, so there is no second path authority that can disagree with the first.
 */
async function runStateStep(io: CliIO, state: SetupWizardState): Promise<void> {
  renderStepHeader(io, 2, TOTAL_STEPS, 'Owner state');

  state.stateRoot = resolveSetupPath(await askValue(io, 'Owner state root', state.stateRoot));
  state.ownerId = (await askValue(io, 'Owner ID', state.ownerId)).trim();

  try {
    requireOwnerId(state.ownerId);
    state.ownerId = state.ownerId.trim();
  } catch (error) {
    renderStatus(io, 'WARN', error instanceof Error ? error.message : String(error));
  }

  const ownerPaths = resolveOwnerPaths(state.stateRoot, requireOwnerId(state.ownerId));
  const pathErrors = validateWritablePath(state.stateRoot, 'state');
  if (pathErrors.length === 0) {
    renderStatus(io, 'OK', 'Owner state directory is writable.');
  } else {
    for (const error of pathErrors) {
      renderStatus(io, 'WARN', error);
    }
  }
  renderStatus(io, 'INFO', `Derived owner workspace: ${ownerPaths.workspace}`);
  renderStatus(io, 'INFO', `Template files: ${listWorkspaceTemplateFiles().join(', ')}`);
}

/**
 * The MAIN role step.
 *
 * R05: a change to the MAIN provider no longer touches the embedding role at all. It used to
 * overwrite `state.embeddingModel` from the main provider's cloud defaults, which silently moved
 * embeddings to cloud behind the operator's back.
 */
async function runProviderStep(io: CliIO, state: SetupWizardState): Promise<void> {
  renderStepHeader(io, 3, TOTAL_STEPS, 'Provider Selection');
  const previousProvider = state.provider;
  state.provider = await askChoice<ProviderConfig['type']>(
    io,
    'Provider type',
    SUPPORTED_ONBOARDING_PROVIDERS,
    state.provider,
  );

  if (state.provider !== previousProvider) {
    const defaults = modelDefaultsForProvider(state.provider);
    state.mainModel = defaults.main;
    state.medicalModel = defaults.medical;
    // The embedding role is deliberately NOT touched here. It has its own step.
    if (state.provider === 'ollama') {
      state.ollamaUrl = state.ollamaUrl ?? LOCAL_OLLAMA_BASE_URL;
      state.apiKey = undefined;
    } else {
      state.ollamaUrl = undefined;
    }
  }

  if (state.provider !== 'ollama') {
    const requiredEnv = requiredCloudEnv(state.provider);
    if (process.env[requiredEnv]?.trim()) {
      renderStatus(io, 'INFO', `Using ${requiredEnv} from the environment.`);
    } else {
      for (;;) {
        state.apiKey = await askSecret(io, `${providerLabel(state.provider)} API key`, state.apiKey ?? '');
        if (state.apiKey?.trim()) {
          break;
        }
        renderStatus(io, 'WARN', `${requiredEnv} or a pasted API key is required.`);
      }
    }
  }

  state.mainModel = await askValue(io, 'Main model', state.mainModel);
  state.medicalModel = await askValue(io, 'Medical model', state.medicalModel);

  if (state.provider === 'ollama') {
    state.ollamaUrl = await askEndpointValue(
      io,
      'Ollama URL',
      state.ollamaUrl,
      LOCAL_OLLAMA_BASE_URL,
    );
  }
}

/**
 * Prompt for an endpoint without ever rendering credentials in the visible default.
 *
 * `askValue` prints its default value. When the current endpoint carries `user:password@`, showing
 * that default would leak the secret into the terminal. This keeps the "Enter keeps the current
 * value" behavior by capturing the pre-prompt value and restoring it when the operator just
 * accepts the (sanitized) default.
 */
async function askEndpointValue(
  io: CliIO,
  prompt: string,
  current: string | undefined,
  fallback: string,
): Promise<string> {
  const source = current ?? fallback;
  const visibleDefault = printableEndpoint(source, fallback);
  const answer = await askValue(io, prompt, visibleDefault);
  // Accepting the shown default keeps the SOURCE value. When `current` is undefined that source is
  // the inherited fallback, so Enter must not silently replace a credentialed inherited endpoint
  // with the sanitized display form. (Cold re-review E2 behavior note.)
  if (answer === visibleDefault) {
    return source;
  }
  return answer;
}

/**
 * The EMBEDDING role step, independent of the main role.
 *
 * A change here resets only what is role-incompatible: switching provider moves the model default
 * to that provider's embedding model and drops a key that belonged to the previous provider, so a
 * stale credential can never survive into a different provider's role. Switching a local role to a
 * remote one (or back) drops a now-incompatible endpoint, and the remote-embedding warning is shown
 * honestly — configured is not verified-ready.
 */
async function runEmbeddingStep(io: CliIO, state: SetupWizardState): Promise<void> {
  renderSectionHeader(io, 'Embedding role (independent of the chat provider)');
  const previous = state.embeddingProvider;
  state.embeddingProvider = await askChoice<ProviderConfig['type']>(
    io,
    'Embedding provider',
    SUPPORTED_ONBOARDING_PROVIDERS,
    state.embeddingProvider,
  );

  if (state.embeddingProvider !== previous) {
    state.embeddingModel = modelDefaultsForProvider(state.embeddingProvider).embeddings;
    // A key and an endpoint belonging to the previous provider must not leak into the new role.
    state.embeddingApiKey = undefined;
    state.embeddingUrl = undefined;
  }

  if (state.embeddingProvider === 'ollama') {
    for (;;) {
      const answer = await askEndpointValue(
        io,
        'Local embedding URL',
        state.embeddingUrl,
        state.ollamaUrl ?? LOCAL_OLLAMA_BASE_URL,
      );
      // The SAME endpoint rule the non-interactive parser applies, not a second copy of it. An
      // invalid interactive answer re-prompts, which R06 explicitly allows.
      try {
        state.embeddingUrl = requireHttpEndpoint('Embedding URL', answer);
        break;
      } catch (error) {
        renderStatus(io, 'WARN', error instanceof Error ? error.message : String(error));
      }
    }
  } else {
    const requiredEnv = requiredCloudEnv(state.embeddingProvider);
    const providerDefault =
      state.embeddingProvider === 'openrouter' ? OPENROUTER_DEFAULT_BASE_URL : '';
    for (;;) {
      const answer = await askEndpointValue(
        io,
        'Embedding endpoint',
        state.embeddingUrl,
        providerDefault,
      );
      try {
        // An empty endpoint is allowed here and means "use the provider's own default".
        state.embeddingUrl = answer.trim() === ''
          ? undefined
          : requireHttpEndpoint('Embedding endpoint', answer);
        break;
      } catch (error) {
        renderStatus(io, 'WARN', error instanceof Error ? error.message : String(error));
      }
    }
    if (!process.env[requiredEnv]?.trim()) {
      for (;;) {
        state.embeddingApiKey = await askSecret(
          io,
          `${providerLabel(state.embeddingProvider)} embedding API key`,
          state.embeddingApiKey ?? '',
        );
        if (state.embeddingApiKey?.trim()) {
          break;
        }
        renderStatus(io, 'WARN', `${requiredEnv} or a pasted embedding API key is required.`);
      }
    } else {
      renderStatus(io, 'INFO', `Using ${requiredEnv} from the environment for embeddings.`);
    }
  }

  state.embeddingModel = await askValue(io, 'Embedding model', state.embeddingModel);

  if (state.embeddingProvider !== 'ollama') {
    renderStatus(
      io,
      'WARN',
      'Remote embeddings send your text to a cloud endpoint. The recall latency budget '
      + '(p50<=300ms / p95<=800ms) assumes local embeddings, and this is configured, not verified.',
    );
  }
}

/**
 * Live Ollama catalog check.
 *
 * Only checks the models that will ACTUALLY be served from this endpoint. It used to check the
 * embedding model unconditionally, which after R05 is wrong: a cloud embedding role is not served
 * from the local Ollama endpoint, so reporting its model as "missing" here would be a false
 * warning. A local embedding role with a DIFFERENT explicit endpoint is skipped for the same
 * reason and gets its own truth from the review/apply path.
 */
async function runProviderChecks(
  io: CliIO,
  state: SetupWizardState,
  options: SetupReadinessDependencies = {},
): Promise<void> {
  if (state.provider !== 'ollama' || !shouldRunLiveChecks(io, options)) {
    return;
  }

  const runtime = await probeOllamaCatalog(state.ollamaUrl, {
    allowNetworkChecks: true,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });
  for (const warning of runtime.warnings) {
    renderStatus(io, 'WARN', warning);
  }
  if (!runtime.reachable) {
    for (const detail of runtime.details) {
      renderStatus(io, 'WARN', detail);
    }
    if (runtime.actionHint) {
      renderStatus(io, 'INFO', runtime.actionHint);
    }
    return;
  }

  renderStatus(io, 'OK', 'Ollama reachable.');
  const mainUrl = state.ollamaUrl ?? LOCAL_OLLAMA_BASE_URL;
  const modelsServedHere = [state.mainModel, state.medicalModel];
  if (
    state.embeddingProvider === 'ollama'
    && (state.embeddingUrl ?? state.ollamaUrl ?? LOCAL_OLLAMA_BASE_URL) === mainUrl
  ) {
    modelsServedHere.push(state.embeddingModel);
  }

  const missingModels = getMissingOllamaModels(modelsServedHere, runtime.models);
  if (missingModels.length === 0) {
    renderStatus(io, 'OK', 'Selected Ollama models are installed.');
    return;
  }

  for (const model of missingModels) {
    renderStatus(io, 'WARN', `Missing Ollama model: ${model}. Run \`ollama pull ${model}\`.`);
  }
  renderStatus(io, 'INFO', 'You can switch models in Review > provider before applying setup.');
}

async function runTelegramStep(io: CliIO, state: SetupWizardState): Promise<void> {
  renderStepHeader(io, 4, TOTAL_STEPS, 'Telegram');
  state.telegramEnabled = await askYesNo(io, 'Enable Telegram?', state.telegramEnabled);
  if (state.telegramEnabled) {
    for (;;) {
      state.telegramToken = await askSecret(io, 'Telegram bot token', state.telegramToken ?? '');
      if (!state.telegramToken.trim()) {
        renderStatus(io, 'WARN', 'Telegram bot token is required when Telegram is enabled.');
        continue;
      }
      return;
    }
  }
  state.telegramToken = '';
}

async function runTelegramChecks(
  io: CliIO,
  state: SetupWizardState,
  options: SetupReadinessDependencies = {},
): Promise<void> {
  if (!state.telegramEnabled || !shouldRunLiveChecks(io, options)) {
    return;
  }

  for (;;) {
    const config = buildConfigFromArgs(stateToArgs(state));
    const result = await verifyTelegramRuntime(config, options);
    if (result.blockers.length === 0) {
      if (result.verified) {
        renderStatus(io, 'OK', 'Telegram token verified.');
      } else {
        for (const warning of result.warnings) {
          renderStatus(io, 'WARN', warning);
        }
      }
      return;
    }

    for (const blocker of result.blockers) {
      renderStatus(io, 'WARN', blocker);
    }
    state.telegramToken = await askSecret(io, 'Telegram bot token', '');
    if (!state.telegramToken.trim()) {
      renderStatus(io, 'WARN', 'Telegram bot token is required when Telegram is enabled.');
    }
  }
}

async function runPreferencesStep(io: CliIO, state: SetupWizardState): Promise<void> {
  renderStepHeader(io, 5, TOTAL_STEPS, 'Preferences');
  state.timezone = await askValue(io, 'Timezone', state.timezone);
  state.heartbeatsEnabled = await askYesNo(io, 'Enable heartbeats?', state.heartbeatsEnabled);
  renderStatus(io, 'INFO', 'Medical responses will include a safety disclaimer');
}

async function runReviewStep(
  io: CliIO,
  state: SetupWizardState,
  options: SetupReadinessDependencies = {},
): Promise<ReviewAction> {
  renderSectionHeader(io, 'Review & Apply');
  const review = await buildReviewStateWithOptions(state, shouldRunLiveChecks(io, options), options);

  renderSummaryRows(io, [
    { label: 'Workspace', value: review.config.memory.workspace },
    { label: 'Provider', value: review.config.providers.main.type },
    { label: 'Main model', value: review.config.providers.main.model },
    { label: 'Medical model', value: review.config.providers.medical.model },
    // R05: the embedding role must be reviewable as its OWN selection. Showing only the model hid
    // the very thing that went wrong — a cloud chat provider quietly taking embeddings with it.
    { label: 'Embedding provider', value: review.config.providers.embeddings.type },
    { label: 'Embedding model', value: review.config.providers.embeddings.model },
    {
      label: 'Embedding endpoint',
      // The SAME sanitizer the config summary uses. Printing the raw base URL here bypassed it and
      // exposed `user:password@` userinfo. (Cold re-review D2.)
      value: printableEndpoint(review.config.providers.embeddings.baseUrl, '(provider default)'),
    },
    // `secret: true` masks it through the shared renderer, so the embedding key is never echoed.
    { label: 'Embedding key', value: review.config.providers.embeddings.apiKey ?? '', secret: true },
    { label: 'Telegram', value: review.config.channels.telegram.enabled ? 'enabled' : 'disabled' },
    { label: 'Telegram token', value: review.config.channels.telegram.botToken, secret: true },
    { label: 'Timezone', value: review.config.heartbeat.timezone },
    { label: 'Heartbeats', value: review.config.heartbeat.enabled ? 'enabled' : 'disabled' },
  ]);
  writeLine(io);
  for (const line of buildReadinessSummaryLines({
    configPath: review.args.configPath,
    workspacePath: review.config.memory.workspace,
    validation: review.validation,
    readiness: review.readiness,
  })) {
    writeLine(io, line);
  }
  writeLine(io);
  writeLine(io, 'Configuration:');
  writeLine(io, showRedactedConfigSummary(review.config).trimEnd());

  if (review.errors.length > 0) {
    writeLine(io);
    for (const error of review.errors) {
      renderStatus(io, 'WARN', error);
    }
  }

  return askReviewAction(io, 'apply');
}

async function rerunSelectedStep(io: CliIO, state: SetupWizardState, action: ReviewAction): Promise<void> {
  switch (action) {
    case 'state':
      await runStateStep(io, state);
      return;
    case 'provider':
      await runProviderStep(io, state);
      return;
    case 'embeddings':
      await runEmbeddingStep(io, state);
      return;
    case 'telegram':
      await runTelegramStep(io, state);
      return;
    case 'preferences':
      await runPreferencesStep(io, state);
      return;
    case 'apply':
      return;
    case 'cancel':
      return;
  }
}

async function ensureReviewCanContinue(
  io: CliIO,
  state: SetupWizardState,
  options: SetupReadinessDependencies = {},
): Promise<boolean> {
  const review = await buildReviewStateWithOptions(state, shouldRunLiveChecks(io, options), options);
  const pathErrors = [
    ...validateWritablePath(state.stateRoot, 'state'),
    ...validateWritablePath(state.configPath, 'config'),
  ];
  const readinessFailures = [...review.readiness.providers, review.readiness.telegram]
    .filter((result) =>
      !result.ready &&
      (
        result.label === 'telegram' ||
        result.reasonCode === 'invalid-url' ||
        result.reasonCode === 'missing-base-url'
      ),
    )
    .flatMap((result) => [
      ...result.details.map((detail) => `${result.label}: ${detail}`),
      ...(result.actionHint ? [`${result.label}: ${result.actionHint}`] : []),
    ]);
  const errors = [...review.errors, ...pathErrors, ...readinessFailures];

  if (errors.length === 0) {
    return true;
  }
  for (const error of errors) {
    renderStatus(io, 'WARN', error);
  }
  renderStatus(io, 'INFO', 'Update the flagged section, then apply again.');
  return false;
}

async function runCompletionStep(
  io: CliIO,
  config: EffectiveConfig,
  configPath: string,
  options: SetupReadinessDependencies = {},
): Promise<CompletionAction> {
  for (;;) {
    const validation = validateConfig(config);
    const readiness = await checkSystemReadiness(config, {
      allowNetworkChecks: shouldRunLiveChecks(io, options),
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    });

    writeLine(io);
    renderCompletionDivider(io);
    writeLine(io, 'Setup complete. Choose the next action.');
    renderCompletionDivider(io);
    renderStatus(io, 'OK', 'Setup complete');
    writeLine(io, `Config written to ${configPath}`);
    for (const line of buildReadinessSummaryLines({
      configPath,
      workspacePath: config.memory.workspace,
      validation,
      readiness,
    })) {
      writeLine(io, line);
    }

    const action = await askCompletionAction(io, 'exit');
    if (action !== 'review-config') {
      return action;
    }

    writeLine(io);
    writeLine(io, 'Configuration:');
    writeLine(io, showRedactedConfigSummary(config).trimEnd());
  }
}

export async function runSetupWizard(
  io: CliIO,
  initial: SetupWizardState,
  options: SetupReadinessDependencies = {},
): Promise<{ config?: EffectiveConfig; action: CompletionAction; cancelled: boolean }> {
  const state: SetupWizardState = {
    ...initial,
    configPath: resolveSetupPath(initial.configPath),
    stateRoot: resolveSetupPath(initial.stateRoot),
  };

  renderWizardBanner(io);
  await runEnvironmentStep(io, state);
  await runStateStep(io, state);
  await runProviderStep(io, state);
  await runProviderChecks(io, state, options);
  // R05: a distinct step, so choosing embeddings cannot be skipped by answering the chat provider
  // step and so a later "Edit embeddings" re-entry has the same path as the first pass.
  await runEmbeddingStep(io, state);
  await runTelegramStep(io, state);
  await runTelegramChecks(io, state, options);
  await runPreferencesStep(io, state);

  let config: EffectiveConfig | undefined;
  let configPath: string | undefined;
  for (;;) {
    const action = await runReviewStep(io, state, options);
    if (action === 'cancel') {
      writeLine(io);
      renderStatus(io, 'INFO', 'Setup cancelled. No files were written.');
      return { action: 'exit', cancelled: true };
    }
    if (action !== 'apply') {
      await rerunSelectedStep(io, state, action);
      continue;
    }
    if (!(await ensureReviewCanContinue(io, state, options))) {
      continue;
    }

    const args = stateToArgs(state);
    config = buildConfigFromArgs(args);
    configPath = args.configPath!;
    try {
      await persistSetupArtifacts(configPath, config);
      break;
    } catch (error) {
      renderStatus(io, 'WARN', `Could not write setup files: ${error instanceof Error ? error.message : String(error)}`);
      // True for every refusal the writer can produce, including a half-published setup: setup never
      // overwrites existing owner evidence, so "apply again" into the SAME target is always refused.
      // Saying only "apply again" walked the operator into a second installation beside the record
      // the message above had just told them to inspect.
      renderStatus(io, 'INFO', 'Apply again only with a fresh --state-root or --config target.');
    }
  }

  const action = await runCompletionStep(io, config!, configPath!, options);
  return { config: config!, action, cancelled: false };
}
