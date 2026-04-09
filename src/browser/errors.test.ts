import { describe, expect, it } from 'vitest';

import { classifyBrowserError, isTransientBrowserError } from './errors.js';

describe('classifyBrowserError', () => {
  it('classifies extension transient errors with 1500ms delay', () => {
    for (const msg of [
      'Extension disconnected',
      'Extension not connected',
      'attach failed',
      'no longer exists',
      'CDP connection reset',
      'Daemon command failed',
      'No window with id: 123',
    ]) {
      const advice = classifyBrowserError(new Error(msg));
      expect(advice.retryable, `expected "${msg}" to be retryable`).toBe(true);
      expect(advice.delayMs).toBe(1500);
    }
  });

  it('classifies CDP target navigation errors with 200ms delay', () => {
    const advice = classifyBrowserError(new Error('Inspected target navigated or closed'));
    expect(advice.retryable).toBe(true);
    expect(advice.delayMs).toBe(200);
  });

  it('classifies CDP -32000 target errors with 200ms delay', () => {
    const advice = classifyBrowserError(new Error('{"code":-32000,"message":"Target closed"}'));
    expect(advice.retryable).toBe(true);
    expect(advice.delayMs).toBe(200);
  });

  it('returns not retryable for unrelated errors', () => {
    expect(classifyBrowserError(new Error('Permission denied')).retryable).toBe(false);
    expect(classifyBrowserError(new Error('malformed exec payload')).retryable).toBe(false);
    expect(classifyBrowserError(new Error('SyntaxError')).retryable).toBe(false);
  });

  it('handles non-Error values', () => {
    expect(classifyBrowserError('Extension disconnected').retryable).toBe(true);
    expect(classifyBrowserError(42).retryable).toBe(false);
  });
});

describe('isTransientBrowserError (convenience wrapper)', () => {
  it('returns true for transient errors', () => {
    expect(isTransientBrowserError(new Error('No window with id: 123'))).toBe(true);
  });

  it('returns false for non-transient errors', () => {
    expect(isTransientBrowserError(new Error('Permission denied'))).toBe(false);
  });
});
