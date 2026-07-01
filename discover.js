/**
 * Discover — Stremio-style metadata (Cinemeta) + multi-source torrent search
 */

const CINEMETA = 'https://v3-cinemeta.strem.io'

export { searchAllSources as searchTorrents, listEnabledSources } from './torrent-sources.js'
export { episodePattern, infoHashFromMagnet } from './torrent-sources.js'

async function cinemetaFetch (url) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'StreamVault/1.0' },
  })
  if (!res.ok) throw new Error(`Cinemeta ${res.status}`)
  return res.json()
}

const CATALOG_ROWS = [
  { key: 'popular', id: 'top', label: 'Popular' },
  { key: 'top', id: 'imdbRating', label: 'Top' },
  { key: 'trending', id: 'trending', label: 'Trending' },
  { key: 'new', id: 'year', label: 'New' },
]

function normalizeMetas (metas, limit = 24) {
  const seen = new Set()
  const out = []
  for (const m of metas || []) {
    if (!m?.id || seen.has(m.id) || !m.poster?.startsWith('http')) continue
    seen.add(m.id)
    out.push(m)
    if (out.length >= limit) break
  }
  return out
}

function catalogUrl (type, id, extra) {
  const extraPath = extra ? `/${extra}` : ''
  return `${CINEMETA}/catalog/${type}/${id}${extraPath}.json`
}

export async function fetchCatalog (type, catalogId, extra = null) {
  const data = await cinemetaFetch(catalogUrl(type, catalogId, extra))
  return normalizeMetas(data.metas)
}

export async function getDefaultCatalogs (type = 'all') {
  const year = String(new Date().getFullYear())
  const types = type === 'all'
    ? ['movie', 'series']
    : [type === 'series' ? 'series' : 'movie']
  const jobs = []
  for (const contentType of types) {
    const suffix = contentType === 'series' ? 'TV Shows' : 'Movies'
    for (const row of CATALOG_ROWS) {
      const extra = row.key === 'new' ? `genre=${year}` : null
      jobs.push(
        fetchCatalog(contentType, row.id, extra).then(metas => ({
          key: row.key,
          title: `${row.label} · ${suffix}`,
          type: contentType,
          metas,
        })),
      )
    }
  }
  const settled = await Promise.allSettled(jobs)
  return settled
    .filter(r => r.status === 'fulfilled' && r.value.metas.length)
    .map(r => r.value)
}

export async function searchCatalog (query, type = 'all') {
  const q = encodeURIComponent(query.trim())
  const jobs = []
  if (type === 'all' || type === 'series') {
    jobs.push(cinemetaFetch(`${CINEMETA}/catalog/series/top/search=${q}.json`))
  }
  if (type === 'all' || type === 'movie') {
    jobs.push(cinemetaFetch(`${CINEMETA}/catalog/movie/top/search=${q}.json`))
  }
  const results = await Promise.allSettled(jobs)
  const metas = []
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value?.metas) metas.push(...r.value.metas)
  }
  const seen = new Set()
  return metas.filter(m => {
    if (!m?.id || seen.has(m.id)) return false
    seen.add(m.id)
    return m.poster?.startsWith('http')
  })
}

export async function getMeta (type, id) {
  const t = type === 'series' ? 'series' : 'movie'
  const data = await cinemetaFetch(`${CINEMETA}/meta/${t}/${id}.json`)
  if (!data?.meta) throw new Error('Not found')
  return data.meta
}

export function buildEpisodeQuery (showName, season, episode) {
  const s = String(season).padStart(2, '0')
  const e = String(episode).padStart(2, '0')
  return `${showName} S${s}E${e}`
}

export function buildMovieQuery (title, year) {
  return year ? `${title} ${year}` : title
}

export function groupEpisodesBySeason (videos) {
  const seasons = {}
  for (const v of videos || []) {
    const sn = v.season ?? 0
    if (!seasons[sn]) seasons[sn] = []
    seasons[sn].push({
      season: sn,
      episode: v.episode ?? v.number,
      title: v.name || v.title || `Episode ${v.episode ?? v.number}`,
      thumbnail: v.thumbnail || null,
      overview: v.overview || v.description || '',
      id: v.id,
    })
  }
  for (const sn of Object.keys(seasons)) {
    seasons[sn].sort((a, b) => a.episode - b.episode)
  }
  return seasons
}
