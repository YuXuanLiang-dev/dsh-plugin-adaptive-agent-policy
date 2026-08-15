import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { CallId, createMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AdaptiveToolResultPruner, {
  codePointLength,
  PRUNE_MARKER,
  resolveConfig,
} from '../src/pruner/index.ts'

const SMALL = {
  thresholdChars: 50,
  headChars: 4,
  tailChars: 3,
}

function service(): AdaptiveToolResultPruner {
  const ctx = new Context()
  void new TokenMeter(ctx)
  return new AdaptiveToolResultPruner(ctx, SMALL)
}

function appendToolStep(
  session: Session,
  turn: number,
  call: string,
  content: ContentBlock[],
): void {
  const callId = CallId(call)
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: '{}' }],
      source: { kind: 'model', provider: 'test', model: 'test' },
    }),
  }, { surfaceOp: 'append' })
  session.append('tool/call', { turn, step: 1, callId, name: 'bash', arguments: '{}' })
  session.append('tool/result', {
    turn,
    step: 1,
    message: createToolResultMessage({ callId, content, isError: false }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

describe('adaptive tool-result pruner', () => {
  it('validates budgets and counts Unicode code points', () => {
    expect(resolveConfig(SMALL)).toEqual(SMALL)
    expect(codePointLength('a😀b')).toBe(3)
    expect(() => resolveConfig({ thresholdChars: 20, headChars: 10, tailChars: 10 }))
      .toThrow(/headChars \+ marker \+ tailChars/)
  })

  it('keeps bounded head and tail without breaking surrogate pairs', () => {
    const pruner = service()
    const result = pruner.pruneContent([{ type: 'text', text: '😀'.repeat(60) }])

    expect(result).toEqual([{
      type: 'text',
      text: `${'😀'.repeat(4)}${PRUNE_MARKER}${'😀'.repeat(3)}`,
    }])
    expect(pruner.measureContent(result ?? [])).toBeLessThanOrEqual(50)
  })

  it('applies local budgets, protects recent steps, and replays identically', () => {
    const session = Session.create(SessionId('standalone-pruner'))
    appendToolStep(session, 1, 'old', [{ type: 'text', text: 'A'.repeat(100) }])
    appendToolStep(session, 2, 'recent', [{ type: 'text', text: 'B'.repeat(100) }])
    session.append('turn/start', { turn: 3 })

    const result = service().pruneSession(session, {
      policy: { thresholdChars: 60, headChars: 10, tailChars: 5 },
      protectRecentSteps: 1,
      minimumCharsRemoved: 1,
    })

    expect(result.pruned.map(entry => entry.callId)).toEqual([CallId('old')])
    expect(result.charsRemoved).toBeGreaterThan(0)
    const replay = Session.create(session.id, [...session.events])
    expect(replay.deriveMessages()).toEqual(session.deriveMessages())
  })

  it('does not rewrite anything below the aggregate saving floor', () => {
    const session = Session.create(SessionId('saving-floor'))
    appendToolStep(session, 1, 'one', [{ type: 'text', text: 'A'.repeat(100) }])
    session.append('turn/start', { turn: 2 })
    const before = session.events.length

    const result = service().pruneSession(session, { minimumCharsRemoved: 10_000 })

    expect(result).toEqual({ pruned: [], charsRemoved: 0 })
    expect(session.events).toHaveLength(before)
  })
})
