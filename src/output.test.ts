import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render } from './output.js';

describe('output TTY detection', () => {
  const originalIsTTY = process.stdout.isTTY;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, writable: true });
    logSpy.mockRestore();
  });

  it('defaults to YAML in non-TTY', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, writable: true });
    render([{ name: 'alice', score: 10 }]);
    const out = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(out).toContain('name: alice');
    expect(out).toContain('score: 10');
  });

  it('defaults to YAML in TTY too', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true });
    render([{ name: 'alice', score: 10 }]);
    const out = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(out).toContain('name: alice');
    expect(out).toContain('score: 10');
  });

  it('respects explicit -f json even in non-TTY', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, writable: true });
    render([{ name: 'alice' }], { fmt: 'json' });
    const out = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(JSON.parse(out)).toEqual([{ name: 'alice' }]);
  });

  it('renders plain output for chat-style single-field rows', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true });
    render([{ response: 'hello' }], { fmt: 'plain' });
    const out = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(out).toContain('hello');
  });

  it('renders markdown tables as plain text', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true });
    render([{ name: 'alice' }], { fmt: 'md' });
    const out = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(out).toContain('| name |');
  });

  it('renders csv as plain text', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true });
    render([{ name: 'alice' }], { fmt: 'csv' });
    const out = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(out).toContain('name');
    expect(out).toContain('alice');
  });

  it('falls back to YAML for removed table format', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true });
    render([{ name: 'alice' }], { fmt: 'table' });
    const out = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(out).toContain('name: alice');
  });
});
