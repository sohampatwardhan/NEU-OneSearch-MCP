#!/usr/bin/env node
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { sessionCachePath } from './cache.js';

const SESSION_PATH = sessionCachePath();

const LOGIN_URL = 'https://onesearch.library.northeastern.edu/discovery/login?vid=01NEU_INST:NUL';

async function main(): Promise<void> {
  mkdirSync(dirname(SESSION_PATH), { recursive: true });

  const browser = await chromium.launch({ headless: false, channel: 'chrome' });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(LOGIN_URL);

  console.log('A browser window has opened. Please complete the NEU login there.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('Press Enter once you are logged in... ');
  rl.close();

  const state = await context.storageState();
  writeFileSync(SESSION_PATH, JSON.stringify(state, null, 2), { mode: 0o600 });

  await browser.close();
  console.log(`Session saved to ${SESSION_PATH}`);
}

main().catch((err) => {
  console.error('Login failed:', err);
  process.exitCode = 1;
});
