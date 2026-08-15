/**
 * Deterministic task routing, request budgets, and progressive tool-result
 * pruning for coding agents.
 *
 * @module dsh-plugin-adaptive-agent-policy
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { deepFreeze } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig, UserMessage } from '@deepseek-ai/dsh-llm'
import AdaptiveToolResultPruner, {
  resolveConfig as resolvePruneConfig,
  type ToolResultPruneConfig,
} from './pruner/index.ts'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-token-meter'
import {
  DEFAULT_RISK_ROUTER_CONFIG,
  resolveRiskRouterConfig,
  riskCheckpoint,
  routeRisk,
  type RiskRouteDecision,
  type RiskRouterConfig,
  type ResolvedRiskRouterConfig,
} from './risk-router.ts'

export {
  DEFAULT_RISK_ROUTER_CONFIG,
  resolveRiskRouterConfig,
  riskCheckpoint,
  routeRisk,
  type RiskClass,
  type RiskRouteDecision,
  type RiskRouterConfig,
  type RiskRouterInput,
  type RiskRouteReason,
  type ResolvedRiskRouterConfig,
  type RoutedTaskClass,
} from './risk-router.ts'

/** Cordis plugin name used by loader diagnostics and model-visible message provenance. */
export const name = 'adaptive-agent-policy'

/** Services required for request-pressure measurement and routed-model capacity lookup. */
export const inject = ['llm', 'tokenMeter', 'systemPrompt']

/** Stable task classes selected from the latest human request. */
export type TaskClass = 'read' | 'small' | 'frontend' | 'large' | 'batch'

/** Request and loop budget for one task class. */
export interface TaskProfileConfig {
  /** Task class this profile controls. */
  taskClass: TaskClass
  /** Maximum output tokens for a model request when the Agent has no explicit cap. */
  maxTokens: number
  /** Step that receives a one-time convergence checkpoint in each turn. */
  softStepBudget: number
  /** Step that receives a text-only finalization request with tools removed. */
  hardStepBudget: number
}

/** One progressive pruning level, qualified by either step count or context pressure. */
export interface PruneLevelConfig extends ToolResultPruneConfig {
  /** Stable level name used in diagnostics. */
  name: string
  /** Qualify at or after this step. */
  atStep: number
  /** Qualify at or above this fraction of the routed model context window. */
  atPressureRatio: number
  /** Number of newest tool-producing steps retained verbatim. */
  protectRecentSteps: number
  /** Aggregate character saving required before replacements land. */
  minimumCharsRemoved: number
  /** Prune when total text exceeds this many Unicode code points. */
  thresholdChars: number
  /** Maximum leading Unicode code points retained. */
  headChars: number
  /** Maximum trailing Unicode code points retained. */
  tailChars: number
}

/** Plugin configuration. */
export interface Config {
  /** Complete task-class request and loop policy table. */
  taskProfiles?: TaskProfileConfig[]
  /** Ordered moderate-to-critical progressive pruning levels. */
  pruneLevels?: PruneLevelConfig[]
  /** Bounded deterministic controls for the one-time risk checkpoint. */
  riskRouter?: RiskRouterConfig
}

/** Fully validated immutable configuration. */
export interface ResolvedConfig {
  /** Exact profile for every task class. */
  readonly taskProfiles: readonly Readonly<TaskProfileConfig>[]
  /** Ordered moderate-to-critical pruning levels. */
  readonly pruneLevels: readonly Readonly<PruneLevelConfig>[]
  /** Complete controls for the second-layer risk router. */
  readonly riskRouter: ResolvedRiskRouterConfig
}

const TASK_CLASSES = ['read', 'small', 'frontend', 'large', 'batch'] as const

const DEFAULT_TASK_PROFILES: TaskProfileConfig[] = [
  { taskClass: 'read', maxTokens: 16_384, softStepBudget: 4, hardStepBudget: 8 },
  { taskClass: 'small', maxTokens: 32_768, softStepBudget: 5, hardStepBudget: 9 },
  { taskClass: 'frontend', maxTokens: 32_768, softStepBudget: 8, hardStepBudget: 14 },
  { taskClass: 'large', maxTokens: 65_536, softStepBudget: 10, hardStepBudget: 18 },
  { taskClass: 'batch', maxTokens: 65_536, softStepBudget: 10, hardStepBudget: 20 },
]

