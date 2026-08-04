# Mint for Pascal

`@mint/pascal-plugin` connects a user's Mint account to Pascal Editor. The panel can browse succeeded Mint 3D models, generate from prompts, uploads, or public image URLs, optimize new models automatically, and place optimized GLBs through Pascal's native item tool. Existing unoptimized models are optimized on demand before placement.

## Exports

```ts
import { mintHostPanel, mintPlugin } from '@mint/pascal-plugin'
import { handleMintPascalRequest } from '@mint/pascal-plugin/server'
```

- `mintPlugin`: Pascal Plugin API v1 manifest, ID `mint:assets`, with no custom scene nodes.
- `mintHostPanel`: disabled-by-default `Mint` editor panel.
- `handleMintPascalRequest(request)`: framework-neutral handler for the one host route at `/api/plugins/mint/[...path]`.
- `mintModelToAsset` and `armMintAssetForPlacement`: native Pascal asset mapping and placement helpers.

The current package targets Pascal Plugin API v1. Its primary development
baseline is Pascal `1.0.0-beta.1`, with compatibility retained for `0.9.2`.

See [HOST_INTEGRATION.md](./HOST_INTEGRATION.md) for the host changes and local test procedure.

## Development

```bash
pnpm --filter @mint/pascal-plugin compatibility
pnpm --filter @mint/pascal-plugin type-check
pnpm --filter @mint/pascal-plugin test
```

The package is MIT licensed.

## Releases

The panel displays its exact package version beside the Mint title for support diagnostics. See [CHANGELOG.md](./CHANGELOG.md) for the user-facing changes in each release.
