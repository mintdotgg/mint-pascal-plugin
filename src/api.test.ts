import { afterEach, describe, expect, it, vi } from 'vitest'
import { uploadReferenceImage } from './api'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Pascal plugin API client', () => {
  it('imports a public image URL through the durable reference-image endpoint', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ id: 'reference_1', type: 'reference_image', url: 'https://cdn.mint.gg/reference.webp' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await uploadReferenceImage(
      { sourceUrl: 'https://images.example.com/chair.jpg' },
      'pascal-reference-url-test',
    )

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/plugins/mint/api/reference-images')
    expect(init).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ sourceUrl: 'https://images.example.com/chair.jpg' }),
      credentials: 'same-origin',
      cache: 'no-store',
    })
    const headers = new Headers(init?.headers)
    expect(headers.get('idempotency-key')).toBe('pascal-reference-url-test')
    expect(headers.get('content-type')).toBe('application/json')
  })
})