const DEFAULT_PRUNE_LEVELS: PruneLevelConfig[] = [
  {
    name: 'moderate',
    atStep: 6,
    atPressureRatio: 0.45,
    thresholdChars: 16_384,
    headChars: 12_288,
    tailChars: 2_048,
    protectRecentSteps: 2,
    minimumCharsRemoved: 8_192,
  },
  {
    name: 'tight',
    atStep: 10,
    atPressureRatio: 0.65,
    thresholdChars: 8_192,
    headChars: 4_096,
    tailChars: 1_024,
    protectRecentSteps: 1,
    minimumCharsRemoved: 4_096,
  },
  {
    name: 'critical',
    atStep: 14,
    atPressureRatio: 0.75,
    thresholdChars: 4_096,
    headChars: 2_048,
    tailChars: 1_024,
    protectRecentSteps: 1,
    minimumCharsRemoved: 2_048,
  },
]

const taskProfileSchema: z<TaskProfileConfig> = z.object({
  taskClass: z.union(TASK_CLASSES),
  maxTokens: z.number().step(1).min(1),
  softStepBudget: z.number().step(1).min(1),
  hardStepBudget: z.number().step(1).min(1),
})

const pruneLevelSchema: z<PruneLevelConfig> = z.object({
  name: z.string().required(),
  atStep: z.number().step(1).min(1),
  atPressureRatio: z.number().min(0).max(1),
  thresholdChars: z.number().step(1).min(1),
  headChars: z.number().step(1).min(0),
  tailChars: z.number().step(1).min(0),
  protectRecentSteps: z.number().step(1).min(0),
  minimumCharsRemoved: z.number().step(1).min(0),
})

function prunePolicy(level: PruneLevelConfig): ToolResultPruneConfig {
  return {
    thresholdChars: level.thresholdChars,
    headChars: level.headChars,
    tailChars: level.tailChars,
  }
}

/** Loader schema for the configurable task profiles and progressive pruning levels. */
export const Config: z<Config> = z.object({
  taskProfiles: z.array(taskProfileSchema).default(DEFAULT_TASK_PROFILES),
  pruneLevels: z.array(pruneLevelSchema).default(DEFAULT_PRUNE_LEVELS),
  riskRouter: z.object({
    enabled: z.boolean().default(DEFAULT_RISK_ROUTER_CONFIG.enabled),
    minimumScore: z.number().step(1).min(1).default(DEFAULT_RISK_ROUTER_CONFIG.minimumScore),
    maxRequestChars: z.number().step(1).min(1).default(DEFAULT_RISK_ROUTER_CONFIG.maxRequestChars),
    maxEvidenceChars: z.number().step(1).min(1).default(DEFAULT_RISK_ROUTER_CONFIG.maxEvidenceChars),
    skipCovered: z.boolean().default(DEFAULT_RISK_ROUTER_CONFIG.skipCovered),
  }).default(DEFAULT_RISK_ROUTER_CONFIG),
})

const POLICY_TEXT: Record<TaskClass, string> = {
  read: 'Treat this as a read-only investigation. Gather only the evidence needed to answer; do not modify files, and stop once the cause or conclusion is supported.',
  small: 'Treat this as a focused change. Inspect the target and immediate conventions, implement the smallest complete fix, and use existing narrow checks for the changed behavior.',
  frontend: 'Treat this as a frontend implementation. Establish a deliberate visual direction, implement early, and verify the user-visible behavior with existing project facilities.',
  large: 'Treat this as a cross-cutting change. Map only the relevant architecture, callers, data flow, and tests, then implement and verify the affected contracts.',
  batch: 'Treat this as a batch-oriented task. Group independent discovery and transformations, use bounded outputs, preserve ordering where operations depend on each other, and verify representative results plus the aggregate outcome.',
}

const CHECKPOINT_TEXT: Record<TaskClass, string> = {
  read: 'Stop exploring. Answer from the strongest evidence already gathered, or name the exact missing evidence.',
  small: 'Converge now. Do not invent a new verification path; use an existing narrow check only if the changed behavior is still unverified, then finish.',
  frontend: 'Converge now. Do not create preview or browser infrastructure; use an existing project check only if the changed user-visible behavior is still unverified, then finish.',
  large: 'Stop broad exploration. Use an existing targeted check only for an affected contract that remains unverified, then finish or report the exact blocker.',
  batch: 'Stop broad exploration. Use existing representative and aggregate evidence; only run a remaining project check if the batch invariant is still unverified, then finish.',
}

