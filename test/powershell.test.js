import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { pngSizeFromBuffer } from '../lib/png.js'

const CROP = fileURLToPath(new URL('../lib/crop.ps1', import.meta.url))
const CAPTURE = fileURLToPath(new URL('../lib/screenshot.ps1', import.meta.url))
const WINDOWS = process.platform === 'win32'

function runPowerShell(args) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], {
    encoding: 'utf8',
    windowsHide: true,
  })
  let json
  try {
    json = JSON.parse((result.stdout || '').trim().split(/\r?\n/).pop())
  } catch {
    json = undefined
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json }
}

async function makePng(file, width, height) {
  const script = [
    'Add-Type -AssemblyName System.Drawing',
    `$b = New-Object System.Drawing.Bitmap(${width}, ${height})`,
    '$g = [System.Drawing.Graphics]::FromImage($b)',
    '$g.Clear([System.Drawing.Color]::FromArgb(255, 30, 90, 180))',
    '$g.Dispose()',
    `$b.Save('${file.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    '$b.Dispose()',
  ].join('; ')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  })
  assert.equal(result.status, 0, result.stderr)
}

test('crop.ps1 clones a physical-pixel rectangle', { skip: !WINDOWS }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-shot-crop-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const source = join(dir, 'source.png')
  const out = join(dir, 'out.png')
  await makePng(source, 200, 120)

  const result = runPowerShell(['-File', CROP, '-Source', source, '-OutPath', out, '-X', '10', '-Y', '20', '-W', '50', '-H', '40'])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.json?.ok, true)

  const size = pngSizeFromBuffer(await readFile(out))
  assert.deepEqual(size, { width: 50, height: 40 })
})

test('crop.ps1 refuses a rectangle outside the source', { skip: !WINDOWS }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-shot-crop-bad-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const source = join(dir, 'source.png')
  await makePng(source, 40, 40)

  const result = runPowerShell([
    '-File',
    CROP,
    '-Source',
    source,
    '-OutPath',
    join(dir, 'out.png'),
    '-X',
    '30',
    '-Y',
    '0',
    '-W',
    '40',
    '-H',
    '40',
  ])
  assert.notEqual(result.status, 0)
  assert.equal(result.json?.ok, false)
  assert.match(result.json.error, /outside/)
})

// Opt-in: grabs the real screen, so it is not part of the default test run.
test('screenshot.ps1 captures the primary screen', { skip: !WINDOWS || process.env.DSH_SCREENSHOT_LIVE !== '1' }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-shot-live-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const out = join(dir, 'shot.png')
  const result = runPowerShell(['-File', CAPTURE, '-OutPath', out, '-HideWindow', '0', '-AllScreens', '0'])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.json?.ok, true)

  const size = pngSizeFromBuffer(await readFile(out))
  assert.equal(size.width, result.json.width)
  assert.equal(size.height, result.json.height)
})
