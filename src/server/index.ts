import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const DEFAULT_CLIENT_ID = 'mint_pascal'
const DEFAULT_SCOPES = ['mint:assets:read', 'mint:assets:generate'] as const
const COOKIE_PATH = '/api/plugins/mint'
const ACCESS_COOKIE = 'mint_pascal_access'
const REFRESH_COOKIE = 'mint_pascal_refresh'
const STATE_COOKIE = 'mint_pascal_state'
const VERIFIER_COOKIE = 'mint_pascal_verifier'
const RETURN_COOKIE = 'mint_pascal_return'

type TokenResponse = {
  access_token: string
  refresh_token: string
  expires_in: number
  token_type: string
  scope: string
}

export type MintPascalServerOptions = {
  origin?: string
  clientId?: string
  oauthIssuer?: string
  oauthResource?: string
  mintApiBase?: string
  fetch?: typeof fetch
}

type ResolvedOptions = Required<MintPascalServerOptions>

function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url')
}

function configuredOrigin(value: string | undefined) {
  if (!value) throw new Error('Mint Pascal host origin is not configured.')
  const url = new URL(value)
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('Mint Pascal host origin must be an HTTP(S) origin without a path.')
  }
  return url.origin
}

function resolveOptions(options: MintPascalServerOptions): ResolvedOptions {
  return {
    origin: configuredOrigin(options.origin ?? process.env.MINT_PASCAL_HOST_ORIGIN),
    clientId: options.clientId ?? DEFAULT_CLIENT_ID,
    oauthIssuer:
      options.oauthIssuer ??
      process.env.MINT_PASCAL_OAUTH_ISSUER ??
      'https://mcp.mint.gg',
    oauthResource:
      options.oauthResource ??
      process.env.MINT_PASCAL_API_RESOURCE ??
      'https://api.mint.gg',
    mintApiBase:
      options.mintApiBase ??
      process.env.MINT_PASCAL_API_BASE ??
      'https://api.mint.gg/v1',
    fetch: options.fetch ?? fetch,
  }
}

function parseCookies(request: Request) {
  const values = new Map<string, string>()
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const separator = part.indexOf('=')
    if (separator < 1) continue
    const name = part.slice(0, separator).trim()
    const value = part.slice(separator + 1).trim()
    try {
      values.set(name, decodeURIComponent(value))
    } catch {
      values.set(name, value)
    }
  }
  return values
}

