import * as fs from 'node:fs';
import * as path from 'node:path';

import { cli, Strategy } from '../../registry.js';
import { ArgumentError, CommandExecutionError } from '../../errors.js';
import type { IPage } from '../../types.js';
import {
  publishMediaViaPrivateApi,
  publishImagesViaPrivateApi,
  resolveInstagramPrivatePublishConfig,
} from './_shared/private-publish.js';
import { resolveInstagramRuntimeInfo } from './_shared/runtime-info.js';

const INSTAGRAM_HOME_URL = 'https://www.instagram.com/';
const SUPPORTED_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const SUPPORTED_VIDEO_EXTENSIONS = new Set(['.mp4']);
const MAX_MEDIA_ITEMS = 10;

type InstagramSuccessRow = {
  status: string;
  detail: string;
  url: string;
};
type InstagramPostMediaItem = {
  type: 'image' | 'video';
  filePath: string;
};

function requirePage(page: IPage | null): IPage {
  if (!page) throw new CommandExecutionError('Browser session required for instagram post');
  return page;
}

export function buildEnsureComposerOpenJs(): string {
  return `
    (() => {
      const path = window.location?.pathname || '';
      const onLoginRoute = /\\/accounts\\/login\\/?/.test(path);
      const hasLoginField = !!document.querySelector('input[name="username"], input[name="password"]');
      const hasLoginButton = Array.from(document.querySelectorAll('button, div[role="button"]')).some((el) => {
        const text = (el.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
        return text === 'log in' || text === 'login' || text === '登录';
      });

      if (onLoginRoute || (hasLoginField && hasLoginButton)) {
        return { ok: false, reason: 'auth' };
      }

      const alreadyOpen = document.querySelector('input[type="file"]');
      if (alreadyOpen) return { ok: true };

      const labels = ['Create', 'New post', 'Post', '创建', '新帖子'];
      const nodes = Array.from(document.querySelectorAll('a, button, div[role="button"], svg[aria-label], [aria-label]'));
      for (const node of nodes) {
        const text = ((node.textContent || '') + ' ' + (node.getAttribute?.('aria-label') || '')).trim();
        if (labels.some((label) => text.toLowerCase().includes(label.toLowerCase()))) {
          const clickable = node.closest('a, button, div[role="button"]') || node;
          if (clickable instanceof HTMLElement) {
            clickable.click();
            return { ok: true };
          }
        }
      }

      return { ok: true };
    })()
  `;
}

export function buildPublishStatusProbeJs(): string {
  return `
    (() => {
      const isVisible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && rect.width > 0
          && rect.height > 0;
      };
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter((el) => isVisible(el));
      const dialogText = dialogs
        .map((el) => (el.textContent || '').replace(/\\s+/g, ' ').trim())
        .join(' ');
      const url = window.location.href;
      const visibleText = dialogText.toLowerCase();
      const sharingVisible = /sharing/.test(visibleText);
      const shared = /post shared|your post has been shared|已分享|已发布/.test(visibleText)
        || /\\/p\\//.test(url);
      const failed = !shared && !sharingVisible && (
        /couldn['']t be shared|could not be shared|failed to share|share failed|无法分享|分享失败/.test(visibleText)
        || (/something went wrong/.test(visibleText) && /try again/.test(visibleText))
      );
      const composerOpen = dialogs.some((dialog) =>
        !!dialog.querySelector('textarea, [contenteditable="true"], input[type="file"]')
        || /write a caption|add location|advanced settings|select from computer|crop|filters|adjustments|sharing/.test((dialog.textContent || '').toLowerCase())
      );
      const settled = !shared && !composerOpen && !/sharing/.test(visibleText);
      return { ok: shared, failed, settled, url: /\\/p\\//.test(url) ? url : '' };
    })()
  `;
}

