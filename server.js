/**
 * StreamVault — Local WebTorrent Streaming Server
 * http://localhost:9091
 */

import express from 'express'
import cors from 'cors'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
import { execFile } from 'child_process'
import ffmpegFluent from 'fluent-ffmpeg'
import ffmpegStatic from 'ffmpeg-static'
import { ensureFlareSolverr } from './flaresolverr-helper.js'

ffmpegFluent.setFfmpegPath(ffmpegStatic)

const { default: WebTorrent } = await import('webtorrent')
import {
  searchCatalog,
  getDefaultCatalogs,
  getMeta,
  searchTorrents,
  buildEpisodeQuery,
  buildMovieQuery,
  groupEpisodesBySeason,
  listEnabledSources,
} from './discover.js'

process.on('uncaughtException', err => {
  console.error('🔥 Uncaught Exception:', err.message, err.stack)
})
process.on('unhandledRejection', (reason, promise) => {
  console.error('🔥 Unhandled Rejection at:', promise, 'reason:', reason)
})
import {
  searchSubtitles,
  fetchSubtitleVtt,
  parseEpisodeFromTitle,
  resolveImdbFromTitle,
} from './subtitles.js'
import {
  torrentAddOpts,
  initStorage,
  storageInfo,
  clearAllTorrents,
  USE_DISK,
  STORE_PATH,
} from './torrent-store.js'
import {
  buildMediaIndex,
  ensureMediaIndex,
  getMediaIndex,
  deleteMediaIndex,
} from './media-index.js'
import {
  shiftPlaybackPriority,
  contiguousReadyPieces,
  countReadyPieces,
  waitForPlaybackBuffer,
  waitForSeekPlayback,
  clearPlaybackSession,
} from './playback-priority.js'

const app = express()
const PORT = 9091
const client = new WebTorrent()
initStorage()

// Our own registry: infoHash -> torrent (EventEmitter)
const registry = new Map()

app.use(cors())
app.use(express.json())

/* ── MIME TYPES ── */
const MIME = {
  mp4: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm',
  avi: 'video/x-msvideo', mov: 'video/quicktime', m4v: 'video/mp4',
  ogv: 'video/ogg', flv: 'video/x-flv',
  mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg',
  aac: 'audio/aac', wav: 'audio/wav', m4a: 'audio/mp4', opus: 'audio/opus',
}
function mimeFor (name) {
  return MIME[name.split('.').pop().toLowerCase()] || 'application/octet-stream'
}

function torrentInfo (torrent) {
  return {
    infoHash: normalizeInfoHash(torrent.infoHash),
    name: torrent.name,
    length: torrent.length,
    files: (torrent.files || []).map((f, i) => ({
      index: i,
      name: f.name,
      path: f.path,
      length: f.length,
      mime: mimeFor(f.name),
    })),
  }
}

/** Extract infoHash from magnet URI */
function infoHashFromMagnet (magnet) {
  const m = magnet.match(/btih:([a-fA-F0-9]{40})/i)
  return m ? m[1].toLowerCase() : null
}

function normalizeInfoHash (infoHash) {
  return infoHash ? String(infoHash).toLowerCase() : infoHash
}

function getTorrent (infoHash) {
  const k = normalizeInfoHash(infoHash)
  return k ? registry.get(k) : null
}

function registerTorrent (torrent) {
  const k = normalizeInfoHash(torrent?.infoHash)
  if (k) registry.set(k, torrent)
}

const durationCache = new Map()

function durationCacheKey (infoHash, fileIndex) {
  return `${infoHash}:${fileIndex}`
}

function cacheDuration (infoHash, fileIndex, durationSec) {
  if (durationSec && durationSec > 0) {
    durationCache.set(durationCacheKey(infoHash, fileIndex), durationSec)
  }
}

function getCachedDuration (infoHash, fileIndex) {
  return durationCache.get(durationCacheKey(infoHash, fileIndex)) || null
}

function timeToByteOffset (file, timeSec, durationSec, infoHash, fileIndex) {
  const idx = infoHash != null ? getMediaIndex(infoHash, fileIndex) : null
  if (idx) return idx.byteAtTime(timeSec)
  if (durationSec && durationSec > 0) {
    return Math.min(file.length - 1, Math.max(0, Math.floor((timeSec / durationSec) * file.length)))
  }
  return Math.min(file.length - 1, Math.max(0, Math.floor(timeSec * 750 * 1024)))
}

function resolveSeekByte (file, timeSec, durationSec, infoHash, fileIndex) {
  const idx = getMediaIndex(infoHash, fileIndex)
  if (idx) return idx.seekByte(timeSec)
  const rewindSec = Math.min(timeSec, 5)
  const byteOff = timeToByteOffset(file, Math.max(0, timeSec - rewindSec), durationSec, infoHash, fileIndex)
  return { byteOff, startTime: Math.max(0, timeSec - rewindSec) }
}

