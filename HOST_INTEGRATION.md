# Pascal maintainer handoff

Mint supplies a reviewed plugin release and registers Pascal's OAuth callbacks.
Pascal only needs to pin the package, register it, include its source in the
build, and mount one route.

## 1. Pin the approved release

Use the exact tag or commit supplied by Mint:

```json
{
  "dependencies": {
    "@mint/pascal-plugin": "github:mintdotgg/mint-pascal-plugin#v<version>"
  }
}
```

Commit the resulting `bun.lock` change. Do not track `main` or an unpinned
release.

## 2. Register Mint before bootstrap

```ts
import { extendPluginDiscovery } from '@pascal-app/core'
import { registerEditorHostPanel } from '@pascal-app/editor'
import { mintHostPanel, mintPlugin } from '@mint/pascal-plugin'

registerEditorHostPanel(mintHostPanel)
extendPluginDiscovery(async () => [mintPlugin])
```

Use `extendPluginDiscovery` so existing plugins remain registered. Mint is
disabled by default and uses Pascal's existing project-level installation
state.

## 3. Include the plugin source

- Add `@mint/pascal-plugin` to `transpilePackages`.
- Add this Tailwind source in `apps/editor/app/globals.css`:

  ```css
  @source "../../../node_modules/@mint/pascal-plugin/src";
  ```

- Allow `https://cdn.mint.gg` in model, image, CSP, and loader policies.

Placed Mint models are ordinary Pascal items; the plugin adds no custom scene
node.

## 4. Mount the server route

Create `/api/plugins/mint/[...path]`:

```ts
import { handleMintPascalRequest } from '@mint/pascal-plugin/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const route = (request: Request) => handleMintPascalRequest(request)

export { route as GET, route as POST }
```

The adapter uses these public Mint endpoints by default:

- OAuth: `https://mcp.mint.gg`
- API resource: `https://api.mint.gg`
- API base: `https://api.mint.gg/v1`

Pascal needs no Mint secret, token database, session-encryption key, or custom
auth framework. Tokens stay in host-only HttpOnly cookies and are never
returned to browser JavaScript.

## 5. Send callback URLs to Mint

Mint must register each exact callback before sign-in can work:

```text
https://<pascal-host>/api/plugins/mint/oauth/callback
```

For local Pascal QA, send Mint:

```text
http://localhost:3002/api/plugins/mint/oauth/callback
```

Pascal does not run Mint infrastructure or register the OAuth client itself.

## QA checklist

After Mint confirms the callback is registered:

```bash
bun install
bun dev
```

Open `http://localhost:3002`, enable Mint for a project, and check:

- Sign-in returns to the same project and shows the correct Mint account.
- Assets load and generated models can run concurrently.
- Unoptimized models optimize before entering Pascal's native placement tool.
- Placed models move, rotate, duplicate, undo, save, reload, and export normally.
- Disabling and re-enabling Mint does not remove placed models.
- Logout clears the Mint session.
- No Mint access or refresh token appears in browser storage, JSON, or logs.

Run Pascal's normal type-check, tests, and production build before merging.

## Updating an installed release

A new GitHub release does not update Pascal automatically:

1. Update the pinned tag or commit and `bun.lock`.
2. Run CI and the QA checklist.
3. Merge and deploy Pascal.
4. Users receive the new plugin on refresh or their next app load.

Keeping the same plugin ID preserves each project's enabled state. Users only
reauthorize when OAuth permissions change.
