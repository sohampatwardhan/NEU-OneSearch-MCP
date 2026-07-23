import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const SESSION_PATH = join(homedir(), '.neu-onesearch-mcp', 'session.json');

const SESSION_DOMAIN = 'onesearch.library.northeastern.edu';

interface StoredCookie {
  name: string;
  value: string;
  domain?: string;
}

interface StorageState {
  cookies?: StoredCookie[];
}

function belongsToOneSearch(cookie: StoredCookie): boolean {
  return (
    typeof cookie.domain === 'string' &&
    (cookie.domain === SESSION_DOMAIN || cookie.domain.endsWith(`.${SESSION_DOMAIN}`))
  );
}

export function loadSession(path: string = SESSION_PATH): string | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }

  let parsed: StorageState;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed.cookies)) {
    return null;
  }

  const relevant = parsed.cookies.filter(belongsToOneSearch);
  if (relevant.length === 0) {
    return null;
  }

  return relevant.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}
