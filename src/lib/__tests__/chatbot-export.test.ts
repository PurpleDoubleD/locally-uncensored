// Feature CC v2.5.0 — chatbot export parser tests. Each schema fixture is a
// minimal real-world shape (verified against actual exports during the dev
// session) trimmed to one or two messages so the tests stay readable.

import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { parseJsonText, parseExportFile, detectPlatform } from '../parsers/chatbot-export'

const chatgptFixture = JSON.stringify([
  {
    title: 'Recipes for pasta',
    create_time: 1700000000.0,
    update_time: 1700001000.0,
    mapping: {
      root: { id: 'root', message: null, parent: null, children: ['u1'] },
      u1: {
        id: 'u1',
        message: {
          id: 'u1',
          author: { role: 'user' },
          create_time: 1700000010.0,
          content: { content_type: 'text', parts: ['Got pasta recipes?'] },
        },
        parent: 'root',
        children: ['a1'],
      },
      a1: {
        id: 'a1',
        message: {
          id: 'a1',
          author: { role: 'assistant' },
          create_time: 1700000020.0,
          content: { content_type: 'text', parts: ['Carbonara, cacio e pepe, aglio e olio.'] },
        },
        parent: 'u1',
        children: [],
      },
    },
  },
])

const claudeFixture = JSON.stringify([
  {
    uuid: 'abc-123',
    name: 'JS array methods',
    created_at: '2026-05-01T10:00:00Z',
    updated_at: '2026-05-01T10:05:00Z',
    chat_messages: [
      { uuid: 'm1', text: 'Explain map vs forEach', sender: 'human', created_at: '2026-05-01T10:00:01Z' },
      { uuid: 'm2', text: 'map returns a new array, forEach returns undefined.', sender: 'assistant', created_at: '2026-05-01T10:00:30Z' },
    ],
  },
])

const geminiFixture = JSON.stringify([
  {
    header: 'Gemini Apps',
    title: 'Asked Gemini about quantum entanglement',
    time: '2026-04-12T15:23:00Z',
    messages: [
      { role: 'user', text: 'What is quantum entanglement?' },
      { role: 'assistant', text: 'Two particles linked such that one\'s state correlates with the other.' },
    ],
  },
])

describe('detectPlatform', () => {
  it('detects ChatGPT exports by the mapping field', () => {
    expect(detectPlatform(JSON.parse(chatgptFixture))).toBe('chatgpt')
  })
  it('detects Claude exports by the chat_messages field', () => {
    expect(detectPlatform(JSON.parse(claudeFixture))).toBe('claude')
  })
  it('detects Gemini exports by the Gemini Apps header', () => {
    expect(detectPlatform(JSON.parse(geminiFixture))).toBe('gemini')
  })
  it('falls back to unknown for foreign shapes', () => {
    expect(detectPlatform({ foo: 'bar' })).toBe('unknown')
    expect(detectPlatform([])).toBe('unknown')
    expect(detectPlatform(null)).toBe('unknown')
  })
})

describe('parseJsonText — ChatGPT', () => {
  it('extracts title + user + assistant turn in order', () => {
    const result = parseJsonText(chatgptFixture)
    expect(result.detectedPlatform).toBe('chatgpt')
    expect(result.conversations).toHaveLength(1)
    const c = result.conversations[0]
    expect(c.title).toBe('Recipes for pasta')
    expect(c.platform).toBe('chatgpt')
    expect(c.messageCount).toBe(2)
    expect(c.markdown).toContain('# Recipes for pasta')
    expect(c.markdown).toContain('**You**')
    expect(c.markdown).toContain('Got pasta recipes?')
    expect(c.markdown).toContain('**Assistant**')
    expect(c.markdown).toContain('Carbonara, cacio e pepe, aglio e olio.')
  })
  it('skips empty mapping conversations', () => {
    const empty = JSON.stringify([{ title: 'empty', mapping: {} }])
    const r = parseJsonText(empty)
    expect(r.conversations).toHaveLength(0)
    expect(r.skipped).toBeGreaterThan(0)
  })
})

describe('parseJsonText — Claude', () => {
  it('extracts the chat_messages array as markdown', () => {
    const result = parseJsonText(claudeFixture)
    expect(result.detectedPlatform).toBe('claude')
    expect(result.conversations).toHaveLength(1)
    const c = result.conversations[0]
    expect(c.title).toBe('JS array methods')
    expect(c.messageCount).toBe(2)
    expect(c.markdown).toContain('Explain map vs forEach')
    expect(c.markdown).toContain('map returns a new array')
  })
  it('skips conversations with no messages', () => {
    const empty = JSON.stringify([{ uuid: 'x', name: 'empty', chat_messages: [] }])
    const r = parseJsonText(empty)
    expect(r.conversations).toHaveLength(0)
  })
})

