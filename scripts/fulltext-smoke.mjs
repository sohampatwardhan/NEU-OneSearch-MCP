import { getFullText } from '../dist/fullText.js';
import { EZPROXY_PROBE_DOI } from '../dist/ezproxy.js';

const doi = process.argv[2] ?? EZPROXY_PROBE_DOI;

const result = await getFullText({ doi });
const preview = result.text ? result.text.slice(0, 500) : null;

console.log(
  JSON.stringify(
    {
      status: result.status,
      doi: result.doi,
      title: result.title,
      via: result.via,
      contentType: result.contentType,
      sourceUrl: result.sourceUrl,
      pageCount: result.pageCount,
      pagesExtracted: result.pagesExtracted,
      truncated: result.truncated,
      charCount: result.charCount,
      message: result.message,
      textPreview: preview,
    },
    null,
    2
  )
);

if (result.status === 'ok' || result.status === 'partial') {
  console.log('Full-text smoke check returned extractable text.');
} else if (result.status === 'login_required') {
  console.log('No usable EZproxy session. Run `node dist/login.js` and finish the proxy sign-in, then retry.');
  process.exitCode = 2;
} else {
  console.log('Full-text smoke check did not retrieve article text. See status and message above.');
  process.exitCode = 1;
}
