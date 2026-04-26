import * as fs from 'fs';
import * as path from 'path';
import { buildReadinessSummaryLines, showRedactedConfigSummary } from './admin';
import type { CliIO } from './prompts';
import { askYesNo } from './prompts';
import {
  buildConfigFromArgs,
  collectSetupErrors,
  modelDefaultsForProvider,
  persistSetupArtifacts,
  providerLabel,
  SUPPORTED_ONBOARDING_PROVIDERS,
  resolveNonInteractiveArgs,
  resolveSetupPath,
  requiredCloudEnv,
} from './service-onboarding';
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
import type { AppConfig, ProviderConfig } from '../config/types';
import { listWorkspaceTemplateFiles } from '../workspace/bootstrap';

const TOTAL_STEPS = 5;

function shouldRunLiveChecks(io: CliIO, options?: SetupReadinessDependencies): boolean {
  return !io.input || Boolean(options?.fetchImpl);
}

function validateWritablePath(targetPath: string, kind: 'workspace' | 'config'): string[] {
  const errors: string[] = [];
  try {
    const directory = kind === 'workspace' ? targetPath : path.dirname(targetPath);
    fs.mkdirSync(directory, { recursive: true });
    fs.accessSync(directory, fs.constants.W_OK);
  } catch (error) {
    errors.push(
      `${kind === 'workspace' ? 'Workspace' : 'Config directory'} is not writable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return errors;
}

function stateToArgs(state: SetupWizardState) {
  return resolveNonInteractiveArgs({
    configPath: state.configPath,
    workspace: state.workspace,
    provider: state.provider,
    mainModel: state.mainModel,
    medicalModel: state.medicalModel,
    embeddingModel: state.embeddingModel,
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
  config: AppConfig;
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

async function runWorkspaceStep(io: CliIO, state: SetupWizardState): Promise<void> {
  renderStepHeader(io, 2, TOTAL_STEPS, 'Workspace');
  state.workspace = resolveSetupPath(await askValue(io, 'Workspace path', state.workspace));
  const pathErrors = validateWritablePath(state.workspace, 'workspace');
  if (pathErrors.length === 0) {
    renderStatus(io, 'OK', 'Workspace directory is writable.');
  } else {
    for (const error of pathErrors) {
      renderStatus(io, 'WARN', error);
    }
  }
  renderStatus(io, 'INFO', `Template files: ${listWorkspaceTemplateFiles().join(', ')}`);
}

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
    state.embeddingModel = defaults.embeddings;
    if (state.provider === 'ollama') {
      state.ollamaUrl = state.ollamaUrl ?? 'http://localhost:11434/v1';
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
      while (true) {
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
  state.embeddingModel = await askValue(io, 'Embedding model', state.embeddingModel);

  if (state.provider === 'ollama') {
    state.ollamaUrl = await askValue(io, 'Ollama URL', state.ollamaUrl ?? 'http://localhost:11434/v1');
  }
}

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
  const missingModels = getMissingOllamaModels(
    [state.mainModel, state.medicalModel, state.embeddingModel],
    runtime.models,
  );
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
    while (true) {
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

  while (true) {
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
    { label: 'Embedding model', value: review.config.providers.embeddings.model },
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
    case 'workspace':
      await runWorkspaceStep(io, state);
      return;
    case 'provider':
      await runProviderStep(io, state);
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
    ...validateWritablePath(state.workspace, 'workspace'),
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
  config: AppConfig,
  configPath: string,
  options: SetupReadinessDependencies = {},
): Promise<CompletionAction> {
  while (true) {
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
): Promise<{ config?: AppConfig; action: CompletionAction; cancelled: boolean }> {
  const state: SetupWizardState = {
    ...initial,
    configPath: resolveSetupPath(initial.configPath),
    workspace: resolveSetupPath(initial.workspace),
  };

  renderWizardBanner(io);
  await runEnvironmentStep(io, state);
  await runWorkspaceStep(io, state);
  await runProviderStep(io, state);
  await runProviderChecks(io, state, options);
  await runTelegramStep(io, state);
  await runTelegramChecks(io, state, options);
  await runPreferencesStep(io, state);

  let config: AppConfig | undefined;
  let configPath: string | undefined;
  while (true) {
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
      renderStatus(io, 'INFO', 'Adjust the workspace or config path and apply again.');
    }
  }

  const action = await runCompletionStep(io, config!, configPath!, options);
  return { config: config!, action, cancelled: false };
}
