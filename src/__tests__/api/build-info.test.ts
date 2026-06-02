import { describe, it, expect } from 'vitest';
import { renderMetrics } from '../../api/metrics.js';
import { createRequire } from 'node:module';

const pkg = createRequire(import.meta.url)('../../../package.json') as { version: string };

describe('mcp_build_info gauge (P0.5 observability)', () => {
  it('exposes a build-info gauge carrying the package version and node version', () => {
    const body = renderMetrics();
    expect(body).toContain('# TYPE mcp_build_info gauge');
    expect(body).toMatch(/mcp_build_info\{[^}]*version="/);
    expect(body).toContain(`version="${pkg.version}"`);
    expect(body).toContain(`node="${process.version}"`);
    // It is a constant-1 info gauge.
    expect(body).toMatch(/mcp_build_info\{[^}]*\} 1/);
  });
});