// Modern Claude export: the body lives in a typed content[] block array and the
// flat `text` field is empty. The old m.text-only read imported these as
// 0-message conversations and dropped them entirely (aldrich, Discord
// 2026-06-20 "how do i import chats from claude"). Also exercises an
// attachment + non-text blocks (thinking / tool_use) that must be skipped.
const claudeContentBlocksFixture = JSON.stringify([
  {
    uuid: 'cb-1',
    name: 'Content block chat',
    created_at: '2026-06-01T10:00:00Z',
    updated_at: '2026-06-01T10:05:00Z',
    chat_messages: [
      {
        uuid: 'm1', sender: 'human', text: '',
        content: [{ type: 'text', text: 'summarize the attached file' }],
        attachments: [{ file_name: 'notes.txt', extracted_content: 'Q3 revenue rose 12 percent.' }],
      },
      {
        uuid: 'm2', sender: 'assistant', text: '',
        content: [
          { type: 'thinking', thinking: 'internal reasoning, no text field' },
          { type: 'tool_use', name: 'calc', input: { a: 1 } },
          { type: 'text', text: 'Revenue grew 12 percent in Q3.' },
        ],
      },
    ],
  },
])

describe('parseJsonText — Claude content[] blocks (modern export)', () => {
  it('imports messages whose text lives in content[] with an empty flat text field', () => {
    const r = parseJsonText(claudeContentBlocksFixture)
    expect(r.detectedPlatform).toBe('claude')
    expect(r.conversations).toHaveLength(1)
    const c = r.conversations[0]
    expect(c.messageCount).toBe(2) // would have been 0 before the content[] fix
    expect(c.markdown).toContain('summarize the attached file')
    expect(c.markdown).toContain('Revenue grew 12 percent in Q3.')
  })
  it('appends extracted attachment content with its filename', () => {
    const r = parseJsonText(claudeContentBlocksFixture)
    const md = r.conversations[0].markdown
    expect(md).toContain('[attachment: notes.txt]')
    expect(md).toContain('Q3 revenue rose 12 percent.')
  })
  it('skips non-text blocks (thinking / tool_use) without leaking them', () => {
    const r = parseJsonText(claudeContentBlocksFixture)
    const md = r.conversations[0].markdown
    expect(md).not.toContain('internal reasoning')
    expect(md).not.toContain('tool_use')
  })
  it('still handles the legacy flat-text shape', () => {
    const r = parseJsonText(claudeFixture)
    expect(r.conversations[0].messageCount).toBe(2)
    expect(r.conversations[0].markdown).toContain('Explain map vs forEach')
  })
})

describe('parseJsonText — Gemini', () => {
  it('extracts the messages array when present', () => {
    const result = parseJsonText(geminiFixture)
    expect(result.detectedPlatform).toBe('gemini')
    expect(result.conversations).toHaveLength(1)
    const c = result.conversations[0]
    expect(c.markdown).toContain('quantum entanglement')
    expect(c.markdown).toContain('**You**')
    expect(c.markdown).toContain('**Assistant**')
  })

  // Fehler 1: Gemini-Takeout-Turns, deren Text in `content` als Blockarray
  // liegt, wurden mit String(...) zu "[object Object]" verkocht und genau so
  // importiert — der echte Gesprächstext war weg, im RAG-Index stand pro Zug
  // eine Zeile "[object Object]".
  it('reads Gemini message text out of a content[] block array instead of stringifying it', () => {
    const raw = JSON.stringify([
      {
        header: 'Gemini Apps',
        title: 'Explain black holes',
        time: '2026-03-01T10:00:00Z',
        messages: [
          { role: 'user', content: [{ text: 'What is a black hole?' }] },
          { role: 'model', content: [{ text: 'A region where gravity wins.' }] },
        ],
      },
    ])
    const c = parseJsonText(raw).conversations[0]
    expect(c.markdown).not.toContain('[object Object]')
    expect(c.markdown).toContain('What is a black hole?')
    expect(c.markdown).toContain('A region where gravity wins.')
    expect(c.messageCount).toBe(2)
  })

  it('never emits [object Object] for a content field it cannot read', () => {
    const raw = JSON.stringify([
      {
        header: 'Gemini Apps',
        title: 'Only a prompt',
        messages: [{ role: 'user', content: { parts: { nested: true } } }],
      },
    ])
    const md = parseJsonText(raw).conversations.map(c => c.markdown).join('\n')
    expect(md).not.toContain('[object Object]')
  })

  it('still reads the flat string content shape', () => {
    const raw = JSON.stringify([
      { header: 'Gemini Apps', title: 'Flat', messages: [{ role: 'user', content: 'plain text turn' }] },
    ])
    expect(parseJsonText(raw).conversations[0].markdown).toContain('plain text turn')
  })
})

