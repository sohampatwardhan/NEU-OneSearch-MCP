import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../src/index.js';
import * as sessionModule from '../src/session.js';

async function connectedClient(server: ReturnType<typeof createServer>) {
  const client = new Client({ name: 'test client', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.server.connect(serverTransport)]);
  return client;
}

describe('MCP server tools', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('search_onesearch returns mapped results as JSON text', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        info: { total: 1 },
        docs: [
          {
            pnx: {
              display: { title: ['Test Title'], type: ['book'] },
              control: { recordid: ['alma1'] },
              addata: {},
            },
          },
        ],
      }),
    });

    const client = await connectedClient(createServer());
    const result = await client.request(
      { method: 'tools/call', params: { name: 'search_onesearch', arguments: { query: 'test' } } },
      CallToolResultSchema
    );

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.totalResults).toBe(1);
    expect(parsed.results[0].title).toBe('Test Title');
  });

  it('search_onesearch accepts a campus param and passes it through to the fetch call', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ info: { total: 0 }, docs: [] }),
    });

    const client = await connectedClient(createServer());
    const result = await client.request(
      { method: 'tools/call', params: { name: 'search_onesearch', arguments: { query: 'test', campus: 'oakland' } } },
      CallToolResultSchema
    );

    expect(result.isError).toBeFalsy();
    const calledUrl = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toContain('tab=Oakland');
    expect(calledUrl).toContain('scope=Mills_and_CI');
  });

  it('search_onesearch combines filters into one qInclude clause', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ info: { total: 0 }, docs: [] }),
    });

    const client = await connectedClient(createServer());
    const result = await client.request(
      {
        method: 'tools/call',
        params: {
          name: 'search_onesearch',
          arguments: { query: 'test', resourceType: 'books', peerReviewedOnly: true },
        },
      },
      CallToolResultSchema
    );

    expect(result.isError).toBeFalsy();
    const calledUrl = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const qInclude = new URL(calledUrl).searchParams.get('qInclude');
    expect(qInclude).toBe('facet_rtype,include,books|,|facet_tlevel,include,peer_reviewed');
  });

  it('get_record returns an error message for unsupported record ids', async () => {
    const client = await connectedClient(createServer());
    const result = await client.request(
      { method: 'tools/call', params: { name: 'get_record', arguments: { recordId: 'cdi_foo' } } },
      CallToolResultSchema
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('only supports Northeastern catalog records');
  });

  it('search_onesearch returns a login_required result when a stale session is rejected', async () => {
    vi.spyOn(sessionModule, 'loadSession').mockReturnValue('JSESSIONID=stale');
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 401,
      url: 'https://onesearch.library.northeastern.edu/primaws/x',
      redirected: false,
      json: async () => ({}),
    });

    const client = await connectedClient(createServer());
    const result = await client.request(
      { method: 'tools/call', params: { name: 'search_onesearch', arguments: { query: 'test' } } },
      CallToolResultSchema
    );

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.status).toBe('login_required');
    expect(parsed.message).toContain('login');
  });

  it('get_full_text returns an error when neither doi nor recordId is given', async () => {
    const client = await connectedClient(createServer());
    const result = await client.request(
      { method: 'tools/call', params: { name: 'get_full_text', arguments: {} } },
      CallToolResultSchema
    );

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.status).toBe('error');
    expect(parsed.message).toMatch(/doi/i);
  });

  it('get_full_text returns login_required when no session is cached', async () => {
    vi.spyOn(sessionModule, 'loadStoredCookies').mockReturnValue(null);
    const client = await connectedClient(createServer());
    const result = await client.request(
      { method: 'tools/call', params: { name: 'get_full_text', arguments: { doi: '10.1371/journal.pone.0212767' } } },
      CallToolResultSchema
    );

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.status).toBe('login_required');
    expect(parsed.sourceUrl).toContain('link.ezproxy.neu.edu');
  });

  it('get_record returns "no record found" for a valid but missing id', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ info: { total: 0 }, docs: [] }),
    });

    const client = await connectedClient(createServer());
    const result = await client.request(
      { method: 'tools/call', params: { name: 'get_record', arguments: { recordId: 'alma999' } } },
      CallToolResultSchema
    );

    expect(result.isError).toBeFalsy();
    expect((result.content[0] as { text: string }).text).toContain('No record found');
  });
});
