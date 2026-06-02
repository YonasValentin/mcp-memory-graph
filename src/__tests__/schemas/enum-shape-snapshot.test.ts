/**
 * E1/E2/Y1 — drift guard for the canonical enum tuples.
 *
 * The Zod schemas, the TS unions, and the shared tuples in
 * `src/constants/enums.ts` must all agree. This test snapshots the enum option
 * lists actually EMITTED by the tool/REST schemas and pins them to the shared
 * tuples — so deriving the schemas from the tuples is provably byte-identical to
 * the previous hand-maintained literals, and any future divergence fails here.
 */
import { describe, it, expect } from 'vitest';
import { z, type ZodTypeAny } from 'zod';
import {
  MemoryStoreSchema,
  MemorySearchSchema,
  MemoryListSchema,
  MemoryIngestSchema,
  MemoryExtractLearningsSchema,
  MemoryGraphSchema,
  MemoryQueryStructuredSchema,
  ApiSearchQuerySchema,
  ApiListQuerySchema,
  ApiManifestQuerySchema,
} from '../../schemas/index.js';
import {
  SCOPES,
  ACCESS_LEVELS,
  SEARCH_MODES,
  CONTENT_TYPES,
  ENTITY_TYPES,
  LEARNING_CATEGORIES,
  SORT_FIELDS,
} from '../../constants/enums.js';

/** Unwrap optional/default/describe wrappers down to the inner enum's options. */
function enumOptions(field: ZodTypeAny): readonly string[] {
  let cur: ZodTypeAny = field;
  // ZodOptional / ZodDefault / ZodNullable all expose `unwrap()` or `_def.innerType`.
  for (let i = 0; i < 8; i++) {
    if (cur instanceof z.ZodEnum) return cur.options as readonly string[];
    const def = (cur as { _def?: { innerType?: ZodTypeAny } })._def;
    if (def?.innerType) {
      cur = def.innerType;
      continue;
    }
    break;
  }
  throw new Error('field is not a (wrapped) ZodEnum');
}

function field(schema: ZodTypeAny, name: string): ZodTypeAny {
  // Unwrap optional/default/describe wrappers, then read the object shape.
  let cur: ZodTypeAny = schema;
  for (let i = 0; i < 8 && !(cur instanceof z.ZodObject); i++) {
    const inner = (cur as { _def?: { innerType?: ZodTypeAny } })._def?.innerType;
    if (!inner) break;
    cur = inner;
  }
  const shape = (cur as z.ZodObject<z.ZodRawShape>).shape;
  if (!shape) throw new Error('schema has no object shape');
  return shape[name];
}

describe('schema enum options match the canonical tuples (E1/E2)', () => {
  it('scope enums everywhere equal SCOPES', () => {
    expect(enumOptions(field(MemoryStoreSchema, 'scope'))).toEqual([...SCOPES]);
    expect(enumOptions(field(MemorySearchSchema, 'scope'))).toEqual([...SCOPES]);
    expect(enumOptions(field(MemoryListSchema, 'scope'))).toEqual([...SCOPES]);
    expect(enumOptions(field(MemoryIngestSchema, 'scope'))).toEqual([...SCOPES]);
    expect(enumOptions(field(ApiSearchQuerySchema, 'scope'))).toEqual([...SCOPES]);
    expect(enumOptions(field(ApiListQuerySchema, 'scope'))).toEqual([...SCOPES]);
    expect(enumOptions(field(ApiManifestQuerySchema, 'scope'))).toEqual([...SCOPES]);
    expect(enumOptions(field(field(MemoryQueryStructuredSchema, 'filter'), 'scope'))).toEqual([...SCOPES]);
  });

  it('access_level enums equal ACCESS_LEVELS', () => {
    expect(enumOptions(field(MemoryStoreSchema, 'access_level'))).toEqual([...ACCESS_LEVELS]);
    expect(enumOptions(field(MemorySearchSchema, 'access_level'))).toEqual([...ACCESS_LEVELS]);
  });

  it('search_mode enums equal SEARCH_MODES', () => {
    expect(enumOptions(field(MemorySearchSchema, 'search_mode'))).toEqual([...SEARCH_MODES]);
    expect(enumOptions(field(ApiSearchQuerySchema, 'mode'))).toEqual([...SEARCH_MODES]);
  });

  it('content_type enum equals CONTENT_TYPES', () => {
    expect(enumOptions(field(MemoryIngestSchema, 'content_type'))).toEqual([...CONTENT_TYPES]);
  });

  it('entity_type enums equal ENTITY_TYPES', () => {
    expect(enumOptions(field(MemoryGraphSchema, 'entity_type'))).toEqual([...ENTITY_TYPES]);
  });

  it('learning categories equal LEARNING_CATEGORIES', () => {
    const categories = field(MemoryExtractLearningsSchema, 'categories');
    // categories is an optional array of enums; reach the element enum.
    const arr = (categories as { _def: { innerType: { _def: { type: ZodTypeAny } } } })._def.innerType._def.type;
    expect(enumOptions(arr)).toEqual([...LEARNING_CATEGORIES]);
  });

  it('sort fields equal SORT_FIELDS', () => {
    expect(enumOptions(field(MemoryListSchema, 'sort_by'))).toEqual([...SORT_FIELDS]);
    expect(enumOptions(field(ApiListQuerySchema, 'sort_by'))).toEqual([...SORT_FIELDS]);
  });
});
