import assert from 'node:assert/strict'
import test from 'node:test'

import { isTrustedScreenshotRequest } from '../lib/index.js'

const request = (headers) => ({ headers })

test('accepts loopback requests without an Origin header', () => {
  assert.equal(isTrustedScreenshotRequest(request({ host: '127.0.0.1:13590' })), true)
  assert.equal(isTrustedScreenshotRequest(request({ host: 'localhost:13590' })), true)
  assert.equal(isTrustedScreenshotRequest(request({ host: '[::1]:13590' })), true)
})

test('accepts same-origin requests', () => {
  assert.equal(
    isTrustedScreenshotRequest(
      request({ host: '127.0.0.1:13590', origin: 'http://127.0.0.1:13590' }),
    ),
    true,
  )
})

test('rejects non-loopback hosts', () => {
  assert.equal(isTrustedScreenshotRequest(request({ host: '192.168.1.10:13590' })), false)
  assert.equal(isTrustedScreenshotRequest(request({ host: 'dsh.example.com' })), false)
  assert.equal(isTrustedScreenshotRequest(request({})), false)
  assert.equal(isTrustedScreenshotRequest(request({ host: '127.0.0.1:1#evil' })), false)
})

test('rejects cross-site navigation and foreign origins', () => {
  const base = { host: '127.0.0.1:13590' }
  assert.equal(isTrustedScreenshotRequest(request({ ...base, 'sec-fetch-site': 'cross-site' })), false)
  assert.equal(isTrustedScreenshotRequest(request({ ...base, origin: 'https://evil.example' })), false)
  assert.equal(isTrustedScreenshotRequest(request({ ...base, origin: 'http://127.0.0.1:1234' })), false)
  assert.equal(isTrustedScreenshotRequest(request({ ...base, origin: 'not a url' })), false)
})
