import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetDaemonHealth, mockListSessions, mockConnect, mockClose } = vi.hoisted(() => ({
  mockGetDaemonHealth: vi.fn(),
  mockListSessions: vi.fn(),
  mockConnect: vi.fn(),
  mockClose: vi.fn(),
}));

vi.mock('./browser/daemon-client.js', () => ({
  getDaemonHealth: mockGetDaemonHealth,
  listSessions: mockListSessions,
}));

vi.mock('./browser/index.js', () => ({
  BrowserBridge: class {
    connect = mockConnect;
    close = mockClose;
  },
}));

import { renderBrowserDoctorReport, runBrowserDoctor } from './doctor.js';

describe('doctor report rendering', () => {
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders OK-style report when daemon and extension connected', () => {
    const text = strip(renderBrowserDoctorReport({
      daemonRunning: true,
      extensionConnected: true,
      issues: [],
    }));

    expect(text).toContain('[OK] Daemon: running on port 19825');
    expect(text).toContain('[OK] Extension: connected');
    expect(text).toContain('Everything looks good!');
  });

  it('renders MISSING when daemon not running', () => {
    const text = strip(renderBrowserDoctorReport({
      daemonRunning: false,
      extensionConnected: false,
      issues: ['Daemon is not running.'],
    }));

    expect(text).toContain('[MISSING] Daemon: not running');
    expect(text).toContain('[MISSING] Extension: not connected');
    expect(text).toContain('Daemon is not running.');
  });

  it('renders extension not connected when daemon is running', () => {
    const text = strip(renderBrowserDoctorReport({
      daemonRunning: true,
      extensionConnected: false,
      issues: ['Daemon is running but the Chrome extension is not connected.'],
    }));

    expect(text).toContain('[OK] Daemon: running on port 19825');
    expect(text).toContain('[MISSING] Extension: not connected');
  });

  it('renders connectivity OK when live test succeeds', () => {
    const text = strip(renderBrowserDoctorReport({
      daemonRunning: true,
      extensionConnected: true,
      connectivity: { ok: true, durationMs: 1234 },
      issues: [],
    }));

    expect(text).toContain('[OK] Connectivity: connected in 1.2s');
  });

  it('renders connectivity SKIP when not tested', () => {
    const text = strip(renderBrowserDoctorReport({
      daemonRunning: true,
      extensionConnected: true,
      issues: [],
    }));

    expect(text).toContain('[SKIP] Connectivity: skipped (--no-live)');
  });

  it('renders unstable extension state when live connectivity and status disagree', () => {
    const text = strip(renderBrowserDoctorReport({
      daemonRunning: true,
      extensionConnected: true,
      extensionFlaky: true,
      connectivity: { ok: true, durationMs: 1234 },
      issues: ['Extension connection is unstable.'],
    }));

    expect(text).toContain('[WARN] Extension: unstable');
    expect(text).toContain('Extension connection is unstable.');
  });

  it('renders unstable daemon state when live connectivity and status disagree', () => {
    const text = strip(renderBrowserDoctorReport({
      daemonRunning: false,
      daemonFlaky: true,
      extensionConnected: false,
      connectivity: { ok: true, durationMs: 1234 },
      issues: ['Daemon connectivity is unstable.'],
    }));

    expect(text).toContain('[WARN] Daemon: unstable');
    expect(text).toContain('Daemon connectivity is unstable.');
  });

  it('reports daemon not running with single getDaemonHealth call', async () => {
    // getDaemonHealth returns stopped — no redundant auto-start
    mockGetDaemonHealth.mockResolvedValue({ state: 'stopped' });

    const report = await runBrowserDoctor({ live: false });

    expect(report.daemonRunning).toBe(false);
    expect(report.extensionConnected).toBe(false);
    // Single getDaemonHealth call (no double status check)
    expect(mockGetDaemonHealth).toHaveBeenCalledTimes(1);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.stringContaining('Daemon is not running'),
    ]));
  });

  it('reports flapping when live check succeeds but final status flips disconnected', async () => {
    mockConnect.mockResolvedValueOnce({
      evaluate: vi.fn().mockResolvedValue(2),
    });
    mockClose.mockResolvedValueOnce(undefined);
    // After live test, health check shows no-extension
    mockGetDaemonHealth.mockResolvedValueOnce({ state: 'no-extension' });

    const report = await runBrowserDoctor({ live: true });

    expect(report.daemonRunning).toBe(true);
    expect(report.extensionConnected).toBe(false);
    expect(report.extensionFlaky).toBe(true);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.stringContaining('Extension connection is unstable'),
    ]));
  });

  it('reports daemon flapping when live check succeeds but daemon disappears afterward', async () => {
    mockConnect.mockResolvedValueOnce({
      evaluate: vi.fn().mockResolvedValue(2),
    });
    mockClose.mockResolvedValueOnce(undefined);
    // After live test, health check shows stopped
    mockGetDaemonHealth.mockResolvedValueOnce({ state: 'stopped' });

    const report = await runBrowserDoctor({ live: true });

    expect(report.daemonRunning).toBe(false);
    expect(report.daemonFlaky).toBe(true);
    expect(report.extensionConnected).toBe(false);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.stringContaining('Daemon connectivity is unstable'),
    ]));
  });

  it('uses the fast default timeout for live connectivity checks', async () => {
    let timeoutSeen: number | undefined;
    mockConnect.mockImplementationOnce(async (opts?: { timeout?: number }) => {
      timeoutSeen = opts?.timeout;
      return {
        evaluate: vi.fn().mockResolvedValue(2),
      };
    });
    mockClose.mockResolvedValueOnce(undefined);
    mockGetDaemonHealth.mockResolvedValueOnce({ state: 'ready', extensionVersion: '1.0.0' });

    await runBrowserDoctor({ live: true });

    expect(timeoutSeen).toBe(8);
  });
});
