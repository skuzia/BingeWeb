import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { spawn, exec } from 'child_process'
import { promisify } from 'util'
import { Readable } from 'stream'
import { finished } from 'stream/promises'

const execPromise = promisify(exec)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FS_DIR = path.join(__dirname, '.flaresolverr')

async function isRunning() {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2000)
    const res = await fetch('http://localhost:8191/', { signal: controller.signal })
    clearTimeout(timeout)
    return res.status === 200 || res.ok
  } catch (e) {
    return false
  }
}

async function downloadFile(url, dest) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to download: HTTP ${res.status}`)
  const fileStream = fs.createWriteStream(dest)
  if (!res.body) throw new Error('Response body is empty')
  await finished(Readable.fromWeb(res.body).pipe(fileStream))
}

function getPlatformConfig() {
  const platform = os.platform()
  const arch = os.arch()
  
  if (platform === 'win32') {
    return {
      url: 'https://github.com/FlareSolverr/FlareSolverr/releases/download/v3.3.21/flaresolverr_windows_x64.zip',
      filename: 'flaresolverr.zip',
      exeName: 'flaresolverr.exe',
      extractCmd: (zipPath, destDir) => `powershell -Command "Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${destDir}'"`
    }
  } else if (platform === 'darwin') {
    return {
      url: 'https://github.com/FlareSolverr/FlareSolverr/releases/download/v3.3.21/flaresolverr_macos_x64.zip',
      filename: 'flaresolverr.zip',
      exeName: 'flaresolverr',
      extractCmd: (zipPath, destDir) => `unzip -o "${zipPath}" -d "${destDir}"`
    }
  } else if (platform === 'linux') {
    return {
      url: 'https://github.com/FlareSolverr/FlareSolverr/releases/download/v3.3.21/flaresolverr_linux_x64.tar.gz',
      filename: 'flaresolverr.tar.gz',
      exeName: 'flaresolverr',
      extractCmd: (tarPath, destDir) => `tar -xzf "${tarPath}" -C "${destDir}"`
    }
  }
  return null
}

function findExecutable(dir, exeName) {
  let checkPath = path.join(dir, exeName)
  if (fs.existsSync(checkPath)) return checkPath
  
  checkPath = path.join(dir, 'flaresolverr', exeName)
  if (fs.existsSync(checkPath)) return checkPath
  
  return null
}

export async function ensureFlareSolverr() {
  if (await isRunning()) {
    console.log('✅ FlareSolverr is already running on http://localhost:8191')
    process.env.FLARESOLVERR_URL = 'http://localhost:8191'
    return
  }

  const config = getPlatformConfig()
  if (!config) {
    console.log('⚠️ Unsupported platform for automated FlareSolverr installation.')
    return
  }

  if (!fs.existsSync(FS_DIR)) {
    fs.mkdirSync(FS_DIR, { recursive: true })
  }

  const exePath = findExecutable(FS_DIR, config.exeName)
  if (!exePath) {
    console.log(`📥 FlareSolverr not found. Downloading v3.3.21 for ${os.platform()}...`)
    const downloadPath = path.join(FS_DIR, config.filename)
    try {
      await downloadFile(config.url, downloadPath)
      console.log('📦 Extracting FlareSolverr...')
      await execPromise(config.extractCmd(downloadPath, FS_DIR))
      
      // Clean up zip/tar file
      try { fs.unlinkSync(downloadPath) } catch (e) {}
      console.log('✅ FlareSolverr extracted successfully.')
    } catch (err) {
      console.error('❌ Failed to download or extract FlareSolverr:', err.message)
      return
    }
  }

  // Force FlareSolverr to use modern system Chrome if installed
  const systemChrome = os.platform() === 'win32' ? [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe')
  ].find(fs.existsSync) : null

  if (systemChrome) {
    const paths = [
      path.join(FS_DIR, 'chrome'),
      path.join(FS_DIR, 'flaresolverr', 'chrome')
    ]
    for (const p of paths) {
      if (fs.existsSync(p)) {
        try {
          fs.renameSync(p, p + '_bak')
          console.log(`🔄 Disabled bundled FlareSolverr Chrome at ${p} to prioritize system Chrome.`)
        } catch (e) {
          // ignore lock errors if it's already running
        }
      }
    }
  }

  const finalExePath = findExecutable(FS_DIR, config.exeName)
  if (!finalExePath) {
    console.error('❌ FlareSolverr executable could not be located after extraction.')
    return
  }

  console.log(`🚀 Starting FlareSolverr from: ${finalExePath}`)
  
  // Set permissions for Unix platforms
  if (os.platform() !== 'win32') {
    try {
      fs.chmodSync(finalExePath, '755')
    } catch (e) {}
  }

  const logFile = path.join(FS_DIR, 'flaresolverr-app.log')
  let outFd, errFd
  try {
    outFd = fs.openSync(logFile, 'a')
    errFd = fs.openSync(logFile, 'a')
  } catch (e) {
    console.error('⚠️ Could not open FlareSolverr log file:', e.message)
  }

  const env = { 
    ...process.env, 
    PORT: '8191', 
    LOG_LEVEL: 'info', 
    LANG: 'en_US.UTF-8', 
    LANGUAGE: 'en_US:en' 
  }
  if (systemChrome) {
    console.log(`🔍 Found system Google Chrome at: ${systemChrome}. Using it in FlareSolverr for Turnstile compatibility.`)
    env.CHROME_EXE_PATH = systemChrome
  }

  const child = spawn(finalExePath, [], {
    detached: true,
    stdio: outFd && errFd ? ['ignore', outFd, errFd] : 'ignore',
    env
  })

  child.unref()

  // Wait a few seconds for it to bind to port
  for (let i = 0; i < 10; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    if (await isRunning()) {
      console.log('✅ FlareSolverr started successfully and running on http://localhost:8191')
      process.env.FLARESOLVERR_URL = 'http://localhost:8191'
      
      // Clean shutdown of FlareSolverr on parent exit
      process.on('exit', () => {
        try { child.kill() } catch (e) {}
      })
      process.on('SIGINT', () => {
        try { child.kill() } catch (e) {}
        process.exit()
      })
      process.on('SIGTERM', () => {
        try { child.kill() } catch (e) {}
        process.exit()
      })
      
      return
    }
  }

  console.error('❌ FlareSolverr process started, but did not respond on http://localhost:8191 in time.')
}
