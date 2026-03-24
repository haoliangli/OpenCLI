/**
 * CDP client — implements IPage by connecting directly to a Chrome/Electron CDP WebSocket.
 *
 * Fixes applied:
 * - send() now has a 30s timeout guard (P0 #4)
 * - goto() waits for Page.loadEventFired instead of hardcoded 1s sleep (P1 #3)
 * - Implemented scroll, autoScroll, screenshot, networkRequests (P1 #2)
 * - Shared DOM helper methods extracted to reduce duplication with Page (P1 #5)
 */

import { WebSocket, type RawData } from 'ws';
import type { BrowserCookie, IPage, ScreenshotOptions, SnapshotOptions, WaitOptions } from '../types.js';
import { wrapForEval } from './utils.js';
import { generateSnapshotJs, scrollToRefJs, getFormStateJs } from './dom-snapshot.js';
import { generateStealthJs } from './stealth.js';
import {
  clickJs,
  typeTextJs,
  pressKeyJs,
  waitForTextJs,
  scrollJs,
  autoScrollJs,
  networkRequestsJs,
  waitForDomStableJs,
} from './dom-helpers.js';

export interface CDPTarget {
  type?: string;
  url?: string;
  title?: string;
  webSocketDebuggerUrl?: string;
}

interface AXTreeNode {
  nodeId?: number;
  backendNodeId?: number;
  role?: string;
  name?: string;
  properties?: Array<{ name: string; value: string | undefined }>;
}

interface AXTree {
  children?: AXTreeNode[];
}

interface RuntimeEvaluateResult {
  result?: {
    value?: unknown;
  };
  exceptionDetails?: {
    exception?: {
      description?: string;
    };
  };
}

const CDP_SEND_TIMEOUT = 30_000; // 30s per command

export class CDPBridge {
  private _ws: WebSocket | null = null;
  private _idCounter = 0;
  private _pending = new Map<number, { resolve: (val: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private _eventListeners = new Map<string, Set<(params: unknown) => void>>();

  async connect(opts?: { timeout?: number; workspace?: string }): Promise<IPage> {
    if (this._ws) throw new Error('CDPBridge is already connected. Call close() before reconnecting.');

    const endpoint = process.env.OPENCLI_CDP_ENDPOINT;
    if (!endpoint) throw new Error('OPENCLI_CDP_ENDPOINT is not set');

    // If it's a direct ws:// URL, use it. Otherwise, fetch the /json endpoint to find a page.
    let wsUrl = endpoint;
    if (endpoint.startsWith('http')) {
      const res = await fetch(`${endpoint.replace(/\/$/, '')}/json`);
      if (!res.ok) throw new Error(`Failed to fetch CDP targets: ${res.statusText}`);
      const targets = await res.json() as CDPTarget[];
      const target = selectCDPTarget(targets);
      if (!target || !target.webSocketDebuggerUrl) {
        throw new Error('No inspectable targets found at CDP endpoint');
      }
      wsUrl = target.webSocketDebuggerUrl;
    }

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timeoutMs = (opts?.timeout ?? 10) * 1000; // opts.timeout is in seconds
      const timeout = setTimeout(() => reject(new Error('CDP connect timeout')), timeoutMs);

      ws.on('open', async () => {
        clearTimeout(timeout);
        this._ws = ws;
        // Register stealth script to run before any page JS on every navigation.
        try {
          await this.send('Page.enable');
          await this.send('Page.addScriptToEvaluateOnNewDocument', { source: generateStealthJs() });
        } catch {
          // Non-fatal: stealth is best-effort
        }
        resolve(new CDPPage(this));
      });

      ws.on('error', (err: Error) => {
        clearTimeout(timeout);
        reject(err);
      });

      ws.on('message', (data: RawData) => {
        try {
          const msg = JSON.parse(data.toString());
          // Handle command responses
          if (msg.id && this._pending.has(msg.id)) {
            const entry = this._pending.get(msg.id)!;
            clearTimeout(entry.timer);
            this._pending.delete(msg.id);
            if (msg.error) {
              entry.reject(new Error(msg.error.message));
            } else {
              entry.resolve(msg.result);
            }
          }
          // Handle CDP events
          if (msg.method) {
            const listeners = this._eventListeners.get(msg.method);
            if (listeners) {
              for (const fn of listeners) fn(msg.params);
            }
          }
        } catch {
          // ignore parsing errors
        }
      });
    });
  }

