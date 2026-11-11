// Bundles the `./render` entry with every dependency followed and fails if
// anything on that graph resolves to `@pascal-app/editor` or `next`. Bundles the
// root entry the same way as a self-test: it must reach the editor through the
// Mint panel, or the guard is not seeing imports. Run with `npm run check:render`.
import { build, type Plugin } from 'esbuild'
import { fileURLToPath } from 'node:url'

const FORBIDDEN = /^(?:@pascal-app\/editor|next)(?:\/|$)/

async function forbiddenImports(entry: string): Promise<string[]> {
  const hits: string[] = []
  const guard: Plugin = {
    name: 'render-entry-guard',
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /.*/ }, (args) => {
        if (!FORBIDDEN.test(args.path)) return undefined
        hits.push(`${args.path}  <-  ${args.importer}`)
        return { path: args.path, external: true }
      })
    },
  }
  await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true,
    write: false,
    outdir: 'out',
    platform: 'browser',
    format: 'esm',
    splitting: true,
    logLevel: 'silent',
    loader: { '.jpg': 'file', '.png': 'file' },
    plugins: [guard],
  })
  return hits
}

const renderHits = await forbiddenImports('../src/render.ts')
if (renderHits.length > 0) {
  console.error('The ./render entry reaches editor-only modules:')
  for (const hit of renderHits) console.error(`  ${hit}`)
  process.exit(1)
}

const rootHits = await forbiddenImports('../src/index.ts')
if (!rootHits.some((hit) => hit.startsWith('@pascal-app/editor'))) {
  console.error('Self-test failed: the root entry should reach @pascal-app/editor.')
  process.exit(1)
}

console.log('./render bundles without @pascal-app/editor or next.')
