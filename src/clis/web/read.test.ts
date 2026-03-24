import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockDownloadArticle } = vi.hoisted(() => ({
  mockDownloadArticle: vi.fn(),
}));

vi.mock('../../download/article-download.js', () => ({
  downloadArticle: mockDownloadArticle,
}));

import { getRegistry } from '../../registry.js';
import './read.js';

describe('web read adapter', () => {
  const command = getRegistry().get('web/read');

  beforeEach(() => {
    mockDownloadArticle.mockReset();
  });

  it('uses the URL as a positional primary argument', () => {
    expect(command?.args[0]).toMatchObject({
      name: 'url',
      required: true,
      positional: true,
    });
  });

  it('extracts article data and forwards referer-aware download options', async () => {
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      wait: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue({
        title: 'Example Article',
        author: 'OpenCLI',
        publishTime: '2026-03-24',
        contentHtml: '<article><p>Hello</p></article>',
        imageUrls: ['https://example.com/image.png'],
      }),
    } as any;

    mockDownloadArticle.mockResolvedValue([
      { title: 'Example Article', author: 'OpenCLI', publish_time: '2026-03-24', status: 'saved', size: '1 KB' },
    ]);

    const result = await command!.func!(page, {
      url: 'https://example.com/posts/test',
      output: './articles',
      wait: 5,
      'download-images': false,
    });

    expect(page.goto).toHaveBeenCalledWith('https://example.com/posts/test');
    expect(page.wait).toHaveBeenCalledWith(5);
    expect(mockDownloadArticle).toHaveBeenCalledWith(
      {
        title: 'Example Article',
        author: 'OpenCLI',
        publishTime: '2026-03-24',
        sourceUrl: 'https://example.com/posts/test',
        contentHtml: '<article><p>Hello</p></article>',
        imageUrls: ['https://example.com/image.png'],
      },
      {
        output: './articles',
        downloadImages: false,
        imageHeaders: { Referer: 'https://example.com/' },
      },
    );
    expect(result).toEqual([
      { title: 'Example Article', author: 'OpenCLI', publish_time: '2026-03-24', status: 'saved', size: '1 KB' },
    ]);
  });
});