function prioritizeAtTime (torrent, file, fileIndex, timeSec, durationSec) {
  const seek = resolveSeekByte(file, timeSec, durationSec, torrent.infoHash, fileIndex)
  const session = shiftPlaybackPriority(torrent, file, seek.byteOff, { fileIndex })
  const ready = contiguousReadyPieces(torrent, session.startPiece, Math.min(session.startPiece + 8, session.endPiece))
  return {
    startPiece: session.startPiece,
    endPiece: session.endPiece,
    byteOffset: seek.byteOff,
    contentStartSec: timeSec,
    requestedSec: timeSec,
    headerStartPiece: session.headerStartPiece,
    headerEndPiece: session.headerEndPiece,
    piecesReady: ready,
    piecesNeeded: 2,
    session,
  }
}

function internalStreamUrl (infoHash, fileIndex) {
  return `http://127.0.0.1:${PORT}/api/stream/${normalizeInfoHash(infoHash)}/${fileIndex}`
}

function transcodeOutputOptions (startSec, query = {}) {
  const mux = ['-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-avoid_negative_ts', 'make_zero']
  const audioIndex = query.audioIndex != null ? parseInt(query.audioIndex, 10) : null
  const audioMap = audioIndex !== null ? `0:${audioIndex}` : '0:a:0?'

  const videoOpts = [
    '-map', '0:v:0?', '-map', audioMap,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '22', '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p', '-profile:v', 'main', '-level', '4.0',
    '-g', '48', '-keyint_min', '48',
  ]

  const vf = []
  const af = []

  const resolution = query.resolution
  if (resolution && resolution !== 'original') {
    const height = parseInt(resolution, 10)
    if (height > 0) vf.push(`scale=-2:${height}`)
  }

  const speed = parseFloat(query.speed) || 1.0
  if (speed !== 1.0) {
    vf.push(`setpts=PTS/${speed}`)
    if (speed >= 0.5 && speed <= 2.0) {
      af.push(`atempo=${speed}`)
    } else {
      let remaining = speed
      while (remaining > 2.0) {
        af.push('atempo=2.0')
        remaining /= 2.0
      }
      while (remaining < 0.5) {
        af.push('atempo=0.5')
        remaining /= 0.5
      }
      af.push(`atempo=${remaining}`)
    }
  }

  if (vf.length > 0) videoOpts.push('-vf', vf.join(','))
  if (af.length > 0) videoOpts.push('-af', af.join(','))

  if (startSec > 0) {
    return [
      ...videoOpts,
      '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
      '-reset_timestamps', '1',
      ...mux,
    ]
  }
  return [
    ...videoOpts,
    '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
    ...mux,
  ]
}

function prioritizeFileStart (torrent, file, fileIndex) {
  const startPiece = file._startPiece ?? Math.floor(file.offset / torrent.pieceLength)
  const endPiece = Math.min(startPiece + 12, file._endPiece ?? startPiece + 12)
  const session = shiftPlaybackPriority(torrent, file, 0, { fileIndex, bufferBytes: 24 * 1024 * 1024 })
  const ready = contiguousReadyPieces(torrent, session.startPiece, session.endPiece)
  return { startPiece: session.startPiece, endPiece: session.endPiece, byteOffset: 0, piecesReady: ready }
}

/* ── HEALTH CHECK ── */
app.get('/api/ping', (_req, res) => {
  const lan = getLanIp();
  res.json({ ok: true, lanUrl: lan ? `http://${lan}:${PORT}` : `http://localhost:${PORT}` });
});

/* ── DISCOVER (Stremio-style search) ── */
app.get('/api/discover/sources', (_req, res) => {
  res.json({ sources: listEnabledSources() })
})

app.get('/api/discover/catalogs', async (req, res) => {
  try {
    const type = req.query.type || 'all'
    const catalogs = await getDefaultCatalogs(type)
    res.json({ catalogs })
  } catch (err) {
    console.error('[discover] catalogs:', err.message)
    res.status(502).json({ error: err.message })
  }
})

app.get('/api/discover/search', async (req, res) => {
  const q = (req.query.q || '').trim()
  if (!q) return res.status(400).json({ error: 'q required' })
  try {
    const type = req.query.type || 'all'
    const results = await searchCatalog(q, type)
    res.json({ results })
  } catch (err) {
    console.error('[discover] search:', err.message)
    res.status(502).json({ error: err.message })
  }
})

app.get('/api/discover/meta/:type/:id', async (req, res) => {
  try {
    const meta = await getMeta(req.params.type, req.params.id)
    if (meta.type === 'series' && meta.videos) {
      meta.seasons = groupEpisodesBySeason(meta.videos)
    }
    res.json({ meta })
  } catch (err) {
    res.status(err.message === 'Not found' ? 404 : 502).json({ error: err.message })
  }
})

app.get('/api/discover/torrents', async (req, res) => {
  const q = (req.query.q || '').trim()
  if (!q) return res.status(400).json({ error: 'q required' })
  const season = req.query.season ? parseInt(req.query.season, 10) : null
  const episode = req.query.episode ? parseInt(req.query.episode, 10) : null
  try {
    const torrents = await searchTorrents(q, { season, episode })
    res.json({ query: q, torrents })
  } catch (err) {
    console.error('[discover] torrents:', err.message)
    res.status(502).json({ error: err.message })
  }
})

