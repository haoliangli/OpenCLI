import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandExecutionError } from '../../errors.js';
import { getRegistry } from '../../registry.js';
import type { IPage } from '../../types.js';
import * as privatePublish from './_shared/private-publish.js';
import { buildClickActionJs, buildEnsureComposerOpenJs, buildInspectUploadStageJs, buildPublishStatusProbeJs } from './post.js';
import './post.js';

const tempDirs: string[] = [];

function createTempImage(name = 'demo.jpg', bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9])): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencli-instagram-post-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, bytes);
  return filePath;
}

function createTempVideo(name = 'demo.mp4', bytes = Buffer.from('video')): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencli-instagram-post-video-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, bytes);
  return filePath;
}

function createPageMock(evaluateResults: unknown[], overrides: Partial<IPage> = {}): IPage {
  const evaluate = vi.fn();
  for (const result of evaluateResults) {
    evaluate.mockResolvedValueOnce(result);
  }

  return {
    goto: vi.fn().mockResolvedValue(undefined),
    evaluate,
    getCookies: vi.fn().mockResolvedValue([]),
    snapshot: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockResolvedValue(undefined),
    typeText: vi.fn().mockResolvedValue(undefined),
    pressKey: vi.fn().mockResolvedValue(undefined),
    scrollTo: vi.fn().mockResolvedValue(undefined),
    getFormState: vi.fn().mockResolvedValue({ forms: [], orphanFields: [] }),
    wait: vi.fn().mockResolvedValue(undefined),
    tabs: vi.fn().mockResolvedValue([]),
    closeTab: vi.fn().mockResolvedValue(undefined),
    newTab: vi.fn().mockResolvedValue(undefined),
    selectTab: vi.fn().mockResolvedValue(undefined),
    networkRequests: vi.fn().mockResolvedValue([]),
    consoleMessages: vi.fn().mockResolvedValue([]),
    scroll: vi.fn().mockResolvedValue(undefined),
    autoScroll: vi.fn().mockResolvedValue(undefined),
    installInterceptor: vi.fn().mockResolvedValue(undefined),
    getInterceptedRequests: vi.fn().mockResolvedValue([]),
    waitForCapture: vi.fn().mockResolvedValue(undefined),
    screenshot: vi.fn().mockResolvedValue(''),
    setFileInput: vi.fn().mockResolvedValue(undefined),
    insertText: undefined,
    getCurrentUrl: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('instagram auth detection', () => {
  it('does not treat generic homepage text containing "log in" as an auth failure', () => {
    const globalState = globalThis as typeof globalThis & {
      document?: unknown;
      window?: unknown;
    };

    const originalDocument = globalState.document;
    const originalWindow = globalState.window;

    globalState.document = {
      body: { innerText: 'Suggested for you Log in to see more content' },
      querySelector: () => null,
      querySelectorAll: () => [],
    } as unknown as Document;
    globalState.window = { location: { pathname: '/' } } as unknown as Window & typeof globalThis;

    try {
      expect(eval(buildEnsureComposerOpenJs()) as { ok: boolean; reason?: string }).toEqual({ ok: true });
    } finally {
      globalState.document = originalDocument;
      globalState.window = originalWindow;
    }
  });
});

describe('instagram publish status detection', () => {
  it('does not treat unrelated page text as share failure while the sharing dialog is still visible', () => {
    const globalState = globalThis as typeof globalThis & {
      document?: unknown;
      window?: unknown;
      HTMLElement?: unknown;
    };

    class MockHTMLElement {}

    const visibleDialog = new MockHTMLElement() as MockHTMLElement & {
      textContent: string;
      querySelector: () => null;
      getBoundingClientRect: () => { width: number; height: number };
    };
    visibleDialog.textContent = 'Sharing';
    visibleDialog.querySelector = () => null;
    visibleDialog.getBoundingClientRect = () => ({ width: 100, height: 100 });

    const originalDocument = globalState.document;
    const originalWindow = globalState.window;
    const originalHTMLElement = globalState.HTMLElement;

    globalState.HTMLElement = MockHTMLElement as unknown as typeof HTMLElement;
    globalState.document = {
      querySelectorAll: (selector: string) => selector === '[role="dialog"]' ? [visibleDialog] : [],
    } as unknown as Document;
    globalState.window = {
      location: { href: 'https://www.instagram.com/' },
      getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    } as unknown as Window & typeof globalThis;

    try {
      expect(eval(buildPublishStatusProbeJs()) as { failed?: boolean; settled?: boolean; ok?: boolean }).toEqual({
        ok: false,
        failed: false,
        settled: false,
        url: '',
      });
    } finally {
      globalState.document = originalDocument;
      globalState.window = originalWindow;
      globalState.HTMLElement = originalHTMLElement;
    }
  });

  it('does not treat a stale visible error dialog as share failure while sharing is still in progress', () => {
    const globalState = globalThis as typeof globalThis & {
      document?: unknown;
      window?: unknown;
      HTMLElement?: unknown;
    };

    class MockHTMLElement {}

    const sharingDialog = new MockHTMLElement() as MockHTMLElement & {
      textContent: string;
      querySelector: () => null;
      getBoundingClientRect: () => { width: number; height: number };
    };
    sharingDialog.textContent = 'Sharing';
    sharingDialog.querySelector = () => null;
    sharingDialog.getBoundingClientRect = () => ({ width: 100, height: 100 });

    const staleErrorDialog = new MockHTMLElement() as MockHTMLElement & {
      textContent: string;
      querySelector: () => null;
      getBoundingClientRect: () => { width: number; height: number };
    };
    staleErrorDialog.textContent = 'Something went wrong. Please try again. Try again';
    staleErrorDialog.querySelector = () => null;
    staleErrorDialog.getBoundingClientRect = () => ({ width: 100, height: 100 });

    const originalDocument = globalState.document;
    const originalWindow = globalState.window;
    const originalHTMLElement = globalState.HTMLElement;

    globalState.HTMLElement = MockHTMLElement as unknown as typeof HTMLElement;
    globalState.document = {
      querySelectorAll: (selector: string) => selector === '[role="dialog"]' ? [sharingDialog, staleErrorDialog] : [],
    } as unknown as Document;
    globalState.window = {
      location: { href: 'https://www.instagram.com/' },
      getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    } as unknown as Window & typeof globalThis;

    try {
      expect(eval(buildPublishStatusProbeJs()) as { failed?: boolean; settled?: boolean; ok?: boolean }).toEqual({
        ok: false,
        failed: false,
        settled: false,
        url: '',
      });
    } finally {
      globalState.document = originalDocument;
      globalState.window = originalWindow;
      globalState.HTMLElement = originalHTMLElement;
    }
  });

  it('prefers explicit post-shared success over stale visible error text', () => {
    const globalState = globalThis as typeof globalThis & {
      document?: unknown;
      window?: unknown;
      HTMLElement?: unknown;
    };

    class MockHTMLElement {}

    const sharedDialog = new MockHTMLElement() as MockHTMLElement & {
      textContent: string;
      querySelector: () => null;
      getBoundingClientRect: () => { width: number; height: number };
    };
    sharedDialog.textContent = 'Post shared Your post has been shared.';
    sharedDialog.querySelector = () => null;
    sharedDialog.getBoundingClientRect = () => ({ width: 100, height: 100 });

    const staleErrorDialog = new MockHTMLElement() as MockHTMLElement & {
      textContent: string;
      querySelector: () => null;
      getBoundingClientRect: () => { width: number; height: number };
    };
    staleErrorDialog.textContent = 'Something went wrong. Please try again. Try again';
    staleErrorDialog.querySelector = () => null;
    staleErrorDialog.getBoundingClientRect = () => ({ width: 100, height: 100 });

    const originalDocument = globalState.document;
    const originalWindow = globalState.window;
    const originalHTMLElement = globalState.HTMLElement;

    globalState.HTMLElement = MockHTMLElement as unknown as typeof HTMLElement;
    globalState.document = {
      querySelectorAll: (selector: string) => selector === '[role="dialog"]' ? [sharedDialog, staleErrorDialog] : [],
    } as unknown as Document;
    globalState.window = {
      location: { href: 'https://www.instagram.com/' },
      getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    } as unknown as Window & typeof globalThis;

    try {
      expect(eval(buildPublishStatusProbeJs()) as { failed?: boolean; settled?: boolean; ok?: boolean }).toEqual({
        ok: true,
        failed: false,
        settled: false,
        url: '',
      });
    } finally {
      globalState.document = originalDocument;
      globalState.window = originalWindow;
      globalState.HTMLElement = originalHTMLElement;
    }
  });
});

describe('instagram click action detection', () => {
  it('matches aria-label-only Next buttons in the media dialog', () => {
    const globalState = globalThis as typeof globalThis & {
      document?: unknown;
      window?: unknown;
      HTMLElement?: unknown;
    };

    class MockHTMLElement {
      textContent = '';
      ariaLabel = '';
      clicked = false;
      querySelectorAll = (_selector: string) => [] as unknown[];
      querySelector = (_selector: string) => null as unknown;
      getAttribute(name: string): string | null {
        if (name === 'aria-label') return this.ariaLabel || null;
        return null;
      }
      getBoundingClientRect() {
        return { width: 100, height: 40 };
      }
      click() {
        this.clicked = true;
      }
    }

    const nextButton = new MockHTMLElement();
    nextButton.ariaLabel = 'Next';

    const dialog = new MockHTMLElement();
    dialog.textContent = 'Crop Back Select crop Open media gallery';
    dialog.querySelector = (selector: string) => selector === 'input[type="file"]' ? {} as Element : null;
    dialog.querySelectorAll = (selector: string) => selector === 'button, div[role="button"]' ? [nextButton] : [];

    const body = new MockHTMLElement();

    const originalDocument = globalState.document;
    const originalWindow = globalState.window;
    const originalHTMLElement = globalState.HTMLElement;

    globalState.HTMLElement = MockHTMLElement as unknown as typeof HTMLElement;
    globalState.document = {
      body,
      querySelectorAll: (selector: string) => selector === '[role="dialog"]' ? [dialog] : [],
    } as unknown as Document;
    globalState.window = {
      getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    } as unknown as Window & typeof globalThis;

    try {
      expect(eval(buildClickActionJs(['Next', '下一步'], 'media')) as { ok: boolean; label?: string }).toEqual({
        ok: true,
        label: 'Next',
      });
      expect(nextButton.clicked).toBe(true);
    } finally {
      globalState.document = originalDocument;
      globalState.window = originalWindow;
      globalState.HTMLElement = originalHTMLElement;
    }
  });

  it('does not click a body-level Next button when media scope has no matching dialog controls', () => {
    const globalState = globalThis as typeof globalThis & {
      document?: unknown;
      window?: unknown;
      HTMLElement?: unknown;
    };

    class MockHTMLElement {
      textContent = '';
      ariaLabel = '';
      clicked = false;
      children: unknown[] = [];
      querySelectorAll = (_selector: string) => this.children;
      querySelector = (_selector: string) => null as unknown;
      getAttribute(name: string): string | null {
        if (name === 'aria-label') return this.ariaLabel || null;
        return null;
      }
      getBoundingClientRect() {
        return { width: 100, height: 40 };
      }
      click() {
        this.clicked = true;
      }
    }

    const bodyNext = new MockHTMLElement();
    bodyNext.ariaLabel = 'Next';

    const errorDialog = new MockHTMLElement();
    errorDialog.textContent = 'Something went wrong Try again';
    errorDialog.children = [];

    const body = new MockHTMLElement();
    body.children = [bodyNext];

    const originalDocument = globalState.document;
    const originalWindow = globalState.window;
    const originalHTMLElement = globalState.HTMLElement;

    globalState.HTMLElement = MockHTMLElement as unknown as typeof HTMLElement;
    globalState.document = {
      body,
      querySelectorAll: (selector: string) => selector === '[role="dialog"]' ? [errorDialog] : [],
    } as unknown as Document;
    globalState.window = {
      getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    } as unknown as Window & typeof globalThis;

    try {
      expect(eval(buildClickActionJs(['Next', '下一步'], 'media')) as { ok: boolean }).toEqual({ ok: false });
      expect(bodyNext.clicked).toBe(false);
    } finally {
      globalState.document = originalDocument;
      globalState.window = originalWindow;
      globalState.HTMLElement = originalHTMLElement;
    }
  });
});

describe('instagram upload stage detection', () => {
  it('does not treat a body-level Next button as upload preview when the visible dialog is an error', () => {
    const globalState = globalThis as typeof globalThis & {
      document?: unknown;
      window?: unknown;
      HTMLElement?: unknown;
    };

    class MockHTMLElement {
      textContent = '';
      ariaLabel = '';
      children: unknown[] = [];
      querySelectorAll = (_selector: string) => this.children;
      querySelector = (_selector: string) => null as unknown;
      getAttribute(name: string): string | null {
        if (name === 'aria-label') return this.ariaLabel || null;
        return null;
      }
      getBoundingClientRect() {
        return { width: 100, height: 40 };
      }
    }

    const bodyNext = new MockHTMLElement();
    bodyNext.ariaLabel = 'Next';

    const errorDialog = new MockHTMLElement();
    errorDialog.textContent = 'Something went wrong. Please try again. Try again';

    const body = new MockHTMLElement();
    body.children = [bodyNext];

    const originalDocument = globalState.document;
    const originalWindow = globalState.window;
    const originalHTMLElement = globalState.HTMLElement;

    globalState.HTMLElement = MockHTMLElement as unknown as typeof HTMLElement;
    globalState.document = {
      body,
      querySelectorAll: (selector: string) => {
        if (selector === '[role="dialog"]') return [errorDialog];
        return [];
      },
    } as unknown as Document;
    globalState.window = {
      getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    } as unknown as Window & typeof globalThis;

    try {
      expect(eval(buildInspectUploadStageJs()) as { state: string; detail: string }).toEqual({
        state: 'failed',
        detail: 'Something went wrong. Please try again. Try again',
      });
    } finally {
      globalState.document = originalDocument;
      globalState.window = originalWindow;
      globalState.HTMLElement = originalHTMLElement;
    }
  });
});

describe('instagram post registration', () => {
  beforeEach(() => {
    vi.spyOn(privatePublish, 'resolveInstagramPrivatePublishConfig').mockResolvedValue({
      apiContext: {
        asbdId: '',
        csrfToken: 'csrf-token',
        igAppId: '936619743392459',
        igWwwClaim: '',
        instagramAjax: '1036523242',
        webSessionId: '',
      },
      jazoest: '22047',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers the post command with a required-value media arg', () => {
    const cmd = getRegistry().get('instagram/post');
    expect(cmd).toBeDefined();
    expect(cmd?.browser).toBe(true);
    expect(cmd?.timeoutSeconds).toBe(300);
    expect(cmd?.args.some((arg) => arg.name === 'media' && !arg.required && arg.valueRequired)).toBe(true);
    expect(cmd?.args.some((arg) => arg.name === 'content' && !arg.required && arg.positional)).toBe(true);
  });

  it('publishes via private API and returns the post URL', async () => {
    const imagePath = createTempImage('private-default.jpg');
    const privateSpy = vi.spyOn(privatePublish, 'publishImagesViaPrivateApi').mockResolvedValueOnce({
      code: 'PRIVATEDEFAULT123',
      uploadIds: ['111'],
    });
    const page = createPageMock([], {
      evaluate: vi.fn(async () => ({ ok: true })),
      getCookies: vi.fn().mockResolvedValue([{ name: 'csrftoken', value: 'csrf-token', domain: 'instagram.com' }]),
    });
    const cmd = getRegistry().get('instagram/post');

    const result = await cmd!.func!(page, { media: imagePath, content: 'private default' });

    expect(privateSpy).toHaveBeenCalledTimes(1);
    expect(page.setFileInput).not.toHaveBeenCalled();
    expect(result).toEqual([
      {
        status: '✅ Posted',
        detail: 'Single image post shared successfully',
        url: 'https://www.instagram.com/p/PRIVATEDEFAULT123/',
      },
    ]);
    privateSpy.mockRestore();
  });

  it('publishes mixed-media posts via private API and preserves input order', async () => {
    const imagePath = createTempImage('mixed-default.jpg');
    const videoPath = createTempVideo('mixed-default.mp4');
    const privateSpy = vi.spyOn(privatePublish, 'publishMediaViaPrivateApi').mockResolvedValueOnce({
      code: 'MIXEDPRIVATE123',
      uploadIds: ['111', '222'],
    });
    const page = createPageMock([], {
      evaluate: vi.fn(async () => ({ ok: true })),
      getCookies: vi.fn().mockResolvedValue([{ name: 'csrftoken', value: 'csrf-token', domain: 'instagram.com' }]),
    });
    const cmd = getRegistry().get('instagram/post');

    const result = await cmd!.func!(page, {
      media: `${imagePath},${videoPath}`,
      content: 'mixed private default',
    });

    expect(privateSpy).toHaveBeenCalledWith(expect.objectContaining({
      mediaItems: [
        { type: 'image', filePath: imagePath },
        { type: 'video', filePath: videoPath },
      ],
      caption: 'mixed private default',
    }));
    expect(page.setFileInput).not.toHaveBeenCalled();
    expect(result).toEqual([
      {
        status: '✅ Posted',
        detail: '2-item mixed-media carousel post shared successfully',
        url: 'https://www.instagram.com/p/MIXEDPRIVATE123/',
      },
    ]);
    privateSpy.mockRestore();
  });

  it('rejects missing --media before browser work', async () => {
    const page = createPageMock([]);
    const cmd = getRegistry().get('instagram/post');

    await expect(cmd!.func!(page, {
      content: 'missing media',
    })).rejects.toThrow('Argument "media" is required.');
  });

  it('rejects empty or invalid --media inputs', async () => {
    const imagePath = createTempImage('invalid-media-image.jpg');
    const page = createPageMock([]);
    const cmd = getRegistry().get('instagram/post');

    await expect(cmd!.func!(page, {
      media: '',
    })).rejects.toThrow('Argument "media" is required.');

    await expect(cmd!.func!(page, {
      media: `${imagePath},/tmp/does-not-exist.mp4`,
    })).rejects.toThrow('Media file not found');
  });

  it('propagates private API errors directly', async () => {
    const imagePath = createTempImage('private-fail.jpg');
    vi.spyOn(privatePublish, 'publishImagesViaPrivateApi').mockRejectedValueOnce(
      new CommandExecutionError('Instagram private publish configure failed: 400'),
    );
    const page = createPageMock([], {
      evaluate: vi.fn(async () => ({ ok: true })),
      getCookies: vi.fn().mockResolvedValue([{ name: 'csrftoken', value: 'csrf-token', domain: 'instagram.com' }]),
    });
    const cmd = getRegistry().get('instagram/post');

    await expect(cmd!.func!(page, {
      media: imagePath,
      content: 'should fail',
    })).rejects.toThrow('Instagram private publish configure failed: 400');
  });
});
