import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { searchOneSearch, getRecord } from './primoClient.js';
import { mapSearchResponse, mapDoc } from './mapper.js';

export function createServer(): McpServer {
  const server = new McpServer({ name: 'neu-onesearch-mcp', version: '0.1.0' });

  server.registerTool(
    'search_onesearch',
    {
      description:
        'Search Northeastern University Scholar OneSearch for academic references and library resources.',
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
      },
    },
    async (params) => {
      try {
        const raw = await searchOneSearch(params);
        const mapped = mapSearchResponse(raw);
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
        'Fetch full detail for a single OneSearch catalog record (abstract, table of contents, availability, full-text link).',
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
