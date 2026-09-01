import { spawn, execSync } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import https from 'https'
import http from 'http'
import { join } from 'path'
import type { RouteMount } from './routes'
import { requirePost, withJsonBody } from './http'
import { bodyNumber, bodyString, decodeBodyChunks } from '../src/dev/http-body'
import {
  parseBraveResults,
  parseDdgHtmlResults,
  parseSearxngResults,
  parseTavilyResults,
  parseWikipediaResults,
  type WebSearchResult,
} from '../src/dev/web-search-parse'

/**
 * Websuche und die SearXNG-Instanz darunter.
 *
 * Zusammen, weil `searxngAvailable` sie verbindet: der Status-Endpunkt meldet
 * das Flag, der Installer setzt es, und die Suchkette liest es als erste Stufe.
 * Getrennt gelegt müsste dieses Flag exportiert werden — ein veränderlicher
 * Wert über Modulgrenzen hinweg.
 */
export function registerWebSearchRoutes(routes: RouteMount): void {
  // --- SearXNG availability check ---
  let searxngAvailable = false
  const checkSearXNG = () => {
    const checkReq = http.get('http://localhost:8888/search?q=test&format=json', { timeout: 2000 }, (response) => {
      searxngAvailable = response.statusCode === 200
      console.log('[WebSearch] SearXNG ' + (searxngAvailable ? 'detected and available' : 'responded but returned non-200'))
      response.resume()
    })
    checkReq.on('error', () => {
      searxngAvailable = false
      console.log('[WebSearch] SearXNG not available (connection refused or timeout)')
    })
    checkReq.on('timeout', () => {
      checkReq.destroy()
      searxngAvailable = false
      console.log('[WebSearch] SearXNG not available (timeout)')
    })
  }
  checkSearXNG()

  // API: Search status (for frontend to check SearXNG availability)
  routes.use('/local-api/search-status', (req, res) => {
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ searxng: searxngAvailable }))
  })


  // --- SearXNG One-Click Install ---
  const searxngInstallLogs: string[] = []
  let searxngInstallStatus: "idle" | "installing" | "complete" | "error" = "idle"
  let searxngInstallError = ""

  routes.use("/local-api/install-searxng", (req, res) => {
    if (req.method === "GET") {
      // Check Docker availability and container status
      let dockerAvailable = false
      let installed = false
      let running = false
      try {
        execSync("docker --version", { stdio: "ignore" })
        dockerAvailable = true
        try {
          const containerStatus = execSync("docker ps -a --filter name=^searxng$ --format \"{{.Status}}\"", { encoding: "utf8" }).trim()
          if (containerStatus) {
            installed = true
            running = containerStatus.toLowerCase().startsWith("up")
          }
        } catch { /* no container */ }
      } catch { /* no docker */ }

      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({
        installed,
        running,
        dockerAvailable,
        status: searxngInstallStatus,
        error: searxngInstallError,
        logs: searxngInstallLogs.slice(-30),
      }))
      return
    }
    if (req.method !== "POST") { res.writeHead(405); res.end(); return }

    if (searxngInstallStatus === "installing") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ status: "already_installing" }))
      return
    }

    // Check if Docker is available
    let postHasDocker = false
    try {
      execSync("docker --version", { stdio: "ignore" })
      postHasDocker = true
    } catch { /* no docker */ }

    if (!postHasDocker) {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "Docker is required for SearXNG. Install Docker first.", dockerMissing: true }))
      return
    }

    // Check if container already exists but is stopped — just restart it
    try {
      const existingStatus = execSync("docker ps -a --filter name=^searxng$ --format \"{{.Status}}\"", { encoding: "utf8" }).trim()
      if (existingStatus && !existingStatus.toLowerCase().startsWith("up")) {
        execSync("docker start searxng", { stdio: "ignore" })
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ status: "ok", message: "SearXNG restarted on port 8888" }))
        // Re-check availability after a short delay
        setTimeout(() => checkSearXNG(), 3000)
        return
      }
    } catch { /* no existing container */ }

    searxngInstallStatus = "installing"
    searxngInstallError = ""
    searxngInstallLogs.length = 0

    const home = process.env.HOME || ""
    const searxngDir = join(home, "searxng")

    const log = (msg: string) => {
      searxngInstallLogs.push(msg)
      if (searxngInstallLogs.length > 200) searxngInstallLogs.shift()
      console.log("[SearXNG Install] " + msg)
    }

    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ status: "started", path: searxngDir }))

    // Run installation in background
    ;(async () => {
      try {
        // Create directory
        if (!existsSync(searxngDir)) {
          mkdirSync(searxngDir, { recursive: true })
          log("Created directory: " + searxngDir)
        }

        log("Pulling SearXNG image...")
        const pull = spawn("docker", ["pull", "searxng/searxng"], { shell: true, stdio: ["ignore", "pipe", "pipe"] })
        pull.stdout?.on("data", (d) => log(d.toString().trim()))
        pull.stderr?.on("data", (d) => log(d.toString().trim()))
        await new Promise<void>((resolve, reject) => {
          pull.on("exit", (code) => code === 0 ? resolve() : reject(new Error("docker pull failed (exit " + code + ")")))
        })
        log("Pull complete. Starting SearXNG container...")

        // Remove existing container if any
        try { execSync("docker rm -f searxng", { stdio: "ignore" }) } catch { /* no existing container */ }

        const run = spawn("docker", [
          "run", "-d", "--name", "searxng",
          "-p", "8888:8080",
          "-e", "SEARXNG_BASE_URL=http://localhost:8888",
          "--restart", "unless-stopped",
          "searxng/searxng",
        ], { shell: true, stdio: ["ignore", "pipe", "pipe"] })
        run.stdout?.on("data", (d) => log(d.toString().trim()))
        run.stderr?.on("data", (d) => log(d.toString().trim()))
        await new Promise<void>((resolve, reject) => {
          run.on("exit", (code) => code === 0 ? resolve() : reject(new Error("docker run failed (exit " + code + ")")))
        })
        log("SearXNG container started on port 8888.")

        // Wait a moment then re-check availability
        await new Promise((r) => setTimeout(r, 3000))
        checkSearXNG()
        log("SearXNG installed and running via Docker!")
        searxngInstallStatus = "complete"
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log("ERROR: " + msg)
        searxngInstallError = msg
        searxngInstallStatus = "error"
      }
    })()
  })

  // API: Multi-tier web search (Brave/Tavily > SearXNG > DDG > Wikipedia)
  routes.use('/local-api/web-search', (req, res) => {
    if (!requirePost(req, res)) return
    withJsonBody(req, res, (body) => {
      try {
        const query = bodyString(body, 'query')
        const provider = bodyString(body, 'provider')
        const braveApiKey = bodyString(body, 'braveApiKey')
        const tavilyApiKey = bodyString(body, 'tavilyApiKey')
        if (!query) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Missing query parameter' }))
          return
        }

        const maxResults = bodyNumber(body, 'count') || 5

        // Fremde JSON-Antwort: `unknown` bis die Auswerter in
        // src/dev/web-search-parse.ts sie geprüft haben.
        const fetchJSON = (url: string): Promise<unknown> => {
          return new Promise((resolve, reject) => {
            const proto = url.startsWith('https') ? https : http
            const httpReq = proto.get(url, { headers: { 'User-Agent': 'locally-uncensored/1.0', 'Accept': 'application/json' }, timeout: 8000 }, (response) => {
              if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                fetchJSON(response.headers.location).then(resolve, reject)
                return
              }
              if (response.statusCode !== 200) {
                reject(new Error('HTTP ' + response.statusCode))
                response.resume()
                return
              }
              const chunks: Buffer[] = []
              response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
              response.on('end', () => {
                try { resolve(JSON.parse(decodeBodyChunks(chunks))) } catch (e) { reject(e) }
              })
            })
            httpReq.on('error', reject)
            httpReq.on('timeout', () => { httpReq.destroy(); reject(new Error('timeout')) })
          })
        }

        // Die fünf Auswerter liegen in src/dev/web-search-parse.ts neben
        // ihrem Test — bis hierher ist jede dieser Antworten `unknown`.
        const tierEmpty = (tier: string): Error => new Error(tier + ' returned no results')

        // Tier 1: SearXNG (local instance)
        const trySearXNG = (): Promise<WebSearchResult[]> => {
          if (!searxngAvailable) return Promise.reject(new Error('SearXNG not available'))
          const searxUrl = 'http://localhost:8888/search?q=' + encodeURIComponent(query) + '&format=json'
          return fetchJSON(searxUrl).then((data) => {
            const results = parseSearxngResults(data, maxResults)
            if (results.length === 0) throw tierEmpty('SearXNG')
            console.log('[WebSearch] SearXNG returned ' + results.length + ' results')
            return results
          })
        }

        // Tier 2: DuckDuckGo HTML search (POST, returns current results)
        const tryDDGHTML = (): Promise<WebSearchResult[]> => {
          return new Promise((resolve, reject) => {
            const postData = 'q=' + encodeURIComponent(query)
            const options = {
              hostname: 'html.duckduckgo.com',
              port: 443,
              path: '/html/',
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData),
                'User-Agent': 'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html',
                'Accept-Language': 'en-US,en;q=0.9',
              },
              timeout: 10000,
            }
            const httpReq = https.request(options, (response) => {
              if (response.statusCode !== 200) {
                response.resume()
                reject(new Error('DDG HTML returned HTTP ' + response.statusCode))
                return
              }
              const chunks: Buffer[] = []
              response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
              response.on('end', () => {
                try {
                  const results = parseDdgHtmlResults(decodeBodyChunks(chunks), maxResults)
                  if (results.length === 0) throw new Error('DDG HTML returned no parseable results')
                  console.log('[WebSearch] DDG HTML returned ' + results.length + ' results')
                  resolve(results)
                } catch (e) {
                  reject(e instanceof Error ? e : new Error(String(e)))
                }
              })
            })
            httpReq.on('error', reject)
            httpReq.on('timeout', () => { httpReq.destroy(); reject(new Error('DDG HTML timeout')) })
            httpReq.write(postData)
            httpReq.end()
          })
        }

        // Tier: Brave Search API (needs API key)
        const tryBrave = (): Promise<WebSearchResult[]> => {
          if (!braveApiKey) return Promise.reject(new Error('No Brave API key'))
          const braveUrl = 'https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(query) + '&count=' + maxResults
          return new Promise((resolve, reject) => {
            const httpReq = https.get(braveUrl, {
              headers: { 'Accept': 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': braveApiKey },
              timeout: 8000,
            }, (response) => {
              if (response.statusCode !== 200) { response.resume(); reject(new Error('Brave HTTP ' + response.statusCode)); return }
              const chunks: Buffer[] = []
              response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
              response.on('end', () => {
                try {
                  const results = parseBraveResults(JSON.parse(decodeBodyChunks(chunks)), maxResults)
                  if (results.length === 0) throw tierEmpty('Brave')
                  console.log('[WebSearch] Brave returned ' + results.length + ' results')
                  resolve(results)
                } catch (e) { reject(e instanceof Error ? e : new Error(String(e))) }
              })
            })
            httpReq.on('error', reject)
            httpReq.on('timeout', () => { httpReq.destroy(); reject(new Error('Brave timeout')) })
          })
        }

        // Tier: Tavily Search API (needs API key, optimized for AI agents)
        const tryTavily = (): Promise<WebSearchResult[]> => {
          if (!tavilyApiKey) return Promise.reject(new Error('No Tavily API key'))
          return new Promise((resolve, reject) => {
            const postData = JSON.stringify({ api_key: tavilyApiKey, query, max_results: maxResults, search_depth: 'basic' })
            const httpReq = https.request({
              hostname: 'api.tavily.com', path: '/search', method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
              timeout: 10000,
            }, (response) => {
              if (response.statusCode !== 200) { response.resume(); reject(new Error('Tavily HTTP ' + response.statusCode)); return }
              const chunks: Buffer[] = []
              response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
              response.on('end', () => {
                try {
                  const results = parseTavilyResults(JSON.parse(decodeBodyChunks(chunks)), maxResults)
                  if (results.length === 0) throw tierEmpty('Tavily')
                  console.log('[WebSearch] Tavily returned ' + results.length + ' results')
                  resolve(results)
                } catch (e) { reject(e instanceof Error ? e : new Error(String(e))) }
              })
            })
            httpReq.on('error', reject)
            httpReq.on('timeout', () => { httpReq.destroy(); reject(new Error('Tavily timeout')) })
            httpReq.write(postData)
            httpReq.end()
          })
        }

        // Tier 3: Wikipedia API (always works)
        const tryWikipedia = (): Promise<WebSearchResult[]> => {
          const wikiUrl = 'https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=' + encodeURIComponent(query) + '&format=json&srlimit=' + maxResults + '&utf8=1'
          return fetchJSON(wikiUrl).then((data) => {
            const results = parseWikipediaResults(data, maxResults)
            if (results.length === 0) throw tierEmpty('Wikipedia')
            console.log('[WebSearch] Wikipedia returned ' + results.length + ' results')
            return results
          })
        }

        // Execute tiers based on provider setting
        const searchChain = (): Promise<WebSearchResult[]> => {
          if (provider === 'brave') return tryBrave().catch(() => trySearXNG()).catch(() => tryDDGHTML()).catch(() => tryWikipedia())
          if (provider === 'tavily') return tryTavily().catch(() => trySearXNG()).catch(() => tryDDGHTML()).catch(() => tryWikipedia())
          // 'auto': SearXNG > Brave (if key) > Tavily (if key) > DDG > Wikipedia
          return trySearXNG()
            .catch(() => braveApiKey ? tryBrave() : Promise.reject(new Error('no brave key')))
            .catch(() => tavilyApiKey ? tryTavily() : Promise.reject(new Error('no tavily key')))
            .catch(() => tryDDGHTML())
            .catch(() => tryWikipedia())
        }
        searchChain()
          .then((results) => {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ results }))
          })
          .catch((err) => {
            console.error('[WebSearch] All tiers failed:', (err as Error).message)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ results: [], error: 'All search tiers failed: ' + (err as Error).message }))
          })
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: String(err) }))
      }
    })
  })
}
