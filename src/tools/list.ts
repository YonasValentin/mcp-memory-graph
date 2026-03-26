import type Database from 'better-sqlite3';
import type {
  Memory,
  PaginatedResult,
  ListOptions,
  MemoryScope,
  SortField,
  SortOrder,
} from '../types.js';
import { listMemories, rowToMemory } from '../db/repository.js';

interface ListInput {
  scope?: MemoryScope;
  namespace?: string;
  department?: string;
  document_type?: string;
  limit?: number;
  offset?: number;
  sort_by?: SortField;
  sort_order?: SortOrder;
}

export function handleList(
  db: Database.Database,
  input: ListInput,
): PaginatedResult<Memory> {
  const options: ListOptions = {
    scope: input.scope,
    namespace: input.namespace,
    department: input.department,
    document_type: input.document_type,
    limit: input.limit ?? 10,
    offset: input.offset ?? 0,
    sort_by: input.sort_by ?? 'created_at',
    sort_order: input.sort_order ?? 'desc',
  };

  const { memories, total } = listMemories(db, options);
  const items = memories.map(rowToMemory);

  return {
    items,
    total,
    limit: options.limit,
    offset: options.offset,
    has_more: options.offset + items.length < total,
  };
}
