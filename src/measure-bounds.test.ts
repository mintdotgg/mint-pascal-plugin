import { describe, expect, it } from 'vitest'
import { inspectGlbFromBytes, measureGlbBoundsFromBytes } from './measure-bounds'

function glb(json: object) {
  const source = new TextEncoder().encode(JSON.stringify(json))
  const chunkLength = Math.ceil(source.byteLength / 4) * 4
  const bytes = new Uint8Array(20 + chunkLength)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 0x46546c67, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, bytes.byteLength, true)
  view.setUint32(12, chunkLength, true)
  view.setUint32(16, 0x4e4f534a, true)
  bytes.fill(0x20, 20)
  bytes.set(source, 20)
  return bytes
}

const unitCube = {
  accessors: [
    { count: 8, min: [-1, -1, -1], max: [1, 1, 1] },
    { count: 36 },
  ],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
}

describe('measureGlbBoundsFromBytes', () => {
  it('measures accessor bounds through node translation and scale', () => {
    const bounds = measureGlbBoundsFromBytes(
      glb({
        ...unitCube,
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0, translation: [3, 4, 5], scale: [2, 3, 4] }],
      }),
    )

    expect(bounds).toEqual({
      min: [1, 1, 1],
      max: [5, 7, 9],
      size: [4, 6, 8],
      center: [3, 4, 5],
    })
  })

  it('combines child transforms and ignores unselected scenes', () => {
    const bounds = measureGlbBoundsFromBytes(
      glb({
        ...unitCube,
        scene: 0,
        scenes: [{ nodes: [0] }, { nodes: [2] }],
        nodes: [
          { translation: [10, 0, 0], children: [1] },
          { mesh: 0, translation: [0, 2, 0] },
          { mesh: 0, translation: [100, 0, 0] },
        ],
      }),
    )

    expect(bounds.min).toEqual([9, 1, -1])
    expect(bounds.max).toEqual([11, 3, 1])
  })

  it('rejects GLBs without measurable position bounds', () => {
    expect(() =>
      measureGlbBoundsFromBytes(glb({ scenes: [{ nodes: [0] }], nodes: [{}] })),
    ).toThrow('does not contain measurable scene geometry')
  })
})

describe('inspectGlbFromBytes', () => {
  it('reports rendered faces, vertices, and exact file size from the selected scene', () => {
    const bytes = glb({
      ...unitCube,
      scene: 0,
      scenes: [{ nodes: [0, 1] }, { nodes: [2] }],
      nodes: [{ mesh: 0 }, { mesh: 0 }, { mesh: 0 }],
    })

    expect(inspectGlbFromBytes(bytes)).toEqual({
      faces: 24,
      vertices: 16,
      fileSizeBytes: bytes.byteLength,
    })
  })
})
