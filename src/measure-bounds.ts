import type { GlbBounds, Vec3 } from './types'

const GLB_MAGIC = 0x46546c67
const GLB_JSON_CHUNK = 0x4e4f534a

type GltfAccessor = {
  count?: number
  min?: number[]
  max?: number[]
}

type GltfMesh = {
  primitives?: Array<{
    attributes?: { POSITION?: number }
    indices?: number
    mode?: number
  }>
}

type GltfNode = {
  children?: number[]
  matrix?: number[]
  mesh?: number
  rotation?: number[]
  scale?: number[]
  translation?: number[]
}

type GltfDocument = {
  accessors?: GltfAccessor[]
  meshes?: GltfMesh[]
  nodes?: GltfNode[]
  scene?: number
  scenes?: Array<{ nodes?: number[] }>
}

type Matrix4 = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
]

export type GlbMetrics = {
  faces: number
  vertices: number
  fileSizeBytes: number
}

const IDENTITY_MATRIX: Matrix4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

function parseGlbJson(bytes: Uint8Array): GltfDocument {
  if (bytes.byteLength < 20) throw new Error('This GLB is incomplete.')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== 2) {
    throw new Error('This file is not a supported GLB.')
  }
  const declaredLength = view.getUint32(8, true)
  if (declaredLength > bytes.byteLength) throw new Error('This GLB is incomplete.')

  let offset = 12
  while (offset + 8 <= declaredLength) {
    const chunkLength = view.getUint32(offset, true)
    const chunkType = view.getUint32(offset + 4, true)
    const chunkStart = offset + 8
    const chunkEnd = chunkStart + chunkLength
    if (chunkEnd > declaredLength) throw new Error('This GLB contains an invalid chunk.')
    if (chunkType === GLB_JSON_CHUNK) {
      const json = new TextDecoder().decode(bytes.subarray(chunkStart, chunkEnd)).trim()
      return JSON.parse(json) as GltfDocument
    }
    offset = chunkEnd
  }
  throw new Error('This GLB does not contain a JSON scene description.')
}

function multiplyMatrices(left: Matrix4, right: Matrix4): Matrix4 {
  const result = new Array<number>(16).fill(0) as Matrix4
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      result[column * 4 + row] =
        left[row]! * right[column * 4]! +
        left[4 + row]! * right[column * 4 + 1]! +
        left[8 + row]! * right[column * 4 + 2]! +
        left[12 + row]! * right[column * 4 + 3]!
    }
  }
  return result
}

function nodeMatrix(node: GltfNode): Matrix4 {
  if (node.matrix?.length === 16) return [...node.matrix] as Matrix4

  const [x = 0, y = 0, z = 0, w = 1] = node.rotation ?? []
  const [sx = 1, sy = 1, sz = 1] = node.scale ?? []
  const [tx = 0, ty = 0, tz = 0] = node.translation ?? []
  const x2 = x + x
  const y2 = y + y
  const z2 = z + z
  const xx = x * x2
  const xy = x * y2
  const xz = x * z2
  const yy = y * y2
  const yz = y * z2
  const zz = z * z2
  const wx = w * x2
  const wy = w * y2
  const wz = w * z2

  return [
    (1 - (yy + zz)) * sx,
    (xy + wz) * sx,
    (xz - wy) * sx,
    0,
    (xy - wz) * sy,
    (1 - (xx + zz)) * sy,
    (yz + wx) * sy,
    0,
    (xz + wy) * sz,
    (yz - wx) * sz,
    (1 - (xx + yy)) * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ]
}

function transformPoint(matrix: Matrix4, point: Vec3): Vec3 {
  return [
    matrix[0] * point[0] + matrix[4] * point[1] + matrix[8] * point[2] + matrix[12],
    matrix[1] * point[0] + matrix[5] * point[1] + matrix[9] * point[2] + matrix[13],
    matrix[2] * point[0] + matrix[6] * point[1] + matrix[10] * point[2] + matrix[14],
  ]
}

function finiteVec3(value: number[] | undefined): value is Vec3 {
  return value?.length === 3 && value.every(Number.isFinite)
}

function rootNodeIds(gltf: GltfDocument) {
  const nodes = gltf.nodes ?? []
  if (gltf.scenes?.length) return gltf.scenes[gltf.scene ?? 0]?.nodes ?? []
  const childIds = new Set(nodes.flatMap((node) => node.children ?? []))
  return nodes.flatMap((_, index) => (childIds.has(index) ? [] : [index]))
}

