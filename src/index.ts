/**
 * Deterministic task routing, request budgets, and progressive tool-result
 * pruning for coding agents.
 *
 * @module dsh-plugin-adaptive-agent-policy
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, deepFreeze } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig, UserMessage } from '@deepseek-ai/dsh-llm'
import AdaptiveToolResultPruner, {
  resolveConfig as resolvePruneConfig,
  type ToolResultPruneConfig,
} from './pruner/index.ts'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-token-meter'

/** Cordis plugin name used by loader diagnostics and model-visible message provenance. */
export const name = 'adaptive-agent-policy'

/** Services required for request-pressure measurement and routed-model capacity lookup. */
export const inject = ['llm', 'tokenMeter']

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
}

/** Fully validated immutable configuration. */
export interface ResolvedConfig {
  /** Exact profile for every task class. */
  readonly taskProfiles: readonly Readonly<TaskProfileConfig>[]
  /** Ordered moderate-to-critical pruning levels. */
  readonly pruneLevels: readonly Readonly<PruneLevelConfig>[]
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
})

const POLICY_TEXT: Record<TaskClass, string> = {
  read: 'Treat this as a read-only investigation. Gather only the evidence needed to answer; do not modify files, and stop once the cause or conclusion is supported.',
  small: 'Treat this as a focused change. Inspect the target and immediate conventions, implement the smallest complete fix, and run narrow checks. Before finishing, execute one pairwise counterexample that combines a neutral or empty value with an extreme or failure value; individually valid boundaries can interact. Do not claim it was checked without observed output.',
  frontend: 'Treat this as a frontend implementation. Establish a deliberate visual direction, implement early, and run existing checks. Keep mobile overflow, hierarchy, primary interaction, and accessibility as acceptance criteria; do not build new verification infrastructure unless the user requested it.',
  large: 'Treat this as a cross-cutting change. Map only the relevant architecture, callers, data flow, and tests, then implement and verify it. Exercise one pairwise state transition combining failure, abort, or retry with ordering, cleanup, or concurrency before finishing.',
  batch: 'Treat this as a batch-oriented task. Group independent discovery and transformations, use bounded outputs, preserve ordering where operations depend on each other, and verify representative results plus the aggregate outcome.',
}

const CHECKPOINT_TEXT: Record<TaskClass, string> = {
  read: 'Stop exploring. Answer from the strongest evidence already gathered, or name the exact missing evidence.',
  small: 'Do not broaden scope. Run one executable pairwise counterexample combining a neutral or empty value with an extreme or failure value, fix only if it fails, then finish. A verbal or algebraic check does not count.',
  frontend: 'Do not build preview or browser infrastructure. Use at most one batched source-inspection step, one corrective edit step, and one existing-check step. If a browser command is already configured, check 390px overflow and the primary interaction once; otherwise inspect those risks in that single batch, then finish.',
  large: 'Stop broad exploration. Run one executable pairwise transition absent from visible tests: combine failure, abort, or retry with ordering, cleanup, or concurrency. Fix from evidence if needed, then finish.',
  batch: 'Stop broad exploration. Verify representative transformed cases and the aggregate count, then finish or report the exact blocker.',
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
  announced: TaskClass | undefined
  checkpointTurns: Set<number>
  finalizationTurns: Set<number>
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
  return deepFreeze({ taskProfiles: profiles, pruneLevels: levels })
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

function latestHumanTask(agent: Agent): TaskClass | undefined {
  const event = agent.session.events.findLast(candidate => (
    candidate.type === 'user/message' && candidate.data.source.kind === 'user'
  ))
  return event?.type === 'user/message' ? classifyTask(messageText(event.data)) : undefined
}

function latestAnnouncement(agent: Agent): TaskClass | undefined {
  const event = agent.session.events.findLast(candidate => (
    candidate.type === 'user/message'
    && candidate.data.source.kind === 'plugin'
    && candidate.data.source.plugin === name
    && candidate.data.source.form === 'notice'
    && candidate.data.source.summary.startsWith('task policy: ')
  ))
  if (event?.type !== 'user/message'
    || event.data.source.kind !== 'plugin'
    || event.data.source.form !== 'notice') return undefined
  const summary = event.data.source.summary
  const taskClass = summary.slice('task policy: '.length)
  return TASK_CLASSES.find(candidate => candidate === taskClass)
}

function priorCheckpointTurns(agent: Agent): Set<number> {
  const turns = new Set<number>()
  for (const event of agent.session.events) {
    if (event.type !== 'user/message'
      || event.data.source.kind !== 'plugin'
      || event.data.source.plugin !== name
      || event.data.source.form !== 'notice') continue
    const turn = /^task checkpoint: [a-z]+; turn (\d+)$/.exec(event.data.source.summary)?.[1]
    if (turn !== undefined) turns.add(Number(turn))
  }
  return turns
}

function priorFinalizationTurns(agent: Agent): Set<number> {
  const turns = new Set<number>()
  for (const event of agent.session.events) {
    if (event.type !== 'user/message'
      || event.data.source.kind !== 'plugin'
      || event.data.source.plugin !== name
      || event.data.source.form !== 'notice') continue
    const turn = /^task finalization: [a-z]+; turn (\d+)$/.exec(event.data.source.summary)?.[1]
    if (turn !== undefined) turns.add(Number(turn))
  }
  return turns
}

function profileFor(config: ResolvedConfig, taskClass: TaskClass): Readonly<TaskProfileConfig> {
  const profile = config.taskProfiles.find(candidate => candidate.taskClass === taskClass)
  /* v8 ignore next -- resolveConfig requires exactly one profile for every closed task class. */
  if (profile === undefined) throw new Error(`adaptive-agent-policy: no profile for ${taskClass}`)
  return profile
}

function policyMessage(taskClass: TaskClass): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: `<task_policy class="${taskClass}">\n${POLICY_TEXT[taskClass]}\n</task_policy>` }],
    source: {
      kind: 'plugin',
      plugin: name,
      form: 'notice',
      summary: `task policy: ${taskClass}`,
    },
  })
}

