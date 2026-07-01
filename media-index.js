/**
 * Media index — map timestamps to byte offsets via ffprobe keyframe packets.
 * Built incrementally from downloaded file ranges (MKV/MP4).
 */

import { spawn } from 'child_process'
import ffmpegStatic from 'ffmpeg-static'
import path from 'path'

const indexes = new Map()

function indexKey (infoHash, fileIndex) {
  return `${infoHash}:${fileIndex}`
}

function ffprobeBin () {
  if (process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH
  if (ffmpegStatic) {
    const dir = path.dirname(ffmpegStatic)
    const base = path.basename(ffmpegStatic).replace(/^ffmpeg/i, 'ffprobe')
    return path.join(dir, base)
  }
  return 'ffprobe'
}

export class MediaIndex {
  constructor (fileLength, durationSec) {
    this.fileLength = fileLength
    this.durationSec = durationSec
    /** @type {{ time: number, byte: number }[]} */
    this.keyframes = []
    this.maxIndexedByte = 0
    this.building = false
  }

  byteAtTime (timeSec) {
    if (!this.keyframes.length) {
      return linearByte(this.fileLength, this.durationSec, timeSec)
    }
    const kf = this.keyframeAtOrBefore(timeSec)
    if (kf) return kf.byte
    return linearByte(this.fileLength, this.durationSec, timeSec)
  }

  keyframeAtOrBefore (timeSec) {
    if (!this.keyframes.length) return null
    let lo = 0
    let hi = this.keyframes.length - 1
    let best = null
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const k = this.keyframes[mid]
      if (k.time <= timeSec) {
        best = k
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    return best
  }

  /** Byte offset to start reading (at or slightly before target) */
  seekByte (timeSec) {
    const kf = this.keyframeAtOrBefore(timeSec)
    if (kf) return { byteOff: kf.byte, startTime: kf.time }
    const rewindSec = Math.min(timeSec, 3)
    const byteOff = Math.max(0, linearByte(this.fileLength, this.durationSec, timeSec - rewindSec))
    return { byteOff, startTime: timeSec - rewindSec }
  }

  addKeyframes (packets) {
    for (const p of packets) {
      if (p.time == null || p.byte == null) continue
      if (p.time < 0 || p.byte < 0 || p.byte >= this.fileLength) continue
      const last = this.keyframes[this.keyframes.length - 1]
      if (last && last.byte === p.byte) continue
      this.keyframes.push({ time: p.time, byte: p.byte })
      this.maxIndexedByte = Math.max(this.maxIndexedByte, p.byte)
    }
    this.keyframes.sort((a, b) => a.time - b.time)
  }
}

function linearByte (fileLength, durationSec, timeSec) {
  if (durationSec && durationSec > 0) {
    return Math.min(fileLength - 1, Math.max(0, Math.floor((timeSec / durationSec) * fileLength)))
  }
  return Math.min(fileLength - 1, Math.max(0, Math.floor(timeSec * 750 * 1024)))
}

export function getMediaIndex (infoHash, fileIndex) {
  return indexes.get(indexKey(infoHash, fileIndex)) || null
}

export function ensureMediaIndex (infoHash, fileIndex, fileLength, durationSec) {
  const key = indexKey(infoHash, fileIndex)
  let idx = indexes.get(key)
  if (!idx) {
    idx = new MediaIndex(fileLength, durationSec)
    indexes.set(key, idx)
  } else if (durationSec && durationSec > 0) {
    idx.durationSec = durationSec
  }
  return idx
}

function probePackets (readStream, maxBytes) {
  return new Promise((resolve) => {
    const packets = []
    const bin = ffprobeBin()
    const args = [
      '-v', 'quiet',
      '-show_entries', 'packet=pts_time,pos,flags',
      '-select_streams', 'v:0',
      '-of', 'json',
      'pipe:0',
    ]
    let proc
    try {
      proc = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch {
      resolve([])
      return
    }

    let stdout = ''
    proc.stdout.on('data', d => { stdout += d })
    proc.on('error', () => resolve([]))
    proc.on('close', () => {
      try {
        const data = JSON.parse(stdout || '{}')
        for (const pkt of data.packets || []) {
          const flags = pkt.flags || ''
          const isKey = flags.includes('K')
          if (!isKey && packets.length > 0) continue
          const time = parseFloat(pkt.pts_time)
          const byte = parseInt(pkt.pos, 10)
          if (Number.isFinite(time) && Number.isFinite(byte)) {
            packets.push({ time, byte, key: isKey })
          }
        }
      } catch {}
      resolve(packets)
    })

    readStream.on('error', () => {
      try { proc.stdin.end() } catch {}
    })
    readStream.pipe(proc.stdin)
    readStream.on('end', () => {
      try { proc.stdin.end() } catch {}
    })

    setTimeout(() => {
      try { proc.kill('SIGKILL') } catch {}
      resolve(packets)
    }, 15000)
  })
}

/** Build / extend keyframe index from downloaded prefix */
export async function buildMediaIndex (torrent, file, durationSec, fileIndex = 0) {
  const idx = ensureMediaIndex(torrent.infoHash, fileIndex, file.length, durationSec)
  if (idx.building) return idx
  idx.building = true

  try {
    const pl = torrent.pieceLength
    const startPiece = file._startPiece ?? Math.floor(file.offset / pl)
    let endPiece = startPiece
    for (let p = startPiece; p <= (file._endPiece ?? startPiece + 200); p++) {
      if (!torrent.bitfield?.get(p)) break
      endPiece = p
    }
    const endByte = Math.min(file.length - 1, (endPiece + 1) * pl - file.offset)
    if (endByte <= idx.maxIndexedByte + pl) return idx

    const probeEnd = Math.min(endByte, Math.max(8 * 1024 * 1024, idx.maxIndexedByte + 16 * 1024 * 1024))
    const stream = file.createReadStream({ start: 0, end: probeEnd })
    stream.on('error', () => {})
    const packets = await probePackets(stream, probeEnd)
    stream.destroy?.()
    idx.addKeyframes(packets.filter(p => p.key !== false))
    if (idx.keyframes.length) {
      console.log(`[index] ${file.name} ${idx.keyframes.length} keyframes, max byte ${idx.maxIndexedByte}`)
    }
  } catch (err) {
    console.warn('[index] build:', err.message)
  } finally {
    idx.building = false
  }
  return idx
}

export function deleteMediaIndex (infoHash) {
  for (const key of [...indexes.keys()]) {
    if (key.startsWith(infoHash)) indexes.delete(key)
  }
}
