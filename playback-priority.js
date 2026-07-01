/**
 * Playback piece prioritization — Stremio-style dynamic priority shift on seek.
 */

const sessions = new Map()

function sessionKey (infoHash, fileIndex) {
  return `${infoHash}:${fileIndex}`
}

export function getPlaybackSession (infoHash, fileIndex) {
  return sessions.get(sessionKey(infoHash, fileIndex)) || null
}

export function clearPlaybackSession (infoHash, fileIndex) {
  sessions.delete(sessionKey(infoHash, fileIndex))
}

/**
 * Drop old playback window and prioritize pieces at new byte position.
 * For mid-file seeks, also prioritizes MKV/MP4 header pieces at file start.
 */
export function shiftPlaybackPriority (torrent, file, byteOffset, opts = {}) {
  const fileIndex = opts.fileIndex ?? 0
  const key = sessionKey(torrent.infoHash, fileIndex)
  const prev = sessions.get(key)
  const pl = torrent.pieceLength
  const abs = file.offset + byteOffset
  const startPiece = Math.floor(abs / pl)
  const bufferBytes = opts.bufferBytes ?? 32 * 1024 * 1024
  const endByte = Math.min(file.offset + file.length - 1, abs + bufferBytes)
  const endPiece = Math.min(
    file._endPiece ?? Math.floor((file.offset + file.length - 1) / pl),
    Math.floor(endByte / pl),
  )

  if (prev) {
    try { torrent._deselect(prev.startPiece, prev.endPiece, true) } catch {}
    try { torrent._deselect(prev.startPiece, prev.endPiece, false) } catch {}
    if (prev.headerStartPiece != null) {
      try { torrent._deselect(prev.headerStartPiece, prev.headerEndPiece, true) } catch {}
    }
    if (prev.footerStartPiece != null) {
      try { torrent._deselect(prev.footerStartPiece, prev.footerEndPiece, true) } catch {}
    }
  }

  let headerStartPiece = null
  let headerEndPiece = null
  const fileStart = file._startPiece ?? Math.floor(file.offset / pl)

  // MKV/MP4 demux needs container header from file start when ffmpeg seeks via HTTP
  if (byteOffset > 512 * 1024) {
    const headerCount = Math.min(20, Math.ceil((8 * 1024 * 1024) / pl))
    headerStartPiece = fileStart
    headerEndPiece = Math.min(file._endPiece ?? fileStart + headerCount, fileStart + headerCount)
    torrent.critical(headerStartPiece, Math.min(headerStartPiece + 8, headerEndPiece))
    torrent._select(headerStartPiece, headerEndPiece, 2, null, true)
  }

  let footerStartPiece = null
  let footerEndPiece = null
  const fileEnd = file._endPiece ?? Math.floor((file.offset + file.length - 1) / pl)

  // MKV demux needs cues/index from the end of the file when seeking
  if (byteOffset > 512 * 1024 && file.name.toLowerCase().endsWith('.mkv')) {
    const footerCount = Math.min(20, Math.ceil((8 * 1024 * 1024) / pl))
    footerStartPiece = Math.max(fileStart, fileEnd - footerCount)
    footerEndPiece = fileEnd
    
    // FFmpeg reads MKV footers backwards. The absolute last piece is the most critical!
    torrent.critical(footerEndPiece, footerEndPiece)
    torrent._select(footerEndPiece, footerEndPiece, 2, null, true)
    
    torrent.critical(footerStartPiece, Math.max(footerStartPiece, footerEndPiece - 1))
    torrent._select(footerStartPiece, Math.max(footerStartPiece, footerEndPiece - 1), 2, null, true)
  }

  torrent.critical(startPiece, Math.min(startPiece + 16, endPiece))
  torrent._select(startPiece, endPiece, 2, null, true)

  const session = {
    startPiece,
    endPiece,
    byteOffset,
    headerStartPiece,
    headerEndPiece,
    footerStartPiece,
    footerEndPiece,
    targetPiece: startPiece,
    updatedAt: Date.now(),
  }
  sessions.set(key, session)
  return session
}

export function contiguousReadyPieces (torrent, startPiece, endPiece) {
  if (!torrent.bitfield) return 0
  let n = 0
  for (let p = startPiece; p <= endPiece && p < torrent.pieces.length; p++) {
    if (!torrent.bitfield.get(p)) break
    n++
  }
  return n
}

export function countReadyPieces (torrent, startPiece, endPiece) {
  if (!torrent.bitfield) return 0
  let n = 0
  for (let p = startPiece; p <= endPiece && p < torrent.pieces.length; p++) {
    if (torrent.bitfield.get(p)) n++
  }
  return n
}

export async function waitForPlaybackBuffer (torrent, startPiece, endPiece, minPieces = 2, timeoutMs = 5000) {
  if (contiguousReadyPieces(torrent, startPiece, endPiece) >= minPieces) return true
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      torrent.removeListener('verified', onVerified)
      clearInterval(timer)
      resolve(contiguousReadyPieces(torrent, startPiece, endPiece) >= minPieces)
    }
    const check = () => {
      if (contiguousReadyPieces(torrent, startPiece, endPiece) >= minPieces) finish()
      else if (Date.now() >= deadline) finish()
    }
    const onVerified = () => check()
    const timer = setInterval(check, 60)
    torrent.on('verified', onVerified)
    check()
  })
}

/** Wait for seek target + container header pieces before ffmpeg HTTP seek */
export async function waitForSeekPlayback (torrent, session, timeoutMs = 5000) {
  const jobs = [
    waitForPlaybackBuffer(
      torrent, session.startPiece, Math.min(session.startPiece + 8, session.endPiece), 2, timeoutMs,
    ),
  ]
  if (session.headerStartPiece != null) {
    jobs.push(waitForPlaybackBuffer(
      torrent, session.headerStartPiece, Math.min(session.headerStartPiece + 4, session.headerEndPiece), 1, Math.min(timeoutMs, 3000),
    ))
  }
  if (session.footerStartPiece != null) {
    jobs.push(waitForPlaybackBuffer(
      torrent, session.footerEndPiece, session.footerEndPiece, 1, Math.min(timeoutMs, 3500),
    ))
  }
  const results = await Promise.all(jobs)
  return results.every(Boolean)
}