describe('parseJsonText — robustness', () => {
  it('returns an empty result for invalid JSON without throwing', () => {
    const r = parseJsonText('not actually json {')
    expect(r.conversations).toHaveLength(0)
    expect(r.detectedPlatform).toBe('unknown')
  })
  it('returns an empty result for empty array', () => {
    const r = parseJsonText('[]')
    expect(r.conversations).toHaveLength(0)
  })
})

// ── Regression: real-world ChatGPT export shapes (mikes_pp, Discord 2026-06-07)
// The old parser used "first parent==null node, then children[0] forever",
// which lands on the abandoned branch after a regenerate/edit and frequently
// produced 0 messages → the whole import failed with "no conversation file
// found". These fixtures exercise the visible-thread selection + content
// shapes that broke it.

// A regenerated answer: the user SAW a2 (current_node), a1 is the abandoned
// original. The walk must follow current_node, not children[0].
const chatgptBranchedFixture = JSON.stringify([
  {
    title: 'Branched chat',
    create_time: 1700000000.0,
    update_time: 1700000100.0,
    current_node: 'a2',
    mapping: {
      root: { id: 'root', message: null, parent: null, children: ['u1'] },
      u1: { id: 'u1', message: { id: 'u1', author: { role: 'user' }, content: { content_type: 'text', parts: ['What is 2+2?'] } }, parent: 'root', children: ['a1', 'a2'] },
      a1: { id: 'a1', message: { id: 'a1', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['OLD abandoned answer'] } }, parent: 'u1', children: [] },
      a2: { id: 'a2', message: { id: 'a2', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['NEW visible answer: four'] } }, parent: 'u1', children: [] },
    },
  },
])

// Multimodal user turn: parts = [image_asset_pointer object, text string].
// The image pointer carries no readable text and must be skipped, not crash.
const chatgptMultimodalFixture = JSON.stringify([
  {
    title: 'Image chat',
    create_time: 1700000000.0,
    current_node: 'a1',
    mapping: {
      root: { id: 'root', message: null, parent: null, children: ['u1'] },
      u1: { id: 'u1', message: { id: 'u1', author: { role: 'user' }, content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'file-service://abc' }, 'Describe this image'] } }, parent: 'root', children: ['a1'] },
      a1: { id: 'a1', message: { id: 'a1', author: { role: 'assistant' }, content: { content_type: 'code', text: 'It is a sunset over the sea.' } }, parent: 'u1', children: [] },
    },
  },
])

// No current_node + a regenerate: the newest (last) child is the visible one.
const chatgptNoCurrentNodeFixture = JSON.stringify([
  {
    title: 'Regenerated no current_node',
    create_time: 1700000000.0,
    mapping: {
      root: { id: 'root', message: null, parent: null, children: ['u1'] },
      u1: { id: 'u1', message: { id: 'u1', author: { role: 'user' }, content: { content_type: 'text', parts: ['Hi'] } }, parent: 'root', children: ['a1', 'a2'] },
      a1: { id: 'a1', message: { id: 'a1', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['first older'] } }, parent: 'u1', children: [] },
      a2: { id: 'a2', message: { id: 'a2', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['second newest'] } }, parent: 'u1', children: [] },
    },
  },
])

describe('parseJsonText — ChatGPT real-world mapping', () => {
  it('follows current_node to the regenerated (visible) branch, not children[0]', () => {
    const r = parseJsonText(chatgptBranchedFixture)
    expect(r.conversations).toHaveLength(1)
    const c = r.conversations[0]
    expect(c.messageCount).toBe(2)
    expect(c.markdown).toContain('What is 2+2?')
    expect(c.markdown).toContain('NEW visible answer: four')
    expect(c.markdown).not.toContain('OLD abandoned answer')
  })
  it('extracts text from multimodal parts (skips image pointers) and code content', () => {
    const r = parseJsonText(chatgptMultimodalFixture)
    expect(r.conversations).toHaveLength(1)
    const c = r.conversations[0]
    expect(c.messageCount).toBe(2)
    expect(c.markdown).toContain('Describe this image')
    expect(c.markdown).toContain('It is a sunset over the sea.')
    expect(c.markdown).not.toContain('asset_pointer')
  })
  it('falls back to the newest (last) child when current_node is absent', () => {
    const r = parseJsonText(chatgptNoCurrentNodeFixture)
    expect(r.conversations).toHaveLength(1)
    const c = r.conversations[0]
    expect(c.messageCount).toBe(2)
    expect(c.markdown).toContain('second newest')
    expect(c.markdown).not.toContain('first older')
  })
})

