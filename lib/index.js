// dsh-screenshot — host half.
//
// A capture spawns Windows PowerShell to grab the screen (optionally hiding
// the foreground DSH window first) into a short-lived PNG. The browser shows
// that preview, the user drags a rectangle, and the host converts the
// display-space selection into physical pixels using the PNG's real IHDR size
// before cropping with PowerShell — the browser never decodes or re-encodes
// image data.
//
// The cropped file is handed to the browser as a Blob and attached through
// DSH's own draft-attachment service (see lib/client.js), so nothing here
// writes into the uploads directory or serializes a path into the prompt.
//
// Registry-ready cordis plugin: exports { name, apply, inject }.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readdir, readFile, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isShotId, stampName, toPhysicalRect } from './geometry.js'
import { readPngSize } from './png.js'

export const name = 'dsh-screenshot'
export const inject = ['webServer']

export const ROUTE_PREFIX = '/api/screenshot'

const CAPTURE_TIMEOUT_MS = 20_000
const CROP_TIMEOUT_MS = 20_000
const RESTORE_TIMEOUT_MS = 10_000
const TEMP_TTL_MS = 30 * 60 * 1000
const SWEEP_INTERVAL_MS = 10 * 60 * 1000
const MAX_BODY_BYTES = 16 * 1024

const CAPTURE_FILE = /^\.cap-[0-9a-f-]{36}\.png$/
const SHOT_FILE = /^shot-[0-9a-f-]{36}\.png$/

/** Absolute path of the PowerShell capture script shipped with this package. */
export function captureScriptPath() {
  return fileURLToPath(new URL('./screenshot.ps1', import.meta.url))
}

/** Absolute path of the PowerShell crop script shipped with this package. */
export function cropScriptPath() {
  return fileURLToPath(new URL('./crop.ps1', import.meta.url))
}

/** Absolute path of the PowerShell crash-recovery script shipped with this package. */
export function restoreScriptPath() {
  return fileURLToPath(new URL('./restore.ps1', import.meta.url))
}

/**
 * Directory holding short-lived captures. Kept out of `uploads/` on purpose:
 * these files are transport between the host and the browser, not user
 * attachments.
 *
 * @param {Record<string, string | undefined>} [env]
 */
export function resolveShotDir(env = process.env) {
  const explicit = env.DSH_SCREENSHOT_DIR?.trim()
  if (explicit) return resolve(explicit)
  const dshHome = env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return resolve(join(dshHome, 'cache', 'dsh-screenshot'))
}

function capturePath(dir, id) {
  return join(dir, `.cap-${id}.png`)
}

function shotPath(dir, id) {
  return join(dir, `shot-${id}.png`)
}

function markerPath(pngPath) {
  return `${pngPath}.hwnd`
}

function header(headers, key) {
  const value = headers?.[key]
  return typeof value === 'string' ? value : undefined
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true
  const parts = hostname.split('.')
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

/**
 * Local-only trust fence: loopback Host, no cross-site navigation, and a
 * same-origin Origin when the browser sends one.
 *
 * @param {{headers?: Record<string, string | string[] | undefined>}} req
 */
export function isTrustedScreenshotRequest(req) {
  const host = header(req.headers, 'host')
  if (host === undefined) return false
  let parsed
  try {
    parsed = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(parsed.hostname)) return false
  // Reject userinfo, paths and fragments smuggled into the Host header: a
  // browser always sends the bare authority it connected to.
  if (parsed.host !== host.toLowerCase()) return false
  if (header(req.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(req.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === parsed.host
  } catch {
    return false
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
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

async function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new HttpError(413, '请求体过大')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, '请求体必须是 JSON 对象')
  }
  return value
}

/**
 * Run one PowerShell script and resolve with the JSON object it prints last.
 *
 * @param {string} script absolute script path
 * @param {string[]} args forwarded after `-File`
 * @param {number} timeoutMs
 * @returns {Promise<Record<string, unknown>>}
 */
function runPowerShell(script, args, timeoutMs) {
  const command = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    ...args,
  ]
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('powershell.exe', command, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }

    const timer = setTimeout(() => {
      child.kill()
      finish(rejectPromise, new Error('PowerShell 超时，已强制结束'))
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      if (stdout.length < 64 * 1024) stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 64 * 1024) stderr += chunk
    })
    child.on('error', (error) => {
      finish(rejectPromise, new Error(`无法启动 PowerShell：${error.message}`))
    })
    child.on('close', () => {
      const line = stdout.trim().split(/\r?\n/).pop() || ''
      let result
      try {
        result = JSON.parse(line)
      } catch {
        finish(
          rejectPromise,
          new Error(`PowerShell 没有返回结果：${(stderr.trim() || stdout.trim()).slice(0, 500) || '无输出'}`),
        )
        return
      }
      if (result.ok !== true) {
        finish(rejectPromise, new Error(result.error || 'PowerShell 执行失败'))
        return
      }
      finish(resolvePromise, result)
    })
  })
}

