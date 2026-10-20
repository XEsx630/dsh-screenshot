import assert from 'node:assert/strict'
import test from 'node:test'

import { pngSizeFromBuffer } from '../lib/png.js'

// 1×1 transparent PNG.
const ONE_PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

test('reads the IHDR size', () => {
  assert.deepEqual(pngSizeFromBuffer(ONE_PIXEL), { width: 1, height: 1 })
})

test('rejects non-PNG bytes', () => {
  assert.throws(() => pngSizeFromBuffer(Buffer.from('not a png at all, definitely not')), /PNG/)
  assert.throws(() => pngSizeFromBuffer(Buffer.alloc(4)), /PNG/)
})

test('rejects a PNG with a zero dimension', () => {
  const broken = Buffer.from(ONE_PIXEL)
  broken.writeUInt32BE(0, 16)
  assert.throws(() => pngSizeFromBuffer(broken), /尺寸/)
})
