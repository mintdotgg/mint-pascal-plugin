# Mint for Pascal

<p align="center">
  <img src="./src/assets/mint-pascal-hero.jpg" alt="Mint for Pascal" width="640">
</p>

Generate, browse, and add Mint 3D assets in Pascal Editor.

## What you can do

- Sign in with your Mint account.
- Browse your Mint 3D asset library.
- Generate models from a prompt or reference image.
- Optimize models and add them to your Pascal scene.

## Add Mint to Pascal

Pascal maintainers can follow the [integration guide](./HOST_INTEGRATION.md) to
install the plugin and connect it to the editor.

Supports Pascal `1.0.0-beta.4` and earlier Plugin API v1 releases back to `0.9.2`.

## Read-only viewers

A viewer that only displays scenes can load the render-only entry instead of the
root plugin. It registers the same `mint:assets` id without importing
`@pascal-app/editor`:

```ts
import { loadPlugin } from '@pascal-app/core'
import { mintRenderPlugin } from '@mint/pascal-plugin/render'

await loadPlugin(mintRenderPlugin)
```

Mint adds no custom scene nodes, so placed Mint models render as ordinary
Pascal items. The Mint panel and placement flow stay on the root entry, and
existing editor hosts are unchanged. `check:render` bundles `./render` and
fails if anything on its graph resolves to `@pascal-app/editor` or `next`.

## Development

```bash
pnpm --filter @mint/pascal-plugin compatibility
pnpm --filter @mint/pascal-plugin type-check
pnpm --filter @mint/pascal-plugin check:render
pnpm --filter @mint/pascal-plugin test
```

`check:render` runs the TypeScript script directly, so it needs Node 22.18 or
later.

## Releases

See the [changelog](./CHANGELOG.md) for each version's updates.

MIT licensed.