const READ_PATTERN = /(?:分析|解释|审查|评估|比较|为什么|原因|诊断|看看|review|analy[sz]e|explain|diagnos|compare|audit|investigate)/i
const READ_ONLY_PATTERNS = [
  /(?:不要修改|无需修改|不用修改|不要改|只读|read[- ]only)/i,
  /(?:do\s+not\s+(?:modify|change|edit)|without\s+(?:modifying|changing|editing))/i,
]
const MUTATION_PATTERNS = [
  /(?:修改|实现|修复|新增|创建|改造|优化|编写|生成|做一个)/i,
  /(?:build|implement|fix|add|create|change|edit|refactor|optimi[sz]e|write|generate)/i,
]
const FRONTEND_PATTERNS = [
  /(?:网页|页面|网站|前端|静态页|落地页|仪表盘|响应式|界面)/i,
  /(?:dashboard|landing\s+page|front[- ]?end|responsive|\bhtml\b|\bcss\b|\bui\b)/i,
]
const BATCH_PATTERNS = [
  /(?:批量|所有文件|全部文件|全仓库|全局替换|大规模迁移|代码迁移)/i,
  /(?:monorepo|all\s+files|across\s+the\s+(?:repo|repository)|mass\s+(?:change|edit)|codemod|bulk)/i,
]
const LARGE_PATTERNS = [
  /(?:架构|跨模块|跨包|端到端|完整实现|全面重构|重大重构)/i,
  /(?:architecture|cross[- ](?:module|package)|multi[- ]package|end[- ]to[- ]end|large[- ]scale)/i,
]

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(text))
}

interface AgentState {
  taskClass: TaskClass
  requestText: string
  routedRisk: { turn: number; decision: RiskRouteDecision } | undefined
  lastPrune: string | undefined
}

/**
 * Classify one human request with deterministic, model-free rules.
 * @param text - flattened text from the newest human request.
 * @returns the stable task class used by prompt, request, and pruning policy.
 */
export function classifyTask(text: string): TaskClass {
  if (matchesAny(text, BATCH_PATTERNS)) return 'batch'
  if (matchesAny(text, FRONTEND_PATTERNS)) return 'frontend'
  if (matchesAny(text, LARGE_PATTERNS) || text.length >= 1_500) return 'large'
  if (READ_PATTERN.test(text)
    && (matchesAny(text, READ_ONLY_PATTERNS) || !matchesAny(text, MUTATION_PATTERNS))) return 'read'
  return 'small'
}

