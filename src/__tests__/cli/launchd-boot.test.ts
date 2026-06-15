/**
 * `init` writes the consolidation launchd plist but pre-2.5.2 never registered it
 * with launchd — launchd only scans ~/Library/LaunchAgents at LOGIN, so the nightly
 * cleanup silently never ran until the next relogin. The fix loads it immediately via
 * `launchctl bootstrap` (bootout first so a re-run with a changed schedule takes effect).
 * This locks the exact argv the loader/uninstaller hand to launchctl.
 */
import { describe, it, expect } from 'vitest';
import { launchdBootCommands } from '../../cli/init.js';

describe('launchdBootCommands', () => {
  it('builds the gui/<uid> domain target and bootout+bootstrap argv', () => {
    expect(launchdBootCommands(501, '/Users/x/Library/LaunchAgents/com.mcp-memory.consolidate.plist')).toEqual({
      domain: 'gui/501',
      bootout: ['bootout', 'gui/501', '/Users/x/Library/LaunchAgents/com.mcp-memory.consolidate.plist'],
      bootstrap: ['bootstrap', 'gui/501', '/Users/x/Library/LaunchAgents/com.mcp-memory.consolidate.plist'],
    });
  });

  it('uses the per-call uid (not a hardcoded one)', () => {
    expect(launchdBootCommands(0, '/p.plist').domain).toBe('gui/0');
  });
});
