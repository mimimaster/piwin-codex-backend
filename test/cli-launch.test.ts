import { describe, expect, it } from 'vitest';
import { codexCliLaunch } from '../src/cli-launch.js';

describe('codex cli launch', () => {
  it('resumes the original thread id', () => {
    expect(codexCliLaunch('thr_123')).toEqual({ backendSessionId: 'thr_123', args: ['resume', 'thr_123'] });
  });
});