/**
 * Validate and detach plugin configuration.
 * @param config - loader-normalized configuration or a direct-call partial.
 * @returns immutable complete task profiles and pruning levels.
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const profiles = structuredClone(config.taskProfiles ?? DEFAULT_TASK_PROFILES)
  const profileClasses = new Set<TaskClass>()
  for (const [index, profile] of profiles.entries()) {
    if (!TASK_CLASSES.includes(profile.taskClass)) {
      throw new Error(`adaptive-agent-policy: taskProfiles[${index}].taskClass is invalid`)
    }
    if (profileClasses.has(profile.taskClass)) {
      throw new Error(`adaptive-agent-policy: duplicate task profile "${profile.taskClass}"`)
    }
    profileClasses.add(profile.taskClass)
    assertPositiveInteger(`taskProfiles[${index}].maxTokens`, profile.maxTokens)
    assertPositiveInteger(`taskProfiles[${index}].softStepBudget`, profile.softStepBudget)
    assertPositiveInteger(`taskProfiles[${index}].hardStepBudget`, profile.hardStepBudget)
    if (profile.hardStepBudget <= profile.softStepBudget) {
      throw new Error(`adaptive-agent-policy: taskProfiles[${index}].hardStepBudget must exceed softStepBudget`)
    }
  }
  const missing = TASK_CLASSES.filter(taskClass => !profileClasses.has(taskClass))
  if (missing.length > 0) {
    throw new Error(`adaptive-agent-policy: missing task profiles: ${missing.join(', ')}`)
  }

  const levels = structuredClone(config.pruneLevels ?? DEFAULT_PRUNE_LEVELS)
  const names = new Set<string>()
  let previousStep = 0
  let previousRatio = 0
  let previousThreshold = Number.POSITIVE_INFINITY
  for (const [index, level] of levels.entries()) {
    if (level.name.length === 0) throw new Error(`adaptive-agent-policy: pruneLevels[${index}].name must not be empty`)
    if (names.has(level.name)) throw new Error(`adaptive-agent-policy: duplicate prune level "${level.name}"`)
    names.add(level.name)
    assertPositiveInteger(`pruneLevels[${index}].atStep`, level.atStep)
    if (!Number.isFinite(level.atPressureRatio) || level.atPressureRatio < 0 || level.atPressureRatio > 1) {
      throw new Error(`adaptive-agent-policy: pruneLevels[${index}].atPressureRatio must be between 0 and 1`)
    }
    assertNonNegativeInteger(`pruneLevels[${index}].protectRecentSteps`, level.protectRecentSteps)
    assertNonNegativeInteger(`pruneLevels[${index}].minimumCharsRemoved`, level.minimumCharsRemoved)
    resolvePruneConfig(prunePolicy(level))
    if (level.atStep < previousStep || level.atPressureRatio < previousRatio || level.thresholdChars >= previousThreshold) {
      throw new Error('adaptive-agent-policy: pruneLevels must increase triggers and strictly decrease thresholds')
    }
    previousStep = level.atStep
    previousRatio = level.atPressureRatio
    previousThreshold = level.thresholdChars
  }
  const riskRouter = resolveRiskRouterConfig(config.riskRouter)
  return deepFreeze({ taskProfiles: profiles, pruneLevels: levels, riskRouter })
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`adaptive-agent-policy: ${name} must be a positive integer`)
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`adaptive-agent-policy: ${name} must be a non-negative integer`)
}

function messageText(message: UserMessage): string {
  return message.content
    .filter((block): block is Extract<UserMessage['content'][number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

function latestHumanRequest(agent: Agent): UserMessage | undefined {
  const event = agent.session.events.findLast(candidate => (
    candidate.type === 'user/message' && candidate.data.source.kind === 'user'
  ))
  return event?.type === 'user/message' ? event.data : undefined
}

function profileFor(config: ResolvedConfig, taskClass: TaskClass): Readonly<TaskProfileConfig> {
  const profile = config.taskProfiles.find(candidate => candidate.taskClass === taskClass)
  /* v8 ignore next -- resolveConfig requires exactly one profile for every closed task class. */
  if (profile === undefined) throw new Error(`adaptive-agent-policy: no profile for ${taskClass}`)
  return profile
}

function checkpointText(taskClass: TaskClass, decision: RiskRouteDecision): string {
  const checkpoint = taskClass === 'read'
    ? CHECKPOINT_TEXT.read
    : decision.risk !== undefined
      ? `Converge now. ${riskCheckpoint(decision.risk)} Fix only from observed evidence if needed, then finish.`
      : decision.reason === 'already-covered'
        ? 'Converge now. Recent output already covers the highest-confidence risk; do not invent another verification path. Finish from the evidence.'
        : CHECKPOINT_TEXT[taskClass]
  return `<task_checkpoint class="${taskClass}" risk="${decision.risk ?? 'none'}">\n${checkpoint}\n</task_checkpoint>`
}

function adaptivePhaseText(
  taskClass: TaskClass,
  phase: 'normal' | 'checkpoint' | 'finalization',
  decision?: RiskRouteDecision,
): string {
  if (phase === 'normal') return `<task_policy class="${taskClass}">\n${POLICY_TEXT[taskClass]}\n</task_policy>`
  if (phase === 'checkpoint' && decision !== undefined) return checkpointText(taskClass, decision)
  if (phase === 'finalization') {
    return `<task_finalization class="${taskClass}">\n`
      + 'The task step budget is exhausted and tools are unavailable for this step. Do not request or call tools. '
      + 'Give the best final answer supported by completed work, and state any exact remaining work or blocker.\n'
      + '</task_finalization>'
  }
  /* v8 ignore next -- every checkpoint assembly supplies its frozen turn decision. */
  return CHECKPOINT_TEXT[taskClass]
}

