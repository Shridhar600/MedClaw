import type { CliIO } from './prompts';
import { writeStdout } from './prompts';
import type { SummaryRow } from './wizard-types';

export type WizardStatusKind = 'INFO' | 'OK' | 'WARN';

const COLORS = {
  reset: '\x1b[0m',
  green: '\x1b[92m',
  cyan: '\x1b[96m',
  yellow: '\x1b[93m',
  dim: '\x1b[90m',
} as const;

function supportsAnsi(): boolean {
  return Boolean(process.stdout.isTTY) && process.env.NO_COLOR !== '1';
}

function colorize(io: CliIO, color: string, text: string): string {
  if (!supportsAnsi()) {
    return text;
  }
  return `${color}${text}${COLORS.reset}`;
}

export function writeLine(io: CliIO, text = ''): void {
  writeStdout(io, `${text}\n`);
}

export function renderDivider(io: CliIO): void {
  writeLine(io, '------------------------------------------------------------');
}

export function renderStepHeader(
  io: CliIO,
  index: number,
  total: number,
  title: string,
): void {
  writeLine(io);
  writeLine(io, colorize(io, COLORS.green, `[${index}/${total}] ${title}`));
  renderDivider(io);
}

export function renderStatus(io: CliIO, kind: WizardStatusKind, text: string): void {
  const color =
    kind === 'OK' ? COLORS.green : kind === 'WARN' ? COLORS.yellow : COLORS.cyan;
  writeLine(io, `${colorize(io, color, `[${kind}]`)} ${text}`);
}

export function renderSectionHeader(io: CliIO, title: string): void {
  writeLine(io);
  writeLine(io, colorize(io, COLORS.green, title));
  renderDivider(io);
}

export function renderCompletionDivider(io: CliIO): void {
  writeLine(io, '============================================================');
}

export function renderWizardBanner(io: CliIO): void {
  // const breadcrumb = colorize(io, COLORS.dim, 'medclaw onboard');

  const wordmark = [
    '╔╦╗╔═╗╔╦╗╔═╗╦  ╔═╗╦ ╦  Setup Wizard v1.0.0',
    '║║║║╣  ║║║  ║  ╠═╣║║║',
    '╩ ╩╚═╝═╩╝╚═╝╩═╝╩ ╩╚╩╝',
  ];

  const divider = '─────────────────────────────────────────────';
  const subtitle = '● ● ●  MedClaw — Personal AI Health Assistant';

  // writeLine(io, breadcrumb);
  writeLine(io);
  writeLine(io, colorize(io, COLORS.dim, subtitle));
  writeLine(io, colorize(io, COLORS.dim, divider));
  for (const line of wordmark) {
    writeLine(io, colorize(io, COLORS.cyan, line));
  }
  // writeLine(io);
}

export function maskSecret(value: string | undefined): string {
  return value && value.trim() ? '[REDACTED]' : '(not set)';
}

export function renderSummaryRows(io: CliIO, rows: readonly SummaryRow[]): void {
  for (const row of rows) {
    const value = row.secret ? maskSecret(row.value) : row.value;
    writeLine(io, `${row.label}: ${value}`);
  }
}
