import * as fs from 'fs';
import * as readline from 'readline/promises';
import { ensureWorkspaceBootstrap } from '../workspace/bootstrap';

const PROMPT_COLOR = '\x1b[96m';
const COLOR_RESET = '\x1b[0m';
const VALUE_COLOR = '\x1b[92m';

function stdoutIsTty(): boolean {
  return Boolean(process.stdout.isTTY) && process.env.NO_COLOR !== '1';
}

let sharedReadline: readline.Interface | undefined;
let pipedAnswers: string[] | undefined;
type CliReadlineFactory = (options: {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}) => readline.Interface;
let cliReadlineFactory: CliReadlineFactory = (options) => readline.createInterface(options);

export interface CliIO {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  input?: (prompt: string) => Promise<string>;
  secretInput?: (prompt: string, defaultValue?: string) => Promise<string>;
}

function formatPrompt(prompt: string, defaultValue = ''): string {
  const bullet = stdoutIsTty() ? `${PROMPT_COLOR}•${COLOR_RESET}` : '•';
  const cursor = stdoutIsTty() ? `${VALUE_COLOR}›${COLOR_RESET}` : '›';
  const lines = [`${bullet} ${prompt}`];
  if (defaultValue) {
    lines.push(`  default: ${defaultValue}`);
  }
  lines.push(`  ${cursor} `);
  return lines.join('\n');
}

function formatSecretPrompt(prompt: string, hasCurrentValue = false): string {
  const bullet = stdoutIsTty() ? `${PROMPT_COLOR}•${COLOR_RESET}` : '•';
  const cursor = stdoutIsTty() ? `${VALUE_COLOR}›${COLOR_RESET}` : '›';
  const lines = [`${bullet} ${prompt}`];
  if (hasCurrentValue) {
    lines.push('  current: configured');
  }
  lines.push(`  ${cursor} `);
  return lines.join('\n');
}

function normalizePromptValue(answer: string, defaultValue = ''): string {
  const trimmed = answer.trim();
  return trimmed.length > 0 ? trimmed : defaultValue;
}

function closeSharedReadline(): void {
  if (!sharedReadline) {
    return;
  }
  sharedReadline.close();
  sharedReadline = undefined;
}

export function writeStdout(io: CliIO, text: string): void {
  io.stdout?.(text);
}

export function writeStderr(io: CliIO, text: string): void {
  io.stderr?.(text);
}

export function createCliReadline(options: {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}): readline.Interface {
  return cliReadlineFactory(options);
}

export function setCliReadlineFactoryForTests(factory?: CliReadlineFactory): void {
  closeSharedReadline();
  cliReadlineFactory = factory ?? ((options) => readline.createInterface(options));
}

export async function askText(
  io: CliIO,
  prompt: string,
  defaultValue = '',
): Promise<string> {
  if (io.input) {
    const answer = await io.input(formatPrompt(prompt, defaultValue));
    return normalizePromptValue(answer, defaultValue);
  }

  const promptText = formatPrompt(prompt, defaultValue);

  if (!process.stdin.isTTY) {
    writeStdout(io, promptText);
    if (!pipedAnswers) {
      pipedAnswers = fs.readFileSync(0, 'utf8').split(/\r?\n/);
    }
    const answer = pipedAnswers.shift() ?? '';
    return normalizePromptValue(answer, defaultValue);
  }

  if (!sharedReadline) {
    sharedReadline = createCliReadline({
      input: process.stdin as unknown as NodeJS.ReadStream,
      output: process.stdout as unknown as NodeJS.WriteStream,
    });
  }
  const answer = await sharedReadline.question(promptText);
  return normalizePromptValue(answer, defaultValue);
}

function readPipedAnswer(): string {
  if (!pipedAnswers) {
    pipedAnswers = fs.readFileSync(0, 'utf8').split(/\r?\n/);
  }
  return pipedAnswers.shift() ?? '';
}

async function readHiddenFromTTY(
  io: CliIO,
  prompt: string,
  defaultValue = '',
): Promise<string> {
  const stdin = process.stdin as NodeJS.ReadStream;
  closeSharedReadline();
  writeStdout(io, `${prompt} `);

  const previousRawMode = Boolean(stdin.isRaw);
  let rawModeSucceeded = false;

  try {
    stdin.setRawMode?.(true);
    rawModeSucceeded = Boolean(stdin.isRaw);
  } catch {
    rawModeSucceeded = false;
  }

  if (!rawModeSucceeded) {
    throw new Error(
      'Secure hidden input is not available because TTY raw mode could not be enabled. Use piped input or injected secret input instead.',
    );
  }

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const chars: string[] = [];

    const cleanup = (): void => {
      stdin.off('data', onData);
      stdin.off('error', onError);
      stdin.setRawMode?.(previousRawMode);
      stdin.pause();
      writeStdout(io, '\n');
    };

    const finish = (value: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(normalizePromptValue(value, defaultValue));
    };

    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const onError = (error: Error): void => fail(error);

    const onData = (chunk: Buffer | string): void => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') {
          finish(chars.join(''));
          return;
        }
        if (char === '\u0003') {
          fail(new Error('Setup cancelled by user.'));
          return;
        }
        if (char === '\u007f' || char === '\b') {
          if (chars.length > 0) {
            chars.pop();
            writeStdout(io, '\b \b');
          }
          continue;
        }
        if (char >= ' ') {
          chars.push(char);
          writeStdout(io, '\u25CF');
        }
      }
    };

    stdin.on('error', onError);
    stdin.on('data', onData);
    stdin.resume();
  });
}

export async function askHiddenText(
  io: CliIO,
  prompt: string,
  defaultValue = '',
): Promise<string> {
  if (io.secretInput) {
    const answer = await io.secretInput(prompt, defaultValue);
    return normalizePromptValue(answer, defaultValue);
  }

  if (io.input) {
    const answer = await io.input(formatSecretPrompt(prompt, defaultValue.trim().length > 0));
    return normalizePromptValue(answer, defaultValue);
  }

  if (!process.stdin.isTTY) {
    writeStdout(io, formatSecretPrompt(prompt, defaultValue.trim().length > 0));
    return normalizePromptValue(readPipedAnswer(), defaultValue);
  }

  return readHiddenFromTTY(
    io,
    formatSecretPrompt(prompt, defaultValue.trim().length > 0).trimEnd(),
    defaultValue,
  );
}

export async function askYesNo(
  io: CliIO,
  prompt: string,
  defaultValue: boolean,
): Promise<boolean> {
  for (;;) {
    const answer = await askText(
      io,
      `${prompt}\n  options: yes, no`,
      defaultValue ? 'yes' : 'no',
    );
    const normalized = answer.trim().toLowerCase();
    if (!normalized) {
      return defaultValue;
    }
    if (normalized === 'y' || normalized === 'yes' || normalized === 'true') {
      return true;
    }
    if (normalized === 'n' || normalized === 'no' || normalized === 'false') {
      return false;
    }
    writeStderr(io, 'Please answer yes or no.\n');
  }
}

export function ensureWorkspaceTemplates(workspacePath: string): void {
  ensureWorkspaceBootstrap(workspacePath, { preserveExisting: true });
}
