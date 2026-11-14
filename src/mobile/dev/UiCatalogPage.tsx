/**
 * /dev/ui: every base component of src/mobile/ui in all its states.
 *
 * Internal: only reachable with the developer switch (a dev build, ?dev=1, or
 * localStorage lu-mobile-dev=1). The screenshots under
 * mobile-docs/design/shell-shots/ are taken from this page, in both themes
 * and at 100 and 200 percent text size.
 */
import { useState, type ReactNode } from 'react'
import { Brain, Download, FileText, Globe, MoreHorizontal, Palette, Plus, Search, SlidersHorizontal, Sparkles, Trash2, User, Wrench } from 'lucide-react'
import { CREDITS_EXHAUSTED_EVENT } from '../../lib/credits-exhausted'
import { useLuEngineSwitchStore } from '../../stores/luEngineSwitchStore'
import { reportGenerationSpeed, useDiagnostics } from '../lib/diagnostics'
import { STORAGE_QUOTA_EVENT } from '../lib/storage-alerts'
import { nav } from '../nav'
import { haptic } from '../platform/haptics'
import { openExternal } from '../platform/open-external'
import { shareFile } from '../platform/share'
import { ensureAiConsent, openReport, revokeAiConsent, storePolicy, useAiConsent } from '../policy'
import { setThemePref, type ThemePref, getThemePref } from '../platform/theme'
import {
  Banner,
  Block,
  Button,
  Card,
  Chip,
  ChipGroup,
  Composer,
  EmptyState,
  ErrorState,
  Field,
  FitBadge,
  Fold,
  Heading,
  Hint,
  IconButton,
  ListGroup,
  MiddleEllipsis,
  ModelChip,
  Monogram,
  Notice,
  NumberField,
  OfflineIcon,
  Page,
  PermissionRow,
  Progress,
  Row,
  SecretField,
  Segmented,
  Skeleton,
  SkeletonCards,
  SkeletonRows,
  Slider,
  Spinner,
  Strip,
  Switch,
  Tag,
  TextArea,
  toast,
  useScreenShape,
} from '../ui'
import { Markdown } from '../ui/Markdown'
import type { PermissionLevel } from '../../api/mcp/types'

/** An answer with everything the Markdown of the kit draws. */
const SAMPLE_ANSWER = [
  '## Day two in Lisbon',
  '',
  'Start at the **tile museum**, then walk to the river. Details are on the [city page](https://example.com/lisbon).',
  '',
  '- Lunch near the river',
  '- A long walk up the hill',
  '',
  '| Stop | Time | Note |',
  '| --- | --- | --- |',
  '| Tile museum | 10:00 | Closed on Mondays, so check the day before you go |',
  '| Viewpoint | 17:30 | Bring water |',
  '',
  '```ts',
  "const stops: string[] = ['museum', 'river', 'viewpoint']",
  'function plan(day: number): string {',
  '  // one line that is long enough to need a sideways scroll on a small phone, on purpose',
  '  return `Day ${day}: ${stops.join(", ")}`',
  '}',
  '```',
  '',
  '```html',
  '<!doctype html>',
  '<html><body><h1>Lisbon</h1></body></html>',
  '```',
  '',
  'Run `plan(2)` to print it.',
].join('\n')

const openedLink = (url: string) => toast(`Link: ${url}`, { testid: 'dev-link' })
const openedPreview = (block: { index: number }) => toast(`Preview of block ${block.index}`, { testid: 'dev-preview' })

function Section({ title, id, children }: { title: string; id: string; children: ReactNode }) {
  return (
    <section className="m-dev-section" data-testid={`m-dev-ui-sec-${id}`}>
      <h2 className="m-dev-title">{title}</h2>
      {children}
    </section>
  )
}

function Box({ children }: { children: ReactNode }) {
  return <div className="m-dev-box">{children}</div>
}

/**
 * What the scaffold supplies beyond components: the diagnostics figures and
 * the global notices. Here so they can be looked at and triggered on a
 * device before the screens that own them exist.
 */
