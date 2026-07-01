/**
 * Multi-source torrent search — TPB, 1337x, UIndex, EXT.to
 */

import { parse } from 'node-html-parser'
import { piratebay } from 'piratebay-scraper'

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const TPB_MIRRORS = (process.env.TPB_PROVIDERS || 'https://thepiratebay.zone,https://tpb.run,https://thepiratebay.org')
  .split(',').map(s => s.trim()).filter(Boolean)

const X1337_BASES = (process.env.X1337_PROVIDERS || 'https://www.1337xx.to,https://1337xto.to')
  .split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean)

const UINDEX_BASE = (process.env.UINDEX_BASE || 'https://uindex.org').replace(/\/$/, '')
const EXT_TO_BASE = (process.env.EXT_TO_BASE || 'https://extto.com').replace(/\/$/, '')

const DEFAULT_SOURCES = 'tpb,1337x,uindex,ext'

const ENABLED = new Set(
  (process.env.TORRENT_SOURCES || DEFAULT_SOURCES).split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
)

const HTTP_TIMEOUT_MS = parseInt(process.env.TORRENT_FETCH_TIMEOUT_MS || '12000', 10)
const SOURCE_TIMEOUT_MS = parseInt(process.env.SOURCE_SEARCH_TIMEOUT_MS || '35000', 10)
const FLARE_TIMEOUT_MS = parseInt(process.env.FLARESOLVERR_TIMEOUT_MS || '30000', 10)

/* ── shared helpers ── */

export function infoHashFromMagnet (magnet) {
  const m = magnet.match(/btih:([a-fA-F0-9]{40})/i) || magnet.match(/btih:([a-zA-Z0-9]{32})/i)
  return m ? m[1].toLowerCase() : null
}

export function episodePattern (season, episode) {
  const s = String(season).padStart(2, '0')
  const e = String(episode).padStart(2, '0')
  return new RegExp(`[\\s._-]s${s}e${e}[\\s._-]|\\s${season}x${episode}[\\s._-]|s${s}[\\s._-]?e${e}`, 'i')
}

/** Match exact episode OR season packs like S01E01-10 that include the episode */
export function episodeMatchesTitle (title, season, episode) {
  if (!season || !episode) return true
  const t = title.toLowerCase()

  if (new RegExp(`(?:^|[\\s._-])${season}x${episode}(?:[\\s._-]|$)`, 'i').test(t)) return true
  if (new RegExp(`s0*${season}[\\s._-]*e0*${episode}(?:[\\s._-]|$)`, 'i').test(t)) return true

  const rangeRes = [
    new RegExp(`s0*${season}[\\s._-]*e(\\d{1,2})\\s*[-–~]\\s*e?(\\d{1,2})`, 'i'),
    new RegExp(`s0*${season}[\\s._-]*e(\\d{1,2})\\s*[-–]\\s*(\\d{1,2})(?:\\D|$)`, 'i'),
  ]
  for (const re of rangeRes) {
    const m = t.match(re)
    if (m) {
      const from = parseInt(m[1], 10)
      const to = parseInt(m[2], 10)
      if (episode >= from && episode <= to) return true
    }
  }

  return false
}

function normalizeForMatch (s) {
  return (s || '').toLowerCase().replace(/[''´`]/g, '').replace(/[^a-z0-9]/g, '')
}

/** Fuzzy show-name match (Widow's Bay ≈ WidowS Bay ≈ Widows Bay) */
export function titleMatchesShow (title, showName) {
  if (!showName) return true
  const tNorm = normalizeForMatch(title)
  const words = showName.toLowerCase()
    .replace(/s\d{1,2}e\d{1,2}/gi, '')
    .split(/[\s._-]+/)
    .map(w => w.replace(/[''´`]/g, ''))
    .filter(w => w.length > 2)
  if (!words.length) return true
  const hits = words.filter(w => tNorm.includes(normalizeForMatch(w)))
  return hits.length >= Math.max(1, Math.ceil(words.length * 0.6))
}

