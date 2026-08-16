// dsh-screenshot — WeChat-style screenshot for the DeepSeek Harness composer.
//
// Host half: serves the screenshot API. A capture spawns Windows PowerShell
// to grab the full screen (optionally hiding the foreground DSH window
// first), saving a temporary PNG under the uploads directory. The browser
// client shows the preview, the user drags a selection rectangle, and the
// client POSTs the display-space rectangle back; the host converts it to
// physical pixels (using the PNG's real dimensions) and crops the image
// server-side with PowerShell — no browser canvas/image-decoding involved.
// The finished PNG is stored as a regular upload so the message serializes
// the stored path for the model (which reads it with the local vision MCP).
//
// Registry-ready cordis plugin: exports { name, apply, inject }.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readdir, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'

export const name = 'dsh-screenshot'
export const inject = ['webServer']

export const SCREENSHOT_TEMP_PREFIX = '.screenshot-'
const CAPTURE_TIMEOUT_MS = 30_000

/** Absolute path of the PowerShell capture script shipped with this package. */
export function captureScriptPath() {
  return fileURLToPath(new URL('./screenshot.ps1', import.meta.url))
}

/** Absolute path of the PowerShell crop script shipped with this package. */
export function cropScriptPath() {
  return fileURLToPath(new URL('./crop.ps1', import.meta.url))
}

function clamp(min, max, value) {
  return Math.max(min, Math.min(max, value))
}

function stampName() {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `screenshot-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.png`
}

export function resolveUploadRoot(env = process.env) {
  const dshHome = env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return resolve(env.DSH_UPLOAD_DIR?.trim() || join(dshHome, 'uploads'))
}

/** Safe temp file name is always `.screenshot-<uuid>.png`; ids are uuids only. */
const ID_RE = /^[0-9a-f-]{36}$/

function header(headers, key) {
  const value = headers[key]
  return typeof value === 'string' ? value : undefined
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Same trust fence as the other DSH local plugins: loopback host + same-origin. */
export function isTrustedScreenshotRequest(req) {
  const host = header(req.headers, 'host')
  if (host === undefined) return false
  let hostname
  try {
    hostname = new URL(`http://${host}`).hostname
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostname)) return false
  if (header(req.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(req.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function methodNotAllowed(res, methods) {
  res.writeHead(405, { allow: methods.join(', '), 'content-length': 0 })
  res.end()
}

async function readJsonBody(req, maxBytes = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new Error('request body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  const value = JSON.parse(text)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('request body must be a JSON object')
  return value
}

/**
 * Run the PowerShell capture script and resolve with its JSON stdout line.
 * Resolves to the parsed result; rejects on spawn/parse/timeout errors.
 */
export function runCapture(outPath, { hideWindow = false, allScreens = false } = {}) {
  const script = captureScriptPath()
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-OutPath',
    outPath,
    '-HideWindow',
    hideWindow ? 1 : 0,
    '-AllScreens',
    allScreens ? 1 : 0,
  ]
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('powershell.exe', args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      if (stdout.length < 64 * 1024) stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 64 * 1024) stderr += chunk
    })
    const timer = setTimeout(() => {
      child.kill()
      rejectPromise(new Error('screenshot capture timed out'))
    }, CAPTURE_TIMEOUT_MS)
    child.on('error', (error) => {
      clearTimeout(timer)
      rejectPromise(new Error(`failed to start powershell: ${error.message}`))
    })
    child.on('close', () => {
      clearTimeout(timer)
      const line = stdout.trim().split(/\r?\n/).pop() || ''
      let result
      try {
        result = JSON.parse(line)
      } catch {
        rejectPromise(new Error(`screenshot script produced no result: ${stderr.trim().slice(0, 2000)}`))
        return
      }
      if (result.ok !== true) {
        rejectPromise(new Error(`screenshot failed: ${result.error || 'unknown error'}`))
        return
      }
      resolvePromise(result)
    })
  })
}

async function sweepStaleTempFiles(root) {
  try {
    await mkdir(root, { recursive: true })
    const entries = await readdir(root, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(SCREENSHOT_TEMP_PREFIX)) continue
      try {
        const info = await stat(join(root, entry.name))
        if (Date.now() - info.mtimeMs > 10 * 60 * 1000) await unlink(join(root, entry.name))
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
  } catch (error) {
    console.warn('[dsh-screenshot] temp sweep failed', error)
  }
}

/** Read the width/height of a PNG from its IHDR chunk (bytes 16-23). */
async function readPngSize(file) {
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(24)
    await handle.read(buffer, 0, 24, 0)
    if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG file')
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  } finally {
    await handle.close()
  }
}

/**
 * Run the PowerShell crop script: clone rectangle (X,Y,W,H) of Source into
 * OutPath. Rejects on spawn/parse/timeout errors.
 */
export function runCrop(source, outPath, x, y, w, h) {
  const script = cropScriptPath()
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-Source',
    source,
    '-OutPath',
    outPath,
    '-X',
    String(x),
    '-Y',
    String(y),
    '-W',
    String(w),
    '-H',
    String(h),
  ]
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('powershell.exe', args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      if (stdout.length < 64 * 1024) stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 64 * 1024) stderr += chunk
    })
    const timer = setTimeout(() => {
      child.kill()
      rejectPromise(new Error('screenshot crop timed out'))
    }, CAPTURE_TIMEOUT_MS)
    child.on('error', (error) => {
      clearTimeout(timer)
      rejectPromise(new Error(`failed to start powershell: ${error.message}`))
    })
    child.on('close', () => {
      clearTimeout(timer)
      const line = stdout.trim().split(/\r?\n/).pop() || ''
      let result
      try {
        result = JSON.parse(line)
      } catch {
        rejectPromise(new Error(`crop script produced no result: ${stderr.trim().slice(0, 2000)}`))
        return
      }
      if (result.ok !== true) {
        rejectPromise(new Error(`crop failed: ${result.error || 'unknown error'}`))
        return
      }
      resolvePromise(result)
    })
  })
}

