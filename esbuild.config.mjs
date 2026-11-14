import esbuild from 'esbuild';
import process from 'node:process';
import { builtinModules } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const production = process.argv[2] === 'production';
const projectRoot = dirname(fileURLToPath(import.meta.url));

const context = await esbuild.context({
  absWorkingDir: projectRoot,
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: [
    'obsidian',
    'electron',
    '@codemirror/autocomplete',
    '@codemirror/collab',
    '@codemirror/commands',
    '@codemirror/language',
    '@codemirror/lint',
    '@codemirror/search',
    '@codemirror/state',
    '@codemirror/view',
    '@lezer/common',
    '@lezer/highlight',
    '@lezer/lr',
    ...builtinModules,
  ],
  format: 'cjs',
  target: 'es2022',
  logLevel: 'info',
  sourcemap: production ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
