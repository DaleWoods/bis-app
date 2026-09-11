import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `addComponent` and `addComment` - the two write-back steps that match what
 * the manual process did by hand: tag the ticket with a completion marker,
 * and leave a comment recording the score.
 */
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

vi.mock('../config/env.js', () => ({
  env: {
    jira: { configured: true, baseUrl: 'https://example.atlassian.net', email: 'a@b.c', apiToken: 'x' },
  },
}));

const { addComponent, addComment } = await import('./jira.js');

beforeEach(() => {
  fetchMock.mockReset();
});

describe('addComponent', () => {
  it('adds the component when the ticket does not already have it', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ fields: { components: [] } }) })
      .mockResolvedValueOnce({ ok: true, status: 204, text: async () => '' });

    await addComponent('ECOM-1', 'BIS_added');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, putCall] = fetchMock.mock.calls;
    expect(putCall[0]).toContain('/rest/api/3/issue/ECOM-1');
    expect(JSON.parse(putCall[1].body)).toEqual({ update: { components: [{ add: { name: 'BIS_added' } }] } });
  });

  it('does not re-add a component the ticket already has', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ fields: { components: [{ name: 'BIS_added' }] } }),
    });

    await addComponent('ECOM-1', 'BIS_added');

    // Only the read - no PUT, and no duplicate-looking edit on the ticket's history.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('matches the component name regardless of case', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ fields: { components: [{ name: 'bis_added' }] } }),
    });

    await addComponent('ECOM-1', 'BIS_added');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('addComment', () => {
  it('posts the comment wrapped in the minimal ADF a v3 comment body needs', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 201, text: async () => '{}' });

    await addComment('ECOM-1', 'Business Impact Score: 42, recorded by the committee.');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/rest/api/3/issue/ECOM-1/comment');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      body: {
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Business Impact Score: 42, recorded by the committee.' }] }],
      },
    });
  });
});
