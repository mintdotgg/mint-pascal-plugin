import { describe, expect, it } from 'vitest'
import { mintPlugin } from './index'
import { mintRenderPlugin } from './render'

describe('Mint render entry', () => {
  it('matches the root plugin id and API version', () => {
    expect(mintRenderPlugin.id).toBe(mintPlugin.id)
    expect(mintRenderPlugin.apiVersion).toBe(mintPlugin.apiVersion)
  })

  it('registers no nodes, panels or tools', () => {
    expect(mintRenderPlugin).toEqual({ id: 'mint:assets', apiVersion: 1, nodes: [] })
  })
})
