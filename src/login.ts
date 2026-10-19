import { chromium, type BrowserContext } from 'playwright';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { buildEzproxyDoiUrl, EZPROXY_PROBE_DOI } from './ezproxy.js';
import { hasEzproxySession, isEzproxyHostname, resolveSessionPath } from './session.js';

const LOGIN_URL = 'https://onesearch.library.northeastern.edu/discovery/login?vid=01NEU_INST:NUL';

async function waitForEzproxySession(context: BrowserContext): Promise<boolean> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const cookies = await context.cookies();
    if (hasEzproxySession(cookies)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function main(): Promise<void> {
  const sessionPath = resolveSessionPath();
  mkdirSync(dirname(sessionPath), { recursive: true });

  const probeUrl = buildEzproxyDoiUrl(EZPROXY_PROBE_DOI);
  if (!probeUrl) {
    throw new Error('Internal error: the EZproxy probe DOI is not valid.');
  }

  const browser = await chromium.launch({ headless: false, channel: 'chrome' });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      await page.goto(LOGIN_URL);
      console.log('A browser window has opened. Complete the NEU login there.');
      console.log('Your password is entered only on NU IT\'s page. This program never sees it.');
      console.log('OneSearch sign-in does not by itself unlock article full text. A second step opens the library proxy.');
      await rl.question('Press Enter once you are logged in to OneSearch... ');

      console.log('Opening NEU EZproxy. Approve any additional NU IT / Duo prompt if it appears.');
      try {
        await page.goto(probeUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
      } catch (err) {
        console.log(`The proxy page did not finish loading on its own (${(err as Error).message}).`);
      }

      if (!(await waitForEzproxySession(context))) {
        console.log('No EZproxy session cookie yet.');
        console.log('If the page says "Authenticate with Northeastern credentials", complete that sign-in.');
        await rl.question('Press Enter once a proxied article page has loaded... ');
      }
    } finally {
      rl.close();
    }

    const state = await context.storageState();
    writeFileSync(sessionPath, JSON.stringify(state, null, 2), { mode: 0o600 });
    chmodSync(sessionPath, 0o600);

    const cookies = state.cookies ?? [];
    const ezproxyNames = [
      ...new Set(
        cookies
          .filter((cookie) => cookie.domain && isEzproxyHostname(cookie.domain.replace(/^\./, '')))
          .map((cookie) => cookie.name)
      ),
    ];
    console.log(`Session saved to ${sessionPath} (owner read/write only).`);
    if (hasEzproxySession(cookies)) {
      console.log(
        `EZproxy session captured (${ezproxyNames.join(', ') || 'ezproxy'}). get_full_text can use this session.`
      );
      console.log('search_onesearch and get_record metadata are unchanged by this login.');
    } else {
      console.log(
        'Warning: no EZproxy session cookie was captured. Search still works, but get_full_text will ask you to log in again.'
      );
      if (ezproxyNames.length > 0) {
        console.log(`EZproxy host cookie names seen: ${ezproxyNames.join(', ')}`);
      }
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('Login failed:', err);
  process.exitCode = 1;
});
