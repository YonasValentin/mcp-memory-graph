/**
 * The launchd consolidation plist generator. The original inline template wrote
 * a BARE `<string>node</string>`, which launchd (minimal PATH:
 * /usr/bin:/bin:/usr/sbin:/sbin) cannot resolve when node lives under nvm — so
 * the nightly consolidation silently never ran (0-byte log). It also set only
 * StandardErrorPath, so a successful run produced no observable output. These
 * tests pin the generator to an absolute node binary + a stdout log.
 */
import { describe, it, expect } from 'vitest';
import { buildConsolidatePlist } from '../../cli/init.js';

const xml = buildConsolidatePlist({
  nodePath: '/abs/path/to/node',
  distIndexPath: '/abs/dist/index.js',
  home: '/Users/tester',
  calendarIntervalXml: '  <dict>\n    <key>Hour</key>\n    <integer>3</integer>\n  </dict>',
});

describe('buildConsolidatePlist', () => {
  it('uses an absolute node binary, never bare "node" (launchd minimal PATH)', () => {
    expect(xml).toContain('<string>/abs/path/to/node</string>');
    expect(xml).not.toMatch(/<string>node<\/string>/);
  });

  it('sets StandardOutPath so a successful run is observable', () => {
    expect(xml).toContain('<key>StandardOutPath</key>');
    expect(xml).toContain('/Users/tester/.mcp-memory/consolidation.out.log');
  });

  it('keeps the script path, the consolidate subcommand, and the stderr log', () => {
    expect(xml).toContain('<string>/abs/dist/index.js</string>');
    expect(xml).toContain('<string>consolidate</string>');
    expect(xml).toContain('/Users/tester/.mcp-memory/consolidation.log');
  });

  it('is well-formed: single Label, ProgramArguments, closed plist', () => {
    expect(xml).toContain('<string>com.mcp-memory.consolidate</string>');
    expect(xml).toContain('<key>ProgramArguments</key>');
    expect(xml.trimEnd().endsWith('</plist>')).toBe(true);
  });
});
