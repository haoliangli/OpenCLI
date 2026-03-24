import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockApiGet, mockGetSelfUid } = vi.hoisted(() => ({
  mockApiGet: vi.fn(),
  mockGetSelfUid: vi.fn(),
}));

vi.mock('./utils.js', () => ({
  apiGet: mockApiGet,
  payloadData: (payload: unknown) => (payload as { data?: unknown })?.data ?? payload,
  getSelfUid: mockGetSelfUid,
}));

import { getRegistry } from '../../registry.js';
import './favorite.js';

describe('bilibili favorite adapter', () => {
  const command = getRegistry().get('bilibili/favorite');

  beforeEach(() => {
    mockApiGet.mockReset();
    mockGetSelfUid.mockReset();
  });

  it('uses the logged-in user UID when resolving the default favorite folder', async () => {
    mockGetSelfUid.mockResolvedValue('123456');
    mockApiGet
      .mockResolvedValueOnce({
        data: { list: [{ id: 999 }] },
      })
      .mockResolvedValueOnce({
        data: {
          medias: [
            {
              title: 'Video title',
              upper: { name: 'Author' },
              cnt_info: { play: 42 },
              bvid: 'BV1xx411c7mD',
            },
          ],
        },
      });

    const result = await command!.func!({} as any, { limit: 5, page: 1 });

    expect(mockGetSelfUid).toHaveBeenCalledWith({});
    expect(mockApiGet).toHaveBeenNthCalledWith(1, {}, '/x/v3/fav/folder/created/list-all', {
      params: { up_mid: '123456' },
      signed: true,
    });
    expect(mockApiGet).toHaveBeenNthCalledWith(2, {}, '/x/v3/fav/resource/list', {
      params: { media_id: 999, pn: 1, ps: 5 },
      signed: true,
    });
    expect(result).toEqual([
      {
        rank: 1,
        title: 'Video title',
        author: 'Author',
        plays: 42,
        url: 'https://www.bilibili.com/video/BV1xx411c7mD',
      },
    ]);
  });
});
