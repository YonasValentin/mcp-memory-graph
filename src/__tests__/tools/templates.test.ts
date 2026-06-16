/**
 * Pillar 6 (T19): per-document_type template scaffolds.
 *
 * Pure functions — no DB. getTemplate returns a known scaffold for recognized
 * document types and a generic default (known:false) otherwise. handleTemplate
 * is a thin wrapper. These templates keep stored memories structurally
 * consistent (Obsidian "templates for agents").
 */
import { describe, it, expect } from 'vitest';

import { getTemplate, handleTemplate, fillTemplate } from '../../tools/templates.js';

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

  it('recognizes "lesson" with the What/Why it matters/How to apply sections', () => {
    const result = getTemplate('lesson');
    expect(result.known).toBe(true);
    expect(result.fields).toEqual(['What', 'Why it matters', 'How to apply']);
    // shares the learning scaffold's sections (one field list, two keys)
    expect(result.fields).toEqual(getTemplate('learning').fields);
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

describe('fillTemplate', () => {
  it('fills a known incident scaffold from snake_case field keys', () => {
    const result = fillTemplate('incident', {
      symptom: 'API returns 500 on /orders',
      root_cause: 'connection pool exhausted',
      fix: 'raised pool size to 50',
      prevention: 'alert at 80% pool utilisation',
    });
    expect(result.known).toBe(true);
    expect(result.fields).toEqual(['Symptom', 'Root Cause', 'Fix', 'Prevention']);
    expect(result.content).toContain('## Symptom\nAPI returns 500 on /orders');
    expect(result.content).toContain('## Root Cause\nconnection pool exhausted');
    expect(result.content).toContain('## Prevention\nalert at 80% pool utilisation');
  });

  it('also accepts exact Title-Case section keys', () => {
    const result = fillTemplate('incident', { 'Root Cause': 'bad migration' });
    expect(result.content).toContain('## Root Cause\nbad migration');
  });

  it('keeps the placeholder for an omitted or blank field (structure preserved)', () => {
    const result = fillTemplate('incident', { symptom: 'down', root_cause: '   ' });
    expect(result.content).toContain('## Symptom\ndown');
    // root_cause was whitespace-only, fix + prevention omitted → placeholder kept
    expect(result.content).toContain('## Root Cause\n_…_');
    expect(result.content).toContain('## Fix\n_…_');
    expect(result.content).toContain('## Prevention\n_…_');
  });

  it('falls back to the generic scaffold for an unknown document_type', () => {
    const result = fillTemplate('totally-unknown', { summary: 'a thing happened' });
    expect(result.known).toBe(false);
    expect(result.fields).toEqual(['Summary', 'Details', 'Notes']);
    expect(result.content).toContain('## Summary\na thing happened');
    expect(result.content).toContain('## Details\n_…_');
  });
});