  async close(): Promise<void> {
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    for (const p of this._pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('CDP connection closed'));
    }
    this._pending.clear();
    this._eventListeners.clear();
  }

  /** Send a CDP command with timeout guard (P0 fix #4) */
  async send(method: string, params: Record<string, unknown> = {}, timeoutMs: number = CDP_SEND_TIMEOUT): Promise<unknown> {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      throw new Error('CDP connection is not open');
    }
    const id = ++this._idCounter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`CDP command '${method}' timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      this._ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Listen for a CDP event */
  on(event: string, handler: (params: unknown) => void): void {
    let set = this._eventListeners.get(event);
    if (!set) { set = new Set(); this._eventListeners.set(event, set); }
    set.add(handler);
  }

  /** Remove a CDP event listener */
  off(event: string, handler: (params: unknown) => void): void {
    this._eventListeners.get(event)?.delete(handler);
  }

  /** Wait for a CDP event to fire (one-shot) */
  waitForEvent(event: string, timeoutMs: number = 15_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(event, handler);
        reject(new Error(`Timed out waiting for CDP event '${event}'`));
      }, timeoutMs);
      const handler = (params: unknown) => {
        clearTimeout(timer);
        this.off(event, handler);
        resolve(params);
      };
      this.on(event, handler);
    });
  }

  /**
   * Fetch AXTree data and build a map of backendNodeId -> interactive state.
   * Returns a Set of backendNodeIds that are clickable/focusable according to AXTree.
   */
  async fetchInteractiveNodeIds(): Promise<Set<number>> {
    try {
      await this.send('Accessibility.enable');
      const result = await this.send('Accessibility.getFullAXTree') as { tree?: AXTree };
      const interactiveIds = new Set<number>();

      function walkTree(node?: AXTreeNode) {
        if (!node) return;
        const backendId = node.backendNodeId;
        if (backendId) {
          // Check if node has interactive role or focusable property
          const role = node.role?.toLowerCase() || '';
          const isClickable = role === 'button' || role === 'link' || role === 'menuitem' ||
                            role === 'tab' || role === 'checkbox' || role === 'radio' ||
                            role === 'combobox' || role === 'textbox' || role === 'searchbox';
          const focusable = node.properties?.some(p =>
            p.name === 'focusable' && (p.value === 'true' || p.value === true)
          );
          if (isClickable || focusable) {
            interactiveIds.add(backendId);
          }
        }
        // Recurse into children (AXTree uses nested children)
        if (Array.isArray(node.children)) {
          for (const child of node.children) {
            walkTree(child);
          }
        }
      }

      const rootNodes = result.tree?.children || [];
      for (const root of rootNodes) {
        walkTree(root);
      }

      return interactiveIds;
    } catch {
      // AXTree may not be available in all contexts (e.g., some extension pages)
      return new Set();
    }
  }

  /**
   * Fetch event listeners for all nodes in the document.
   * Returns a Map of nodeId -> array of listener types.
   */
  async fetchEventListeners(): Promise<Map<number, string[]>> {
    try {
      await this.send('DOM.enable');
      await this.send('DOMDebugger.enable');

      const docResult = await this.send('DOM.getFlattenedDocument') as {
        nodes?: Array<{ nodeId: number; localName?: string; children?: unknown[] }>;
      };

      const listenerMap = new Map<number, string[]>();

      if (!docResult.nodes) return listenerMap;

      // Check listeners for each node (limit to first 100 to avoid excessive calls)
      const nodesToCheck = docResult.nodes.slice(0, 100);
      for (const node of nodesToCheck) {
        if (typeof node.nodeId !== 'number') continue;

        try {
          const listenersResult = await this.send('DOMDebugger.getEventListeners', {
            nodeId: node.nodeId,
            objectId: undefined,
          }) as { listeners: Array<{ type: string }> };

          if (Array.isArray(listenersResult.listeners) && listenersResult.listeners.length > 0) {
            const types = listenersResult.listeners.map(l => l.type);
            listenerMap.set(node.nodeId, types);
          }
        } catch {
          // Some nodes may not support getting listeners
        }
      }

      return listenerMap;
    } catch {
      return new Map();
    }
  }
}

class CDPPage implements IPage {
  private _pageEnabled = false;
  constructor(private bridge: CDPBridge) {}

  /** Navigate with proper load event waiting (P1 fix #3) */
  async goto(url: string, options?: { waitUntil?: 'load' | 'none'; settleMs?: number }): Promise<void> {
    if (!this._pageEnabled) {
      await this.bridge.send('Page.enable');
      this._pageEnabled = true;
    }
    const loadPromise = this.bridge.waitForEvent('Page.loadEventFired', 30_000)
      .catch(() => {}); // Don't fail if load event times out — page may be an SPA
    await this.bridge.send('Page.navigate', { url });
    await loadPromise;
    // Smart settle: use DOM stability detection instead of fixed sleep.
    // settleMs is now a timeout cap (default 1000ms), not a fixed wait.
    if (options?.waitUntil !== 'none') {
      const maxMs = options?.settleMs ?? 1000;
      await this.evaluate(waitForDomStableJs(maxMs, Math.min(500, maxMs)));
    }
  }

  async evaluate(js: string): Promise<unknown> {
    const expression = wrapForEval(js);
    const result = await this.bridge.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    }) as RuntimeEvaluateResult;
    if (result.exceptionDetails) {
      throw new Error('Evaluate error: ' + (result.exceptionDetails.exception?.description || 'Unknown exception'));
    }
    return result.result?.value;
  }

  async getCookies(opts: { domain?: string; url?: string } = {}): Promise<BrowserCookie[]> {
    const result = await this.bridge.send('Network.getCookies', opts.url ? { urls: [opts.url] } : {});
    const cookies = isRecord(result) && Array.isArray(result.cookies) ? result.cookies : [];
    const domain = opts.domain;
    return domain
      ? cookies.filter((cookie): cookie is BrowserCookie => isCookie(cookie) && matchesCookieDomain(cookie.domain, domain))
      : cookies;
  }

  async snapshot(opts: SnapshotOptions = {}): Promise<unknown> {
    const snapshotJs = generateSnapshotJs({
      viewportExpand: opts.viewportExpand ?? 800,
      maxDepth: Math.max(1, Math.min(Number(opts.maxDepth) || 50, 200)),
      interactiveOnly: opts.interactive ?? false,
      maxTextLength: opts.maxTextLength ?? 120,
      includeScrollInfo: true,
      bboxDedup: true,
    });
    const result = await this.evaluate(snapshotJs) as Record<string, unknown>;

    // Enhance with event listener data if requested
    if (opts.detectListeners === true) {
      const listenerData = await this.fetchEventListeners();
      if (listenerData.size > 0) {
        await annotateWithListeners(this.bridge, result, listenerData);
      }
    }

    return result;
  }

  // ── Shared DOM operations (P1 fix #5 — using dom-helpers.ts) ──

  async click(ref: string): Promise<void> {
    await this.evaluate(clickJs(ref));
  }

  async typeText(ref: string, text: string): Promise<void> {
    await this.evaluate(typeTextJs(ref, text));
  }

  async pressKey(key: string): Promise<void> {
    await this.evaluate(pressKeyJs(key));
  }

  async scrollTo(ref: string): Promise<unknown> {
    return this.evaluate(scrollToRefJs(ref));
  }

  async getFormState(): Promise<Record<string, unknown>> {
    return (await this.evaluate(getFormStateJs())) as Record<string, unknown>;
  }

  async wait(options: number | WaitOptions): Promise<void> {
    if (typeof options === 'number') {
      await new Promise(resolve => setTimeout(resolve, options * 1000));
      return;
    }
    if (typeof options.time === 'number') {
      const waitTime = options.time;
      await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
      return;
    }
    if (options.text) {
      const timeout = (options.timeout ?? 30) * 1000;
      await this.evaluate(waitForTextJs(options.text, timeout));
    }
  }

  // ── Implemented methods (P1 fix #2) ──

  async scroll(direction: string = 'down', amount: number = 500): Promise<void> {
    await this.evaluate(scrollJs(direction, amount));
  }

  async autoScroll(options?: { times?: number; delayMs?: number }): Promise<void> {
    const times = options?.times ?? 3;
    const delayMs = options?.delayMs ?? 2000;
    await this.evaluate(autoScrollJs(times, delayMs));
  }

  async screenshot(options: ScreenshotOptions = {}): Promise<string> {
    const result = await this.bridge.send('Page.captureScreenshot', {
      format: options.format ?? 'png',
      quality: options.format === 'jpeg' ? (options.quality ?? 80) : undefined,
      captureBeyondViewport: options.fullPage ?? false,
    });
    const base64 = isRecord(result) && typeof result.data === 'string' ? result.data : '';
    if (options.path) {
      await saveBase64ToFile(base64, options.path);
    }
    return base64;
  }

  async networkRequests(includeStatic: boolean = false): Promise<unknown[]> {
    const result = await this.evaluate(networkRequestsJs(includeStatic));
    return Array.isArray(result) ? result : [];
  }

  async tabs(): Promise<unknown[]> {
    return [];
  }

  async closeTab(_index?: number): Promise<void> {
    // Not supported in direct CDP mode
  }

  async newTab(): Promise<void> {
    await this.bridge.send('Target.createTarget', { url: 'about:blank' });
  }

  async selectTab(_index: number): Promise<void> {
    // Not supported in direct CDP mode
  }

  async consoleMessages(_level?: string): Promise<unknown[]> {
    return [];
  }

  async installInterceptor(pattern: string): Promise<void> {
    const { generateInterceptorJs } = await import('../interceptor.js');
    await this.evaluate(generateInterceptorJs(JSON.stringify(pattern), {
      arrayName: '__opencli_xhr',
      patchGuard: '__opencli_interceptor_patched',
    }));
  }

  async getInterceptedRequests(): Promise<unknown[]> {
    const { generateReadInterceptedJs } = await import('../interceptor.js');
    const result = await this.evaluate(generateReadInterceptedJs('__opencli_xhr'));
    return Array.isArray(result) ? result : [];
  }
}

import { isRecord, saveBase64ToFile } from '../utils.js';

/**
 * Post-process snapshot with event listener data.
 *
 * This uses DOM.getFlattenedDocument to get nodeIds, then matches them
 * against the event listener data from DOMDebugger.getEventListeners.
 */
async function annotateWithListeners(
  bridge: CDPBridge,
  node: Record<string, unknown>,
  listenerMap: Map<number, string[]>,
): Promise<void> {
  const children = isRecord(node.children) ? node.children as Record<string, unknown>[] :
                   Array.isArray(node.children) ? node.children as Record<string, unknown>[] : [];

  // Process current node - check for click-like listeners
  const ref = node.ref;
  if (typeof ref === 'number') {
    try {
      // Try to find a matching node in the DOM by checking attributes
      // For elements with unique IDs, we can match directly
      const id = node.id;
      if (typeof id === 'string' && id) {
        // Query by ID to get nodeId
        const queryResult = await bridge.send('DOM.querySelector', {
          nodeId: 1, // document node
          selector: `#${CSS.escape(id)}`,
        }) as { nodeId: number };

        if (queryResult.nodeId && listenerMap.has(queryResult.nodeId)) {
          const listeners = listenerMap.get(queryResult.nodeId)!;
          const hasClickListener = listeners.some(t =>
            t === 'click' || t === 'mousedown' || t === 'mouseup' || t === 'touchstart'
          );
          if (hasClickListener) {
            (node as Record<string, unknown>).hasClickListener = true;
          }
        }
      }
    } catch {
      // Node not found or other error - skip
    }
  }

  // Recurse into children
  for (const child of children) {
    if (isRecord(child)) {
      await annotateWithListeners(bridge, child, listenerMap);
    }
  }
}

