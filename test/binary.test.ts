import { describe, expect, it } from 'vitest';
import { isMissingPlatformVendor, isUnusableCodexProbe, resolveCodexBinary } from '../src/binary.js';

describe('codex binary', () => {
  it('treats missing darwin vendor binary as unavailable', () => {
    const vendor = '/opt/node_modules/@openai/codex/vendor/aarch64-apple-darwin/codex/codex';
    expect(isMissingPlatformVendor(vendor, () => false)).toBe(true);
    const resolved = resolveCodexBinary({
      hostBinaryPath: vendor,
      pathExists: () => false,
      env: { PATH: '' },
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toBe('not-installed');
  });
});


describe('codex version probe', () => {
  it('treats vendor ENOENT as unusable even when the wrapper path exists', () => {
    expect(isUnusableCodexProbe({
      stderr: 'Error: spawn /opt/vendor/aarch64-apple-darwin/codex/codex ENOENT',
    })).toBe(true);
    expect(isUnusableCodexProbe({ errorCode: 'ENOENT' })).toBe(true);
    expect(isUnusableCodexProbe({ stderr: 'codex-cli 0.1.0' })).toBe(false);
  });
});
