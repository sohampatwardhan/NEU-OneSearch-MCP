#!/usr/bin/env node
import { removeSession, sessionCachePath, profileDir } from './cache.js';

function main(): void {
  const { cacheRemoved, profileRemoved } = removeSession();

  if (cacheRemoved) {
    console.log(`Removed cached session: ${sessionCachePath()}`);
  }
  if (profileRemoved) {
    console.log(`Removed browser profile: ${profileDir()}`);
  }
  if (!cacheRemoved && !profileRemoved) {
    console.log('Nothing to remove. You are already signed out.');
  } else {
    console.log('Signed out. Run `neu-onesearch-login` (or `node dist/login.js`) to sign in again.');
  }
}

try {
  main();
} catch (err) {
  console.error('Logout failed:', (err as Error).message);
  process.exitCode = 1;
}