function ScaffoldSection() {
  const { report, refresh, loading } = useDiagnostics()
  const [result, setResult] = useState('')
  const policy = storePolicy()
  const consent = useAiConsent()
  return (
    <Section title="Scaffold" id="scaffold">
      <Box>
        <pre className="m-mono m-dev-report" data-testid="m-dev-ui-diagnostics" aria-busy={loading}>
          {report || 'Reading the device'}
        </pre>
        <Button block onPress={() => void refresh()} testid="m-dev-ui-diag-refresh">
          Read the device again
        </Button>
        <Button
          block
          onPress={() => {
            reportGenerationSpeed({ tokens: 96, ms: 8000, model: 'Gemma 3 4B' })
          }}
          testid="m-dev-ui-diag-speed"
        >
          Report 12 tokens per second
        </Button>
        <Button
          block
          onPress={() => {
            shareFile({ name: 'lu-diagnostics.txt', mime: 'text/plain', data: report || 'LU diagnostics' }).then(
              (r) => setResult(r.completed ? `Shared (${r.via})` : 'Share sheet closed'),
              (err: unknown) => setResult(err instanceof Error ? err.message : 'Sharing failed'),
            )
          }}
          testid="m-dev-ui-diag-share"
        >
          Share the report
        </Button>
        <Button
          block
          onPress={() => {
            void openExternal('https://lu-labs.ai/').then((r) => setResult(r.opened ? 'Opened in the browser' : `Not opened (${r.reason})`))
          }}
          testid="m-dev-ui-open-link"
        >
          Open a link in the browser
        </Button>
        {result ? (
          <span className="m-cap" data-testid="m-dev-ui-scaffold-result" role="status">
            {result}
          </span>
        ) : null}
        <Button block onPress={() => window.dispatchEvent(new CustomEvent(STORAGE_QUOTA_EVENT, { detail: { key: 'chat-conversations' } }))} testid="m-dev-ui-storage-full">
          Signal: chat storage is full
        </Button>
        <Button block onPress={() => window.dispatchEvent(new CustomEvent(CREDITS_EXHAUSTED_EVENT, { detail: { reason: 'credits' } }))} testid="m-dev-ui-credits">
          Signal: out of credits
        </Button>
        <Button
          block
          onPress={() => useLuEngineSwitchStore.getState().announce('"Gemma 3 4B" is gone from the model list, so the chat switched to "Qwen 2.5 3B".')}
          testid="m-dev-ui-model-note"
        >
          Signal: the chat model was replaced
        </Button>
      </Box>
      <Box>
        <p className="m-cap" data-testid="m-dev-ui-policy">
          {`Store preset: ${policy.preset}. Age gate ${policy.ageGate}, content levels ${policy.contentLevels}, purchase ${policy.purchase}. Cloud consent ${consent ? 'given' : 'not given'}.`}
        </p>
        <Button
          block
          onPress={() => openReport({ kind: 'message', id: 'dev-message', model: 'Gemma 3 4B', source: 'local', excerpt: 'An answer the user wants to report.' })}
          testid="m-dev-ui-report"
        >
          Report an answer
        </Button>
        <Button
          block
          onPress={() => {
            void ensureAiConsent().then((agreed) => setResult(agreed ? 'Cloud consent given' : 'Cloud consent declined'))
          }}
          testid="m-dev-ui-consent"
        >
          Ask before sending to LU Cloud
        </Button>
        <Button block onPress={() => revokeAiConsent()} testid="m-dev-ui-consent-revoke">
          Take the Cloud consent back
        </Button>
      </Box>
    </Section>
  )
}

