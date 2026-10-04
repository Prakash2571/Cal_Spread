// Test-only TypeScript transpilation for Node builds without built-in TS support.
// Uses the already locked TypeScript dependency; production builds remain tsc+Vite.
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

export async function load(url, context, nextLoad) {
  if (!/\.(ts|tsx)$/.test(new URL(url).pathname)) return nextLoad(url, context);
  const source = (await readFile(new URL(url), 'utf8')).replaceAll('import.meta.env', '(globalThis.__VITE_TEST_ENV__ ?? {})');
  const result = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    jsx: ts.JsxEmit.ReactJSX, verbatimModuleSyntax: true,
  }, fileName: new URL(url).pathname });
  return { format: 'module', shortCircuit: true, source: result.outputText };
}
