/**
 * /dev/composer: ui/Composer as the fixed foot of a page, the way the chat,
 * the remote chat and Compare use it. Internal, only reachable with the
 * developer switch. The tests measure here that the composer takes at most
 * a third of the height with the phone on its side, and that a toast lies
 * neither on the composer nor on the end of the list.
 */
import { useState } from 'react'
import { Chip, Composer, ListGroup, Page, Row, toast } from '../ui'

export const COMPOSER_ROWS = 16

export default function ComposerPage() {
  const [text, setText] = useState('')
  const [running, setRunning] = useState(false)
  return (
    <Page
      title="Composer page"
      screen="dev-composer"
      bareFooter
      footer={
        <Composer
          value={text}
          onChange={setText}
          onSend={() => {
            setText('')
            setRunning(true)
            toast('Sent', { testid: 'dev-composer' })
          }}
          running={running}
          onStop={() => setRunning(false)}
          onDictate={() => toast('Dictation uses LU Cloud', { testid: 'dev-composer' })}
          idPrefix="m-dev-composer"
          testid="m-dev-composer"
          status={
            <Chip kind="action" mini tone="warn">
              Context 96%
            </Chip>
          }
          tune={{
            summary: (
              <>
                <b>Gemma 3 4B instruct, the long name of a model</b> · Agent · 3 documents · Cloud
              </>
            ),
            label: 'Chat settings: Gemma 3 4B instruct, Agent, 3 documents, Cloud',
            changed: true,
            onPress: () => toast('Chat settings', { testid: 'dev-composer' }),
            testid: 'm-dev-composer-options',
          }}
          attach={{ label: 'Attach', onPress: () => toast('Attach', { testid: 'dev-composer' }), testid: 'm-dev-composer-attach' }}
        />
      }
    >
      <ListGroup title="Messages">
        {Array.from({ length: COMPOSER_ROWS }, (_, i) => (
          <Row key={i} title={`Message ${i + 1}`} subtitle={i === COMPOSER_ROWS - 1 ? 'The end of the list' : undefined} testid={`m-dev-composer-row-${i + 1}`} />
        ))}
      </ListGroup>
    </Page>
  )
}