export default function UiCatalogPage() {
  const [theme, setTheme] = useState<ThemePref>(getThemePref())
  const [seg, setSeg] = useState('medium')
  const [filters, setFilters] = useState<Record<string, boolean>>({ fits: true, vision: false })
  const [tool, setTool] = useState('image')
  const [sw, setSw] = useState(true)
  const [cloud, setCloud] = useState(false)
  const [radio, setRadio] = useState('standard')
  const [text, setText] = useState('')
  const [email, setEmail] = useState('not an address')
  const [key, setKey] = useState('')
  const [notes, setNotes] = useState('You are a calm assistant.')
  const [longNotes, setLongNotes] = useState('')
  const [temp, setTemp] = useState(0.7)
  const [threads, setThreads] = useState(4)
  const [message, setMessage] = useState('')
  const [running, setRunning] = useState(false)
  const [quality, setQuality] = useState('standard')
  const [picked, setPicked] = useState('gemma')
  const [picks, setPicks] = useState(0)
  const [web, setWeb] = useState<PermissionLevel>('confirm')
  const [files, setFiles] = useState<PermissionLevel>('blocked')
  const [keep, setKeep] = useState(20)
  const [password, setPassword] = useState('correct horse')
  const [secret, setSecret] = useState('')
  const [ratio, setRatio] = useState('1:1')
  const shape = useScreenShape()

  return (
    <Page
      title="UI catalogue"
      screen="dev-ui"
      needsNetwork
      actions={<IconButton icon={MoreHorizontal} label="Open the demo sheet" onPress={() => nav.openSheet('dev-demo')} testid="m-dev-ui-open-sheet" />}
    >
      <Section title="Theme" id="theme">
        <Box>
          <Segmented
            label="Theme"
            value={theme}
            onChange={(next) => {
              setTheme(next)
              setThemePref(next)
            }}
            options={[
              { value: 'system', label: 'System' },
              { value: 'dark', label: 'Dark' },
              { value: 'light', label: 'Light' },
            ]}
            testid="m-dev-ui-theme"
          />
        </Box>
      </Section>

      <Section title="Button" id="button">
        <Box>
          <Button variant="primary" block testid="m-dev-ui-btn-primary" onPress={() => haptic('light')}>
            Download 2.5 GB
          </Button>
          <Button variant="cloud" block>
            Switch to Cloud
          </Button>
          <Button block>Skip for now</Button>
          <Button variant="quiet" block>
            Not now
          </Button>
          <Button variant="danger" block icon={Trash2}>
            Delete chat
          </Button>
          <Button variant="primary" block busy label="Connecting">
            Connecting
          </Button>
          <Button variant="primary" block disabled disabledReason="No internet">
            Create
          </Button>
          <div className="m-rowh">
            <Button compact icon={Download}>
              Resume
            </Button>
            <Button compact>Remove</Button>
            <Button compact variant="quiet">
              A longer label that has to wrap when the text is large
            </Button>
          </div>
        </Box>
      </Section>

      <Section title="Risk marks" id="risk">
        <Box>
          <span className="m-cap">Targets that cost credits or remove data carry data-m-risk, so a test or an agent can tell before tapping.</span>
          <Button variant="cloud" block risk="paid" testid="m-dev-ui-risk-paid">
            Create, 4 credits
          </Button>
          <Button variant="danger" block icon={Trash2} risk="destructive" testid="m-dev-ui-risk-destructive">
            Delete all chats
          </Button>
          <div className="m-rowh">
            <IconButton icon={Trash2} label="Remove this document" risk="destructive" testid="m-dev-ui-risk-icon" />
            <Chip kind="action" risk="paid" testid="m-dev-ui-risk-chip">
              Upscale
            </Chip>
          </div>
        </Box>
        <ListGroup>
          <Row icon={Trash2} title="Delete account" danger onPress={() => {}} chevron={false} risk="destructive" testid="m-dev-ui-risk-row" />
        </ListGroup>
      </Section>

      <Section title="IconButton" id="iconbutton">
        <Box>
          <div className="m-rowh">
            <IconButton icon={Plus} label="Attach" />
            <IconButton icon={SlidersHorizontal} label="Chat options" />
            <IconButton icon={Download} label="Downloads" count={1} />
            <IconButton icon={Download} label="Downloads" count={12} />
            <IconButton icon={MoreHorizontal} label="More" disabled />
            <IconButton icon={Plus} label="Increase" edged />
          </div>
        </Box>
      </Section>

      <Section title="Segmented" id="segmented">
        <Box>
          <Segmented
            label="Reasoning effort"
            value={seg}
            onChange={setSeg}
            options={[
              { value: 'low', label: 'Low' },
              { value: 'medium', label: 'Medium' },
              { value: 'high', label: 'High' },
              { value: 'max', label: 'Max' },
            ]}
            testid="m-dev-ui-seg"
          />
          <Segmented label="Where" value="phone" onChange={() => {}} options={[{ value: 'phone', label: 'On this phone' }, { value: 'remote', label: 'Remote desktop' }]} />
          <Segmented label="Permission" value="ask" onChange={() => {}} options={[{ value: 'blocked', label: 'Blocked' }, { value: 'ask', label: 'Ask' }, { value: 'auto', label: 'Auto', disabled: true }]} />
          <span className="m-cap">Options that do not fit next to each other all go under each other</span>
          <Segmented
            label="Quality"
            value={quality}
            onChange={setQuality}
            options={[
              { value: 'draft', label: 'Draft', testid: 'm-dev-ui-seg-long-draft' },
              { value: 'standard', label: 'Standard', testid: 'm-dev-ui-seg-long-standard' },
              { value: 'high', label: 'High quality', testid: 'm-dev-ui-seg-long-high' },
            ]}
            testid="m-dev-ui-seg-long"
          />
        </Box>
      </Section>

      <Section title="Chip" id="chip">
        <ChipGroup label="Filters" testid="m-dev-ui-chips">
          {[
            ['fits', 'Fits this phone'],
            ['mainstream', 'Mainstream'],
            ['unfiltered', 'Unfiltered'],
            ['vision', 'Vision'],
          ].map(([id, label]) => (
            <Chip key={id} selected={!!filters[id]} onPress={() => setFilters((f) => ({ ...f, [id]: !f[id] }))} testid={`m-dev-ui-chip-${id}`}>
              {label}
            </Chip>
          ))}
        </ChipGroup>
        <Box>
          <span className="m-cap">Choice, one of a group</span>
        </Box>
        <ChipGroup label="Tool" role="radiogroup">
          {[
            ['image', 'Image'],
            ['edit', 'Edit'],
            ['video', 'Video'],
            ['music', 'Music'],
          ].map(([id, label]) => (
            <Chip key={id} kind="choice" selected={tool === id} onPress={() => setTool(id)} icon={id === 'image' ? Sparkles : undefined}>
              {label}
            </Chip>
          ))}
        </ChipGroup>
        <Box>
          <span className="m-cap">A short label is still a full target</span>
        </Box>
        <ChipGroup label="Aspect ratio" role="radiogroup" wrap>
          {['1:1', '4:3', '16:9', '9:16'].map((id) => (
            <Chip key={id} kind="choice" selected={ratio === id} onPress={() => setRatio(id)} testid={`m-dev-ui-chip-ratio-${id.replace(':', 'x')}`}>
              {id}
            </Chip>
          ))}
        </ChipGroup>
        <Box>
          <span className="m-cap">Status chips of the composer: 28 px to the eye, 44 px to the finger</span>
          <div className="m-rowh">
            <Chip kind="action" mini tone="ok">
              Agent
            </Chip>
            <Chip kind="action" mini>
              3 documents
            </Chip>
            <Chip kind="action" mini tone="cloud">
              Cloud, uses credits
            </Chip>
            <Chip kind="action" mini tone="warn">
              91%
            </Chip>
          </div>
        </Box>
      </Section>

      <Section title="Switch" id="switch">
        <Box>
          <div className="m-rowh">
            <Switch checked={sw} onChange={setSw} label="Agent mode" testid="m-dev-ui-switch">
              Agent mode
            </Switch>
            <Switch checked={cloud} onChange={setCloud} label="Cloud" tone="cloud" pill testid="m-dev-ui-cloud">
              Cloud
            </Switch>
            <Switch checked={false} onChange={() => {}} label="Thinking" disabled>
              Thinking
            </Switch>
          </div>
        </Box>
      </Section>

      <Section title="List and Row" id="list">
        <ListGroup title="App">
          <Row icon={Palette} title="Appearance" value="System" onPress={() => {}} testid="m-dev-ui-row-nav" />
          <Row icon={User} title="Personas" value="Default" onPress={() => {}} />
          <Row icon={Globe} title="Web search" subtitle="Search and read pages when needed" switch={{ checked: sw, onChange: setSw }} testid="m-dev-ui-row-switch" />
          <Row title="Thinking" disabled disabledReason="Always on for this model" switch={{ checked: true, onChange: () => {} }} />
          <Row icon={Trash2} title="Delete all chats" danger onPress={() => {}} chevron={false} />
        </ListGroup>
        <ListGroup title="Content policy" role="radiogroup">
          {[
            ['strict', 'Strict', 'Blocks more than the default'],
            ['standard', 'Standard', 'The default'],
            ['off', 'Off', 'No filter on what the models write'],
          ].map(([id, title, sub]) => (
            <Row key={id} title={title} subtitle={sub} radio={{ checked: radio === id, onSelect: () => setRadio(id) }} testid={`m-dev-ui-radio-${id}`} />
          ))}
        </ListGroup>
        <ListGroup title="Rows with an id, a state and a choice that can be tapped again" role="radiogroup" label="Model">
          {[
            ['gemma', 'Gemma 3 4B', 'loaded'],
            ['qwen', 'Qwen 2.5 3B', 'idle'],
          ].map(([id, title, state]) => (
            <Row
              key={id}
              title={title}
              subtitle={state === 'loaded' ? 'Loaded' : undefined}
              id={id}
              state={state}
              radio={{
                checked: picked === id,
                reselect: true,
                onSelect: () => {
                  setPicked(id)
                  setPicks((n) => n + 1)
                },
              }}
              testid="m-dev-ui-model-row"
            />
          ))}
        </ListGroup>
        <Box>
          <span className="m-cap" data-testid="m-dev-ui-model-picks">{`Picked ${picks} times`}</span>
        </Box>
        <ListGroup title="Two targets in one row">
          <Row
            title="Trip plan for Lisbon"
            subtitle="Day two starts at the tile museum, then lunch near the river and a long walk up the hill"
            onPress={() => {}}
            chevron={false}
            trailing={<IconButton icon={MoreHorizontal} label="More for Trip plan for Lisbon" />}
          />
          <Row title="A very long chat title that has to wrap onto a second line instead of being cut off" subtitle="Gemma 3 4B" onPress={() => {}} chevron={false} trailing={<IconButton icon={MoreHorizontal} label="More for this chat" />} />
        </ListGroup>
      </Section>

      <Section title="Field and TextArea" id="field">
        <Box>
          <Field label="Search chats" hideLabel icon={Search} type="search" value={text} onChange={setText} placeholder="Search chats" clearable testid="m-dev-ui-search" />
          <Field label="Email" type="email" inputMode="email" autoComplete="email" value={email} onChange={setEmail} error="Email or password is not correct." />
          <Field label="API key" value={key} onChange={setKey} pasteable clearable hint="Kept in the keychain of this phone" placeholder="Paste your key" />
          <Field label="Address" value="" onChange={() => {}} disabled placeholder="192.168.0.12:8080" />
          <TextArea label="Instructions" value={notes} onChange={setNotes} rows={3} testid="m-dev-ui-notes" />
          <TextArea label="Long instructions" hint="Twelve rows, like the instructions of a persona." value={longNotes} onChange={setLongNotes} rows={12} testid="m-dev-ui-long-notes" />
          <SecretField label="Password" value={password} onChange={setPassword} autoComplete="current-password" testid="m-dev-ui-secret" actionTestid="m-dev-ui-secret-show" />
          <SecretField label="Hugging Face token" kind="key" value={secret} onChange={setSecret} autoComplete="off" hint="Kept in the keychain of this phone. It is never shown again." placeholder="hf_" testid="m-dev-ui-key" actionTestid="m-dev-ui-key-paste" />
        </Box>
      </Section>

      <Section title="Slider and NumberField" id="slider">
        {/* A slider has no inset of its own (round 57): it stands on the line of the block it is in. */}
        <Box>
          <Slider label="Temperature" value={temp} onChange={setTemp} min={0} max={2} step={0.1} format={(v) => v.toFixed(1)} testid="m-dev-ui-slider" />
        </Box>
        <Box>
          <div className="m-rowh">
            <span className="m-grow">Threads</span>
            <NumberField label="Threads" value={threads} onChange={setThreads} min={1} max={8} testid="m-dev-ui-number" />
          </div>
        </Box>
        <NumberField label="Keep at most" hint="Older memories are removed first. Whole numbers from 1 to 200." showLabel integer value={keep} onChange={setKeep} min={1} max={200} testid="m-dev-ui-number-int" />
      </Section>

      <Section title="Progress" id="progress">
        <Box>
          <Progress label="Downloading Gemma 3 4B" value={0.38} detail="of 2.5 GB" meta="4.1 MB/s, about 6 min" testid="m-dev-ui-progress" />
          <Progress label="Download paused" value={0.71} state="paused" detail="Paused" />
          <Progress label="Download failed" value={0.2} state="error" detail="Interrupted" />
          <Progress label="Cloud credits this period" value={0.62} tone="cloud" hidePercent detail="1,240 of 2,000" />
          <Progress label="Loading Gemma 3 4B" detail="Loading Gemma 3 4B" />
          <div className="m-rowh">
            <Spinner label="Checking your account" />
            <span className="m-cap">Checking your account</span>
          </div>
        </Box>
      </Section>

      <Section title="Notice, Banner" id="notice">
        <Banner variant="warn" icon={OfflineIcon}>
          No internet. On device models still work.
        </Banner>
        <Banner action={{ label: 'Load again', onPress: () => toast('Loading again'), testid: 'm-dev-ui-banner-load' }} testid="m-dev-ui-banner-one">
          The model was unloaded to free memory.
        </Banner>
        <Banner
          variant="warn"
          actions={[
            { label: 'Open chat', onPress: () => toast('Opened'), testid: 'm-dev-ui-banner-open' },
            { label: 'Dismiss', onPress: () => toast('Dismissed'), testid: 'm-dev-ui-banner-dismiss' },
          ]}
          testid="m-dev-ui-banner-two"
        >
          LU was closed while answering. The answer is saved up to this point.
        </Banner>
        <Box>
          <span />
        </Box>
        <Notice title="Document Chat">Documents are read and searched on this phone. Only the passages that match your question are sent to the model.</Notice>
        <Notice
          variant="warn"
          title="LU was closed while answering"
          actions={
            <>
              <Button compact variant="primary">
                Continue answer
              </Button>
              <Button compact>Dismiss</Button>
            </>
          }
        >
          Your phone needed the memory. The answer is saved up to this point and the model has been loaded again.
        </Notice>
        <Notice
          variant="error"
          title="Download interrupted"
          testid="m-dev-ui-notice-error"
          actions={
            <>
              <Button compact variant="primary">
                Resume
              </Button>
              <Button compact>Remove</Button>
            </>
          }
        >
          Stopped at 38%. The part that arrived is kept, so you will not start over.
        </Notice>
      </Section>

      <Section title="Card, Tag, FitBadge" id="card">
        <Card title="Gemma 3 4B">
          <div className="m-stackv">
            <span className="m-mono m-t3">2.5 GB · Q4_K_M</span>
            <div className="m-tags">
              <Tag>Vision</Tag>
              <Tag>Tools</Tag>
              <Tag>No Filter</Tag>
              <Tag accent>Uncensored</Tag>
            </div>
            <FitBadge level="fits" />
            <Button variant="primary" block icon={Download}>
              Download 2.5 GB
            </Button>
          </div>
        </Card>
        <Box>
          <FitBadge level="fits" testid="m-dev-ui-fit-fits" />
          <FitBadge level="tight" />
          <FitBadge level="too-large" />
          <FitBadge level="unknown" />
        </Box>
      </Section>

      <Section title="Fold" id="fold">
        <Box>
          <Fold title="Thought" meta="4 s" icon={Brain} testid="m-dev-ui-fold">
            {() => <span className="m-cap">The user wants a plan for day two. The museum closes early, so it goes first.</span>}
          </Fold>
          <Fold title="Search the web" sub="lisbon tile museum opening hours" icon={Wrench} state="done" defaultOpen trailing={<IconButton icon={Trash2} label="Remove this step" />}>
            <span className="m-cap">3 results</span>
          </Fold>
          <Fold title="Read a file" icon={Wrench} state="failed" meta="0.3 s">
            <span className="m-cap">The file is not in this chat.</span>
          </Fold>
        </Box>
      </Section>

      <Section title="PermissionRow" id="permission">
        <div className="m-group">
          <PermissionRow title="Web" hint="Search and read pages." value={web} onChange={setWeb} testid="m-dev-ui-perm-web" />
          <PermissionRow title="Files in chat" hint="Read and write the files of a chat." note="Changed for this chat." value={files} onChange={setFiles} testid="m-dev-ui-perm-files" />
        </div>
      </Section>

      <Section title="Block, Hint, Heading, Strip" id="layout">
        <Block lead testid="m-dev-ui-block">
          <Heading>What stays on this phone</Heading>
          <Hint strong>Chats, documents and memories are stored on this phone.</Hint>
          <Hint>Only what you send to LU Cloud leaves it, and LU asks before the first time.</Hint>
        </Block>
        <Strip label="Recent results" testid="m-dev-ui-strip">
          {['Harbour at dawn', 'Tile pattern', 'Tram 28', 'Viewpoint', 'River at night', 'Old town', 'Bridge', 'Market hall'].map((name) => (
            <Tag key={name}>{name}</Tag>
          ))}
        </Strip>
        <Box>
          <span className="m-cap" data-testid="m-dev-ui-shape">{`Screen shape: ${shape}`}</span>
        </Box>
      </Section>

      <Section title="MiddleEllipsis" id="middle">
        <Box>
          <MiddleEllipsis text="beach-holiday-lisbon-day-two-evening-light-final-export.png" testid="m-dev-ui-middle" />
          <MiddleEllipsis text="beach.png" testid="m-dev-ui-middle-short" />
        </Box>
      </Section>

      <Section title="Markdown" id="markdown">
        <Box>
          <Markdown content={SAMPLE_ANSWER} onLink={openedLink} onPreview={openedPreview} />
        </Box>
      </Section>

      <Section title="EmptyState, ErrorState" id="empty">
        <EmptyState title="Ask LU anything" actions={<Button variant="primary" block icon={Plus}>New chat</Button>}>
          Your chats stay on this phone.
        </EmptyState>
        <EmptyState icon={FileText} title="No documents in this chat yet." />
        <ErrorState
          title="Could not load cloud models"
          actions={
            <Button variant="primary" block>
              Try again
            </Button>
          }
        >
          Check your connection.
        </ErrorState>
      </Section>

      <Section title="Skeleton" id="skeleton">
        <SkeletonRows rows={2} />
        <SkeletonCards cards={1} />
        <Box>
          <Skeleton width="60%" />
        </Box>
      </Section>

      <Section title="ModelChip, Composer" id="composer">
        <Box>
          <div className="m-rowh">
            <ModelChip name="Gemma 3 4B" where="local" onPress={() => {}} />
          </div>
          <div className="m-rowh">
            <ModelChip name="DeepSeek V3.2" where="cloud" onPress={() => {}} />
          </div>
          <div className="m-rowh">
            <ModelChip name={null} where="cloud" onPress={() => {}} />
          </div>
        </Box>
        <Composer
          value={message}
          onChange={setMessage}
          onSend={() => {
            setRunning(true)
            setMessage('')
          }}
          running={running}
          onStop={() => setRunning(false)}
          onDictate={() => toast('Dictation uses LU Cloud')}
          idPrefix="m-dev-ui-composer"
          tune={{
            summary: (
              <>
                <b>Gemma 3 4B</b> · Agent
              </>
            ),
            label: 'Chat settings: Gemma 3 4B, Agent',
            onPress: () => nav.openSheet('dev-demo'),
          }}
          attach={{ label: 'Attach', onPress: () => toast('Attach') }}
        />
        <Composer value="Describe your image" onChange={() => {}} onSend={() => {}} cloud sendLabel="Create" risk="paid" idPrefix="m-dev-ui-composer2" tune={{ summary: <b>Image · Flux Schnell · 1:1</b>, label: 'Create settings: Image, Flux Schnell, 1:1', onPress: () => {} }} attach={{ label: 'Add a picture', onPress: () => {} }} />
      </Section>

      <Section title="Sheet, Dialog, Toast" id="overlays">
        <Box>
          <Button block onPress={() => nav.openSheet('dev-demo', { note: 'Opened from the catalogue.' })} testid="m-dev-ui-sheet">
            Open a sheet
          </Button>
          <Button
            block
            onPress={() => {
              void nav.confirm({ title: 'Delete this chat?', text: 'The chat and its files are removed from this phone.', confirmLabel: 'Delete', cancelLabel: 'Keep', tone: 'danger', testid: 'demo' }).then((yes) => toast(yes ? 'Deleted' : 'Kept'))
            }}
            testid="m-dev-ui-dialog"
          >
            Ask before deleting
          </Button>
          <Button
            block
            onPress={() => {
              void nav.prompt({ title: 'Rename chat', confirmLabel: 'Save', field: { label: 'Name', initial: 'Trip plan for Lisbon' }, testid: 'rename' }).then((name) => {
                if (name) toast(`Renamed to ${name}`)
              })
            }}
            testid="m-dev-ui-prompt"
          >
            Rename with a text field
          </Button>
          <Button
            block
            onPress={() => {
              void nav.confirm({ title: 'Delete all memories?', text: 'This removes every memory from this phone.', confirmLabel: 'Delete all', tone: 'danger', requireText: 'DELETE', testid: 'gate' })
            }}
          >
            Ask with a typed word
          </Button>
          <Button block onPress={() => nav.push('/dev/frame')} testid="m-dev-ui-frame">
            A page with a long title and a tall footer
          </Button>
          <Button block onPress={() => nav.push('/dev/composer')} testid="m-dev-ui-composer-page">
            A page with a composer below
          </Button>
          <Button block onPress={() => nav.push('/dev/viewer')} testid="m-dev-ui-viewer">
            The viewer with a long file name
          </Button>
          <Button block onPress={() => toast('Copied')} testid="m-dev-ui-toast">
            Show a toast
          </Button>
          <Button block onPress={() => toast('LU is running out of space for chats.', { tone: 'error', action: { label: 'Manage storage', onPress: () => {} } })} testid="m-dev-ui-toast-action">
            Show a toast with an action
          </Button>
        </Box>
      </Section>

      <ScaffoldSection />

      <Section title="Type and marks" id="type">
        <Box>
          <div className="m-rowh">
            <Monogram size={28} />
            <span style={{ fontFamily: 'var(--m-font-display)', fontSize: 'var(--m-text-display)', fontWeight: 500 }}>Display 24</span>
          </div>
          <span style={{ fontSize: 'var(--m-text-title)', fontWeight: 600 }}>Title 17</span>
          <span>Body 16. Private AI on your phone.</span>
          <span style={{ fontSize: 'var(--m-text-control)', fontWeight: 500 }}>Control 15</span>
          <span className="m-cap">Caption 13</span>
          <span className="m-label">Label 12</span>
          <span className="m-mono">Mono 13 · 2.5 GB · 0:07</span>
        </Box>
      </Section>
    </Page>
  )
}
