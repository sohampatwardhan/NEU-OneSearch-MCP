import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const SESSION_PATH = join(homedir(), '.neu-onesearch-mcp', 'session.json');

interface StoredCookie {
  name: string;
  value: string;
}

interface StorageState {
  cookies?: StoredCookie[];
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

  if (!Array.isArray(parsed.cookies) || parsed.cookies.length === 0) {
    return null;
  }

  return parsed.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}
