// Real first-run contender for the setup suite.
//
// Spawned as an actual OS process with its OWN `HOME`, it runs the production `runCli` entry point
// for `onboard` with NO `--config` flag, so the configuration is selected by the real default
// (`<home>/.redacted/config.json`). Nothing outside the synthetic home is read or written: the
// machine and shell environment are untouched, and only this child's environment is overridden.
//
// Prints exactly one JSON result line on stdout.
import { runCli } from '../../src/cli';
import { defaultRuntimeConfigPath } from '../../src/runtime/startup';

async function main(): Promise<void> {
  let stdout = '';
  let stderr = '';
  const code = await runCli(
    ['onboard', '--yes', '--provider', 'ollama', '--telegram-enabled', 'false', '--heartbeats-enabled', 'false'],
    { stdout: (text: string) => { stdout += text; }, stderr: (text: string) => { stderr += text; } },
  );
  process.stdout.write(`${JSON.stringify({
    exit: code,
    selectedPath: defaultRuntimeConfigPath(),
    stdoutClaimsSetupComplete: stdout.includes('Setup complete'),
    stdout,
    stderr,
  })}\n`);
}

void main();