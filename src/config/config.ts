import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CliError } from '../cli/errors';

export interface GlobalConfig {
  provider?: string;
  harness?: string;
  token?: string;
  yolo?: boolean;
  env?: Record<string, string>;
}

export interface Layer {
  dir: string;
  read(): GlobalConfig;
}

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.SANDER_CONFIG_DIR;
  if (override && override.trim() !== '') {
    return override;
  }
  return path.join(os.homedir(), '.config', 'sander');
}

export function registryPath(dir: string): string {
  return path.join(dir, 'registry.json');
}

export function configPath(dir: string): string {
  return path.join(dir, 'config.json');
}

export function readGlobalConfig(dir: string): GlobalConfig {
  const file = configPath(dir);
  if (!fs.existsSync(file)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as GlobalConfig;
  } catch {
    throw new CliError(`cannot read config file: ${file}`);
  }
}

export function saveConfig(dir: string, config: GlobalConfig): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = configPath(dir);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export function workspaceLayer(root: string): Layer {
  const dir = path.join(root, '.sander');
  return {
    dir,
    read(): GlobalConfig {
      const file = configPath(dir);
      if (!fs.existsSync(file)) {
        return {};
      }
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8')) as GlobalConfig;
      } catch {
        throw new CliError(`cannot read workspace config file: ${file}`);
      }
    },
  };
}