describe('parseExportFile — ChatGPT .zip with dated top-level folder', () => {
  // Build a zip shaped like a current OpenAI export: everything nested under a
  // dated folder, with sibling metadata files the old "largest .json" / exact
  // path lookup would trip on. Use a uint8array payload tagged with .name so
  // the test needs neither File/Blob nor FileReader (vitest env: node).
  async function makeZipFile(files: Record<string, string>, name: string): Promise<File> {
    const zip = new JSZip()
    for (const [path, content] of Object.entries(files)) zip.file(path, content)
    const buf = await zip.generateAsync({ type: 'uint8array' })
    return Object.assign(buf, { name }) as unknown as File
  }

  it('finds conversations.json nested under a dated folder, ignoring sibling json', async () => {
    const folder = '1716800000-ab12cd34ef56'
    const file = await makeZipFile({
      [`${folder}/conversations.json`]: chatgptFixture,
      [`${folder}/message_feedback.json`]: JSON.stringify([{ id: 'fb1', rating: 'thumbsUp' }]),
      [`${folder}/user.json`]: JSON.stringify({ id: 'user-1', email: 'x@y.z' }),
      [`${folder}/chat.html`]: '<html><body>export</body></html>',
    }, 'chatgpt-export.zip')
    const res = await parseExportFile(file)
    expect(res.detectedPlatform).toBe('chatgpt')
    expect(res.conversations).toHaveLength(1)
    expect(res.conversations[0].title).toBe('Recipes for pasta')
    expect(res.conversations[0].messageCount).toBe(2)
  })

  it('still finds a root-level conversations.json (older export layout)', async () => {
    const file = await makeZipFile({
      'conversations.json': chatgptFixture,
      'user.json': JSON.stringify({ id: 'user-1' }),
    }, 'old-export.zip')
    const res = await parseExportFile(file)
    expect(res.conversations).toHaveLength(1)
    expect(res.conversations[0].platform).toBe('chatgpt')
  })

  it('merges every conversations-NNN.json shard (large export split at 100 chats)', async () => {
    // ChatGPT splits big histories into conversations-000.json,
    // conversations-001.json, … We must import ALL of them, not just the first
    // (mikes_pp, Discord 2026-06-17: "only the 100 in conversations-000.json
    // imported, none from conversations-001.json").
    const folder = '1716800000-shard'
    const oneChat = (title: string, part: string) => JSON.stringify([{
      title,
      create_time: 1700000000.0,
      update_time: 1700001000.0,
      mapping: {
        root: { id: 'root', message: null, parent: null, children: ['u1'] },
        u1: { id: 'u1', message: { id: 'u1', author: { role: 'user' }, create_time: 1700000010.0, content: { content_type: 'text', parts: [part] } }, parent: 'root', children: [] },
      },
    }])
    const file = await makeZipFile({
      [`${folder}/conversations-000.json`]: oneChat('Shard one chat', 'hi from shard one'),
      [`${folder}/conversations-001.json`]: oneChat('Shard two chat', 'hi from shard two'),
      [`${folder}/user.json`]: JSON.stringify({ id: 'user-1' }),
    }, 'multi-shard-export.zip')
    const res = await parseExportFile(file)
    expect(res.detectedPlatform).toBe('chatgpt')
    expect(res.conversations).toHaveLength(2)
    const titles = res.conversations.map((c) => c.title)
    expect(titles).toContain('Shard one chat')
    expect(titles).toContain('Shard two chat')
  })

  it('merges shards when zip entries use BACKSLASH separators (Windows-rezipped export)', async () => {
    // Windows tools (Explorer "Compressed folder", PowerShell Compress-Archive)
    // write backslash-separated entry names. The old basename split on '/' only,
    // so none matched conversations-NNN.json → fallback picked ONE file (~100
    // chats). Verified live 2026-06-21 with a 10-shard 1000-chat zip → 100.
    const folder = '1716800000-winshard'
    const oneChat = (title: string, part: string) => JSON.stringify([{
      title,
      create_time: 1700000000.0,
      mapping: {
        root: { id: 'root', message: null, parent: null, children: ['u1'] },
        u1: { id: 'u1', message: { id: 'u1', author: { role: 'user' }, content: { content_type: 'text', parts: [part] } }, parent: 'root', children: [] },
      },
    }])
    const file = await makeZipFile({
      [`${folder}\\conversations-000.json`]: oneChat('Win shard one', 'hi one'),
      [`${folder}\\conversations-001.json`]: oneChat('Win shard two', 'hi two'),
      [`${folder}\\user.json`]: JSON.stringify({ id: 'user-1' }),
    }, 'win-rezipped.zip')
    const res = await parseExportFile(file)
    expect(res.detectedPlatform).toBe('chatgpt')
    expect(res.conversations).toHaveLength(2)
    const titles = res.conversations.map((c) => c.title)
    expect(titles).toContain('Win shard one')
    expect(titles).toContain('Win shard two')
  })
})
