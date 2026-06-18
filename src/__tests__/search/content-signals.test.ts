import { describe, it, expect } from 'vitest';
import { classifyVolatility } from '../../search/content-signals.js';

/**
 * classifyVolatility derives how fast a memory's truth decays from its content +
 * document_type. document_type is the stronger intent signal and wins over
 * incidental wording; within content, deploy/state phrasing marks a fact volatile.
 * The motivating failure: a "UAT-verified" note that was trusted a day later.
 */
describe('classifyVolatility', () => {
  it('flags deploy/state wording as volatile', () => {
    expect(classifyVolatility('The fix is deployed to PROD and verified live')).toBe('volatile');
    expect(classifyVolatility('event-24 is now live, smoke test passing')).toBe('volatile');
    expect(classifyVolatility('Currently the job runs every 5 minutes')).toBe('volatile');
  });

  it('treats durable explanatory content as normal', () => {
    expect(classifyVolatility('A stored procedure is one object; ALTER replaces the whole body.')).toBe('normal');
    expect(classifyVolatility('The pattern uses MediatR for command handling.')).toBe('normal');
  });

  it('lets document_type override to volatile even without trigger words', () => {
    expect(classifyVolatility('see the linked board', 'status')).toBe('volatile');
    expect(classifyVolatility('whatever', 'incident-status')).toBe('volatile');
  });

  it('lets document_type mark durable references stable, beating volatile wording', () => {
    // Content says "currently" (volatile) but a contract is a durable reference.
    expect(classifyVolatility('currently in effect', 'contract')).toBe('stable');
    expect(classifyVolatility('the decision, deployed', 'decision')).toBe('stable');
    expect(classifyVolatility('reference text', 'reference')).toBe('stable');
  });

  it('is case-insensitive on document_type and content', () => {
    expect(classifyVolatility('DEPLOYED TO PRODUCTION')).toBe('volatile');
    expect(classifyVolatility('x', 'STATUS')).toBe('volatile');
  });

  it('defaults to normal for plain content and null document_type', () => {
    expect(classifyVolatility('just a note', null)).toBe('normal');
    expect(classifyVolatility('just a note')).toBe('normal');
  });
});
