#!/usr/bin/env node
import { chromium, type BrowserContext } from 'playwright';
import { createInterface } from 'node:readline/promises';
import { buildEzproxyDoiUrl, EZPROXY_PROBE_DOI } from './ezproxy.js';
import { ensureCacheDir, profileDir, sessionCachePath } from './cache.js';
import {
  hasEzproxySession,
  hasOneSearchSession,
  isEzproxyHostname,
  writeSessionCache,
  type StoredCookie,
} from './session.js';

const LOGIN_URL = 'https://onesearch.library.northeastern.edu/discovery/login?vid=01NEU_INST:NUL';
const ONESEARCH_DOMAIN = 'onesearch.library.northeastern.edu';

/** Keep only the cookies the tools actually use: OneSearch and EZproxy. */
function relevantCookies(cookies: StoredCookie[]): StoredCookie[] {
  return cookies.filter((cookie) => {
    const domain = (cookie.domain ?? '').replace(/^\./, '').toLowerCase();
    if (!domain) return false;
    const isOneSearch = domain === ONESEARCH_DOMAIN || domain.endsWith(`.${ONESEARCH_DOMAIN}`);
    return isOneSearch || isEzproxyHostname(domain);
  });
}

async function waitForEzproxySession(context: BrowserContext): Promise<boolean> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const cookies = await context.cookies();
    if (hasEzproxySession(cookies)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function launchProfile(): Promise<BrowserContext> {
  try {
    return await chromium.launchPersistentContext(profileDir(), {
      headless: false,
      channel: 'chrome',
    });
  } catch (err) {
    throw new Error(
      `Could not launch Google Chrome. Install Chrome (the browser this login drives) and try again. ` +
        `Underlying error: ${(err as Error).message}`
    );
  }
}

async function main(): Promise<void> {
  ensureCacheDir();

  const probeUrl = buildEzproxyDoiUrl(EZPROXY_PROBE_DOI);
  if (!probeUrl) {
    throw new Error('Internal error: the EZproxy probe DOI is not valid.');
  }

  const context = await launchProfile();
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      await page.goto(LOGIN_URL);
      console.log('A dedicated Chrome window has opened. Complete the NEU sign-in there.');
      console.log("Your password is entered only on NU IT's page. This program never sees it.");
      console.log('OneSearch sign-in alone does not unlock article full text. A second step opens the library proxy.');
      await rl.question('Press Enter once you are signed in to OneSearch... ');

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

    const allCookies = (await context.cookies()) as StoredCookie[];
    const cookies = relevantCookies(allCookies);
    writeSessionCache(cookies);

    const cachePath = sessionCachePath();
    const ezproxyNames = [
      ...new Set(
        cookies
          .filter((cookie) => cookie.domain && isEzproxyHostname((cookie.domain ?? '').replace(/^\./, '')))
          .map((cookie) => cookie.name)
      ),
    ];

    console.log(`Session cached at ${cachePath} (owner read/write only).`);
    if (hasEzproxySession(cookies)) {
      console.log(`EZproxy session captured (${ezproxyNames.join(', ') || 'ezproxy'}). Full-text access can use this session.`);
    } else {
      console.log('Warning: no EZproxy session cookie was captured. Search still works, but full-text access will ask you to sign in again.');
      if (ezproxyNames.length > 0) {
        console.log(`EZproxy host cookie names seen: ${ezproxyNames.join(', ')}`);
      }
    }
    if (hasOneSearchSession(cookies)) {
      console.log('OneSearch session captured. search_onesearch and get_record metadata are unchanged by this login.');
    }
    console.log('Run `neu-onesearch-logout` (or `node dist/logout.js`) to remove this session and the browser profile.');
  } finally {
    await context.close();
  }
}

main().catch((err) => {
  console.error('Login failed:', (err as Error).message);
  process.exitCode = 1;
});