function proposedPosition(agent: Agent): { turn: number; step: number } | undefined {
  const start = agent.session.events.findLast(event => event.type === 'turn/start')
  if (start?.type !== 'turn/start') return undefined
  const ended = agent.session.events.findLast(event => event.type === 'turn/end')
  if (ended?.type === 'turn/end' && ended.data.turn === start.data.turn) return undefined
  const completedSteps = agent.session.events.filter(event => (
    event.type === 'step/start' && event.data.turn === start.data.turn
  )).length
  return { turn: start.data.turn, step: completedSteps + 1 }
}

function routedTarget(agent: Agent): Pick<LlmCallConfig, 'provider' | 'model'> | undefined {
  const config = agent.session.requestHeader()?.config
  if (config !== undefined && config.provider.length > 0 && config.model.length > 0) {
    return { provider: config.provider, model: config.model }
  }
  if (agent.options.provider === undefined || agent.options.model === undefined) return undefined
  return { provider: agent.options.provider, model: agent.options.model }
}

/** Collect text from only the newest few tool results, bounded before routing. */
function recentToolEvidence(agent: Agent, maximum: number): string {
  const pieces: string[] = []
  let remaining = maximum
  let inspectedResults = 0
  for (let index = agent.session.events.length - 1; index >= 0 && remaining > 0 && inspectedResults < 8; index -= 1) {
    const event = agent.session.events[index]
    if (event?.type !== 'tool/result') continue
    inspectedResults += 1
    const block = event.data.message.content[0]
    const raw = nestedText(block.content, remaining)
    if (raw.length === 0) continue
    const prefix = block.isError ? '[tool error]\n' : '[tool result]\n'
    const available = Math.max(0, remaining - prefix.length)
    const piece = `${prefix}${boundEvidencePiece(raw, available)}`
    pieces.push(piece)
    remaining -= piece.length + 1
  }
  return pieces.join('\n')
}

function nestedText(blocks: readonly unknown[], maximum: number): string {
  const pieces: string[] = []
  let remaining = maximum
  for (const value of blocks) {
    if (remaining <= 0 || typeof value !== 'object' || value === null) continue
    const block = value as { type?: unknown; text?: unknown }
    if (block.type !== 'text' || typeof block.text !== 'string') continue
    const piece = block.text.slice(0, remaining)
    pieces.push(piece)
    remaining -= piece.length + 1
  }
  return pieces.join('\n')
}

function boundEvidencePiece(text: string, maximum: number): string {
  if (text.length <= maximum) return text
  if (maximum <= 3) return text.slice(0, maximum)
  const tail = Math.floor(maximum / 4)
  return `${text.slice(0, maximum - tail - 3)}\n…\n${text.slice(-tail)}`
}

/**
 * Install deterministic task classification, request caps, soft convergence checkpoints, and adaptive pruning.
 * @param ctx - Cordis context carrying LLM and token-meter services.
 * @param rawConfig - configurable task profiles and pruning levels.
 */
