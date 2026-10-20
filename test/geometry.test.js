import assert from 'node:assert/strict'
import test from 'node:test'

import { isShotId, stampName, toPhysicalRect } from '../lib/geometry.js'

test('isShotId accepts canonical uuids only', () => {
  assert.equal(isShotId('123e4567-e89b-42d3-a456-426614174000'), true)
  assert.equal(isShotId('123E4567-E89B-42D3-A456-426614174000'), true)
  assert.equal(isShotId('../../etc/passwd'), false)
  assert.equal(isShotId('123e4567-e89b-42d3-a456-42661417400'), false)
  assert.equal(isShotId('------------------------------------'), false)
  assert.equal(isShotId(undefined), false)
})

test('toPhysicalRect maps a half-scale stage to full-resolution pixels', () => {
  const rect = { x: 10, y: 10, w: 100, h: 50 }
  const stage = { w: 960, h: 540 }
  const image = { width: 1920, height: 1080 }
  assert.deepEqual(toPhysicalRect(rect, stage, image), { x: 20, y: 20, w: 200, h: 100 })
})

test('toPhysicalRect clamps a selection that overflows the image', () => {
  const rect = { x: 1800, y: 1000, w: 500, h: 500 }
  const stage = { w: 1920, h: 1080 }
  const image = { width: 1920, height: 1080 }
  assert.deepEqual(toPhysicalRect(rect, stage, image), { x: 1800, y: 1000, w: 120, h: 80 })
})

test('toPhysicalRect keeps a 1px crop when the selection sits on the last pixel', () => {
  const rect = { x: 1919.6, y: 1079.6, w: 10, h: 10 }
  const stage = { w: 1920, h: 1080 }
  const image = { width: 1920, height: 1080 }
  assert.deepEqual(toPhysicalRect(rect, stage, image), { x: 1919, y: 1079, w: 1, h: 1 })
})

test('toPhysicalRect rejects degenerate input', () => {
  const image = { width: 100, height: 100 }
  assert.equal(toPhysicalRect({ x: 0, y: 0, w: 0, h: 10 }, { w: 100, h: 100 }, image), null)
  assert.equal(toPhysicalRect({ x: 0, y: 0, w: 10, h: 10 }, { w: 0, h: 100 }, image), null)
  assert.equal(toPhysicalRect({ x: 0, y: 0, w: 10, h: 10 }, { w: 100, h: 100 }, { width: 0, height: 1 }), null)
  assert.equal(toPhysicalRect({ x: 'a', y: 0, w: 10, h: 10 }, { w: 100, h: 100 }, image), null)
})

test('stampName is a stable, human-readable file name', () => {
  const name = stampName(new Date(2026, 9, 20, 12, 15, 6))
  assert.equal(name, 'screenshot-20261020-121506.png')
})
