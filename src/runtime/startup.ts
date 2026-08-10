import * as os from 'os';
import * as path from 'path';
import { loadConfig } from '../config/config';
import type { AppConfig } from '../config/types';

interface RuntimeConfigOptions {
  configPath?: string;
  homeDir?: string;
}

export function defaultRuntimeConfigPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.redacted', 'config.json');
}

export async function loadRuntimeConfig(options: RuntimeConfigOptions = {}): Promise<AppConfig> {
  const envConfigPath = process.env.REDACTED_CONFIG_PATH?.trim();
  const configPath = options.configPath
    ?? (envConfigPath && envConfigPath.length > 0 ? envConfigPath : undefined)
    ?? defaultRuntimeConfigPath(options.homeDir);
  return loadConfig({ configPath, requireFile: true });
}
