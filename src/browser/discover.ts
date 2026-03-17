/**
 * MCP server path discovery and argument building.
 */

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let _cachedMcpServerPath: string | null | undefined;
let _existsSync = fs.existsSync;
let _execSync = execSync;

export function resetMcpServerPathCache(): void {
  _cachedMcpServerPath = undefined;
}

export function setMcpDiscoveryTestHooks(input?: {
  existsSync?: typeof fs.existsSync;
  execSync?: typeof execSync;
}): void {
  _existsSync = input?.existsSync ?? fs.existsSync;
  _execSync = input?.execSync ?? execSync;
}

export function findMcpServerPath(): string | null {
  if (_cachedMcpServerPath !== undefined) return _cachedMcpServerPath;

  const envMcp = process.env.OPENCLI_MCP_SERVER_PATH;
  if (envMcp && _existsSync(envMcp)) {
    _cachedMcpServerPath = envMcp;
    return _cachedMcpServerPath;
  }

  // Check local node_modules first (@playwright/mcp is the modern package)
  const localMcp = path.resolve('node_modules', '@playwright', 'mcp', 'cli.js');
  if (_existsSync(localMcp)) {
    _cachedMcpServerPath = localMcp;
    return _cachedMcpServerPath;
  }

  // Check project-relative path
  const __dirname2 = path.dirname(fileURLToPath(import.meta.url));
  const projectMcp = path.resolve(__dirname2, '..', '..', 'node_modules', '@playwright', 'mcp', 'cli.js');
  if (_existsSync(projectMcp)) {
    _cachedMcpServerPath = projectMcp;
    return _cachedMcpServerPath;
  }

  // Check global npm/yarn locations derived from current Node runtime.
  const nodePrefix = path.resolve(path.dirname(process.execPath), '..');
  const globalNodeModules = path.join(nodePrefix, 'lib', 'node_modules');
  const globalMcp = path.join(globalNodeModules, '@playwright', 'mcp', 'cli.js');
  if (_existsSync(globalMcp)) {
    _cachedMcpServerPath = globalMcp;
    return _cachedMcpServerPath;
  }

  // Check npm global root directly.
  try {
    const npmRootGlobal = _execSync('npm root -g 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    const npmGlobalMcp = path.join(npmRootGlobal, '@playwright', 'mcp', 'cli.js');
    if (npmRootGlobal && _existsSync(npmGlobalMcp)) {
      _cachedMcpServerPath = npmGlobalMcp;
      return _cachedMcpServerPath;
    }
  } catch {}

  // Check common locations
  const candidates = [
    path.join(os.homedir(), '.npm', '_npx'),
    path.join(os.homedir(), 'node_modules', '.bin'),
    '/usr/local/lib/node_modules',
  ];

  // Try npx resolution (legacy package name)
  try {
    const result = _execSync('npx -y --package=@playwright/mcp which mcp-server-playwright 2>/dev/null', { encoding: 'utf-8', timeout: 10000 }).trim();
    if (result && _existsSync(result)) {
      _cachedMcpServerPath = result;
      return _cachedMcpServerPath;
    }
  } catch {}

  // Try which
  try {
    const result = _execSync('which mcp-server-playwright 2>/dev/null', { encoding: 'utf-8', timeout: 5000 }).trim();
    if (result && _existsSync(result)) {
      _cachedMcpServerPath = result;
      return _cachedMcpServerPath;
    }
  } catch {}

  // Search in common npx cache
  for (const base of candidates) {
    if (!_existsSync(base)) continue;
    try {
      const found = _execSync(`find "${base}" -name "cli.js" -path "*playwright*mcp*" 2>/dev/null | head -1`, { encoding: 'utf-8', timeout: 5000 }).trim();
      if (found) {
        _cachedMcpServerPath = found;
        return _cachedMcpServerPath;
      }
    } catch {}
  }

  _cachedMcpServerPath = null;
  return _cachedMcpServerPath;
}

export function buildMcpArgs(input: { mcpPath: string; executablePath?: string | null }): string[] {
  const args = [input.mcpPath];
  if (!process.env.CI) {
    // Local: always connect to user's running Chrome via MCP Bridge extension
    args.push('--extension');
  }
  // CI: standalone mode — @playwright/mcp launches its own browser (headed by default).
  // xvfb provides a virtual display for headed mode in GitHub Actions.
  if (input.executablePath) {
    args.push('--executable-path', input.executablePath);
  }
  return args;
}
