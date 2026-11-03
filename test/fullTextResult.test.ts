import { describe, it, expect } from 'vitest';
import { emptyResult, finalizeResult } from '../src/fullTextResult.js';

const URL_ = 'https://link.ezproxy.neu.edu/login?qurl=x';

describe('finalizeResult', () => {
  it('marks ok as full text with textKind article and no prefix', () => {
    const r = finalizeResult(emptyResult({ status: 'ok', message: 'Extracted.', text: 'body' }), URL_);
    expect(r).toMatchObject({ fullText: true, textKind: 'article', readUrl: null, message: 'Extracted.' });
  });

  it.each(['partial', 'login_required', 'not_proxied', 'not_entitled', 'not_found', 'too_large', 'unsupported', 'blocked', 'error'] as const)(
    '%s is not full text, carries readUrl and the plain prefix',
    (status) => {
      const r = finalizeResult(emptyResult({ status, message: 'Reason.' }), URL_);
      expect(r.fullText).toBe(false);
      expect(r.readUrl).toBe(URL_);
      expect(r.message.startsWith('Full text was not retrieved: Reason.')).toBe(true);
      expect(r.message).toContain(`Open it in a browser: ${URL_}`);
    }
  );

  it('uses the abstract prefix for textKind abstract', () => {
    const r = finalizeResult(emptyResult({ status: 'partial', textKind: 'abstract', message: 'Only the abstract.' }), URL_);
    expect(r.message.startsWith('Abstract only. Full text was not retrieved: Only the abstract.')).toBe(true);
    expect(r.textKind).toBe('abstract');
  });

  it('defaults partial textKind to unknown', () => {
    expect(finalizeResult(emptyResult({ status: 'partial', message: 'x' }), null).textKind).toBe('unknown');
  });

  it('keeps a readUrl already on the result over the argument', () => {
    const r = finalizeResult(emptyResult({ status: 'not_proxied', readUrl: 'https://pub.example/a', message: 'x' }), URL_);
    expect(r.readUrl).toBe('https://pub.example/a');
    expect(r.message).toContain('Open it in a browser: https://pub.example/a');
    expect(r.message).not.toContain(URL_);
  });

  it('omits the suffix when there is no readUrl', () => {
    const r = finalizeResult(emptyResult({ status: 'error', message: 'Bad.' }), null);
    expect(r.readUrl).toBeNull();
    expect(r.message).toBe('Full text was not retrieved: Bad.');
  });

  it('is idempotent', () => {
    const once = finalizeResult(emptyResult({ status: 'partial', textKind: 'abstract', message: 'x' }), URL_);
    expect(finalizeResult(once, URL_)).toEqual(once);
  });
});