function isCookie(value: unknown): value is BrowserCookie {
  return isRecord(value)
    && typeof value.name === 'string'
    && typeof value.value === 'string'
    && typeof value.domain === 'string';
}

function matchesCookieDomain(cookieDomain: string, targetDomain: string): boolean {
  const normalizedCookieDomain = cookieDomain.replace(/^\./, '').toLowerCase();
  const normalizedTargetDomain = targetDomain.replace(/^\./, '').toLowerCase();
  return normalizedTargetDomain === normalizedCookieDomain
    || normalizedTargetDomain.endsWith(`.${normalizedCookieDomain}`);
}

// ── CDP target selection (unchanged) ──

function selectCDPTarget(targets: CDPTarget[]): CDPTarget | undefined {
  const preferredPattern = compilePreferredPattern(process.env.OPENCLI_CDP_TARGET);

  const ranked = targets
    .map((target, index) => ({ target, index, score: scoreCDPTarget(target, preferredPattern) }))
    .filter(({ score }) => Number.isFinite(score))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.index - b.index;
    });

  return ranked[0]?.target;
}

function scoreCDPTarget(target: CDPTarget, preferredPattern?: RegExp): number {
  if (!target.webSocketDebuggerUrl) return Number.NEGATIVE_INFINITY;

  const type = (target.type ?? '').toLowerCase();
  const url = (target.url ?? '').toLowerCase();
  const title = (target.title ?? '').toLowerCase();
  const haystack = `${title} ${url}`;

  if (!haystack.trim() && !type) return Number.NEGATIVE_INFINITY;
  if (haystack.includes('devtools')) return Number.NEGATIVE_INFINITY;

  let score = 0;

  if (preferredPattern && preferredPattern.test(haystack)) score += 1000;

  if (type === 'app') score += 120;
  else if (type === 'webview') score += 100;
  else if (type === 'page') score += 80;
  else if (type === 'iframe') score += 20;

  if (url.startsWith('http://localhost') || url.startsWith('https://localhost')) score += 90;
  if (url.startsWith('file://')) score += 60;
  if (url.startsWith('http://127.0.0.1') || url.startsWith('https://127.0.0.1')) score += 50;
  if (url.startsWith('about:blank')) score -= 120;
  if (url === '' || url === 'about:blank') score -= 40;

  if (title && title !== 'devtools') score += 25;
  if (title.includes('antigravity')) score += 120;
  if (title.includes('codex')) score += 120;
  if (title.includes('cursor')) score += 120;
  if (title.includes('chatwise')) score += 120;
  if (title.includes('notion')) score += 120;
  if (title.includes('discord')) score += 120;

  if (url.includes('antigravity')) score += 100;
  if (url.includes('codex')) score += 100;
  if (url.includes('cursor')) score += 100;
  if (url.includes('chatwise')) score += 100;
  if (url.includes('notion')) score += 100;
  if (url.includes('discord')) score += 100;

  return score;
}

function compilePreferredPattern(raw: string | undefined): RegExp | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  return new RegExp(escapeRegExp(value.toLowerCase()));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const __test__ = {
  selectCDPTarget,
  scoreCDPTarget,
};
