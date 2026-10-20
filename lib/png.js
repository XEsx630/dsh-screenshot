// dsh-screenshot — PNG header reader.
//
// The host never decodes image pixels; it only needs the authoritative pixel
// size from the IHDR chunk so display-space selections can be converted to
// physical pixels before PowerShell crops.

import { open } from 'node:fs/promises'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * @param {Buffer} buffer at least the first 24 bytes of a PNG
 * @returns {{width: number, height: number}}
 */
export function pngSizeFromBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) throw new Error('不是有效的 PNG 文件')
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('不是有效的 PNG 文件')
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  if (width <= 0 || height <= 0) throw new Error('PNG 尺寸无效')
  return { width, height }
}

/**
 * @param {string} file absolute path
 * @returns {Promise<{width: number, height: number}>}
 */
export async function readPngSize(file) {
  const handle = await open(file, 'r')
  try {
    const head = Buffer.alloc(24)
    const { bytesRead } = await handle.read(head, 0, 24, 0)
    if (bytesRead < 24) throw new Error('不是有效的 PNG 文件')
    return pngSizeFromBuffer(head)
  } finally {
    await handle.close()
  }
}
