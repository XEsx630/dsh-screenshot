import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.js'

const UUID = '123e4567-e89b-42d3-a456-426614174000'

function createHarness() {
  const routes = []
  const ctx = {
    effect(fn) {
      fn()
      return () => {}
    },
    inject(_names, callback) {
      callback({
        webServer: {
          register(route) {
            routes.push(route)
            return () => {}
          },
        },
        effect(fn) {
          fn()
          return () => {}
        },
      })
    },
  }
  apply(ctx)
  assert.equal(routes.length, 1)
  return routes[0]
}

function createResponse() {
  const state = { status: 0, headers: {}, body: '' }
  const res = {
    headersSent: false,
    writeHead(status, headers = {}) {
      state.status = status
      state.headers = headers
      res.headersSent = true
      return res
    },
    end(chunk) {
      if (chunk !== undefined) state.body += String(chunk)
      return res
    },
    on() {},
    destroy() {},
  }
  return { res, state }
}

function createRequest({ method = 'GET', url, headers = {}, body } = {}) {
  const payload =
    body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  return {
    method,
    url,
    headers: { host: '127.0.0.1:13590', ...headers },
    async *[Symbol.asyncIterator]() {
      if (payload !== null) yield payload
    },
  }
}

async function call(route, options) {
  const { res, state } = createResponse()
  await route.handler(createRequest(options), res)
  let json
  try {
    json = JSON.parse(state.body)
  } catch {
    json = undefined
  }
  return { status: state.status, headers: state.headers, body: state.body, json }
}

test('screenshot routes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-shot-test-'))
  process.env.DSH_SCREENSHOT_DIR = dir
  t.after(async () => {
    delete process.env.DSH_SCREENSHOT_DIR
    await rm(dir, { recursive: true, force: true })
  })

  const route = createHarness()
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, '/api/screenshot')

  await t.test('rejects foreign hosts before touching the filesystem', async () => {
    const result = await call(route, {
      method: 'POST',
      url: '/api/screenshot/capture',
      headers: { host: 'evil.example' },
      body: {},
    })
    assert.equal(result.status, 403)
    assert.equal(result.json.ok, false)
  })

  await t.test('rejects cross-site requests', async () => {
    const result = await call(route, {
      method: 'GET',
      url: '/api/screenshot/preview?id=' + UUID,
      headers: { 'sec-fetch-site': 'cross-site' },
    })
    assert.equal(result.status, 403)
  })

  await t.test('reports the allowed methods', async () => {
    const result = await call(route, { method: 'GET', url: '/api/screenshot/capture' })
    assert.equal(result.status, 405)
    assert.equal(result.headers.allow, 'POST')
  })

  await t.test('validates ids before resolving files', async () => {
    for (const id of ['', '../../etc/passwd', '123']) {
      const result = await call(route, {
        method: 'GET',
        url: `/api/screenshot/preview?id=${encodeURIComponent(id)}`,
      })
      assert.equal(result.status, 400)
      assert.equal(result.json.ok, false)
    }
  })

  await t.test('returns 404 for an expired capture', async () => {
    const result = await call(route, { method: 'GET', url: `/api/screenshot/preview?id=${UUID}` })
    assert.equal(result.status, 404)
    assert.match(result.json.error, /不存在|过期/)
  })

  await t.test('rejects malformed crop bodies', async () => {
    const badJson = await call(route, {
      method: 'POST',
      url: '/api/screenshot/crop',
      body: '{',
    })
    assert.equal(badJson.status, 400)

    const badRect = await call(route, {
      method: 'POST',
      url: '/api/screenshot/crop',
      body: { id: UUID, rect: { x: 0, y: 0, w: 10 }, stage: { w: 100, h: 100 } },
    })
    assert.equal(badRect.status, 400)

    const badId = await call(route, {
      method: 'POST',
      url: '/api/screenshot/crop',
      body: { id: '../x', rect: { x: 0, y: 0, w: 10, h: 10 }, stage: { w: 100, h: 100 } },
    })
    assert.equal(badId.status, 400)
  })

  await t.test('returns 404 when the capture to crop is gone', async () => {
    const result = await call(route, {
      method: 'POST',
      url: '/api/screenshot/crop',
      body: { id: UUID, rect: { x: 0, y: 0, w: 10, h: 10 }, stage: { w: 100, h: 100 } },
    })
    assert.equal(result.status, 404)
  })

  await t.test('caps request bodies', async () => {
    const result = await call(route, {
      method: 'POST',
      url: '/api/screenshot/crop',
      body: { id: UUID, pad: 'x'.repeat(32 * 1024) },
    })
    assert.equal(result.status, 413)
  })

  await t.test('answers unknown sub-routes with 404', async () => {
    const result = await call(route, { method: 'GET', url: '/api/screenshot/nope' })
    assert.equal(result.status, 404)
  })
})
