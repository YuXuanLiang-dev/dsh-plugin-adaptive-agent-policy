/**
 * Replay-safe, model-free tool-result pruning service.
 *
 * @module dsh-plugin-adaptive-agent-policy/pruner
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, ToolResultMessage } from '@deepseek-ai/dsh-session'
// Type-only: the `compaction/*` SessionEventMap merges (the shadow-price event).
import type {} from '@deepseek-ai/dsh-compaction'
// Type-only: the `ctx.tokenMeter` Context merge for the declared injection.
import type {} from '@deepseek-ai/dsh-token-meter'
import { codePointLength, DEFAULTS, PRUNE_MARKER, resolveConfig } from './config.ts'
import type {
  PrunedEntry,
  PruneSessionOptions,
  PruneResult,
  ResolvedConfig,
  ToolResultPruneConfig,
} from './types.ts'

export { codePointLength, DEFAULTS, PRUNE_MARKER, resolveConfig } from './config.ts'
export type {
  PrunedEntry,
  PruneSessionOptions,
  PruneResult,
  ResolvedConfig,
  ToolResultPruneConfig,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    adaptiveToolResultPruner: AdaptiveToolResultPruner
  }
}

interface SnapshotCandidate {
  readonly seq: number
  readonly event: SessionEvent<'tool/result'>
}

interface PreparedReplacement extends SnapshotCandidate {
  readonly content: ContentBlock[]
  readonly charsBefore: number
  readonly charsAfter: number
}

/** Deterministic head/middle/tail pruning for current tool-result surface nodes. */
export class AdaptiveToolResultPruner extends Service {
  // The token meter prices each shadowed node for its logged shadow-price
  // event, so pruning genuinely requires the pricing capability.
  static inject = ['tokenMeter']

  static Config: z<ToolResultPruneConfig> = z.object({
    thresholdChars: z.number().step(1).min(1).default(DEFAULTS.thresholdChars),
    headChars: z.number().step(1).min(0).default(DEFAULTS.headChars),
    tailChars: z.number().step(1).min(0).default(DEFAULTS.tailChars),
  })

  /** Resolved and immutable character budgets. */
  readonly config: ResolvedConfig

  constructor(ctx: Context, config: ToolResultPruneConfig = {}) {
    super(ctx, 'adaptiveToolResultPruner')
    this.config = resolveConfig(config)
  }

  /**
   * Measure text content in Unicode code points; non-text blocks cost zero.
   * @param blocks - tool-result content to measure.
   * @returns total Unicode code points across text blocks.
   */
  measureContent(blocks: readonly ContentBlock[]): number {
    let chars = 0
    for (const block of blocks) {
      if (block.type === 'text') chars += codePointLength(block.text)
    }
    return chars
  }

  /**
   * Replace an over-budget text middle while retaining rich-block order.
   * Text slicing is by Unicode code point, not UTF-16 code unit, so a retained
   * boundary cannot split a surrogate pair. Grapheme clusters may still split.
   * @param blocks - original tool-result content.
   * @param policy - resolved pass-local or service-default character budgets.
   * @returns pruned content, or `null` when the text is within budget.
   */
  pruneContent(
    blocks: readonly ContentBlock[],
    policy: ResolvedConfig = this.config,
  ): ContentBlock[] | null {
    const totalChars = this.measureContent(blocks)
    if (totalChars <= policy.thresholdChars) return null

    const removedStart = policy.headChars
    const removedEnd = totalChars - policy.tailChars
    const pruned: ContentBlock[] = []
    let consumed = 0
    let markerInserted = false

    for (const block of blocks) {
      if (block.type !== 'text') {
        pruned.push(block)
        continue
      }

      const points = Array.from(block.text)
      const blockStart = consumed
      const blockEnd = blockStart + points.length
      const headEnd = Math.min(points.length, Math.max(0, removedStart - blockStart))
      const tailStart = Math.min(points.length, Math.max(0, removedEnd - blockStart))
      const intersectsRemoved = blockStart < removedEnd && blockEnd > removedStart
      const marker = intersectsRemoved && !markerInserted ? PRUNE_MARKER : ''
      if (marker.length > 0) markerInserted = true
      const text = points.slice(0, headEnd).join('')
        + marker
        + points.slice(tailStart).join('')
      if (text.length > 0) pruned.push({ ...block, text })
      consumed = blockEnd
    }

    /* v8 ignore next -- totalChars > threshold and valid budgets guarantee a removed text span. */
    if (!markerInserted) throw new Error('tool-result prune: failed to locate the removed text span')
    const charsAfter = this.measureContent(pruned)
    /* v8 ignore next -- config validation fixes the emitted head + marker + tail budget. */
    if (charsAfter > policy.thresholdChars || charsAfter >= totalChars) {
      throw new Error('tool-result prune: replacement must be smaller and within threshold')
    }
    return pruned
  }

