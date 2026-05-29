/**
 * Pillar 6 (T19): per-document_type template scaffolds.
 *
 * Pure functions — no DB. getTemplate returns a known scaffold for recognized
 * document types and a generic default (known:false) otherwise. handleTemplate
 * is a thin wrapper. These templates keep stored memories structurally
 * consistent (Obsidian "templates for agents").
 */
import { describe, it, expect } from 'vitest';

import { getTemplate, handleTemplate } from '../../tools/templates.js';

describe('getTemplate', () => {
  it('returns a known decision template with Context/Decision/Consequences sections', () => {
    const result = getTemplate('decision');
    expect(result.document_type).toBe('decision');
    expect(result.known).toBe(true);
    expect(result.template).toContain('## Context');
    expect(result.template).toContain('## Decision');
    expect(result.template).toContain('## Consequences');
    expect(result.fields).toEqual(
      expect.arrayContaining(['Context', 'Decision', 'Consequences']),
    );
  });

  it('returns a generic non-empty default for an unknown document_type', () => {
    const result = getTemplate('totally-unknown');
    expect(result.document_type).toBe('totally-unknown');
    expect(result.known).toBe(false);
    expect(result.template.length).toBeGreaterThan(0);
    expect(result.fields.length).toBeGreaterThan(0);
  });
});

describe('handleTemplate', () => {
  it('wraps getTemplate for the requested document_type', () => {
    const result = handleTemplate({ document_type: 'incident' });
    expect(result).toEqual(getTemplate('incident'));
    expect(result.known).toBe(true);
    expect(result.template).toContain('## Symptom');
  });
});
