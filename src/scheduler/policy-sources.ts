import * as fs from 'fs';
import * as path from 'path';

export interface PolicySourceRecord {
  relativePath: string;
  title: string;
  status: string;
  cron: string;
  prompt: string;
  timezone?: string;
}

function parseFrontmatter(markdown: string): Record<string, string> {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) {
    return {};
  }

  const pairs: Array<[string, string]> = [];
  for (const line of match[1].split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue;
    }
    const index = trimmed.indexOf(':');
    if (index <= 0) {
      continue;
    }
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    if (key.length > 0) {
      pairs.push([key, value]);
    }
  }

  return Object.fromEntries(pairs);
}

function extractTitle(markdown: string, relativePath: string): string {
  const titleLine = markdown.split('\n').find((line) => line.trim().startsWith('# '));
  if (titleLine) {
    return titleLine.trim().slice(2).trim();
  }
  return path.basename(relativePath, path.extname(relativePath));
}

function toWorkspaceRelativePath(workspacePath: string, absolutePath: string): string {
  return path.relative(workspacePath, absolutePath).split(path.sep).join('/');
}

export async function readPolicySourceRecords(
  workspacePath: string,
  dirName: 'medications' | 'conditions' | 'goals',
): Promise<PolicySourceRecord[]> {
  const dirPath = path.join(workspacePath, dirName);
  if (!fs.existsSync(dirPath)) {
    return [];
  }

  const records: PolicySourceRecord[] = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) {
      continue;
    }

    const absolutePath = path.join(dirPath, entry.name);
    const markdown = fs.readFileSync(absolutePath, 'utf8');
    const frontmatter = parseFrontmatter(markdown);

    if ((frontmatter.status ?? 'active').toLowerCase() !== 'active') {
      continue;
    }

    if (!frontmatter.cron || !frontmatter.prompt) {
      continue;
    }

    const relativePath = toWorkspaceRelativePath(workspacePath, absolutePath);
    records.push({
      relativePath,
      title: extractTitle(markdown, relativePath),
      status: frontmatter.status ?? 'active',
      cron: frontmatter.cron,
      prompt: frontmatter.prompt,
      timezone: frontmatter.timezone,
    });
  }

  return records;
}
