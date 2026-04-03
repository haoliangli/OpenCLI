import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerVerboseAction } from './cli.js';

describe('registerVerboseAction', () => {
  beforeEach(() => {
    delete process.env.OPENCLI_VERBOSE;
  });

  it('enables OPENCLI_VERBOSE before invoking the action when -v is passed', async () => {
    const action = vi.fn();
    const program = new Command();

    registerVerboseAction(
      program.command('explore').argument('<url>'),
      async (url: string, opts: { verbose?: boolean }) => {
        action(url, opts.verbose, process.env.OPENCLI_VERBOSE);
      },
    );

    await program.parseAsync(['node', 'opencli', 'explore', 'https://example.com', '-v']);

    expect(action).toHaveBeenCalledWith('https://example.com', true, '1');
    expect(process.env.OPENCLI_VERBOSE).toBe('1');
  });

  it('leaves OPENCLI_VERBOSE unset when -v is omitted', async () => {
    const action = vi.fn();
    const program = new Command();

    registerVerboseAction(
      program.command('generate').argument('<url>'),
      async (url: string, opts: { verbose?: boolean }) => {
        action(url, opts.verbose, process.env.OPENCLI_VERBOSE);
      },
    );

    await program.parseAsync(['node', 'opencli', 'generate', 'https://example.com']);

    expect(action).toHaveBeenCalledWith('https://example.com', undefined, undefined);
    expect(process.env.OPENCLI_VERBOSE).toBeUndefined();
  });
});
