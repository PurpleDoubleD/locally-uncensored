// @vitest-environment jsdom
//
// The handbook on locallyuncensored.com is one hub page plus one page per
// chapter under docs/guide/. Every chapter page links back to the hub, every
// page carries a JSON-LD block that parses, and the sitemap names every page.
// Without this file a chapter could vanish, or lose its way back to the hub,
// and nothing would notice until a reader did.
import { existsSync, readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const CHAPTERS = [
  'what-it-is', 'install', 'first-start', 'chat', 'agent', 'code', 'create',
  'cloud', 'settings-and-troubleshooting', 'faq-and-glossary',
] as const

/** The step by step guides under the chapters (community questions, 3.0.6). */
const GUIDES = ['beginners', 'agent-sandbox', 'character-studio', 'remote-access-setup', 'storage', 'hugging-face'] as const

const parse = (path: string) => new DOMParser().parseFromString(readFileSync(path, 'utf8'), 'text/html')

it('the hub page lists every chapter', () => {
  const hub = parse('docs/guide/index.html')
  expect(hub.querySelector('article[data-handbook-hub]')).not.toBeNull()
  const listed = [...hub.querySelectorAll('.post-card[data-handbook-chapter]')].map((el) => el.getAttribute('data-handbook-chapter'))
  expect(listed).toEqual([...CHAPTERS])
  for (const slug of CHAPTERS) {
    expect(hub.querySelector(`a[href="/guide/${slug}/"]`), slug).not.toBeNull()
  }
})

it('every chapter page exists, links back to the hub, and carries parseable JSON-LD', () => {
  for (const slug of CHAPTERS) {
    const path = `docs/guide/${slug}/index.html`
    expect(existsSync(path), path).toBe(true)
    const page = parse(path)
    expect(page.querySelector(`article[data-handbook-chapter="${slug}"]`), slug).not.toBeNull()
    expect(page.querySelector('a[href="/guide/"]'), `${slug} has no link to the hub`).not.toBeNull()
    expect(page.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(`https://locallyuncensored.com/guide/${slug}/`)
    const blocks = [...page.querySelectorAll('script[type="application/ld+json"]')]
    expect(blocks.length, slug).toBeGreaterThan(0)
    for (const block of blocks) {
      const ld = JSON.parse(block.textContent!)
      expect(['TechArticle', 'BreadcrumbList'], slug).toContain(ld['@type'])
      if (ld['@type'] === 'BreadcrumbList') continue
      expect(ld.isPartOf?.url, slug).toBe('https://locallyuncensored.com/guide/')
    }
    const description = page.querySelector('meta[name="description"]')!.getAttribute('content')
    expect(page.querySelector('meta[property="og:description"]')!.getAttribute('content'), slug).toBe(description)
    expect(description, slug).not.toMatch(/[–—]/u)
  }
})

it('the sitemap names the hub and every chapter', () => {
  const sitemap = readFileSync('docs/sitemap.xml', 'utf8')
  expect(sitemap).toContain('<loc>https://locallyuncensored.com/guide/</loc>')
  for (const slug of CHAPTERS) {
    expect(sitemap, slug).toContain(`<loc>https://locallyuncensored.com/guide/${slug}/</loc>`)
  }
})

it('no handbook page carries an em or en dash', () => {
  for (const path of ['docs/guide/index.html', ...CHAPTERS.map((s) => `docs/guide/${s}/index.html`)]) {
    expect(readFileSync(path, 'utf8'), path).not.toMatch(/[–—]|&[mn]dash;/u)
  }
})

it('the hub page lists every step by step guide, and each one is a full handbook page', () => {
  const hub = parse('docs/guide/index.html')
  const listed = [...hub.querySelectorAll('.post-card[data-handbook-guide]')].map((el) => el.getAttribute('data-handbook-guide'))
  expect(listed).toEqual([...GUIDES])
  const sitemap = readFileSync('docs/sitemap.xml', 'utf8')
  for (const slug of GUIDES) {
    const path = `docs/guide/${slug}/index.html`
    expect(existsSync(path), path).toBe(true)
    const page = parse(path)
    expect(page.querySelector(`article[data-handbook-guide="${slug}"]`), slug).not.toBeNull()
    expect(page.querySelector('a[href="/guide/"]'), `${slug} has no link to the hub`).not.toBeNull()
    expect(page.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(`https://locallyuncensored.com/guide/${slug}/`)
    for (const block of page.querySelectorAll('script[type="application/ld+json"]')) {
      const ld = JSON.parse(block.textContent!)
      if (ld['@type'] === 'TechArticle') expect(ld.url, slug).toBe(`https://locallyuncensored.com/guide/${slug}/`)
    }
    const description = page.querySelector('meta[name="description"]')!.getAttribute('content')
    expect(page.querySelector('meta[property="og:description"]')!.getAttribute('content'), slug).toBe(description)
    expect(readFileSync(path, 'utf8'), path).not.toMatch(/[\u2013\u2014]|&[mn]dash;/u)
    expect(sitemap, slug).toContain(`<loc>https://locallyuncensored.com/guide/${slug}/</loc>`)
  }
})