function checkpointMessage(taskClass: TaskClass, turn: number): UserMessage {
  return createUserMessage({
    content: [{
      type: 'text',
      text: `<task_checkpoint class="${taskClass}">\n${CHECKPOINT_TEXT[taskClass]}\n</task_checkpoint>`,
    }],
    source: {
      kind: 'plugin',
      plugin: name,
      form: 'notice',
      summary: `task checkpoint: ${taskClass}; turn ${turn}`,
    },
  })
}

function finalizationMessage(taskClass: TaskClass, turn: number): UserMessage {
  return createUserMessage({
    content: [{
      type: 'text',
      text: `<task_finalization class="${taskClass}">\n`
        + 'The task step budget is exhausted and tools are unavailable for this step. Do not request or call tools. '
        + 'Give the best final answer supported by completed work, and state any exact remaining work or blocker.\n'
        + '</task_finalization>',
    }],
    source: {
      kind: 'plugin',
      plugin: name,
      form: 'notice',
      summary: `task finalization: ${taskClass}; turn ${turn}`,
    },
  })
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
    const state: AgentState = {
      taskClass: latestHumanTask(agent) ?? 'small',
      announced: latestAnnouncement(agent),
      checkpointTurns: priorCheckpointTurns(agent),
      finalizationTurns: priorFinalizationTurns(agent),
      lastPrune: undefined,
    }
    states.set(agent, state)
    return state
  }

  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (message.source.kind !== 'user') return
    const state = stateFor(agent)
    state.taskClass = classifyTask(messageText(message))
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
    if (position.step < profile.hardStepBudget || assembled.tools.length === 0) return assembled
    return { ...assembled, tools: [] }
  })

  ctx.on('agent/pre-step', async ({ agent, messages, turn, step, signal }, next): Promise<PreStepDecision> => {
    const state = stateFor(agent)
    const newestHuman = messages.findLast(message => message.source.kind === 'user')
    if (newestHuman !== undefined) state.taskClass = classifyTask(messageText(newestHuman))
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

    const profile = profileFor(config, state.taskClass)
    const finalizing = step >= profile.hardStepBudget && !state.finalizationTurns.has(turn)
    const checkpoint = step >= profile.softStepBudget && !state.checkpointTurns.has(turn)
    const announce = state.announced !== state.taskClass
    if (!announce && !checkpoint && !finalizing) return downstream
    state.announced = state.taskClass
    if (checkpoint) state.checkpointTurns.add(turn)
    if (finalizing) state.finalizationTurns.add(turn)
    const policyMessages: UserMessage[] = []
    if (announce) policyMessages.push(policyMessage(state.taskClass))
    if (checkpoint) policyMessages.push(checkpointMessage(state.taskClass, turn))
    if (finalizing) policyMessages.push(finalizationMessage(state.taskClass, turn))
    return {
      kind: 'enter',
      messages: [...policyMessages, ...downstream.messages],
    }
  })
}
