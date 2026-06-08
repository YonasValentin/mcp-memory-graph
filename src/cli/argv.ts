/** Parses `--flag value` pairs from a raw argv slice. */
export function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      out[a.slice(2)] = args[i + 1] ?? '';
      i++;
    }
  }
  return out;
}
