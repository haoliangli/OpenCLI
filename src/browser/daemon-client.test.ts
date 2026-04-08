import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fetchDaemonStatus,
  getDaemonHealth,
  requestDaemonShutdown,
} from './daemon-client.js';

describe('daemon-client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetchDaemonStatus sends the shared status request and returns parsed data', async () => {
    const status = {
      ok: true,
      pid: 123,
      uptime: 10,
      extensionConnected: true,
      extensionVersion: '1.2.3',
      pending: 0,
      lastCliRequestTime: Date.now(),
      memoryMB: 32,
      port: 19825,
    };
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(status),
    } as Response);

    await expect(fetchDaemonStatus()).resolves.toEqual(status);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/status$/),
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-OpenCLI': '1' }),
      }),
    );
  });

  it('fetchDaemonStatus returns null on network failure', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(fetchDaemonStatus()).resolves.toBeNull();
  });

  it('requestDaemonShutdown POSTs to the shared shutdown endpoint', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({ ok: true } as Response);

    await expect(requestDaemonShutdown()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/shutdown$/),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-OpenCLI': '1' }),
      }),
    );
  });

  it('getDaemonHealth returns stopped when fetch fails', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(getDaemonHealth()).resolves.toEqual({ state: 'stopped' });
  });

  it('getDaemonHealth returns no-extension when daemon running but extension not connected', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          ok: true,
          pid: 123,
          uptime: 10,
          extensionConnected: false,
          pending: 0,
          lastCliRequestTime: Date.now(),
          memoryMB: 16,
          port: 19825,
        }),
    } as Response);

    await expect(getDaemonHealth()).resolves.toEqual({ state: 'no-extension', extensionVersion: undefined });
  });

  it('getDaemonHealth returns ready when extension connected', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          ok: true,
          pid: 123,
          uptime: 10,
          extensionConnected: true,
          extensionVersion: '1.0.0',
          pending: 0,
          lastCliRequestTime: Date.now(),
          memoryMB: 16,
          port: 19825,
        }),
    } as Response);

    await expect(getDaemonHealth()).resolves.toEqual({ state: 'ready', extensionVersion: '1.0.0' });
  });
});
