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