export async function apply(ctx: Context, rawConfig: Config = {}): Promise<void> {
  const config = resolveConfig(rawConfig)
  if (ctx.get('adaptiveToolResultPruner') === undefined) {
    await ctx.plugin(AdaptiveToolResultPruner)
  }
  const states = new WeakMap<Agent, AgentState>()
  const warnedCapacity = new Set<string>()

  const stateFor = (agent: Agent): AgentState => {
    const existing = states.get(agent)
    if (existing !== undefined) return existing
    const request = latestHumanRequest(agent)
    const state: AgentState = {
      taskClass: request === undefined ? 'small' : classifyTask(messageText(request)),
      requestText: request === undefined ? '' : messageText(request),
      routedRisk: undefined,
      lastPrune: undefined,
    }
    states.set(agent, state)
    return state
  }

  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (message.source.kind !== 'user') return
    const state = stateFor(agent)
    state.requestText = messageText(message)
    state.taskClass = classifyTask(state.requestText)
  })

  ctx.on('agent/request', async ({ agent }, next): Promise<LlmCallConfig> => {
    const resolved = await next()
    if (agent.options.maxTokens !== undefined) return resolved
    const cap = profileFor(config, stateFor(agent).taskClass).maxTokens
    if (resolved.maxTokens !== undefined && resolved.maxTokens <= cap) return resolved
    return { ...resolved, maxTokens: cap }
  })

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const agent = context.agent
    if (agent === undefined) return assembled
    const position = proposedPosition(agent)
    if (position === undefined) return assembled
    const state = stateFor(agent)
    const profile = profileFor(config, state.taskClass)
    let phase: 'normal' | 'checkpoint' | 'finalization' = 'normal'
    let decision: RiskRouteDecision | undefined
    if (position.step >= profile.hardStepBudget) {
      phase = 'finalization'
    } else if (position.step >= profile.softStepBudget) {
      phase = 'checkpoint'
      if (state.routedRisk?.turn !== position.turn) {
        state.routedRisk = {
          turn: position.turn,
          decision: routeRisk({
            taskClass: state.taskClass,
            requestText: state.requestText,
            recentEvidence: recentToolEvidence(agent, config.riskRouter.maxEvidenceChars),
          }, config.riskRouter),
        }
        const routed = state.routedRisk.decision
        const detail = `adaptive-agent-policy: risk checkpoint ${routed.risk ?? 'none'} `
          + `(reason ${routed.reason}, score ${routed.score})`
        if (routed.risk === undefined) ctx.logger.debug(detail)
        else ctx.logger.info(detail)
      }
      decision = state.routedRisk.decision
    }
    // A system section is rebuilt for the current request and never becomes a
    // session message. This keeps one compact phase instruction without the
    // cumulative input growth caused by appending runtime-context snapshots.
    const adaptiveSection = {
      name: 'adaptive-agent-policy:state',
      text: adaptivePhaseText(state.taskClass, phase, decision),
    }
    const sections = assembled.sections.filter(candidate => candidate.name !== adaptiveSection.name)
    return {
      ...assembled,
      sections: [...sections, adaptiveSection],
      tools: phase === 'finalization' ? [] : assembled.tools,
    }
  })

  ctx.on('agent/pre-step', async ({ agent, messages, turn, step, signal }, next): Promise<PreStepDecision> => {
    const state = stateFor(agent)
    const newestHuman = messages.findLast(message => message.source.kind === 'user')
    if (newestHuman !== undefined) {
      state.requestText = messageText(newestHuman)
      state.taskClass = classifyTask(state.requestText)
    }
    const downstream = await next()
    if (downstream.kind === 'reject' || signal.aborted) return downstream

    const target = routedTarget(agent)
    let pressureRatio = 0
    if (target !== undefined) {
      try {
        const recorded = agent.session.requestContext()
        const recordedWindow = recorded?.provider === target.provider && recorded.model === target.model
          ? recorded.contextWindow
          : undefined
        const contextWindow = recordedWindow
          ?? (await ctx.llm.resolveModelInfo(target.provider, target.model, signal)).context?.contextWindow
        if (contextWindow !== undefined && contextWindow > 0) {
          pressureRatio = ctx.tokenMeter.measure(agent.session).totalTokens / contextWindow
        }
      } catch (error: unknown) {
        const key = `${target.provider}/${target.model}`
        if (!warnedCapacity.has(key)) {
          warnedCapacity.add(key)
          ctx.logger.warn(`adaptive-agent-policy: context capacity unavailable for ${key}: ${String(error)}`)
        }
      }
    }

    const level = config.pruneLevels.findLast(candidate => (
      step >= candidate.atStep || pressureRatio >= candidate.atPressureRatio
    ))
    if (level !== undefined) {
      const pruneKey = `${turn}:${step}:${level.name}`
      if (state.lastPrune !== pruneKey) {
        state.lastPrune = pruneKey
        const pruner = agent.ctx.get('adaptiveToolResultPruner')
        if (pruner !== undefined) {
          const result = pruner.pruneSession(agent.session, {
            policy: prunePolicy(level),
            protectRecentSteps: level.protectRecentSteps,
            minimumCharsRemoved: level.minimumCharsRemoved,
          })
          if (result.pruned.length > 0) {
            ctx.logger.info(
              `adaptive-agent-policy: ${level.name} pruning removed ${result.charsRemoved} characters `
              + `from ${result.pruned.length} tool results`,
            )
          }
        }
      }
    }

    return downstream
  })
}