function primitiveFaceCount(
  primitive: NonNullable<GltfMesh['primitives']>[number],
  gltf: GltfDocument,
) {
  const positionCount = gltf.accessors?.[primitive.attributes?.POSITION ?? -1]?.count ?? 0
  const elementCount = gltf.accessors?.[primitive.indices ?? -1]?.count ?? positionCount
  const mode = primitive.mode ?? 4
  if (mode === 4) return Math.floor(elementCount / 3)
  if (mode === 5 || mode === 6) return Math.max(0, elementCount - 2)
  return 0
}

export function inspectGlbFromBytes(bytes: Uint8Array): GlbMetrics {
  const gltf = parseGlbJson(bytes)
  const nodes = gltf.nodes ?? []
  const metrics = { faces: 0, vertices: 0, fileSizeBytes: bytes.byteLength }

  function visit(nodeId: number, ancestors: Set<number>) {
    if (ancestors.has(nodeId)) throw new Error('This GLB contains a cyclic scene graph.')
    const node = nodes[nodeId]
    if (!node) return
    const mesh = node.mesh === undefined ? undefined : gltf.meshes?.[node.mesh]
    for (const primitive of mesh?.primitives ?? []) {
      const positionAccessor = gltf.accessors?.[primitive.attributes?.POSITION ?? -1]
      metrics.vertices += positionAccessor?.count ?? 0
      metrics.faces += primitiveFaceCount(primitive, gltf)
    }
    const nextAncestors = new Set(ancestors).add(nodeId)
    for (const childId of node.children ?? []) visit(childId, nextAncestors)
  }

  for (const root of rootNodeIds(gltf)) visit(root, new Set())
  return metrics
}

export function measureGlbBoundsFromBytes(bytes: Uint8Array): GlbBounds {
  const gltf = parseGlbJson(bytes)
  const nodes = gltf.nodes ?? []
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]

  function includeAccessor(accessor: GltfAccessor | undefined, matrix: Matrix4) {
    if (!finiteVec3(accessor?.min) || !finiteVec3(accessor.max)) return
    for (const x of [accessor.min[0], accessor.max[0]]) {
      for (const y of [accessor.min[1], accessor.max[1]]) {
        for (const z of [accessor.min[2], accessor.max[2]]) {
          const point = transformPoint(matrix, [x, y, z])
          for (let axis = 0; axis < 3; axis++) {
            min[axis] = Math.min(min[axis]!, point[axis]!)
            max[axis] = Math.max(max[axis]!, point[axis]!)
          }
        }
      }
    }
  }

  function visit(nodeId: number, parentMatrix: Matrix4, ancestors: Set<number>) {
    if (ancestors.has(nodeId)) throw new Error('This GLB contains a cyclic scene graph.')
    const node = nodes[nodeId]
    if (!node) return
    const matrix = multiplyMatrices(parentMatrix, nodeMatrix(node))
    const mesh = node.mesh === undefined ? undefined : gltf.meshes?.[node.mesh]
    for (const primitive of mesh?.primitives ?? []) {
      const accessorId = primitive.attributes?.POSITION
      includeAccessor(accessorId === undefined ? undefined : gltf.accessors?.[accessorId], matrix)
    }
    const nextAncestors = new Set(ancestors).add(nodeId)
    for (const childId of node.children ?? []) visit(childId, matrix, nextAncestors)
  }

  for (const root of rootNodeIds(gltf)) visit(root, IDENTITY_MATRIX, new Set())
  if (![...min, ...max].every(Number.isFinite)) {
    throw new Error('This GLB does not contain measurable scene geometry.')
  }

  return {
    min,
    max,
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    center: [
      (min[0] + max[0]) / 2,
      (min[1] + max[1]) / 2,
      (min[2] + max[2]) / 2,
    ],
  }
}

export async function measureGlbBounds(url: string): Promise<GlbBounds> {
  const response = await fetch(url, { credentials: 'omit' })
  if (!response.ok) throw new Error(`Unable to load this model (${response.status}).`)
  return measureGlbBoundsFromBytes(new Uint8Array(await response.arrayBuffer()))
}

export async function inspectGlb(url: string): Promise<GlbMetrics> {
  const response = await fetch(url, { credentials: 'omit' })
  if (!response.ok) throw new Error(`Unable to load this model (${response.status}).`)
  return inspectGlbFromBytes(new Uint8Array(await response.arrayBuffer()))
}
