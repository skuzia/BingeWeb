/**
 * Online subtitle search — Wyzie Subs aggregator (OpenSubtitles, SubDL, etc.)
 * Free API key: https://store.wyzie.io/redeem
 */

const WYZIE_BASE = 'https://sub.wyzie.io'
const DEFAULT_WYZIE_API_KEY = 'wyzie-ublul4vcrogxaf7fuva7dhbl2m16b5sm'

export function srtToVtt (srt) {
  return 'WEBVTT\n\n' + srt
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
    .replace(/^\d+\n/gm, '')
}

const LANG_NAMES = {
  en: 'English', he: 'Hebrew', es: 'Spanish', fr: 'French', de: 'German',
  it: 'Italian', pt: 'Portuguese', ru: 'Russian', ar: 'Arabic', ja: 'Japanese',
  ko: 'Korean', zh: 'Chinese', nl: 'Dutch', pl: 'Polish', tr: 'Turkish',
  sv: 'Swedish', no: 'Norwegian', da: 'Danish', fi: 'Finnish', cs: 'Czech',
  hu: 'Hungarian', ro: 'Romanian', el: 'Greek', th: 'Thai', vi: 'Vietnamese',
  id: 'Indonesian', hi: 'Hindi', uk: 'Ukrainian',
}

export function languageLabel (code) {
  if (!code) return 'Unknown'
  const c = code.toLowerCase().split('-')[0]
  return LANG_NAMES[c] || code.toUpperCase()
}

function normalizeWyzieItem (item) {
  return {
    id: item.id || item.url || item.link,
    url: item.url || item.link || item.download_url,
    language: (item.language || item.lang || 'und').toLowerCase(),
    languageLabel: item.display || item.languageLabel || languageLabel(item.language || item.lang),
    format: (item.format || 'srt').toLowerCase(),
    source: item.source || item.provider || '',
    hearingImpaired: !!(item.hi || item.hearing_impaired),
    release: item.release || '',
  }
}

export async function searchSubtitles ({
  imdbId,
  season,
  episode,
  languages = [],
  apiKey,
}) {
  const key = apiKey || process.env.WYZIE_API_KEY || DEFAULT_WYZIE_API_KEY
  if (!key) {
    throw new Error('Wyzie API key required — get a free key at store.wyzie.io/redeem and add it in Settings or set WYZIE_API_KEY on the server')
  }
  if (!imdbId) throw new Error('IMDB id required for subtitle search')

  const params = new URLSearchParams({ id: imdbId, key, format: 'srt' })
  if (season != null) params.set('season', String(season))
  if (episode != null) params.set('episode', String(episode))
  if (languages.length) params.set('language', languages.join(','))

  const res = await fetch(`${WYZIE_BASE}/search?${params}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'StreamVault/1.0' },
  })

  if (res.status === 401) {
    throw new Error('Invalid Wyzie API key — check Settings or WYZIE_API_KEY')
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Subtitle search failed (${res.status})${text ? ': ' + text.slice(0, 120) : ''}`)
  }

  const data = await res.json()
  const raw = Array.isArray(data) ? data : (data.subtitles || data.results || data.data || [])
  const subs = raw.map(normalizeWyzieItem).filter(s => s.url)

  // Prefer requested languages first, then sort by language name
  if (languages.length) {
    const pref = languages.map(l => l.toLowerCase())
    subs.sort((a, b) => {
      const ai = pref.indexOf(a.language.split('-')[0])
      const bi = pref.indexOf(b.language.split('-')[0])
      const as = ai === -1 ? 999 : ai
      const bs = bi === -1 ? 999 : bi
      return as - bs || a.languageLabel.localeCompare(b.languageLabel)
    })
  }

  return subs
}

export async function fetchSubtitleVtt (url, language) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'StreamVault/1.0' },
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`Failed to download subtitle (${res.status})`)

  const buf = await res.arrayBuffer()
  const bytes = new Uint8Array(buf)

  const lang = (language || '').toLowerCase().split('-')[0]
  const preferHebrew = lang === 'he' || lang === 'iw'

  let text = decodeSubtitleBytes(bytes, preferHebrew)

  const trimmed = text.trim()
  if (trimmed.startsWith('WEBVTT')) return trimmed
  return srtToVtt(trimmed)
}

function decodeSubtitleBytes (bytes, preferHebrew) {
  const encodings = preferHebrew
    ? ['utf-8', 'windows-1255', 'iso-8859-8', 'windows-1252', 'latin1']
    : ['utf-8', 'windows-1255', 'iso-8859-8', 'windows-1252', 'latin1']

  let best = ''
  let bestScore = Infinity

  for (const enc of encodings) {
    try {
      const text = new TextDecoder(enc, { fatal: enc !== 'utf-8' }).decode(bytes)
      const replacements = (text.match(/\uFFFD/g) || []).length
      const hebrew = (text.match(/[\u0590-\u05FF]/g) || []).length
      const score = replacements * 10 - hebrew
      if (score < bestScore) {
        bestScore = score
        best = text
      }
      if (enc === 'utf-8' && replacements === 0) return text
      if (preferHebrew && hebrew > 2 && replacements === 0) return text
    } catch {}
  }

  if (best) return best
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

/** Parse S01E02 from release name */
export function parseEpisodeFromTitle (title) {
  if (!title) return null
  const m = title.match(/[Ss](\d{1,2})[Ee](\d{1,2})/)
  if (!m) return null
  return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10) }
}

export async function resolveImdbFromTitle (title) {
  const clean = title.replace(/[._-]/g, ' ').replace(/\s+/g, ' ').trim()
  const showPart = clean.replace(/\s*[Ss]\d{1,2}[Ee]\d{1,2}.*/i, '').trim()
  const q = encodeURIComponent(showPart || clean)
  for (const type of ['series', 'movie']) {
    try {
      const res = await fetch(`https://v3-cinemeta.strem.io/catalog/${type}/top/search=${q}.json`)
      if (!res.ok) continue
      const data = await res.json()
      const hit = data.metas?.[0]
      if (hit?.id) return { imdbId: hit.id, type: hit.type, title: hit.name }
    } catch {}
  }
  return null
}