async function handleCapture(req, res) {
  const body = await readJsonBody(req)
  const hideWindow = body.hideWindow === true
  const allScreens = body.allScreens === true
  const root = resolveUploadRoot()
  await mkdir(root, { recursive: true })
  const id = randomUUID()
  const outPath = join(root, `${SCREENSHOT_TEMP_PREFIX}${id}.png`)
  try {
    const shot = await runCapture(outPath, { hideWindow, allScreens })
    sendJson(res, 200, {
      ok: true,
      id,
      width: Number(shot.width),
      height: Number(shot.height),
      url: `/api/screenshot/preview?id=${id}`,
    })
  } catch (error) {
    try {
      await unlink(outPath)
    } catch {}
    sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

async function handlePreview(req, res, id) {
  if (!ID_RE.test(id)) return sendJson(res, 400, { ok: false, error: 'invalid id' })
  const root = resolveUploadRoot()
  const file = join(root, `${SCREENSHOT_TEMP_PREFIX}${id}.png`)
  let info
  try {
    info = await stat(file)
  } catch {
    return sendJson(res, 404, { ok: false, error: 'not found' })
  }
  if (!info.isFile()) return sendJson(res, 400, { ok: false, error: 'not a file' })
  res.writeHead(200, {
    'content-type': 'image/png',
    'content-length': info.size,
    'cache-control': 'no-store',
  })
  createReadStream(file).pipe(res)
}

async function handleDelete(req, res, id) {
  if (!ID_RE.test(id)) return sendJson(res, 400, { ok: false, error: 'invalid id' })
  const root = resolveUploadRoot()
  const file = join(root, `${SCREENSHOT_TEMP_PREFIX}${id}.png`)
  try {
    await unlink(file)
    sendJson(res, 200, { ok: true, deleted: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return sendJson(res, 200, { ok: true, deleted: false })
    sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

async function handleCrop(req, res) {
  const body = await readJsonBody(req)
  const id = typeof body.id === 'string' ? body.id : ''
  if (!ID_RE.test(id)) return sendJson(res, 400, { ok: false, error: 'invalid id' })
  const rect = body.rect
  const stage = body.stage
  const okRect =
    rect !== null && typeof rect === 'object' &&
    isFiniteNumber(rect.x) && isFiniteNumber(rect.y) && isFiniteNumber(rect.w) && isFiniteNumber(rect.h)
  const okStage =
    stage !== null && typeof stage === 'object' && isFiniteNumber(stage.w) && isFiniteNumber(stage.h) &&
    stage.w > 0 && stage.h > 0
  if (!okRect || !okStage) return sendJson(res, 400, { ok: false, error: 'invalid rectangle or stage' })

  const root = resolveUploadRoot()
  const source = join(root, `${SCREENSHOT_TEMP_PREFIX}${id}.png`)
  let info
  try {
    info = await stat(source)
  } catch {
    return sendJson(res, 404, { ok: false, error: 'capture not found' })
  }
  if (!info.isFile()) return sendJson(res, 400, { ok: false, error: 'not a file' })

  try {
    // Convert display-space selection to physical pixels via the real PNG size.
    const { width: pngW, height: pngH } = await readPngSize(source)
    const ratioX = pngW / stage.w
    const ratioY = pngH / stage.h
    const sx = clamp(0, pngW, Math.round(rect.x * ratioX))
    const sy = clamp(0, pngH, Math.round(rect.y * ratioY))
    const sw = clamp(1, pngW - sx, Math.round(rect.w * ratioX))
    const sh = clamp(1, pngH - sy, Math.round(rect.h * ratioY))
    if (sw <= 1 && sh <= 1) return sendJson(res, 400, { ok: false, error: '空选区，请重新框选后再试' })

    const name = stampName()
    const outPath = join(root, name)
    await runCrop(source, outPath, sx, sy, sw, sh)
    await unlink(source).catch(() => {})
    const outInfo = await stat(outPath)
    sendJson(res, 200, {
      ok: true,
      file: { name, path: outPath, size: outInfo.size },
    })
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

export async function apply(ctx) {
  ctx.effect(() => {
    void sweepStaleTempFiles(resolveUploadRoot())
  }, 'dsh-screenshot: stale temp sweep')

  ctx.inject(['webServer'], (sctx) => {
    const disposeRoute = sctx.webServer.register({
      kind: 'prefix',
      path: '/api/screenshot',
      handler: async (req, res) => {
        if (!isTrustedScreenshotRequest(req)) return sendJson(res, 403, { ok: false, error: 'forbidden origin' })
        try {
          const url = new URL(req.url || '/', 'http://dsh.internal')
          const pathname = url.pathname
          if (req.method === 'POST' && pathname === '/api/screenshot/capture') return await handleCapture(req, res)
          if (req.method === 'POST' && pathname === '/api/screenshot/crop') return await handleCrop(req, res)
          if (req.method === 'GET' && pathname === '/api/screenshot/preview') return await handlePreview(req, res, url.searchParams.get('id') || '')
          if (req.method === 'DELETE' && pathname === '/api/screenshot/preview') return await handleDelete(req, res, url.searchParams.get('id') || '')
          return methodNotAllowed(res, ['POST', 'GET', 'DELETE'])
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    })
    sctx.effect(() => disposeRoute, 'dsh-screenshot: route')
  })
}