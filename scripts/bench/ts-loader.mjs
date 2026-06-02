// Minimal TypeScript ESM loader for running the real .ts sources without a
// build step (the worktree has no dist/). Uses esbuild (already a transitive
// dependency via vitest) to strip types, and rewrites Node16-style `.js`
// import specifiers back to the `.ts` source on disk. This lets the benchmark
// harness exercise the EXACT production handlers, not a compiled copy.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transform } from 'esbuild';

const TS_EXT = /\.ts$/;

export async function resolve(specifier, context, nextResolve) {
  // Rewrite relative `./x.js` -> `./x.ts` when only the .ts source exists.
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && specifier.endsWith('.js')) {
    const parentDir = context.parentURL ? new URL('.', context.parentURL) : pathToFileURL(process.cwd() + '/');
    const tsUrl = new URL(specifier.replace(/\.js$/, '.ts'), parentDir);
    if (existsSync(fileURLToPath(tsUrl))) {
      return { url: tsUrl.href, format: 'module', shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (TS_EXT.test(url)) {
    const source = readFileSync(fileURLToPath(url), 'utf8');
    const { code } = await transform(source, {
      loader: 'ts',
      format: 'esm',
      target: 'node22',
      sourcemap: 'inline',
    });
    return { format: 'module', source: code, shortCircuit: true };
  }
  return nextLoad(url, context);
}