export function buildInspectUploadStageJs(): string {
  return `
    (() => {
      const isVisible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && rect.width > 0
          && rect.height > 0;
      };
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter((el) => isVisible(el));
      const visibleTexts = dialogs.map((el) => (el.textContent || '').replace(/\\s+/g, ' ').trim());
      const dialogText = visibleTexts.join(' ');
      const combined = dialogText.toLowerCase();
      const hasVisibleButtonInDialogs = (labels) => {
        return dialogs.some((dialog) =>
          Array.from(dialog.querySelectorAll('button, div[role="button"]')).some((el) => {
            const text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
            const aria = (el.getAttribute?.('aria-label') || '').replace(/\\s+/g, ' ').trim();
            return isVisible(el) && (labels.includes(text) || labels.includes(aria));
          })
        );
      };
      const hasCaption = dialogs.some((dialog) => !!dialog.querySelector('textarea, [contenteditable="true"]'));
      const hasPicker = hasVisibleButtonInDialogs(['Select from computer', '从电脑中选择']);
      const hasNext = hasVisibleButtonInDialogs(['Next', '下一步']);
      const hasPreviewUi = hasCaption
        || (!hasPicker && hasNext)
        || /crop|select crop|select zoom|open media gallery|filters|adjustments|裁剪|缩放|滤镜|调整/.test(combined);
      const failed = /something went wrong|please try again|couldn['']t upload|could not upload|upload failed|try again|出错|失败/.test(combined);
      if (hasPreviewUi) return { state: 'preview', detail: dialogText || '' };
      if (failed) return { state: 'failed', detail: dialogText || 'Something went wrong' };
      return { state: 'pending', detail: dialogText || '' };
    })()
  `;
}

export function buildClickActionJs(labels: string[], scope: 'any' | 'media' | 'caption' = 'any'): string {
  return `
    ((labels, scope) => {
      const isVisible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && rect.width > 0
          && rect.height > 0;
      };

      const matchesScope = (dialog) => {
        if (!(dialog instanceof HTMLElement) || !isVisible(dialog)) return false;
        const text = (dialog.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
        if (scope === 'caption') {
          return !!dialog.querySelector('textarea, [contenteditable="true"]')
            || text.includes('write a caption')
            || text.includes('add location')
            || text.includes('add collaborators')
            || text.includes('accessibility')
            || text.includes('advanced settings');
        }
        if (scope === 'media') {
          return !!dialog.querySelector('input[type="file"]')
            || text.includes('select from computer')
            || text.includes('crop')
            || text.includes('filters')
            || text.includes('adjustments')
            || text.includes('open media gallery')
            || text.includes('select crop')
            || text.includes('select zoom');
        }
        return true;
      };

      const containers = scope !== 'any'
        ? Array.from(document.querySelectorAll('[role="dialog"]')).filter(matchesScope)
        : [document.body];

      for (const container of containers) {
        const nodes = Array.from(container.querySelectorAll('button, div[role="button"]'));
        for (const node of nodes) {
          const text = (node.textContent || '').replace(/\\s+/g, ' ').trim();
          const aria = (node.getAttribute?.('aria-label') || '').replace(/\\s+/g, ' ').trim();
          if (!text && !aria) continue;
          if (!labels.includes(text) && !labels.includes(aria)) continue;
          if (node instanceof HTMLElement && isVisible(node) && node.getAttribute('aria-disabled') !== 'true') {
            node.click();
            return { ok: true, label: text || aria };
          }
        }
      }
      return { ok: false };
    })(${JSON.stringify(labels)}, ${JSON.stringify(scope)})
  `;
}

function validateMixedMediaItems(inputs: string[]): InstagramPostMediaItem[] {
  if (!inputs.length) {
    throw new ArgumentError(
      'Argument "media" is required.',
      'Provide --media /path/to/file.jpg or --media /path/a.jpg,/path/b.mp4',
    );
  }
  if (inputs.length > MAX_MEDIA_ITEMS) {
    throw new ArgumentError(`Too many media items: ${inputs.length}`, `Instagram carousel posts support at most ${MAX_MEDIA_ITEMS} items`);
  }

  const items = inputs.map((input) => {
    const resolved = path.resolve(String(input || '').trim());
    if (!resolved) {
      throw new ArgumentError('Media path cannot be empty');
    }
    if (!fs.existsSync(resolved)) {
      throw new ArgumentError(`Media file not found: ${resolved}`);
    }
    const ext = path.extname(resolved).toLowerCase();
    if (SUPPORTED_IMAGE_EXTENSIONS.has(ext)) {
      return { type: 'image' as const, filePath: resolved };
    }
    if (SUPPORTED_VIDEO_EXTENSIONS.has(ext)) {
      return { type: 'video' as const, filePath: resolved };
    }
    throw new ArgumentError(`Unsupported media format: ${ext}`, 'Supported formats: images (.jpg, .jpeg, .png, .webp) and videos (.mp4)');
  });

  return items;
}

