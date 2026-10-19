import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../src/index.js';

const fixturePdf = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/tiny.pdf'));

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
    vi.unstubAllEnvs();
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

  it('search_onesearch surfaces a facet-conflict error as a tool error', async () => {
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

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('only supports one filter');
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

  it('search_onesearch stays anonymous when no session file exists', async () => {
    vi.stubEnv('NEU_ONESEARCH_SESSION_PATH', '/nonexistent/neu-onesearch-session.json');
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ info: { total: 0 }, docs: [] }),
    });

    const client = await connectedClient(createServer());
    const result = await client.request(
      { method: 'tools/call', params: { name: 'search_onesearch', arguments: { query: 'test' } } },
      CallToolResultSchema
    );

    expect(result.isError).toBeFalsy();
    const init = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit | undefined;
    expect(init?.headers).toBeUndefined();
  });

  it('get_full_text reports login_required and does not fetch when no session exists', async () => {
    vi.stubEnv('NEU_ONESEARCH_SESSION_PATH', '/nonexistent/neu-onesearch-session.json');
    const client = await connectedClient(createServer());
    const result = await client.request(
      {
        method: 'tools/call',
        params: { name: 'get_full_text', arguments: { doi: '10.1371/journal.pone.0212767' } },
      },
      CallToolResultSchema
    );

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.status).toBe('login_required');
    expect(parsed.text).toBeNull();
    expect(parsed.sourceUrl).toContain('link.ezproxy.neu.edu');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('get_full_text returns extracted text and keeps the session cookie out of the tool result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'onesearch-mcp-fulltext-'));
    const sessionPath = join(dir, 'session.json');
    writeFileSync(
      sessionPath,
      JSON.stringify({
        cookies: [{ name: 'ezproxy', value: 'secret-cookie-value', domain: '.ezproxy.neu.edu', path: '/', expires: -1 }],
      })
    );
    vi.stubEnv('NEU_ONESEARCH_SESSION_PATH', sessionPath);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(fixturePdf, { status: 200, headers: { 'content-type': 'application/pdf' } })
    );

    try {
      const client = await connectedClient(createServer());
      const result = await client.request(
        {
          method: 'tools/call',
          params: { name: 'get_full_text', arguments: { doi: '10.1371/journal.pone.0212767' } },
        },
        CallToolResultSchema
      );

      expect(result.isError).toBeFalsy();
      const text = (result.content[0] as { text: string }).text;
      const parsed = JSON.parse(text);
      expect(parsed.status).toBe('ok');
      expect(parsed.via).toBe('pdf');
      expect(parsed.text).toContain('Hello from the proxy fixture.');
      expect(text).not.toContain('secret-cookie-value');
      const init = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
      expect((init.headers as Record<string, string>).Cookie).toContain('ezproxy=secret-cookie-value');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
