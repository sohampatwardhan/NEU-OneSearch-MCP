import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const skill = readFileSync('skills/neu-literature-review/SKILL.md', 'utf8');

describe('neu-literature-review skill', () => {
  it('has the required frontmatter', () => {
    expect(skill).toMatch(/^---\nname: neu-literature-review\ndescription: Use when .+\n---\n/);
  });
  it.each(['fullText', 'readUrl', 'textKind', 'version', 'blocked', 'partial', 'login_required', 'neu-onesearch-login'])(
    'mentions %s',
    (term) => {
      expect(skill).toContain(term);
    },
  );
  it('description names OneSearch and full-text retrieval', () => {
    const d = skill.match(/^description: (.+)$/m)![1];
    expect(d).toMatch(/OneSearch/);
    expect(d).toMatch(/full-text retrieval/i);
    expect(d).toMatch(/Northeastern/);
  });
  it('stays under 120 lines', () => {
    expect(skill.split('\n').length).toBeLessThan(120);
  });
  it('ships in the npm package', () => {
    expect(JSON.parse(readFileSync('package.json', 'utf8')).files).toContain('skills/**');
  });
});
