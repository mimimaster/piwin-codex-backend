import { existsSync } from 'node:fs';
import { delimiter } from 'node:path';

/** Platform vendor binary holes are unavailable, not something this plugin repairs. */
export function isMissingPlatformVendor(path: string, exists: (path: string) => boolean): boolean {
  return /vendor\/aarch64-apple-darwin\/codex\/codex$/.test(path) && !exists(path);
}

export function resolveCodexBinary(input: {
  hostBinaryPath?: string;
  env?: NodeJS.ProcessEnv;
  pathExists?: (path: string) => boolean;
}): { ok: true; binaryPath: string } | { ok: false; searched: string[]; reason: string } {
  const exists = input.pathExists ?? existsSync;
  const env = input.env ?? process.env;
  const searched: string[] = [];
  const candidates = [input.hostBinaryPath, env.CODEX_CLI, env.CODEX_BINARY];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue;
    searched.push(candidate);
    if (!exists(candidate)) continue;
    if (isMissingPlatformVendor(candidate, exists)) {
      return { ok: false, searched, reason: 'platform-binary-missing' };
    }
    return { ok: true, binaryPath: candidate };
  }
  const pathEnv = env.PATH ?? '';
  for (const dir of pathEnv.split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = `${dir.replace(/[/\\]$/, '')}/codex`;
    searched.push(candidate);
    if (exists(candidate)) return { ok: true, binaryPath: candidate };
  }
  return { ok: false, searched, reason: 'not-installed' };
}


/** Wrapper scripts that exist but cannot spawn the platform vendor binary. */
export function isUnusableCodexProbe(input: { stderr?: string; errorCode?: string }): boolean {
  if (input.errorCode === 'ENOENT') return true;
  const stderr = input.stderr ?? '';
  return /ENOENT|spawn .* ENOENT/i.test(stderr);
}
