import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleMintPascalRequest } from './index'

type HeadersWithCookies = Headers & { getSetCookie: () => string[] }
const setCookies = (response: Response) => (response.headers as HeadersWithCookies).getSetCookie()
const cookieHeader = (response: Response) => setCookies(response).map((value) => value.split(';')[0]).join('; ')
const cookieValue = (response: Response, name: string) => {
  const entry = setCookies(response).find((value) => value.startsWith(`${name}=`))
  return entry ? decodeURIComponent(entry.split(';')[0]!.slice(name.length + 1)) : null
}

afterEach(() => vi.unstubAllEnvs())

describe('Pascal OAuth server adapter', () => {
  it('uses public Mint defaults for loopback hosts unless endpoints are configured', async () => {
    const response = await handleMintPascalRequest(
      new Request('http://localhost:3002/api/plugins/mint/oauth/start'),
    )
    const redirect = new URL(response.headers.get('location')!)
    expect(redirect.origin).toBe('https://mcp.mint.gg')
    expect(redirect.searchParams.get('resource')).toBe('https://api.mint.gg')
  })

  it('supports explicit Mint endpoint overrides for internal local development', async () => {
    vi.stubEnv('MINT_PASCAL_OAUTH_ISSUER', 'https://oauth.internal.example')
    vi.stubEnv('MINT_PASCAL_API_RESOURCE', 'https://api.internal.example')
    vi.stubEnv('MINT_PASCAL_API_BASE', 'https://api.internal.example/v1')

    const start = await handleMintPascalRequest(
      new Request('http://localhost:3002/api/plugins/mint/oauth/start'),
    )
    const redirect = new URL(start.headers.get('location')!)
    expect(redirect.origin).toBe('https://oauth.internal.example')
    expect(redirect.searchParams.get('resource')).toBe('https://api.internal.example')

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        authentication: { scopes: ['mint:assets:read'] },
        owner: { userId: '0xabc', email: null },
      }),
    )
    await handleMintPascalRequest(
      new Request('http://localhost:3002/api/plugins/mint/session', {
        headers: { Cookie: 'mint_pascal_access=access-token' },
      }),
      { fetch: fetchMock },
    )
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.internal.example/v1/me',
      expect.any(Object),
    )
  })

  it('starts resource-bound PKCE with both asset scopes and no secret', async () => {
    const response = await handleMintPascalRequest(
      new Request('https://editor.pascal.app/api/plugins/mint/oauth/start?returnTo=%2Fproject%2F123'),
    )
    expect(response.status).toBe(302)
    const redirect = new URL(response.headers.get('location')!)
    expect(redirect.origin).toBe('https://mcp.mint.gg')
    expect(redirect.searchParams.get('client_id')).toBe('mint_pascal')
    expect(redirect.searchParams.get('resource')).toBe('https://api.mint.gg')
    expect(redirect.searchParams.get('scope')).toBe('mint:assets:read mint:assets:generate')
    expect(redirect.searchParams.get('code_challenge_method')).toBe('S256')
    expect(redirect.searchParams.has('client_secret')).toBe(false)
    expect(setCookies(response)).toHaveLength(3)
    expect(setCookies(response).every((value) => value.includes('HttpOnly') && value.includes('Secure'))).toBe(true)
  })

  it('exchanges the callback and stores tokens only in HttpOnly cookies', async () => {
    const start = await handleMintPascalRequest(
      new Request('https://editor.pascal.app/api/plugins/mint/oauth/start?returnTo=%2Fproject%2F123'),
    )
    const state = cookieValue(start, 'mint_pascal_state')
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body as URLSearchParams
      expect(body.get('resource')).toBe('https://api.mint.gg')
      expect(body.get('client_secret')).toBeNull()
      expect(body.get('code_verifier')).toBeTruthy()
      return Response.json({ access_token: 'access-token', refresh_token: 'refresh-token', expires_in: 3600, token_type: 'Bearer', scope: 'mint:assets:read mint:assets:generate' })
    })
    const response = await handleMintPascalRequest(
      new Request(`https://editor.pascal.app/api/plugins/mint/oauth/callback?code=code-1&state=${state}`, { headers: { Cookie: cookieHeader(start) } }),
      { fetch: fetchMock as typeof fetch },
    )
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('https://editor.pascal.app/project/123')
    expect(cookieValue(response, 'mint_pascal_access')).toBe('access-token')
    expect(cookieValue(response, 'mint_pascal_refresh')).toBe('refresh-token')
  })

  it('rejects mismatched state before exchange', async () => {
    const start = await handleMintPascalRequest(new Request('https://editor.pascal.app/api/plugins/mint/oauth/start'))
    const fetchMock = vi.fn<typeof fetch>()
    const response = await handleMintPascalRequest(
      new Request('https://editor.pascal.app/api/plugins/mint/oauth/callback?code=code-1&state=wrong', { headers: { Cookie: cookieHeader(start) } }),
      { fetch: fetchMock },
    )
    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rotates refresh tokens server-side without exposing them in session JSON', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, token_type: 'Bearer', scope: 'mint:assets:read mint:assets:generate' }))
      .mockResolvedValueOnce(Response.json({ authentication: { type: 'oauth', scopes: ['mint:assets:read', 'mint:assets:generate'] }, owner: { userId: '0xabc', email: null } }))
    const response = await handleMintPascalRequest(
      new Request('https://editor.pascal.app/api/plugins/mint/session', { headers: { Cookie: 'mint_pascal_refresh=old-refresh' } }),
      { fetch: fetchMock },
    )
    const body = await response.json()
    expect(body).toEqual({ connected: true, user: { walletAddress: '0xabc', email: null }, scopes: ['mint:assets:read', 'mint:assets:generate'] })
    expect(JSON.stringify(body)).not.toContain('new-access')
    expect(cookieValue(response, 'mint_pascal_refresh')).toBe('new-refresh')
    const refreshBody = fetchMock.mock.calls[0]![1]!.body as URLSearchParams
    expect(refreshBody.get('resource')).toBe('https://api.mint.gg')
  })

  it('reports upstream session failures without clearing a valid local session', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ error: 'unavailable' }, { status: 503 }),
    )
    const response = await handleMintPascalRequest(
      new Request('https://editor.pascal.app/api/plugins/mint/session', {
        headers: { Cookie: 'mint_pascal_access=access-token' },
      }),
      { fetch: fetchMock },
    )

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      error: 'mint_unavailable',
      detail: 'Mint could not verify the current session.',
    })
    expect(setCookies(response)).toEqual([])
  })

  it('enforces origin and a fixed upstream route allowlist', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ object: 'operation' }))
    const rejectedOrigin = await handleMintPascalRequest(
      new Request('https://editor.pascal.app/api/plugins/mint/api/models:generate', { method: 'POST', headers: { Origin: 'https://attacker.example', Cookie: 'mint_pascal_access=token' }, body: '{}' }),
      { fetch: fetchMock },
    )
    expect(rejectedOrigin.status).toBe(403)
    const rejectedPath = await handleMintPascalRequest(
      new Request('https://editor.pascal.app/api/plugins/mint/api/assets/asset_1', { headers: { Cookie: 'mint_pascal_access=token' } }),
      { fetch: fetchMock },
    )
    expect(rejectedPath.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('proxies allowed generation with only safe headers', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ object: 'operation', id: 'op_1' }, { status: 202 }))
    const response = await handleMintPascalRequest(
      new Request('https://editor.pascal.app/api/plugins/mint/api/models:generate', {
        method: 'POST',
        headers: { Origin: 'https://editor.pascal.app', Cookie: 'mint_pascal_access=token', 'Idempotency-Key': 'stable-key', 'X-Secret': 'nope', 'Content-Type': 'application/json' },
        body: '{"prompt":"chair"}',
      }),
      { fetch: fetchMock },
    )
    expect(response.status).toBe(202)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.mint.gg/v1/models:generate')
    expect(new Headers(init!.headers).get('authorization')).toBe('Bearer token')
    expect(new Headers(init!.headers).get('idempotency-key')).toBe('stable-key')
    expect(new Headers(init!.headers).has('x-secret')).toBe(false)
  })

  it('revokes same-origin logout and clears both session cookies', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}))
    const response = await handleMintPascalRequest(
      new Request('https://editor.pascal.app/api/plugins/mint/logout', { method: 'POST', headers: { Origin: 'https://editor.pascal.app', Cookie: 'mint_pascal_refresh=refresh-token' }, body: '{}' }),
      { fetch: fetchMock },
    )
    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(setCookies(response).every((value) => value.includes('Max-Age=0'))).toBe(true)
  })
})
