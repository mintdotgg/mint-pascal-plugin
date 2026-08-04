import { describe, expect, it } from 'vitest'
import { MINT_PASCAL_PLUGIN_VERSION, mintHostPanel, mintPlugin } from './index'

describe('Pascal plugin registration', () => {
  it('exports an API v1 manifest without custom scene nodes', () => {
    expect(mintPlugin).toEqual({ id: 'mint:assets', apiVersion: 1, nodes: [] })
  })

  it('exports a disabled-by-default Mint host panel', () => {
    expect(mintHostPanel).toMatchObject({
      id: 'mint:assets:models',
      label: 'Mint',
      pluginId: 'mint:assets',
      defaultInstalled: false,
      creator: { name: 'Mint', url: 'https://mint.gg' },
      pluginUrl: 'https://github.com/mintdotgg/mint-pascal-plugin',
      icon: {
        kind: 'url',
        src: expect.stringMatching(/^data:image\/png;base64,/),
      },
    })
  })

  it('exports a diagnostic SemVer version', () => {
    expect(MINT_PASCAL_PLUGIN_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
