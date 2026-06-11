import { describe, it, expect } from 'vitest';
import { ENTITY_TYPES, RELATIONSHIP_TYPES } from '../../constants/enums.js';
import { MemoryExtractEntitiesSchema, MemoryGraphSchema } from '../../schemas/index.js';

describe('org-ontology entity + relationship types (enterprise-brain recipe)', () => {
  it('ENTITY_TYPES includes the org kinds', () => {
    for (const t of ['team', 'department', 'sop', 'agent']) {
      expect(ENTITY_TYPES).toContain(t);
    }
    // the pre-existing kinds must survive (additive change only)
    for (const t of ['person', 'project', 'tool', 'concept', 'organization', 'work_item']) {
      expect(ENTITY_TYPES).toContain(t);
    }
  });

  it('RELATIONSHIP_TYPES is the single source for the extract-entities relationship enum', () => {
    for (const t of ['manages', 'reports_to', 'member_of', 'works_on', 'owns', 'follows']) {
      expect(RELATIONSHIP_TYPES).toContain(t);
    }
    for (const t of ['uses', 'created_by', 'depends_on', 'related_to', 'part_of', 'works_with']) {
      expect(RELATIONSHIP_TYPES).toContain(t);
    }
  });

  it('memory_extract_entities accepts a declared org chart', () => {
    const parsed = MemoryExtractEntitiesSchema.parse({
      memory_id: 'm1',
      entities: [
        { name: 'Dana Kim', type: 'person' },
        { name: 'Platform', type: 'team' },
        { name: 'Incident response SOP', type: 'sop' },
        { name: 'release-bot', type: 'agent' },
        { name: 'HR', type: 'department' },
      ],
      relationships: [
        { source: 'Dana Kim', target: 'Alice Nguyen', type: 'manages' },
        { source: 'Alice Nguyen', target: 'Dana Kim', type: 'reports_to' },
        { source: 'Alice Nguyen', target: 'Platform', type: 'member_of' },
        { source: 'Alice Nguyen', target: 'Orbit', type: 'works_on' },
        { source: 'Platform', target: 'Incident response SOP', type: 'follows' },
        { source: 'Platform', target: 'Orbit', type: 'owns' },
      ],
    });
    expect(parsed.entities).toHaveLength(5);
    expect(parsed.relationships).toHaveLength(6);
  });

  it('memory_graph entity_type filter accepts the org kinds', () => {
    expect(MemoryGraphSchema.parse({ entity_type: 'sop' }).entity_type).toBe('sop');
    expect(MemoryGraphSchema.parse({ entity_type: 'team' }).entity_type).toBe('team');
  });

  it('still rejects an unknown relationship type (closed set, no typo sprawl)', () => {
    expect(() =>
      MemoryExtractEntitiesSchema.parse({
        memory_id: 'm1',
        entities: [{ name: 'A', type: 'person' }],
        relationships: [{ source: 'A', target: 'B', type: 'manage' }],
      }),
    ).toThrow();
  });
});
