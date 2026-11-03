#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { searchOneSearch, getRecord } from './primoClient.js';
import { mapSearchResponse, mapDoc } from './mapper.js';
import { LoginRequiredError } from './auth.js';
import { getFullText } from './fullText.js';

function loginRequiredResult(err: LoginRequiredError) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ status: 'login_required', message: err.message }, null, 2),
      },
    ],
  };
}

// package.json sits one level above both src/ and dist/, so this resolves in tests and in the published package.
const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

export function createServer(): McpServer {
  const server = new McpServer({ name: 'neu-onesearch-mcp', version });

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
          .describe('Filter to one resource type (combines with the other filters, AND)'),
        dateFrom: z.number().int().optional().describe('Earliest publication year (combines with the other filters, AND)'),
        dateTo: z.number().int().optional().describe('Latest publication year (combines with the other filters, AND)'),
        peerReviewedOnly: z.boolean().optional().describe('Only return peer-reviewed results (combines with the other filters, AND)'),
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
        if (err instanceof LoginRequiredError) {
          return loginRequiredResult(err);
        }
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
        if (err instanceof LoginRequiredError) {
          return loginRequiredResult(err);
        }
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
        'Retrieve and extract the plain text of an article Northeastern subscribes to, fetched through the library EZproxy using the cached sign-in session. Pass a DOI (preferred) or an alma OneSearch record id. Requires a valid EZproxy session from `neu-onesearch-login`; returns status `login_required` when the session is missing or expired. Publishers the NEU proxy does not cover (usually open access) are fetched directly without the session; if that fails the status is `not_proxied` and `sourceUrl` is the publisher URL to open. Result statuses: ok, partial, login_required, not_proxied, not_entitled, not_found, too_large, unsupported, error.',
      inputSchema: {
        doi: z.string().optional().describe('Article DOI, or a https://doi.org/ URL (preferred input)'),
        recordId: z
          .string()
          .optional()
          .describe('alma OneSearch record id from a prior search_onesearch/get_record result'),
      },
    },
    async ({ doi, recordId }) => {
      try {
        const result = await getFullText({ doi, recordId });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        if (err instanceof LoginRequiredError) {
          return loginRequiredResult(err);
        }
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

// npm runs bins through a symlink (node_modules/.bin, npx), so compare real paths rather than raw argv[1].
function isEntrypoint(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main().catch((err) => {
    console.error('neu-onesearch-mcp failed to start:', err);
    process.exit(1);
  });
}