function normalizePostMediaItems(kwargs: Record<string, unknown>): InstagramPostMediaItem[] {
  const media = String(kwargs.media ?? '').trim();
  return validateMixedMediaItems(media.split(',').map((part) => part.trim()).filter(Boolean));
}

function validateInstagramPostArgs(kwargs: Record<string, unknown>): void {
  const media = kwargs.media;
  if (media === undefined) {
    throw new ArgumentError(
      'Argument "media" is required.',
      'Provide --media /path/to/file.jpg or --media /path/a.jpg,/path/b.mp4',
    );
  }
}

function describePostDetail(mediaItems: InstagramPostMediaItem[]): string {
  if (mediaItems.every((item) => item.type === 'image')) {
    return mediaItems.length === 1
      ? 'Single image post shared successfully'
      : `${mediaItems.length}-image carousel post shared successfully`;
  }
  return mediaItems.length === 1
    ? 'Single mixed-media post shared successfully'
    : `${mediaItems.length}-item mixed-media carousel post shared successfully`;
}

function buildInstagramSuccessResult(mediaItems: InstagramPostMediaItem[], url: string): InstagramSuccessRow[] {
  return [{
    status: '✅ Posted',
    detail: describePostDetail(mediaItems),
    url,
  }];
}

async function resolveCurrentUserId(page: IPage): Promise<string> {
  const cookies = await page.getCookies({ domain: 'instagram.com' });
  return cookies.find((cookie) => cookie.name === 'ds_user_id')?.value || '';
}

async function resolveProfileUrl(page: IPage, currentUserId = ''): Promise<string> {
  if (currentUserId) {
    const runtimeInfo = await resolveInstagramRuntimeInfo(page);
    const apiResult = await page.evaluate(`
      (async () => {
        const userId = ${JSON.stringify(currentUserId)};
        const appId = ${JSON.stringify(runtimeInfo.appId || '')};
        try {
          const res = await fetch(
            'https://www.instagram.com/api/v1/users/' + encodeURIComponent(userId) + '/info/',
            {
              credentials: 'include',
              headers: appId ? { 'X-IG-App-ID': appId } : {},
            },
          );
          if (!res.ok) return { ok: false };
          const data = await res.json();
          const username = data?.user?.username || '';
          return { ok: !!username, username };
        } catch {
          return { ok: false };
        }
      })()
    `) as { ok?: boolean; username?: string };

    if (apiResult?.ok && apiResult.username) {
      return new URL(`/${apiResult.username}/`, INSTAGRAM_HOME_URL).toString();
    }
  }

  const result = await page.evaluate(`
    (() => {
      const isVisible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && rect.width > 0
          && rect.height > 0;
      };

      const anchors = Array.from(document.querySelectorAll('a[href]'))
        .filter((el) => el instanceof HTMLAnchorElement && isVisible(el))
        .map((el) => ({
          href: el.getAttribute('href') || '',
          text: (el.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase(),
          aria: (el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().toLowerCase(),
        }))
        .filter((el) => /^\\/[^/?#]+\\/$/.test(el.href));

      const explicitProfile = anchors.find((el) => el.text === 'profile' || el.aria === 'profile')?.href || '';
      const path = explicitProfile;
      return { ok: !!path, path };
    })()
  `) as { ok?: boolean; path?: string };

  if (!result?.ok || !result.path) return '';
  return new URL(result.path, INSTAGRAM_HOME_URL).toString();
}