export function buildSearchQueries (showName, season, episode) {
  const s2 = String(season).padStart(2, '0')
  const e2 = String(episode).padStart(2, '0')
  const bare = showName.replace(/[''´`]/g, '').trim()
  const widows = showName.replace(/[''´`]s\b/gi, 's').replace(/[''´`]/g, '').trim()
  return [...new Set([
    `${showName} S${s2}E${e2}`,
    `${bare} S${s2}E${e2}`,
    `${widows} S${s2}E${e2}`,
    `${showName} S${season}E${episode}`,
    `${bare} S${s2}`,
    `${widows} season ${season}`,
  ])]
}

function rankTorrent (t) {
  return (t.seeders || 0) * 2 - (t.leechers || 0)
}

function decodeHtml (s) {
  return (s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
}

function normalizeResult (partial, provider) {
  return {
    title: partial.title || 'Unknown',
    magnet: partial.magnet || '',
    seeders: partial.seeders || 0,
    leechers: partial.leechers || 0,
    size: partial.size || '?',
    uploaded: partial.uploaded || '',
    uploader: partial.uploader || '',
    provider,
  }
}

async function fetchWithTimeout (url, opts = {}, timeoutMs = HTTP_TIMEOUT_MS) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html', ...opts.headers },
      redirect: 'follow',
      signal: ctrl.signal,
      ...opts,
    })
    const html = await res.text()
    if (html.includes('Just a moment')) throw new Error('Cloudflare challenge')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return html
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Timeout after ${timeoutMs}ms`)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

async function fetchHtml (url, opts = {}) {
  return fetchWithTimeout(url, opts, HTTP_TIMEOUT_MS)
}

async function flareGet (url) {
  const base = process.env.FLARESOLVERR_URL?.replace(/\/$/, '')
  if (!base) throw new Error('FlareSolverr not configured')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FLARE_TIMEOUT_MS)
  let res
  try {
    res = await fetch(`${base}/v1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({ cmd: 'request.get', url, maxTimeout: Math.min(FLARE_TIMEOUT_MS, 60000) }),
    })
  } finally {
    clearTimeout(timer)
  }
  const data = await res.json()
  if (data.status !== 'ok') throw new Error(data.message || 'FlareSolverr failed')
  const html = data.solution?.response
  if (!html) throw new Error('FlareSolverr empty response')
  return html
}

async function getPage (url) {
  const isProtected = url.includes('uindex.org') || url.includes('ext.to')
  if (isProtected && process.env.FLARESOLVERR_URL) {
    try {
      return await flareGet(url)
    } catch (err) {
      console.warn(`[sources] FlareSolverr failed for ${url}, trying direct fetch:`, err.message)
    }
  }
  try {
    return await fetchHtml(url)
  } catch (err) {
    if (process.env.FLARESOLVERR_URL && err.message.includes('Cloudflare')) {
      return await flareGet(url)
    }
    throw err
  }
}

function extractMagnet (html) {
  const m = html.match(/href="(magnet:[^"]+)"/i) || html.match(/href='(magnet:[^']+)'/i)
  return m ? decodeHtml(m[1]) : null
}

async function mapPool (items, fn, concurrency = 4) {
  const out = []
  let i = 0
  async function worker () {
    while (i < items.length) {
      const idx = i++
      try {
        const r = await fn(items[idx], idx)
        if (r) out.push(r)
      } catch {}
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return out
}

/* ── TPB ── */

async function searchTpb (query, { epRe, limit }) {
  const results = []
  for (const provider of TPB_MIRRORS) {
    try {
      const raw = await Promise.race([
        piratebay.search(query, provider),
        new Promise((_, reject) => setTimeout(() => reject(new Error('TPB timeout')), HTTP_TIMEOUT_MS)),
      ])
      for (const t of raw) {
        const hash = infoHashFromMagnet(t.link)
        if (!hash) continue
        if (epRe && !epRe.test(t.title)) continue
        results.push(normalizeResult({
          title: t.title,
          magnet: t.link,
          seeders: t.seeders,
          leechers: t.leechers,
          size: t.size,
          uploaded: t.uploaded,
          uploader: t.uploader,
        }, provider.replace(/^https?:\/\//, '')))
      }
      if (results.length > 0) return results.slice(0, limit)
    } catch (err) {
      console.warn(`[sources/tpb] ${provider}:`, err.message)
      if (results.length > 0) return results.slice(0, limit)
    }
  }
  return results
}

/* ── 1337x ── */

async function fetch1337xMagnet (base, href) {
  const html = await getPage(`${base}${href}`)
  return extractMagnet(html)
}

async function search1337x (query, { epRe, limit }) {
  const results = []
  for (const base of X1337_BASES) {
    try {
      const searchUrl = `${base}/search/${encodeURIComponent(query)}/1/`
      const html = await getPage(searchUrl)
      const rows = parse(html).querySelectorAll('tbody tr')
      const candidates = []

      for (const row of rows) {
        const link = row.querySelector('a[href*="/torrent/"]')
        if (!link) continue
        const title = link.textContent.trim()
        if (epRe && !epRe.test(title)) continue
        candidates.push({
          title,
          href: link.getAttribute('href'),
          seeders: parseInt(row.querySelector('.seeds')?.textContent || '0', 10) || 0,
          leechers: parseInt(row.querySelector('.leeches')?.textContent || '0', 10) || 0,
          size: row.querySelector('.size')?.textContent?.trim() || '?',
          uploaded: row.querySelector('.coll-date')?.textContent?.trim() || '',
          uploader: row.querySelector('.coll-5 a')?.textContent?.trim() || '',
        })
      }

      const withMagnets = await mapPool(candidates.slice(0, Math.min(limit, 4)), async (c) => {
        const magnet = await fetch1337xMagnet(base, c.href)
        if (!magnet) return null
        return normalizeResult({ ...c, magnet }, '1337x')
      })

      results.push(...withMagnets)
      if (results.length) return results.slice(0, limit)
    } catch (err) {
      console.warn(`[sources/1337x] ${base}:`, err.message)
    }
  }
  return results
}

/* ── UIndex ── */

async function fetchUindexMagnet (detailPath) {
  const url = detailPath.startsWith('http') ? detailPath : `${UINDEX_BASE}${detailPath}`
  const html = await getPage(url)
  return extractMagnet(html)
}

async function searchUindex (query, { epRe, limit }) {
  try {
    const searchUrl = `${UINDEX_BASE}/search.php?search=${encodeURIComponent(query)}&c=0`
    const html = await getPage(searchUrl)
    const links = parse(html).querySelectorAll('a[href*="details.php?id="]')
    const candidates = []
    const seen = new Set()

    for (const a of links) {
      const href = a.getAttribute('href')
      const title = a.textContent.trim()
      if (!href || !title || seen.has(href)) continue
      seen.add(href)
      if (epRe && !epRe.test(title)) continue
      // Skip nav links
      if (title.length < 4) continue
      candidates.push({ title, href })
    }

    // Parse seeders from table rows if present
    for (const row of parse(html).querySelectorAll('tr')) {
      const a = row.querySelector('a[href*="details.php?id="]')
      if (!a) continue
      const href = a.getAttribute('href')
      const cand = candidates.find(c => c.href === href)
      if (!cand) continue
      const cells = row.querySelectorAll('td')
      if (cells.length >= 4) {
        cand.size = cells[1]?.textContent?.trim() || cand.size
        cand.seeders = parseInt(cells[2]?.textContent?.replace(/,/g, '') || '0', 10) || 0
        cand.leechers = parseInt(cells[3]?.textContent?.replace(/,/g, '') || '0', 10) || 0
      }
    }

    const withMagnets = await mapPool(candidates.slice(0, Math.min(limit, 3)), async (c) => {
      const magnet = await fetchUindexMagnet(c.href)
      if (!magnet) return null
      return normalizeResult({
        title: c.title,
        magnet,
        seeders: c.seeders || 0,
        leechers: c.leechers || 0,
        size: c.size || '?',
      }, 'uindex.org')
    })

    return withMagnets.slice(0, limit)
  } catch (err) {
    console.warn('[sources/uindex]:', err.message)
    return []
  }
}

/* ── EXT.to ── */

async function searchExtTo (query, { epRe, limit }) {
  try {
    const searchUrl = `${EXT_TO_BASE}/browse/?q=${encodeURIComponent(query)}&with_adult=1`
    const html = await getPage(searchUrl)
    const root = parse(html)
    const candidates = []
    const seen = new Set()

    for (const a of root.querySelectorAll('a[href*="/torrent/"], a[href*="torrent-"]')) {
      const href = a.getAttribute('href')
      const title = a.textContent.trim()
      if (!href || !title || title.length < 4 || seen.has(href)) continue
      if (epRe && !epRe.test(title)) continue
      seen.add(href)
      candidates.push({ title, href })
    }

    const withMagnets = await mapPool(candidates.slice(0, Math.min(limit, 3)), async (c) => {
      const detailUrl = c.href.startsWith('http') ? c.href : `${EXT_TO_BASE}${c.href}`
      const detailHtml = await getPage(detailUrl)
      let magnet = extractMagnet(detailHtml)

      // EXT.to AJAX magnet API (tokens in page)
      if (!magnet && process.env.FLARESOLVERR_URL) {
        const id = detailHtml.match(/torrent_id[=:]\s*['"]?(\d+)/i)?.[1]
          || c.href.match(/(\d+)/)?.[1]
        const ts = detailHtml.match(/timestamp['":\s]+(\d+)/i)?.[1]
        const hmac = detailHtml.match(/hmac['":\s]+['"]([a-f0-9]+)/i)?.[1]
        const sessid = detailHtml.match(/sessid['":\s]+['"]([^'"]+)/i)?.[1]
        if (id && ts && hmac && sessid) {
          const apiRes = await fetch(`${process.env.FLARESOLVERR_URL.replace(/\/$/, '')}/v1`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              cmd: 'request.post',
              url: `${EXT_TO_BASE}/ajax/getTorrentMagnet.php`,
              postData: `torrent_id=${id}&download_type=magnet&timestamp=${ts}&hmac=${hmac}&sessid=${sessid}`,
              maxTimeout: 60000,
            }),
          })
          const apiData = await apiRes.json()
          const body = apiData.solution?.response || ''
          magnet = body.match(/magnet:[^"'<\s]+/i)?.[0] || null
        }
      }

      if (!magnet) return null
      return normalizeResult({ title: c.title, magnet }, 'ext.to')
    })

    return withMagnets.slice(0, limit)
  } catch (err) {
    console.warn('[sources/ext.to]:', err.message)
    return []
  }
}

/* ── aggregator ── */

const SOURCE_FNS = {
  tpb: searchTpb,
  '1337x': search1337x,
  uindex: searchUindex,
  ext: searchExtTo,
}

function withSourceTimeout (label, promise, ms = SOURCE_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((resolve) => {
      setTimeout(() => {
        console.warn(`[sources] ${label} timed out after ${ms}ms`)
        resolve([])
      }, ms)
    }),
  ])
}

async function searchTorrentio (imdbId, season, episode) {
  try {
    const isSeries = season != null && episode != null
    const url = isSeries
      ? `https://torrentio.strem.fun/stream/series/${imdbId}:${season}:${episode}.json`
      : `https://torrentio.strem.fun/stream/movie/${imdbId}.json`

    const res = await fetch(url, { headers: { 'User-Agent': 'StreamVault/1.0' } })
    if (!res.ok) throw new Error(`Torrentio HTTP ${res.status}`)
    const data = await res.json()
    if (!data || !data.streams || !data.streams.length) return []

    return data.streams.map(s => {
      const parts = s.title.split('\n')
      const mainTitle = parts[0] || s.behaviorHints?.filename || 'Unknown'
      const metaLine = parts[1] || ''

      const seedersMatch = metaLine.match(/👤\s*(\d+)/)
      const seeders = seedersMatch ? parseInt(seedersMatch[1], 10) : 0

      const sizeMatch = metaLine.match(/💾\s*([\d.]+\s*[a-zA-Z]+)/)
      const size = sizeMatch ? sizeMatch[1] : '?'

      const providerMatch = metaLine.match(/⚙️\s*([^\s]+)/)
      const provider = providerMatch ? providerMatch[1] : 'Torrentio'

      return {
        title: mainTitle,
        magnet: `magnet:?xt=urn:btih:${s.infoHash}&dn=${encodeURIComponent(mainTitle)}`,
        seeders,
        leechers: 0,
        size,
        uploaded: '',
        uploader: '',
        provider: `${provider} (cached)`
      }
    })
  } catch (err) {
    console.warn('[sources/torrentio] Error:', err.message)
    return []
  }
}

export async function searchAllSources (query, { season, episode, limit = 30, showName, imdbId } = {}) {
  if (imdbId) {
    const torrentioResults = await searchTorrentio(imdbId, season, episode)
    if (torrentioResults.length > 0) {
      console.log(`[sources/torrentio] Found ${torrentioResults.length} cached results for ${imdbId}`)
      torrentioResults.sort((a, b) => rankTorrent(b) - rankTorrent(a))
      return torrentioResults.slice(0, limit)
    }
  }

  const name = showName || query.replace(/\s*s\d{1,2}e\d{1,2}.*/i, '').trim()
  const allQueries = (season != null && episode != null && name)
    ? buildSearchQueries(name, season, episode)
    : [query]
  const queries = allQueries.slice(0, 2)
  const epRe = (season != null && episode != null) ? episodePattern(season, episode) : null

  const perSource = Math.ceil(limit / Math.max(ENABLED.size, 1)) + 5

  async function runSource (fn) {
    const seen = new Set()
    const out = []
    for (const q of queries) {
      if (out.length >= perSource) break
      try {
        const batch = await fn(q, { epRe, limit: perSource })
        for (const t of batch) {
          const hash = infoHashFromMagnet(t.magnet)
          if (!hash || seen.has(hash)) continue
          seen.add(hash)
          out.push(t)
        }
      } catch {}
    }
    return out
  }

  const jobs = [...ENABLED].map(srcName => {
    const fn = SOURCE_FNS[srcName]
    const timeoutMs = (srcName === 'uindex' || srcName === 'ext') ? 15000 : 10000
    return fn ? withSourceTimeout(srcName, runSource(fn), timeoutMs) : Promise.resolve([])
  })

  const batches = await Promise.allSettled(jobs)
  const seen = new Set()
  const all = []

  for (const batch of batches) {
    if (batch.status !== 'fulfilled') continue
    for (const t of batch.value) {
      if (season != null && episode != null) {
        if (!episodeMatchesTitle(t.title, season, episode)) continue
        if (!titleMatchesShow(t.title, name)) continue
      }
      const hash = infoHashFromMagnet(t.magnet)
      if (!hash || seen.has(hash)) continue
      seen.add(hash)
      all.push(t)
    }
  }

  all.sort((a, b) => rankTorrent(b) - rankTorrent(a))
  return all.slice(0, limit)
}

export function listEnabledSources () {
  return [...ENABLED].map(name => ({
    id: name,
    label: { tpb: 'TPB', '1337x': '1337x', uindex: 'UIndex', ext: 'EXT.to' }[name] || name,
    needsFlare: name === 'uindex' || name === 'ext',
  }))
}
