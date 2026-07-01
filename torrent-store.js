/**
 * WebTorrent storage — memory (default, no disk) or optional disk cache
 *
 * Env:
 *   WEBTORRENT_STORE=memory|disk   (default: memory — nothing written to C:\tmp\webtorrent)
 *   WEBTORRENT_PATH=/path/to/cache (disk mode only, default: OS temp/streamvault-cache)
 *   WEBTORRENT_CACHE_SLOTS=128     (in-memory piece cache slots per torrent)
 *   WEBTORRENT_CLEAR_ON_START=1    (disk mode: wipe cache folder on server start)
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import MemoryChunkStore from 'memory-chunk-store'

export const STORE_MODE = (process.env.WEBTORRENT_STORE || 'memory').toLowerCase()
export const STORE_PATH = process.env.WEBTORRENT_PATH
  || path.join(os.tmpdir(), 'streamvault-cache')
export const USE_DISK = STORE_MODE === 'disk' || STORE_MODE === 'cache'

export function torrentAddOpts () {
  const opts = {
    destroyStoreOnDestroy: true,
    storeCacheSlots: parseInt(process.env.WEBTORRENT_CACHE_SLOTS || '128', 10),
    strategy: 'sequential',
    announce: [
      'udp://tracker.opentrackr.org:1337/announce',
      'udp://tracker.coppersurfer.tk:6969/announce',
      'udp://tracker.leechers-paradise.org:6969/announce',
      'udp://open.stealth.si:80/announce',
      'udp://tracker.openbittorrent.com:6969/announce',
      'udp://tracker.cyberia.is:6969/announce',
      'udp://explodie.org:6969/announce',
      'udp://tracker.torrent.eu.org:451/announce',
      'udp://ipv4.tracker.harry.lu:80/announce',
      'udp://tracker.moack.co.kr:80/announce',
      'udp://tracker.tiny-vps.com:6969/announce'
    ]
  }
  if (USE_DISK) {
    fs.mkdirSync(STORE_PATH, { recursive: true })
    opts.path = STORE_PATH
  } else {
    opts.store = MemoryChunkStore
  }
  return opts
}

export function initStorage () {
  if (USE_DISK) {
    fs.mkdirSync(STORE_PATH, { recursive: true })
    if (process.env.WEBTORRENT_CLEAR_ON_START === '1') {
      clearDiskFolder()
      console.log(`[storage] Cleared disk cache: ${STORE_PATH}`)
    }
    console.log(`[storage] Disk cache: ${STORE_PATH}`)
  } else {
    console.log('[storage] Memory-only (no disk cache). Set WEBTORRENT_STORE=disk for disk cache.')
  }
}

function dirSize (dir) {
  let total = 0
  try {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name)
      const st = fs.statSync(p)
      if (st.isDirectory()) total += dirSize(p)
      else total += st.size
    }
  } catch {}
  return total
}

export function storageInfo (client) {
  const torrents = (client?.torrents || []).map(t => ({
    infoHash: t.infoHash,
    name: t.name,
    progress: Math.round((t.progress || 0) * 100),
    downloaded: t.downloaded || 0,
    length: t.length || 0,
  }))
  return {
    mode: USE_DISK ? 'disk' : 'memory',
    path: USE_DISK ? STORE_PATH : null,
    diskBytes: USE_DISK ? dirSize(STORE_PATH) : 0,
    torrentCount: torrents.length,
    torrents,
  }
}

export function clearDiskFolder () {
  if (!USE_DISK) return
  try {
    fs.rmSync(STORE_PATH, { recursive: true, force: true })
    fs.mkdirSync(STORE_PATH, { recursive: true })
  } catch {}
}

export async function clearAllTorrents (client, registry) {
  const hashes = [...registry.keys()]
  await Promise.all(hashes.map(hash => new Promise(resolve => {
    const t = registry.get(hash)
    registry.delete(hash)
    if (t) client.remove(t, { destroyStore: true }, () => resolve())
    else resolve()
  })))
  clearDiskFolder()
}