app.post('/api/discover/episode-torrents', async (req, res) => {
  const { showName, season, episode, imdbId } = req.body || {}
  if (!showName || season == null || episode == null) {
    return res.status(400).json({ error: 'showName, season, episode required' })
  }
  try {
    const query = buildEpisodeQuery(showName, season, episode)
    const torrents = await searchTorrents(query, { season, episode, showName, imdbId })
    res.json({ query, torrents })
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

app.post('/api/discover/movie-torrents', async (req, res) => {
  const { title, year, imdbId } = req.body || {}
  if (!title) return res.status(400).json({ error: 'title required' })
  try {
    const query = buildMovieQuery(title, year)
    const torrents = await searchTorrents(query, { imdbId })
    res.json({ query, torrents })
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

/* ── SUBTITLES (Wyzie Subs) ── */
app.get('/api/subtitles/search', async (req, res) => {
  try {
    let imdbId = req.query.imdbId || req.query.imdb
    let season = req.query.season != null ? parseInt(req.query.season, 10) : null
    let episode = req.query.episode != null ? parseInt(req.query.episode, 10) : null
    const languages = (req.query.languages || req.query.language || '')
      .split(',').map(s => s.trim()).filter(Boolean)
    const apiKey = req.query.apiKey || req.headers['x-wyzie-key']

    // Fallback: resolve from torrent/show title
    if (!imdbId && req.query.title) {
      const ep = parseEpisodeFromTitle(req.query.title)
      if (ep) { season = season ?? ep.season; episode = episode ?? ep.episode }
      const resolved = await resolveImdbFromTitle(req.query.title)
      if (resolved) imdbId = resolved.imdbId
    }

    if (!imdbId) return res.status(400).json({ error: 'Could not identify title — use Discover or provide imdbId' })

    const subtitles = await searchSubtitles({ imdbId, season, episode, languages, apiKey })
    res.json({ imdbId, season, episode, subtitles })
  } catch (err) {
    console.error('[subtitles] search:', err.message)
    res.status(err.message.includes('API key') ? 503 : 502).json({ error: err.message })
  }
})

app.post('/api/subtitles/fetch', async (req, res) => {
  const { url, language } = req.body || {}
  if (!url || !url.startsWith('http')) return res.status(400).json({ error: 'url required' })
  try {
    const vtt = await fetchSubtitleVtt(url, language)
    res.type('text/vtt').send(vtt)
  } catch (err) {
    console.error('[subtitles] fetch:', err.message)
    res.status(502).json({ error: err.message })
  }
})

/* ── ADD TORRENT ── */
app.post('/api/add', (req, res) => {
  const { magnet } = req.body
  if (!magnet) return res.status(400).json({ error: 'magnet required' })

  const hash = infoHashFromMagnet(magnet)

  // Already in registry with metadata → return immediately
  if (hash && registry.has(hash)) {
    const t = getTorrent(hash)
    if (t.files && t.files.length > 0) {
      console.log('[server] Cache hit:', t.name)
      return res.json(torrentInfo(t))
    }
    // In registry but still fetching metadata — wait for it
    console.log('[server] Waiting for cached torrent metadata…')
    return waitForMetadata(t, res)
  }

  console.log('[server] Adding:', magnet.slice(0, 80) + '…')

  let torrent
  try {
    torrent = client.add(magnet, torrentAddOpts())
  } catch (err) {
    if (err.message.includes('duplicate') && hash) {
      torrent = client.get(hash)
    }
    if (!torrent) {
      return res.status(400).json({ error: err.message })
    }
  }

  // Register immediately so duplicate requests wait instead of double-adding
  registerTorrent(torrent)

  torrent.once('infoHash', () => {
    registerTorrent(torrent)
  })

  if (torrent.files && torrent.files.length > 0) {
    // Metadata already available (e.g. .torrent file)
    return res.json(torrentInfo(torrent))
  }

  waitForMetadata(torrent, res)
})

/* ── PREBUFFER TORRENT ── */
app.post('/api/prebuffer', (req, res) => {
  const { magnet } = req.body
  if (!magnet) return res.status(400).json({ error: 'magnet required' })

  const hash = infoHashFromMagnet(magnet)
  if (hash && registry.has(hash)) {
    return res.json({ ok: true, cached: true })
  }

  console.log('[server] Prebuffering next torrent in background:', magnet.slice(0, 80) + '…')
  try {
    let torrent
    try {
      torrent = client.add(magnet, torrentAddOpts())
    } catch (err) {
      if (err.message.includes('duplicate') && hash) {
        torrent = client.get(hash)
      }
      if (!torrent) throw err
    }
    registerTorrent(torrent)
    
    torrent.once('infoHash', () => {
      registerTorrent(torrent)
    })
    
    torrent.once('metadata', () => {
      console.log('[server] Prebuffer metadata resolved. Deselecting pieces to save bandwidth:', torrent.name)
      torrent.files.forEach(f => f.deselect())
    })
    
    res.json({ ok: true })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

function waitForMetadata (torrent, res) {
  let done = false
  const finish = (fn) => { if (!done) { done = true; fn() } }

  const timer = setTimeout(() => {
    finish(() => res.status(504).json({
      error: 'Timeout: no peers responded after 60 s. Try a more popular torrent or check your connection.',
    }))
  }, 60000)

  torrent.once('metadata', () => {
    clearTimeout(timer)
    console.log('[server] Metadata:', torrent.name, '—', torrent.files.length, 'files')
    finish(() => res.json(torrentInfo(torrent)))
  })

  torrent.once('error', (err) => {
    if (err.message.includes('duplicate')) {
      console.log('[server] Ignored duplicate error event on torrent:', err.message)
      return
    }
    clearTimeout(timer)
    console.error('[server] Error:', err.message)
    finish(() => res.status(500).json({ error: err.message }))
  })
}

/* ── STREAM FILE ── */
app.get('/api/stream/:infoHash/:fileIndex', (req, res) => {
  const infoHash = normalizeInfoHash(req.params.infoHash)
  const torrent = getTorrent(infoHash)
  if (!torrent) {
    console.warn('[stream] 404 — torrent not in registry:', infoHash)
    return res.status(404).json({ error: 'Torrent not found — call /api/add first' })
  }

  const file = torrent.files[parseInt(req.params.fileIndex, 10)]
  if (!file) return res.status(404).json({ error: 'File index out of range' })

  const fileLen = file.length
  const range = req.headers.range

  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Content-Type', mimeFor(file.name))
  res.setHeader('Cache-Control', 'no-cache')

  if (range) {
    const [s, e] = range.replace(/bytes=/, '').split('-')
    const start = parseInt(s, 10)
    const end = e ? parseInt(e, 10) : fileLen - 1
    const isInternal = req.headers['user-agent']?.includes('StreamVault-Internal') || req.headers['user-agent']?.includes('Lavf')
    if (start > 0 && !isInternal) {
      shiftPlaybackPriority(torrent, file, start, { fileIndex: parseInt(req.params.fileIndex, 10) })
    }
    console.log(`[server] Stream ${file.name} bytes=${start}-${end}` + (isInternal ? ' (internal)' : ''))
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileLen}`,
      'Content-Length': end - start + 1,
    })
    const stream = file.createReadStream({ start, end })
    stream.on('error', (err) => console.error(`[stream] read error bytes=${start}-${end}:`, err.message))
    res.on('close', () => stream.destroy()) // clean up when browser disconnects
    stream.pipe(res)
  } else {
    res.setHeader('Content-Length', fileLen)
    res.status(200)
    const stream = file.createReadStream()
    stream.on('error', () => {})
    res.on('close', () => stream.destroy())
    stream.pipe(res)
  }
})


/* ── PRIORITIZE pieces for seek ── */
app.post('/api/prioritize/:infoHash/:fileIndex', async (req, res) => {
  const torrent = getTorrent(req.params.infoHash)
  if (!torrent) return res.status(404).json({ error: 'Torrent not found' })
  const fileIndex = parseInt(req.params.fileIndex, 10)
  const file = torrent.files[fileIndex]
  if (!file) return res.status(404).json({ error: 'File not found' })

  const timeSec = parseFloat(req.body?.time ?? req.query.time ?? '0') || 0
  const durationSec = getCachedDuration(req.params.infoHash, fileIndex)
    || parseFloat(req.body?.duration ?? req.query.duration ?? '0')

  ensureMediaIndex(req.params.infoHash, fileIndex, file.length, durationSec)
  buildMediaIndex(torrent, file, durationSec, fileIndex).catch(() => {})

  let prio
  if (timeSec <= 0) {
    prio = prioritizeFileStart(torrent, file, fileIndex)
    prio.contentStartSec = 0
  } else {
    prio = prioritizeAtTime(torrent, file, fileIndex, timeSec, durationSec)
  }
  prio.ready = prio.piecesReady >= prio.piecesNeeded
  console.log(`[prioritize] ${file.name} t=${timeSec}s content@${prio.contentStartSec ?? 0}s byte=${prio.byteOffset} pieces=${prio.startPiece}-${prio.endPiece} ready=${prio.piecesReady}`)
  res.json({ ok: true, ...prio })
})

/* ── TRANSCODE STREAM (video copy + audio → AAC) ── */
app.get('/api/transcode/:infoHash/:fileIndex', async (req, res) => {
  const torrent = getTorrent(req.params.infoHash)
  if (!torrent) return res.status(404).json({ error: 'Torrent not found' })
  const fileIndex = parseInt(req.params.fileIndex, 10)
  const file = torrent.files[fileIndex]
  if (!file) return res.status(404).json({ error: 'File index out of range' })

  const startSec = Math.max(0, parseFloat(req.query.start || req.query.t || '0') || 0)
  const durationSec = getCachedDuration(req.params.infoHash, fileIndex)
    || parseFloat(req.query.duration || '0')

  console.log(`[transcode] ${file.name}${startSec > 0 ? ` seek=${startSec}s dur=${durationSec}s` : ' (start)'}`)

  ensureMediaIndex(req.params.infoHash, fileIndex, file.length, durationSec)
  buildMediaIndex(torrent, file, durationSec, fileIndex).catch(() => {})

  const inputUrl = internalStreamUrl(req.params.infoHash, fileIndex)
  let session

  if (startSec > 0) {
    const seek = resolveSeekByte(file, startSec, durationSec, req.params.infoHash, fileIndex)
    const prio = prioritizeAtTime(torrent, file, fileIndex, startSec, durationSec)
    session = prio.session
    res.setHeader('X-Content-Start', String(startSec))
    console.log(`[transcode] seek request=${startSec}s content@${seek.startTime}s byte=${seek.byteOff} pieces=${prio.startPiece}-${prio.endPiece}` +
      (session.headerStartPiece != null ? ` header=${session.headerStartPiece}-${session.headerEndPiece}` : ''))

    const ready = await waitForSeekPlayback(torrent, session, 4000)
    console.log(`[transcode] seek buffer ready=${ready} pieces@${prio.startPiece}=${contiguousReadyPieces(torrent, prio.startPiece, Math.min(prio.startPiece + 8, prio.endPiece))}`)
    if (!ready) console.warn(`[transcode] starting seek before full buffer — ffmpeg will range-fetch`)
  } else {
    session = shiftPlaybackPriority(torrent, file, 0, { fileIndex, bufferBytes: 24 * 1024 * 1024 })
    await waitForPlaybackBuffer(torrent, session.startPiece, Math.min(session.startPiece + 8, session.endPiece), 1, 6000)
  }

  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  })

  let cmd = ffmpegFluent().input(inputUrl)
  if (startSec > 0) cmd = cmd.seekInput(startSec)

  const proc = cmd
    .inputOptions([
      '-user_agent', 'StreamVault-Internal',
      '-seekable', '1',
      '-probesize', '32M',
      '-analyzeduration', '10M',
      '-fflags', '+genpts+discardcorrupt',
    ])
    .outputOptions(transcodeOutputOptions(startSec, req.query))
    .format('mp4')
    .on('start', cmdLine => console.log('🔥 EXACT FFMPEG COMMAND:', cmdLine))
    .on('stderr', line => {
      const s = String(line)
      if (/error|invalid|failed/i.test(s)) console.warn('[ffmpeg stderr]', s.trim().slice(0, 200))
    })
    .on('error', err => console.error('[transcode error]', err.message))
    .on('end', () => console.log('[transcode] done:', file.name))

  proc.pipe(res, { end: true })

  let killTimer = null
  res.on('close', () => {
    console.log('[transcode] client disconnected')
    killTimer = setTimeout(() => {
      try { proc.kill('SIGKILL') } catch {}
    }, 8000)
  })
  res.on('finish', () => {
    if (killTimer) clearTimeout(killTimer)
    console.log('[transcode] done:', file.name)
  })
})


/* ── HLS TRANSCODE (LG webOS / iPhone Safari) ── */
const hlsSessions = new Map()

function hlsKey (infoHash, fileIndex) {
  return `${infoHash}:${fileIndex}`
}

function hlsProfileFromRequest (req) {
  // "transcode" = libx264 HLS for browsers (iOS Safari, desktop). TVs use stream copy.
  if (req.query.safari === '1' || req.query.browser === '1') return 'transcode'
  const ua = req.headers['user-agent'] || ''
  if (/iPhone|iPad|iPod/i.test(ua)) return 'transcode'
  // Desktop browsers need libx264 — copy often yields audio-only black screen in Edge/Chrome
  if (!/Web0S|webOS|Tizen|SmartTV|BRAVIA|NetCast|LG Browser/i.test(ua)) return 'transcode'
  return 'tv'
}

function hlsVideoOutputOptions (profile, opts = {}) {
  if (profile === 'transcode') {
    const videoOpts = [
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
      '-profile:v', 'main', '-level', '4.0',
      '-pix_fmt', 'yuv420p', '-g', '30', '-keyint_min', '30', '-tune', 'zerolatency',
    ]
    const vf = []
    const resolution = opts.resolution
    if (resolution && resolution !== 'original') {
      const height = parseInt(resolution, 10)
      if (height > 0) vf.push(`scale=-2:${height}`)
    }
    const speed = parseFloat(opts.speed) || 1.0
    if (speed !== 1.0) {
      vf.push(`setpts=PTS/${speed}`)
    }
    if (vf.length > 0) videoOpts.push('-vf', vf.join(','))
    return videoOpts
  }
  return ['-c:v', 'copy']
}

function hlsStartupOpts (profile) {
  if (profile === 'transcode') {
    return {
      bufferBytes: 4 * 1024 * 1024,
      bufferTimeoutMs: 5000,
      minPieces: 0,
      endPieceOffset: 4,
      probeSize: '8M',
      analyzeDuration: '2M',
      segmentSec: 2,
      pollMs: 200,
    }
  }
  return {
    bufferBytes: 24 * 1024 * 1024,
    bufferTimeoutMs: 90000,
    minPieces: 1,
    endPieceOffset: 8,
    probeSize: '32M',
    analyzeDuration: '10M',
    segmentSec: 4,
    pollMs: 500,
  }
}

function hlsPublicBase (req) {
  const host = req.get('x-forwarded-host') || req.get('host')
  const proto = req.get('x-forwarded-proto') || req.protocol
  return `${proto}://${host}/api/hls/${req.params.infoHash}/${req.params.fileIndex}/`
}

function rewriteHlsPlaylist (text, baseUrl) {
  return text.split(/\r?\n/).map(line => {
    const t = line.trim()
    if (!t || t.startsWith('#')) return line
    if (/^https?:\/\//i.test(t)) return t
    return baseUrl + path.basename(t.replace(/\\/g, '/'))
  }).join('\n')
}

function stopHlsSession (key) {
  const session = hlsSessions.get(key)
  if (!session) return
  hlsSessions.delete(key)
  try { session.proc.kill('SIGKILL') } catch {}
  try { fs.rmSync(session.outDir, { recursive: true, force: true }) } catch {}
}

function getTorrentFile (infoHash, fileIndex) {
  const torrent = getTorrent(infoHash)
  if (!torrent) return null
  const file = torrent.files[parseInt(fileIndex, 10)]
  return file || null
}

function isHlsProcAlive(session) {
  if (!session?.proc) return false;
  const p = session.proc.ffmpegProc || session.proc;
  return p && p.exitCode == null && !p.killed;
}

async function startHlsSession (infoHash, fileIndex, file, opts = {}) {
  let profile = opts.profile || 'tv'
  if ((opts.resolution && opts.resolution !== 'original') || (opts.speed && parseFloat(opts.speed) !== 1.0)) {
    profile = 'transcode'
  }
  infoHash = normalizeInfoHash(infoHash)
  const key = hlsKey(infoHash, fileIndex)
  const existing = hlsSessions.get(key)
  if (existing) {
    if (existing.profile === profile &&
        existing.resolution === opts.resolution &&
        existing.speed === opts.speed &&
        existing.audioIndex === opts.audioIndex &&
        isHlsProcAlive(existing)) {
      return existing.ready
    }
    stopHlsSession(key)
  }

  const torrent = getTorrent(infoHash)
  if (!torrent) throw new Error('Torrent not found — add torrent before playback')

  const fileIdx = parseInt(fileIndex, 10)
  const startup = hlsStartupOpts(profile)
  const prioSession = shiftPlaybackPriority(torrent, file, 0, {
    fileIndex: fileIdx,
    bufferBytes: startup.bufferBytes,
  })
  const endPiece = Math.min(prioSession.startPiece + startup.endPieceOffset, prioSession.endPiece)
  const bufReady = await waitForPlaybackBuffer(
    torrent, prioSession.startPiece, endPiece, startup.minPieces, startup.bufferTimeoutMs,
  )
  if (!bufReady) console.warn(`[hls] ${file.name} starting before full buffer (${profile})`)

  const outDir = path.join(os.tmpdir(), 'streamvault-hls', `${key.replace(/:/g, '-')}-${profile}`)
  fs.mkdirSync(outDir, { recursive: true })
  const playlistPath = path.join(outDir, 'playlist.m3u8')
  const segmentPattern = path.join(outDir, 'seg%03d.ts')
  const inputUrl = internalStreamUrl(torrent.infoHash, fileIndex)

  const audioIndex = opts.audioIndex != null ? parseInt(opts.audioIndex, 10) : null
  const audioMap = audioIndex !== null ? `0:${audioIndex}` : '0:a:0?'

  const outputOpts = [
    '-map', '0:v:0?',
    '-map', audioMap,
    ...hlsVideoOutputOptions(profile, opts),
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ac', '2',
    '-max_muxing_queue_size', '9999',
    '-f', 'hls',
    '-hls_time', String(startup.segmentSec),
    '-hls_list_size', '0',
    '-hls_flags', 'independent_segments+append_list',
    '-hls_segment_filename', segmentPattern,
  ]

  const af = []
  const speed = parseFloat(opts.speed) || 1.0
  if (speed !== 1.0) {
    if (speed >= 0.5 && speed <= 2.0) {
      af.push(`atempo=${speed}`)
    } else {
      let remaining = speed
      while (remaining > 2.0) {
        af.push('atempo=2.0')
        remaining /= 2.0
      }
      while (remaining < 0.5) {
        af.push('atempo=0.5')
        remaining /= 0.5
      }
      af.push(`atempo=${remaining}`)
    }
  }
  if (af.length > 0) outputOpts.push('-af', af.join(','))

  const proc = ffmpegFluent(inputUrl)
    .inputOptions([
      '-user_agent', 'StreamVault-Internal',
      '-seekable', '1',
      '-probesize', startup.probeSize,
      '-analyzeduration', startup.analyzeDuration,
      '-fflags', '+genpts+discardcorrupt',
    ])
    .outputOptions(outputOpts)
    .output(playlistPath)
    .on('start', cmd => console.log('🔥 EXACT HLS FFMPEG COMMAND:', cmd))
    .on('error', err => {
      console.error(`[hls ${profile} error]`, err.message)
      hlsSessions.delete(key)
    })
    .on('end', () => {
      console.log(`[hls ${profile}] done:`, file.name)
      hlsSessions.delete(key)
    })

  proc.run()

  const ready = new Promise((resolve, reject) => {
    let checks = 0
    const poll = setInterval(() => {
      checks++
      try {
        if (!fs.existsSync(playlistPath)) return
        const text = fs.readFileSync(playlistPath, 'utf8')
        if (text.includes('#EXTINF') && fs.readdirSync(outDir).some(f => f.endsWith('.ts'))) {
          clearInterval(poll)
          resolve()
        }
      } catch {}
      if (checks > Math.ceil(120000 / startup.pollMs)) {
        clearInterval(poll)
        reject(new Error('HLS startup timeout — waiting for torrent data'))
      }
    }, startup.pollMs)

    proc.once('error', err => {
      clearInterval(poll)
      reject(err)
    })
  })

  hlsSessions.set(key, { outDir, playlistPath, proc, profile, resolution: opts.resolution, speed: opts.speed, audioIndex: opts.audioIndex, ready })
  return ready
}

app.get('/api/hls/:infoHash/:fileIndex/playlist.m3u8', async (req, res) => {
  const file = getTorrentFile(req.params.infoHash, req.params.fileIndex)
  if (!file) return res.status(404).type('text/plain').send('Torrent not found')

  const profile = hlsProfileFromRequest(req)
  console.log(`[hls] playlist (${profile}): ${file.name}`)

  try {
    await startHlsSession(req.params.infoHash, req.params.fileIndex, file, {
      profile,
      resolution: req.query.resolution,
      speed: req.query.speed,
      audioIndex: req.query.audioIndex,
    })
    const session = hlsSessions.get(hlsKey(req.params.infoHash, req.params.fileIndex))
    const text = fs.readFileSync(session.playlistPath, 'utf8')
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.send(rewriteHlsPlaylist(text, hlsPublicBase(req)))
  } catch (err) {
    console.error('[hls] playlist error:', err.message)
    res.status(503).type('text/plain').send(err.message)
  }
})

app.get('/api/hls/:infoHash/:fileIndex/:segment', (req, res) => {
  const key = hlsKey(req.params.infoHash, req.params.fileIndex)
  const session = hlsSessions.get(key)
  if (!session) return res.status(404).end()

  const segment = path.basename(req.params.segment)
  if (!/^[\w.-]+$/.test(segment)) return res.status(400).end()

  const filePath = path.join(session.outDir, segment)
  if (!filePath.startsWith(session.outDir)) return res.status(403).end()

  const send = () => {
    const ext = segment.split('.').pop().toLowerCase()
    res.setHeader('Content-Type', ext === 'm3u8'
      ? 'application/vnd.apple.mpegurl'
      : 'video/mp2t')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Access-Control-Allow-Origin', '*')
    fs.createReadStream(filePath).pipe(res)
  }

  if (fs.existsSync(filePath)) return send()

  let tries = 0
  const wait = setInterval(() => {
    tries++
    if (fs.existsSync(filePath)) {
      clearInterval(wait)
      send()
    } else if (tries > 40) {
      clearInterval(wait)
      res.status(404).end()
    }
  }, 250)
})

app.delete('/api/hls/:infoHash/:fileIndex', (req, res) => {
  stopHlsSession(hlsKey(req.params.infoHash, req.params.fileIndex))
  res.json({ ok: true })
})


/* ── PROBE audio codec + duration ── */

function estimateDurationFromSize (fileLength) {
  if (!fileLength || fileLength < 5 * 1024 * 1024) return null
  // Typical 720p–1080p WEB-DL: ~750 KB/s average
  return Math.round(fileLength / (750 * 1024))
}

function isPlausibleDuration (durationSec, fileLength) {
  if (!durationSec || durationSec <= 0) return false
  if (!fileLength || fileLength < 20 * 1024 * 1024) return durationSec >= 60
  const impliedBps = fileLength / durationSec
  // Reject partial-read artifacts (e.g. 92 s for a 800 MB file ≈ 8 MB/s — too fast)
  if (impliedBps > 4 * 1024 * 1024 && fileLength > 80 * 1024 * 1024) return false
  if (impliedBps < 150 * 1024 && fileLength > 50 * 1024 * 1024) return false
  return true
}

function probeWithFfmpeg (inputSource, cb) {
  execFile(ffmpegStatic, ['-user_agent', 'StreamVault-Internal', '-i', inputSource], (err, stdout, stderr) => {
    const output = stderr || ''
    
    let duration = null
    const durationMatch = output.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/)
    if (durationMatch) {
      const hh = parseInt(durationMatch[1], 10)
      const mm = parseInt(durationMatch[2], 10)
      const ss = parseFloat(durationMatch[3])
      duration = hh * 3600 + mm * 60 + ss
    }

    const audioTracks = []
    const lines = output.split('\n')
    let currentAudio = null

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const streamMatch = line.match(/Stream #0:(\d+)(?:\(([^)]+)\))?.*Audio:\s*([a-zA-Z0-9_]+)/)
      if (streamMatch) {
        const index = parseInt(streamMatch[1], 10)
        const language = streamMatch[2] || 'unknown'
        const codec = streamMatch[3]
        currentAudio = {
          index,
          codec,
          language,
          title: `Track ${audioTracks.length + 1}`
        }
        audioTracks.push(currentAudio)
      } else if (currentAudio && line.trim().startsWith('Stream #0:')) {
        currentAudio = null
      } else if (currentAudio && line.includes('title')) {
        const titleMatch = line.match(/title\s*:\s*(.+)/)
        if (titleMatch) {
          currentAudio.title = titleMatch[1].trim()
        }
      }
    }

    cb(null, duration, audioTracks)
  })
}

app.get('/api/probe/:infoHash/:fileIndex', (req, res) => {
  const torrent = getTorrent(req.params.infoHash)
  if (!torrent) return res.status(404).json({ error: 'Not found' })
  const fileIndex = parseInt(req.params.fileIndex, 10)
  const file = torrent.files[fileIndex]
  if (!file) return res.status(404).json({ error: 'File not found' })

  const fileLength = file.length
  const durationEstimate = estimateDurationFromSize(fileLength)
  const done = torrent.done

  function respond (rawDuration, audioTracks) {
    const duration = rawDuration && isPlausibleDuration(rawDuration, fileLength) ? rawDuration : null
    cacheDuration(req.params.infoHash, fileIndex, duration || durationEstimate)
    ensureMediaIndex(req.params.infoHash, fileIndex, fileLength, duration || durationEstimate)
    buildMediaIndex(torrent, file, duration || durationEstimate, fileIndex).catch(() => {})
    
    const audioTrack = audioTracks[0]
    const codec = audioTrack ? audioTrack.codec : 'unknown'
    const BROWSER_AUDIO = ['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_u8']
    const needsTranscode = !BROWSER_AUDIO.includes(codec)
    
    console.log(`[probe] ${file.name} audio=${codec} duration=${duration ?? '?'}s est=${durationEstimate ?? '?'}s done=${done}`)
    res.json({ codec, needsTranscode, audioTracks, duration, durationEstimate, fileLength, done })
  }

  // Use on-disk path if downloading on disk and USE_DISK is enabled
  if (file.path && fs.existsSync(file.path) && USE_DISK) {
    probeWithFfmpeg(file.path, (err, rawDuration, audioTracks) => {
      if (!err && rawDuration && isPlausibleDuration(rawDuration, fileLength)) {
        return respond(rawDuration, audioTracks)
      }
      probeUrl()
    })
  } else {
    probeUrl()
  }

  function probeUrl () {
    const inputUrl = internalStreamUrl(req.params.infoHash, fileIndex)
    probeWithFfmpeg(inputUrl, (err, rawDuration, audioTracks) => {
      if (err) {
        return res.json({
          needsTranscode: false,
          duration: null,
          durationEstimate,
          fileLength,
          done,
          error: err.message,
          audioTracks: []
        })
      }
      respond(rawDuration, audioTracks)
    })
  }
})

/* ── STATS ── */
app.get('/api/stats/:infoHash', (req, res) => {
  const t = getTorrent(req.params.infoHash)
  if (!t) return res.status(404).json({ error: 'Not found' })
  res.json({
    name: t.name,
    progress: t.progress,
    downloaded: t.downloaded,
    downloadSpeed: t.downloadSpeed,
    uploadSpeed: t.uploadSpeed,
    numPeers: t.numPeers,
    done: t.done,
  })
})

/* ── STORAGE / CACHE ── */
app.get('/api/storage', (_req, res) => {
  res.json(storageInfo(client))
})

app.post('/api/storage/clear', async (_req, res) => {
  try {
    for (const key of [...hlsSessions.keys()]) stopHlsSession(key)
    await clearAllTorrents(client, registry)
    res.json({ ok: true, ...storageInfo(client) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/* ── REMOVE ── */
app.delete('/api/torrent/:infoHash', (req, res) => {
  const infoHash = normalizeInfoHash(req.params.infoHash)
  const t = getTorrent(infoHash)
  if (t) {
    for (const key of [...hlsSessions.keys()]) {
      if (key.startsWith(infoHash + ':')) stopHlsSession(key)
    }
    registry.delete(infoHash)
    deleteMediaIndex(infoHash)
    for (const f of t.files || []) {
      const idx = t.files.indexOf(f)
      if (idx >= 0) clearPlaybackSession(infoHash, idx)
    }
    try {
      t.pause()
      if (t.files) t.files.forEach(f => f.deselect())
    } catch (e) {
      console.warn('[server] Pause old torrent error:', e.message)
    }
    res.json({ ok: true })
  } else {
    res.json({ ok: true })
  }
})

/* ── STATIC UI (same origin for iPhone Safari) ── */
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'main.html'))
})
app.use(express.static(__dirname, { index: false }))

/* ── START ── */

function getLanIp () {
  const nets = os.networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address
    }
  }
  return null
}

client.on('error', err => console.error('[webtorrent client]', err.message))

// Listen on 0.0.0.0 so every network interface (LAN, Wi-Fi) is reachable
async function startServer () {
  try {
    await ensureFlareSolverr()
  } catch (err) {
    console.error('⚠️ Could not automatically set up FlareSolverr:', err.message)
  }

  app.listen(PORT, '0.0.0.0', () => {
    const lan = getLanIp()
    console.log('\n✅  StreamVault server running')
    console.log(`   Local :  http://localhost:${PORT}`)
    if (lan) {
      console.log(`   LAN   :  http://${lan}:${PORT}`)
      console.log(`\n   📡  On phone / TV open:  http://${lan}:${PORT}`)
      console.log(`       (or http://${lan}:3000 if using npx serve)`)
    }
    if (USE_DISK) console.log(`   💾  Disk cache: ${STORE_PATH}`)
    else console.log('   💾  Storage: memory-only (no disk cache)')
    console.log()
  })
}

startServer()
