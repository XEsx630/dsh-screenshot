// dsh-screenshot — pure geometry helpers shared by the host half.
//
// Everything in this module is side-effect free so it can be unit-tested
// without PowerShell, a browser, or the harness.

/** Canonical UUID (any version); the host only ever mints v4 ids. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** @param {unknown} value candidate id */
export function isShotId(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

/** @param {number} min @param {number} max @param {number} value */
export function clamp(min, max, value) {
  return Math.max(min, Math.min(max, value))
}

/**
 * Convert a browser display-space selection into physical pixels of the
 * captured PNG.
 *
 * The client renders the screenshot scaled to fit the viewport and reports the
 * rectangle in that rendered space plus the rendered stage size. The PNG's
 * real dimensions are authoritative, so the ratio absorbs device pixel ratio,
 * browser zoom and the fit-to-viewport scale in one step — no canvas needed.
 *
 * @param {{x: number, y: number, w: number, h: number}} rect display-space selection
 * @param {{w: number, h: number}} stage rendered image size in CSS pixels
 * @param {{width: number, height: number}} image PNG pixel size
 * @returns {{x: number, y: number, w: number, h: number} | null} clamped integer rect, or null when degenerate
 */
export function toPhysicalRect(rect, stage, image) {
  if (!Number.isFinite(stage?.w) || !Number.isFinite(stage?.h) || stage.w <= 0 || stage.h <= 0) return null
  if (!Number.isFinite(image?.width) || !Number.isFinite(image?.height) || image.width <= 0 || image.height <= 0) return null
  if (![rect?.x, rect?.y, rect?.w, rect?.h].every(Number.isFinite)) return null
  if (rect.w < 1 || rect.h < 1) return null

  const ratioX = image.width / stage.w
  const ratioY = image.height / stage.h

  // Clamp the origin one pixel inside the image so a selection that starts on
  // the right/bottom edge still yields a valid (1px) crop instead of a rect
  // that PowerShell rejects.
  const x = clamp(0, image.width - 1, Math.round(rect.x * ratioX))
  const y = clamp(0, image.height - 1, Math.round(rect.y * ratioY))
  const w = clamp(1, image.width - x, Math.round(rect.w * ratioX))
  const h = clamp(1, image.height - y, Math.round(rect.h * ratioY))

  return { x, y, w, h }
}

/**
 * Display name for a cropped shot: `screenshot-20261020-121500.png`.
 * Names are cosmetic (the attachment card uses them); uniqueness comes from
 * the id, not from this stamp.
 *
 * @param {Date} [now] clock injected for tests
 */
export function stampName(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `screenshot-${date}-${time}.png`
}