  /**
   * Prune every over-budget tool result from one stable current-surface snapshot.
   * Each replacement preserves the complete event data except for `content`,
   * cites the shadowed node so replay can recover the replacement input, and is
   * immediately preceded by a `compaction/prune` shadow-price event pricing the
   * shadowed node through the injected token meter, so pure consumers can
   * subtract it without per-node state.
   * @param session - session whose current surface is rewritten.
   * @param options - pass-local budgets, protected recent steps, and minimum aggregate saving.
   * @returns landed replacements and aggregate Unicode-code-point savings.
   * @throws when the session rejects a replacement; replacements committed
   * earlier in the pass remain durable.
   */
  pruneSession(session: Session, options: PruneSessionOptions = {}): PruneResult {
    const policy = options.policy === undefined ? this.config : resolveConfig(options.policy)
    const protectRecentSteps = options.protectRecentSteps ?? 0
    const minimumCharsRemoved = options.minimumCharsRemoved ?? 0
    if (!Number.isInteger(protectRecentSteps) || protectRecentSteps < 0) {
      throw new Error('tool-result prune: protectRecentSteps must be a non-negative integer')
    }
    if (!Number.isInteger(minimumCharsRemoved) || minimumCharsRemoved < 0) {
      throw new Error('tool-result prune: minimumCharsRemoved must be a non-negative integer')
    }

    const candidates: SnapshotCandidate[] = []
    for (const seq of [...session.surface.nodes]) {
      const event = session.events[seq]
      /* v8 ignore next -- surface seqs are validated contiguous log references. */
      if (event?.type === 'tool/result') candidates.push({ seq, event })
    }

    const protectedSteps = new Set<string>()
    for (let index = candidates.length - 1; index >= 0 && protectedSteps.size < protectRecentSteps; index -= 1) {
      const event = candidates[index]?.event
      if (event !== undefined) protectedSteps.add(`${event.data.turn}\u0000${event.data.step}`)
    }

    const prepared: PreparedReplacement[] = []
    let projectedCharsRemoved = 0
    for (const candidate of candidates) {
      const { event } = candidate
      if (protectedSteps.has(`${event.data.turn}\u0000${event.data.step}`)) continue
      const result = event.data.message.content[0]
      const content = this.pruneContent(result.content, policy)
      if (content === null) continue
      const charsBefore = this.measureContent(result.content)
      const charsAfter = this.measureContent(content)
      projectedCharsRemoved += charsBefore - charsAfter
      prepared.push({ ...candidate, content, charsBefore, charsAfter })
    }
    if (projectedCharsRemoved < minimumCharsRemoved) return { pruned: [], charsRemoved: 0 }

    const pruned: PrunedEntry[] = []
    let charsRemoved = 0
    for (const { seq, event, content, charsBefore, charsAfter } of prepared) {
      const result = event.data.message.content[0]
      const message = freezeMessage<ToolResultMessage>({
        ...event.data.message,
        content: [{
          ...result,
          content,
        }] as [typeof result],
      })
      // Shadow-price protocol: the metering event and its replacement are
      // appended synchronously adjacent, so pure consumers subtract the
      // shadowed node's heuristic price without retaining per-node state.
      session.append('compaction/prune', {
        shadowedRange: { start: seq, end: seq },
        shadowedSeqs: [seq],
        shadowedTokenCount: this.ctx.tokenMeter.estimateMessage(event.data.message),
      })
      const replacement = session.append('tool/result', {
        ...event.data,
        message,
      }, {
        surfaceOp: { op: 'replace', start: seq, end: seq },
        sourceEventSeqs: [seq],
      })
      pruned.push({
        originalSeq: seq,
        replacementSeq: replacement.seq,
        callId: event.data.message.source.callId,
        charsBefore,
        charsAfter,
      })
      charsRemoved += charsBefore - charsAfter
    }
    return { pruned, charsRemoved }
  }
}

export default AdaptiveToolResultPruner
