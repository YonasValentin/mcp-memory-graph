import type { ServerConfig } from '../types.js';

export type InputMode = 'defaults' | 'interactive' | 'nonInteractive';

/** --yes/-y → defaults; a TTY → interactive prompt; otherwise nonInteractive
 *  (the existing prompter still consumes piped stdin; the difference is the report). */
export function resolveInputMode(argv: string[], isTTY: boolean): InputMode {
  if (argv.includes('--yes') || argv.includes('-y')) return 'defaults';
  return isTTY ? 'interactive' : 'nonInteractive';
}

export function parseSchedule(
  argv: string[],
): Array<{ hour: number; minute: number }> | undefined {
  const i = argv.indexOf('--schedule');
  if (i === -1 || !argv[i + 1]) return undefined;
  return argv[i + 1].split(',').map((tok) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(tok.trim());
    if (!m) throw new Error(`Invalid --schedule entry "${tok}" (expected HH:MM)`);
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      throw new Error(`--schedule out of range: "${tok}"`);
    }
    return { hour, minute };
  });
}

export interface InitFlags {
  installSkill: boolean;
  reviewOnStop?: boolean;
  vault?: string;
  schedule?: Array<{ hour: number; minute: number }>;
}

export function parseInitFlags(argv: string[]): InitFlags {
  const flags: InitFlags = { installSkill: !argv.includes('--no-skill') };
  if (argv.includes('--no-review-on-stop')) flags.reviewOnStop = false;
  const vi = argv.indexOf('--vault');
  if (vi !== -1 && argv[vi + 1]) flags.vault = argv[vi + 1];
  const sched = parseSchedule(argv);
  if (sched) flags.schedule = sched;
  return flags;
}

/** Human-readable summary of what a non-interactive init configured + how to change it. */
export function formatInitReport(config: ServerConfig, scope: string): string {
  const times = config.consolidation.schedule
    .map(
      ({ hour, minute }) =>
        `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    )
    .join(', ');
  return [
    'Applied configuration (non-interactive):',
    `  install_scope=${scope}  default_scope=${config.defaults.scope}  namespace=${config.defaults.namespace}`,
    `  auto_capture=${config.capture.auto_capture}  review_on_stop=${config.hooks.review_on_stop}`,
    `  schedule=${times}  vault=${config.vault.path ?? 'none'}`,
    'To change, re-run with any of:',
    '  --scope user|project   --schedule HH:MM[,HH:MM]   --vault <path>',
    '  --no-review-on-stop    --no-skill                 --yes (accept defaults silently)',
  ].join('\n');
}