function cookie(name: string, value: string, input: { maxAge: number; secure: boolean }) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${COOKIE_PATH}`,
    'HttpOnly',
    'SameSite=Lax',
    input.secure ? 'Secure' : '',
    `Max-Age=${input.maxAge}`,
  ]
    .filter(Boolean)
    .join('; ')
}

function secureCookies(options: ResolvedOptions) {
  return new URL(options.origin).protocol === 'https:'
}

function tokenCookies(options: ResolvedOptions, tokens: TokenResponse) {
  const secure = secureCookies(options)
  return [
    cookie(ACCESS_COOKIE, tokens.access_token, {
      maxAge: Math.max(1, Math.floor(tokens.expires_in)),
      secure,
    }),
    cookie(REFRESH_COOKIE, tokens.refresh_token, { maxAge: 90 * 24 * 60 * 60, secure }),
  ]
}

function temporaryCookies(
  options: ResolvedOptions,
  input: { state: string; verifier: string; returnTo: string },
) {
  const secure = secureCookies(options)
  return [
    cookie(STATE_COOKIE, input.state, { maxAge: 600, secure }),
    cookie(VERIFIER_COOKIE, input.verifier, { maxAge: 600, secure }),
    cookie(RETURN_COOKIE, input.returnTo, { maxAge: 600, secure }),
  ]
}

function clearCookies(options: ResolvedOptions, names = [ACCESS_COOKIE, REFRESH_COOKIE]) {
  const secure = secureCookies(options)
  return names.map((name) => cookie(name, '', { maxAge: 0, secure }))
}

function responseWithCookies(response: Response, cookies: string[]) {
  const headers = new Headers(response.headers)
  headers.set('Cache-Control', 'no-store')
  for (const value of cookies) headers.append('Set-Cookie', value)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

function json(value: unknown, status = 200, cookies: string[] = []) {
  return responseWithCookies(
    new Response(JSON.stringify(value), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    }),
    cookies,
  )
}

function safeReturnPath(value: string | null) {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/'
  try {
    const parsed = new URL(value, 'https://pascal.invalid')
    return parsed.origin === 'https://pascal.invalid'
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : '/'
  } catch {
    return '/'
  }
}

function callbackUrl(options: ResolvedOptions) {
  return `${options.origin}${COOKIE_PATH}/oauth/callback`
}

function sameSecret(left: string, right: string) {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

function sameOrigin(request: Request, options: ResolvedOptions) {
  const origin = request.headers.get('origin')
  return origin !== null && origin === options.origin
}

function tokenEndpoint(options: ResolvedOptions) {
  return `${options.oauthIssuer.replace(/\/$/, '')}/oauth/token`
}

function revokeEndpoint(options: ResolvedOptions) {
  return `${options.oauthIssuer.replace(/\/$/, '')}/oauth/revoke`
}

async function exchangeCode(options: ResolvedOptions, code: string, verifier: string) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: options.clientId,
    code,
    code_verifier: verifier,
    redirect_uri: callbackUrl(options),
    resource: options.oauthResource,
  })
  const response = await options.fetch(tokenEndpoint(options), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!response.ok) throw new Error('Mint rejected the OAuth authorization code.')
  return (await response.json()) as TokenResponse
}

async function refreshTokens(options: ResolvedOptions, refreshToken: string) {
  const response = await options.fetch(tokenEndpoint(options), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: options.clientId,
      refresh_token: refreshToken,
      resource: options.oauthResource,
    }),
  })
  if (!response.ok) return null
  const tokens = (await response.json()) as TokenResponse
  return { accessToken: tokens.access_token, cookies: tokenCookies(options, tokens) }
}

async function startAuthorization(request: Request, options: ResolvedOptions) {
  const requestUrl = new URL(request.url)
  const state = randomToken()
  const verifier = randomToken(64)
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const returnTo = safeReturnPath(requestUrl.searchParams.get('returnTo'))
  const authorize = new URL('/oauth/authorize', options.oauthIssuer)
  authorize.searchParams.set('response_type', 'code')
  authorize.searchParams.set('client_id', options.clientId)
  authorize.searchParams.set('redirect_uri', callbackUrl(options))
  authorize.searchParams.set('scope', DEFAULT_SCOPES.join(' '))
  authorize.searchParams.set('resource', options.oauthResource)
  authorize.searchParams.set('state', state)
  authorize.searchParams.set('code_challenge', challenge)
  authorize.searchParams.set('code_challenge_method', 'S256')
  return responseWithCookies(
    Response.redirect(authorize, 302),
    temporaryCookies(options, { state, verifier, returnTo }),
  )
}

async function finishAuthorization(request: Request, options: ResolvedOptions) {
  const requestUrl = new URL(request.url)
  const values = parseCookies(request)
  const expectedState = values.get(STATE_COOKIE)
  const verifier = values.get(VERIFIER_COOKIE)
  const returnTo = safeReturnPath(values.get(RETURN_COOKIE) ?? null)
  const state = requestUrl.searchParams.get('state')
  const code = requestUrl.searchParams.get('code')
  const temporaryNames = [STATE_COOKIE, VERIFIER_COOKIE, RETURN_COOKIE]
  if (
    requestUrl.searchParams.has('error') ||
    !expectedState ||
    !state ||
    !sameSecret(expectedState, state) ||
    !verifier ||
    !code
  ) {
    return json(
      { error: 'invalid_oauth_callback', detail: 'Mint sign-in could not be verified.' },
      400,
      clearCookies(options, temporaryNames),
    )
  }

  try {
    const tokens = await exchangeCode(options, code, verifier)
    const redirect = Response.redirect(new URL(returnTo, options.origin), 303)
    return responseWithCookies(redirect, [
      ...tokenCookies(options, tokens),
      ...clearCookies(options, temporaryNames),
    ])
  } catch {
    return json(
      { error: 'oauth_exchange_failed', detail: 'Mint sign-in could not be completed.' },
      502,
      clearCookies(options, [...temporaryNames, ACCESS_COOKIE, REFRESH_COOKIE]),
    )
  }
}

type AuthenticatedFetch = {
  response: Response | null
  cookies: string[]
}

async function authenticatedApiFetch(
  request: Request,
  options: ResolvedOptions,
  upstreamPath: string,
  init: RequestInit,
): Promise<AuthenticatedFetch> {
  const values = parseCookies(request)
  const refreshToken = values.get(REFRESH_COOKIE)
  let accessToken = values.get(ACCESS_COOKIE)
  let rotatedCookies: string[] = []
  if (!accessToken && refreshToken) {
    const refreshed = await refreshTokens(options, refreshToken)
    if (!refreshed) return { response: null, cookies: clearCookies(options) }
    accessToken = refreshed.accessToken
    rotatedCookies = refreshed.cookies
  }
  if (!accessToken) return { response: null, cookies: [] }

  const execute = (token: string) =>
    options.fetch(`${options.mintApiBase.replace(/\/$/, '')}/${upstreamPath}`, {
      ...init,
      headers: { ...Object.fromEntries(new Headers(init.headers)), Authorization: `Bearer ${token}` },
    })
  let response = await execute(accessToken)
  if (response.status === 401 && refreshToken) {
    const refreshed = await refreshTokens(options, refreshToken)
    if (!refreshed) return { response: null, cookies: clearCookies(options) }
    rotatedCookies = refreshed.cookies
    response = await execute(refreshed.accessToken)
  }
  return { response, cookies: rotatedCookies }
}

const GET_API_PATH = /^(?:me|usage|models(?:\/[A-Za-z0-9_-]+)?|operations\/[A-Za-z0-9_-]+)$/
const POST_API_PATH = /^(?:pricing:estimate|reference-images|models:generate|models\/[A-Za-z0-9_-]+:(?:retry|optimize)|operations\/[A-Za-z0-9_-]+:(?:approve|revise|resume))$/

function allowedApiPath(method: string, path: string) {
  return method === 'GET' ? GET_API_PATH.test(path) : method === 'POST' && POST_API_PATH.test(path)
}

async function proxyApi(request: Request, options: ResolvedOptions, path: string) {
  if (!allowedApiPath(request.method, path)) {
    return json({ error: 'not_found', detail: 'This Mint plugin API route is not available.' }, 404)
  }
  if (request.method === 'POST' && !sameOrigin(request, options)) {
    return json({ error: 'origin_mismatch', detail: 'The request origin was not accepted.' }, 403)
  }

  const requestUrl = new URL(request.url)
  const upstreamPath = `${path}${requestUrl.search}`
  const headers = new Headers()
  headers.set('Accept', 'application/json')
  const contentType = request.headers.get('content-type')
  const idempotencyKey = request.headers.get('idempotency-key')
  if (contentType) headers.set('Content-Type', contentType)
  if (idempotencyKey) headers.set('Idempotency-Key', idempotencyKey)
  const body = request.method === 'POST' ? await request.arrayBuffer() : undefined
  const upstream = await authenticatedApiFetch(request, options, upstreamPath, {
    method: request.method,
    headers,
    ...(body ? { body } : {}),
  })
  if (!upstream.response) {
    return json({ error: 'session_expired', detail: 'Reconnect Mint to continue.' }, 401, upstream.cookies)
  }

  const responseHeaders = new Headers()
  for (const name of ['content-type', 'retry-after', 'location', 'x-request-id']) {
    const value = upstream.response.headers.get(name)
    if (value) responseHeaders.set(name, value)
  }
  return responseWithCookies(
    new Response(upstream.response.body, {
      status: upstream.response.status,
      statusText: upstream.response.statusText,
      headers: responseHeaders,
    }),
    upstream.cookies,
  )
}

async function session(request: Request, options: ResolvedOptions) {
  const upstream = await authenticatedApiFetch(request, options, 'me', {
    method: 'GET',
    headers: { Accept: 'application/json' },
  })
  if (!upstream.response) return json({ connected: false }, 200, upstream.cookies)
  if (!upstream.response.ok) {
    if (upstream.response.status === 401) {
      return json({ connected: false }, 200, clearCookies(options))
    }
    return json(
      { error: 'mint_unavailable', detail: 'Mint could not verify the current session.' },
      502,
      upstream.cookies,
    )
  }
  const account = (await upstream.response.json()) as {
    authentication?: { scopes?: string[] }
    owner?: { userId?: string; email?: string | null }
  }
  if (!account.owner?.userId) return json({ connected: false }, 200, clearCookies(options))
  return json(
    {
      connected: true,
      user: { walletAddress: account.owner.userId, email: account.owner.email ?? null },
      scopes: account.authentication?.scopes ?? [],
    },
    200,
    upstream.cookies,
  )
}

async function logout(request: Request, options: ResolvedOptions) {
  if (!sameOrigin(request, options)) {
    return json({ error: 'origin_mismatch', detail: 'The request origin was not accepted.' }, 403)
  }
  const refreshToken = parseCookies(request).get(REFRESH_COOKIE)
  if (refreshToken) {
    await options
      .fetch(revokeEndpoint(options), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token: refreshToken,
          token_type_hint: 'refresh_token',
          client_id: options.clientId,
          resource: options.oauthResource,
        }),
      })
      .catch(() => null)
  }
  return json({}, 200, clearCookies(options))
}

function routePath(request: Request) {
  const marker = `${COOKIE_PATH}/`
  const pathname = new URL(request.url).pathname
  const markerIndex = pathname.indexOf(marker)
  return markerIndex < 0 ? '' : pathname.slice(markerIndex + marker.length).replace(/\/+$/, '')
}

export async function handleMintPascalRequest(
  request: Request,
  serverOptions: MintPascalServerOptions = {},
) {
  try {
    const options = resolveOptions(serverOptions)
    const path = routePath(request)
    if (request.method === 'GET' && path === 'oauth/start') return await startAuthorization(request, options)
    if (request.method === 'GET' && path === 'oauth/callback') {
      return await finishAuthorization(request, options)
    }
    if (request.method === 'GET' && path === 'session') return await session(request, options)
    if (request.method === 'POST' && path === 'logout') return await logout(request, options)
    if (path.startsWith('api/')) return await proxyApi(request, options, path.slice(4))
    return json({ error: 'not_found', detail: 'Mint plugin route not found.' }, 404)
  } catch {
    return json({ error: 'mint_unavailable', detail: 'Mint is temporarily unavailable.' }, 502)
  }
}

export const mintPascalOAuthScopes = [...DEFAULT_SCOPES]
export const mintPascalOAuthClientId = DEFAULT_CLIENT_ID
