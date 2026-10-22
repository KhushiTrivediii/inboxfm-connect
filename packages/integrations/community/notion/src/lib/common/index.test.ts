import { describe, it, expect, vi } from 'vitest';
import { fetchAllWorkspaceUsers, NotionUsersClient } from './index';

describe('fetchAllWorkspaceUsers', () => {
  it('should fetch single page of users when has_more is false', async () => {
    const mockUsers = [
      { id: 'u1', name: 'Alice', type: 'person' },
      { id: 'u2', name: 'Bob', type: 'person' },
    ];
    const mockNotion: NotionUsersClient = {
      users: {
        list: vi.fn().mockResolvedValue({
          results: mockUsers,
          has_more: false,
          next_cursor: null,
        }),
      },
    };

    const result = await fetchAllWorkspaceUsers(mockNotion);
    expect(result.users).toHaveLength(2);
    expect(result.users).toEqual(mockUsers);
    expect(result.truncated).toBe(false);
    expect(mockNotion.users.list).toHaveBeenCalledTimes(1);
    expect(mockNotion.users.list).toHaveBeenCalledWith({
      page_size: 100,
      start_cursor: undefined,
    });
  });

  it('should paginate across multiple pages until has_more is false', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: `u-${i}`,
      name: `User ${i}`,
      type: 'person',
    }));
    const page2 = Array.from({ length: 25 }, (_, i) => ({
      id: `u-${100 + i}`,
      name: `User ${100 + i}`,
      type: 'person',
    }));

    const mockNotion: NotionUsersClient = {
      users: {
        list: vi
          .fn()
          .mockResolvedValueOnce({
            results: page1,
            has_more: true,
            next_cursor: 'cursor-page-2',
          })
          .mockResolvedValueOnce({
            results: page2,
            has_more: false,
            next_cursor: null,
          }),
      },
    };

    const result = await fetchAllWorkspaceUsers(mockNotion);
    expect(result.users).toHaveLength(125);
    expect(result.truncated).toBe(false);
    expect(mockNotion.users.list).toHaveBeenCalledTimes(2);
    expect(mockNotion.users.list).toHaveBeenNthCalledWith(1, {
      page_size: 100,
      start_cursor: undefined,
    });
    expect(mockNotion.users.list).toHaveBeenNthCalledWith(2, {
      page_size: 100,
      start_cursor: 'cursor-page-2',
    });
  });

  it('should handle mid-pagination failure by returning partial users and truncated true', async () => {
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: `u-${i}`,
      name: `User ${i}`,
      type: 'person',
    }));

    const mockNotion: NotionUsersClient = {
      users: {
        list: vi
          .fn()
          .mockResolvedValueOnce({
            results: page1,
            has_more: true,
            next_cursor: 'cursor-page-2',
          })
          .mockRejectedValueOnce(
            new Error('Notion API rate limit or network error')
          ),
      },
    };

    const result = await fetchAllWorkspaceUsers(mockNotion);
    expect(result.users).toHaveLength(100);
    expect(result.truncated).toBe(true);
    expect(mockNotion.users.list).toHaveBeenCalledTimes(2);
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('should handle empty first page with has_more false', async () => {
    const mockNotion: NotionUsersClient = {
      users: {
        list: vi.fn().mockResolvedValue({
          results: [],
          has_more: false,
          next_cursor: null,
        }),
      },
    };

    const result = await fetchAllWorkspaceUsers(mockNotion);
    expect(result.users).toHaveLength(0);
    expect(result.truncated).toBe(false);
    expect(mockNotion.users.list).toHaveBeenCalledTimes(1);
    expect(mockNotion.users.list).toHaveBeenCalledWith({
      page_size: 100,
      start_cursor: undefined,
    });
  });

  it('should exit with truncated true when has_more is true but next_cursor is null or undefined', async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => ({
      id: `u-${i}`,
      name: `User ${i}`,
      type: 'person',
    }));

    const mockNotion: NotionUsersClient = {
      users: {
        list: vi.fn().mockResolvedValue({
          results: page1,
          has_more: true,
          next_cursor: null,
        }),
      },
    };

    const result = await fetchAllWorkspaceUsers(mockNotion);
    expect(result.users).toHaveLength(50);
    expect(result.truncated).toBe(true);
    expect(mockNotion.users.list).toHaveBeenCalledTimes(1);
  });

  it('should stop after reaching MAX_PAGES cap to prevent infinite loops and return truncated true', async () => {
    const mockNotion: NotionUsersClient = {
      users: {
        list: vi.fn().mockResolvedValue({
          results: Array.from({ length: 100 }, (_, i) => ({
            id: `user-${i}`,
            name: `User ${i}`,
            type: 'person',
          })),
          has_more: true,
          next_cursor: 'endless-cursor',
        }),
      },
    };

    const result = await fetchAllWorkspaceUsers(mockNotion);
    expect(mockNotion.users.list).toHaveBeenCalledTimes(50);
    expect(result.users).toHaveLength(5000);
    expect(result.truncated).toBe(true);
  });
});
