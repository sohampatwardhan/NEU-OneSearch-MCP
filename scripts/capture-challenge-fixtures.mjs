// One-off capture of bot-wall pages for test fixtures (#14). Needs `npm run build` and a cached NEU session.
// Exactly one request per URL, using the package's own fetchers and headers; no retries, no variations.
// Prints only status, final host and sizes. Never prints or saves cookie values.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchEzproxyResource, fetchPublicResource, toEzproxyFetchUrl } from '../dist/ezproxy.js';
import { loadStoredCookies } from '../dist/session.js';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '../test/fixtures');
mkdirSync(outDir, { recursive: true });

const targets = [
  { file: 'challenge-springer.html', url: 'https://doi.org/10.1007/s42979-024-03476-y', proxied: true },
  { file: 'challenge-ieee.html', url: 'https://doi.org/10.1109/TII.2018.2822680', proxied: true },
  { file: 'mdpi-403.html', url: 'https://www.mdpi.com/2410-387X/7/2/30/pdf', proxied: false },
  {
    file: 'ezproxy-interstitial.html',
    url: 'https://link.springer.com/content/pdf/10.1007/s42979-024-03476-y.pdf',
    proxied: true,
  },
];

function trim(html) {
  return html
    .replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi, '$1/* trimmed */$2')
    .slice(0, 4096);
}

const cookies = loadStoredCookies() ?? [];
for (const t of targets) {
  const result = t.proxied
    ? await fetchEzproxyResource(toEzproxyFetchUrl(t.url), cookies)
    : await fetchPublicResource(t.url);
  if (result.kind !== 'response') {
    console.log(`${t.file}: kind=${result.kind} finalHost=${result.finalUrl ? new URL(result.finalUrl).host : null}`);
    continue;
  }
  const html = new TextDecoder('utf-8', { fatal: false }).decode(result.body);
  const saved = trim(html);
  writeFileSync(join(outDir, t.file), saved);
  console.log(
    `${t.file}: http=${result.httpStatus} finalHost=${new URL(result.finalUrl).host} contentType=${result.contentType} bytes=${result.body.length} saved=${saved.length}`
  );
}
