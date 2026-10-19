import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { searchOneSearch, getRecord } from './primoClient.js';
import { mapSearchResponse, mapDoc } from './mapper.js';
import { getFullText } from './fullText.js';

export function createServer(): McpServer {
  const server = new McpServer({ name: 'neu-onesearch-mcp', version: '0.1.0' });

  server.registerTool(
    'search_onesearch',
    {
      description:
        'Search Northeastern University Scholar OneSearch for academic references and library resources. Anonymous. A saved NEU session does not change these metadata results. Use get_full_text with a result doi when you need the article text.',
      inputSchema: {
        query: z.string().describe('Free-text search query'),
        limit: z.number().int().min(1).max(50).optional().describe('Max results to return (default 10, max 50)'),
        resourceType: z
          .enum(['articles', 'journals', 'books', 'newspaper_articles', 'reviews', 'book_chapters', 'dissertations'])
          .optional()
          .describe('Filter to one resource type'),
        dateFrom: z.number().int().optional().describe('Earliest publication year'),
        dateTo: z.number().int().optional().describe('Latest publication year'),
        peerReviewedOnly: z.boolean().optional().describe('Only return peer-reviewed results'),
        sort: z.enum(['rank', 'date', 'title', 'author']).optional().describe('Sort order (default rank)'),
        campus: z
          .enum(['all', 'boston', 'oakland', 'online'])
          .optional()
          .describe('Restrict to one NEU campus/scope (default: all campuses)'),
      },
    },
    async (params) => {
      try {
        const raw = await searchOneSearch(params);
        const mapped = mapSearchResponse(raw, params.campus);
        return { content: [{ type: 'text' as const, text: JSON.stringify(mapped, null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `OneSearch search failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'get_record',
    {
      description:
        'Fetch full detail for a single OneSearch catalog record (abstract, table of contents, availability, full-text link). Returns links, including ezproxyDoiUrl, but not the article body. Use get_full_text for entitled full text. Only alma record ids are supported.',
      inputSchema: {
        recordId: z.string().describe('Record id from a prior search_onesearch result (must start with "alma")'),
      },
    },
    async ({ recordId }) => {
      try {
        const doc = await getRecord(recordId);
        if (!doc) {
          return { content: [{ type: 'text' as const, text: `No record found for id: ${recordId}` }] };
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(mapDoc(doc), null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `get_record failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'get_full_text',
    {
      description:
        'Retrieve synthesizable plain text for one item the signed-in Northeastern user can access through the library EZproxy. Requires a session from `node dist/login.js` that captured the EZproxy cookie (NU IT SSO in the browser; this server never asks for a password). Pass doi from search_onesearch — that works for CDI articles as well as catalog records — or an alma recordId. When both are passed, doi is used. Returns extracted PDF or HTML text plus source URL, content type, and page count when known. Does not return the original PDF or other binary files. Caps download size, PDF pages, and characters. Status login_required, not_entitled, partial, unsupported, too_large, or not_found means the text is missing or incomplete. Anonymous search_onesearch and get_record are unchanged.',
      inputSchema: {
        doi: z
          .string()
          .optional()
          .describe('DOI from a search result, with or without a https://doi.org/ prefix. Preferred over recordId, including for CDI articles.'),
        recordId: z
          .string()
          .optional()
          .describe('NEU catalog record id from search_onesearch. Must start with "alma". Used only when doi is omitted.'),
      },
    },
    async ({ doi, recordId }) => {
      try {
        const result = await getFullText({ doi, recordId });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          isError: result.status === 'error',
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `get_full_text failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  return server;
}

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