async function collectVisibleProfilePostPaths(page: IPage): Promise<string[]> {
  const result = await page.evaluate(`
    (() => {
      const isVisible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && rect.width > 0
          && rect.height > 0;
      };

      const hrefs = Array.from(document.querySelectorAll('a[href*="/p/"]'))
        .filter((el) => el instanceof HTMLAnchorElement && isVisible(el))
        .map((el) => el.getAttribute('href') || '')
        .filter((href) => /^\\/(?:[^/?#]+\\/)?p\\/[^/?#]+\\/?$/.test(href))
        .filter((href, index, arr) => arr.indexOf(href) === index);

      return { ok: hrefs.length > 0, hrefs };
    })()
  `) as { ok?: boolean; hrefs?: string[] };

  return Array.isArray(result?.hrefs) ? result.hrefs.filter(Boolean) : [];
}

async function captureExistingProfilePostPaths(page: IPage): Promise<Set<string>> {
  const currentUserId = await resolveCurrentUserId(page);
  if (!currentUserId) return new Set();

  const profileUrl = await resolveProfileUrl(page, currentUserId);
  if (!profileUrl) return new Set();

  try {
    await page.goto(profileUrl);
    await page.wait({ time: 3 });
    return new Set(await collectVisibleProfilePostPaths(page));
  } catch {
    return new Set();
  }
}

async function resolveLatestPostUrl(page: IPage, existingPostPaths: ReadonlySet<string>): Promise<string> {
  const currentUrl = await page.getCurrentUrl?.();
  if (currentUrl && /\/p\//.test(currentUrl)) return currentUrl;

  const currentUserId = await resolveCurrentUserId(page);
  const profileUrl = await resolveProfileUrl(page, currentUserId);
  if (!profileUrl) return '';

  await page.goto(profileUrl);
  await page.wait({ time: 4 });

  for (let attempt = 0; attempt < 8; attempt++) {
    const hrefs = await collectVisibleProfilePostPaths(page);
    const href = hrefs.find((candidate) => !existingPostPaths.has(candidate)) || '';
    if (href) {
      return new URL(href, INSTAGRAM_HOME_URL).toString();
    }

    if (attempt < 7) await page.wait({ time: 1 });
  }

  return '';
}

async function executePrivateInstagramPost(input: {
  page: IPage;
  mediaItems: InstagramPostMediaItem[];
  content: string;
  existingPostPaths: Set<string>;
}): Promise<InstagramSuccessRow[]> {
  const privateConfig = await resolveInstagramPrivatePublishConfig(input.page);
  const privateResult = input.mediaItems.every((item) => item.type === 'image')
    ? await publishImagesViaPrivateApi({
        page: input.page,
        imagePaths: input.mediaItems.map((item) => item.filePath),
        caption: input.content,
        apiContext: privateConfig.apiContext,
        jazoest: privateConfig.jazoest,
      })
    : await publishMediaViaPrivateApi({
        page: input.page,
        mediaItems: input.mediaItems,
        caption: input.content,
        apiContext: privateConfig.apiContext,
        jazoest: privateConfig.jazoest,
      });
  const url = privateResult.code
    ? new URL(`/p/${privateResult.code}/`, INSTAGRAM_HOME_URL).toString()
    : await resolveLatestPostUrl(input.page, input.existingPostPaths);
  return buildInstagramSuccessResult(input.mediaItems, url);
}

cli({
  site: 'instagram',
  name: 'post',
  description: 'Post an Instagram feed image or mixed-media carousel',
  domain: 'www.instagram.com',
  strategy: Strategy.UI,
  browser: true,
  timeoutSeconds: 300,
  args: [
    { name: 'media', required: false, valueRequired: true, help: `Comma-separated media paths (images/videos, up to ${MAX_MEDIA_ITEMS})` },
    { name: 'content', positional: true, required: false, help: 'Caption text' },
  ],
  columns: ['status', 'detail', 'url'],
  validateArgs: validateInstagramPostArgs,
  func: async (page: IPage | null, kwargs) => {
    const browserPage = requirePage(page);
    const mediaItems = normalizePostMediaItems(kwargs as Record<string, unknown>);
    const content = String(kwargs.content ?? '').trim();
    const existingPostPaths = await captureExistingProfilePostPaths(browserPage);
    return executePrivateInstagramPost({
      page: browserPage,
      mediaItems,
      content,
      existingPostPaths,
    });
  },
});