/**
 * A hidden window is restored by screenshot.ps1 on every normal exit path.
 * If that process is killed (host timeout, crash), the marker it wrote before
 * hiding survives; this re-shows the window from the outside.
 *
 * @param {string} pngPath capture path whose `.hwnd` marker should be cleared
 */
async function restoreIfNeeded(pngPath) {
  const marker = markerPath(pngPath)
  let text
  try {
    text = await readFile(marker, 'utf8')
  } catch {
    return
  }
  const hwnd = Number.parseInt(text.trim(), 10)
  try {
    if (Number.isFinite(hwnd) && hwnd > 0) {
      await runPowerShell(restoreScriptPath(), ['-Hwnd', String(hwnd)], RESTORE_TIMEOUT_MS)
    }
  } catch (error) {
    console.warn('[dsh-screenshot] restore failed', error)
  } finally {
    await unlink(marker).catch(() => {})
  }
}

/**
 * Delete stale transport files and recover any window left hidden by a
 * previous crash.
 *
 * @param {string} dir
 */
async function sweepShots(dir) {
  try {
    await mkdir(dir, { recursive: true })
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const file = join(dir, entry.name)
      if (entry.name.endsWith('.hwnd')) {
        await restoreIfNeeded(file.slice(0, -'.hwnd'.length))
        continue
      }
      if (!CAPTURE_FILE.test(entry.name) && !SHOT_FILE.test(entry.name)) continue
      try {
        const info = await stat(file)
        if (Date.now() - info.mtimeMs > TEMP_TTL_MS) await unlink(file)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
  } catch (error) {
    console.warn('[dsh-screenshot] 清理临时文件失败', error)
  }
}

let lastSweep = 0

function maybeSweep(dir) {
  if (Date.now() - lastSweep < SWEEP_INTERVAL_MS) return
  lastSweep = Date.now()
  void sweepShots(dir)
}

async function handleCapture(req, res) {
  const body = await readJsonBody(req)
  const hideWindow = body.hideWindow === true
  const allScreens = body.allScreens === true
  const dir = resolveShotDir()
  await mkdir(dir, { recursive: true })
  maybeSweep(dir)

  const id = randomUUID()
  const file = capturePath(dir, id)
  try {
    await runPowerShell(
      captureScriptPath(),
      [
        '-OutPath',
        file,
        '-HideWindow',
        hideWindow ? '1' : '0',
        '-AllScreens',
        allScreens ? '1' : '0',
      ],
      CAPTURE_TIMEOUT_MS,
    )
    const image = await readPngSize(file)
    sendJson(res, 200, {
      ok: true,
      id,
      width: image.width,
      height: image.height,
      url: `${ROUTE_PREFIX}/preview?id=${id}`,
    })
  } catch (error) {
    await restoreIfNeeded(file)
    await unlink(file).catch(() => {})
    throw error
  }
}

async function handlePreview(req, res, id) {
  const file = capturePath(resolveShotDir(), id)
  await pipePng(res, file)
}

async function handleFile(req, res, id) {
  const file = shotPath(resolveShotDir(), id)
  await pipePng(res, file)
}

async function pipePng(res, file) {
  let info
  try {
    info = await stat(file)
  } catch {
    throw new HttpError(404, '截图不存在或已过期')
  }
  if (!info.isFile()) throw new HttpError(404, '截图不存在或已过期')
  res.writeHead(200, {
    'content-type': 'image/png',
    'content-length': info.size,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(file)
    stream.on('error', rejectPromise)
    stream.on('end', resolvePromise)
    res.on('close', resolvePromise)
    stream.pipe(res)
  })
}

async function handleDelete(req, res, id, kind) {
  const dir = resolveShotDir()
  const file = kind === 'file' ? shotPath(dir, id) : capturePath(dir, id)
  try {
    await unlink(file)
    sendJson(res, 200, { ok: true, deleted: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return sendJson(res, 200, { ok: true, deleted: false })
    throw error
  }
}

async function handleCrop(req, res) {
  const body = await readJsonBody(req)
  const id = typeof body.id === 'string' ? body.id : ''
  if (!isShotId(id)) throw new HttpError(400, '截图编号无效')

  const { rect, stage } = body
  const validRect =
    rect !== null &&
    typeof rect === 'object' &&
    [rect.x, rect.y, rect.w, rect.h].every((value) => typeof value === 'number' && Number.isFinite(value))
  const validStage =
    stage !== null &&
    typeof stage === 'object' &&
    Number.isFinite(stage.w) &&
    Number.isFinite(stage.h) &&
    stage.w > 0 &&
    stage.h > 0
  if (!validRect || !validStage) throw new HttpError(400, '选区或画布尺寸无效')

  const dir = resolveShotDir()
  const source = capturePath(dir, id)
  try {
    await stat(source)
  } catch {
    throw new HttpError(404, '截图已过期，请重新截图')
  }

  const image = await readPngSize(source)
  const target = toPhysicalRect(rect, stage, image)
  if (target === null) throw new HttpError(400, '选区太小，请重新框选')

  const outId = randomUUID()
  const outPath = shotPath(dir, outId)
  try {
    await runPowerShell(
      cropScriptPath(),
      [
        '-Source',
        source,
        '-OutPath',
        outPath,
        '-X',
        String(target.x),
        '-Y',
        String(target.y),
        '-W',
        String(target.w),
        '-H',
        String(target.h),
      ],
      CROP_TIMEOUT_MS,
    )
    const outInfo = await stat(outPath)
    await unlink(source).catch(() => {})
    sendJson(res, 200, {
      ok: true,
      id: outId,
      name: stampName(),
      bytes: outInfo.size,
      width: target.w,
      height: target.h,
      url: `${ROUTE_PREFIX}/file?id=${outId}`,
    })
  } catch (error) {
    await unlink(outPath).catch(() => {})
    throw error
  }
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function handleRequest(req, res) {
  if (!isTrustedScreenshotRequest(req)) {
    return sendJson(res, 403, { ok: false, error: '仅允许本机同源请求' })
  }

  let url
  try {
    url = new URL(req.url || '/', 'http://dsh.invalid')
  } catch {
    return sendJson(res, 400, { ok: false, error: '无效的请求地址' })
  }

  const { pathname } = url
  const id = url.searchParams.get('id') || ''
  const method = req.method || 'GET'

  try {
    if (pathname === `${ROUTE_PREFIX}/capture`) {
      if (method !== 'POST') return methodNotAllowed(res, ['POST'])
      return await handleCapture(req, res)
    }
    if (pathname === `${ROUTE_PREFIX}/crop`) {
      if (method !== 'POST') return methodNotAllowed(res, ['POST'])
      return await handleCrop(req, res)
    }
    if (pathname === `${ROUTE_PREFIX}/preview`) {
      if (!isShotId(id)) return sendJson(res, 400, { ok: false, error: '截图编号无效' })
      if (method === 'GET') return await handlePreview(req, res, id)
      if (method === 'DELETE') return await handleDelete(req, res, id, 'preview')
      return methodNotAllowed(res, ['GET', 'DELETE'])
    }
    if (pathname === `${ROUTE_PREFIX}/file`) {
      if (!isShotId(id)) return sendJson(res, 400, { ok: false, error: '截图编号无效' })
      if (method === 'GET') return await handleFile(req, res, id)
      if (method === 'DELETE') return await handleDelete(req, res, id, 'file')
      return methodNotAllowed(res, ['GET', 'DELETE'])
    }
    return sendJson(res, 404, { ok: false, error: '未知接口' })
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500
    const message = error instanceof Error ? error.message : String(error)
    if (!(error instanceof HttpError)) console.warn('[dsh-screenshot] 请求失败', error)
    if (res.headersSent) {
      res.destroy()
      return
    }
    return sendJson(res, status, { ok: false, error: message })
  }
}

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx) {
  const dir = resolveShotDir()
  ctx.effect(() => {
    void sweepShots(dir)
  }, 'dsh-screenshot: 启动清理')

  ctx.inject(['webServer'], (sctx) => {
    const dispose = sctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: handleRequest,
    })
    sctx.effect(() => dispose, 'dsh-screenshot: 路由')
  })
}
