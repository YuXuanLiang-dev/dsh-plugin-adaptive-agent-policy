/** Model-free, bounded risk selection for one convergence checkpoint. */

export type RiskClass =
  | 'boundary'
  | 'retry'
  | 'concurrency'
  | 'persistence'
  | 'security'
  | 'compatibility'
  | 'frontend'
  | 'resource'
  | 'batch-integrity'

export type RoutedTaskClass = 'read' | 'small' | 'frontend' | 'large' | 'batch'

/** User-tunable router limits. All work remains local and deterministic. */
export interface RiskRouterConfig {
  enabled?: boolean
  minimumScore?: number
  maxRequestChars?: number
  maxEvidenceChars?: number
  skipCovered?: boolean
}

export interface ResolvedRiskRouterConfig {
  readonly enabled: boolean
  readonly minimumScore: number
  readonly maxRequestChars: number
  readonly maxEvidenceChars: number
  readonly skipCovered: boolean
}

export interface RiskRouterInput {
  taskClass: RoutedTaskClass
  requestText: string
  recentEvidence?: string
}

export type RiskRouteReason = 'selected' | 'disabled' | 'read-only' | 'low-confidence' | 'already-covered'

/** Auditable result used by the checkpoint message and tests. */
export interface RiskRouteDecision {
  readonly risk: RiskClass | undefined
  readonly score: number
  readonly reason: RiskRouteReason
  readonly requestCharsInspected: number
  readonly evidenceCharsInspected: number
}

interface RiskProfile {
  readonly risk: RiskClass
  readonly strong: readonly RegExp[]
  readonly support: readonly RegExp[]
  readonly affinity: readonly RoutedTaskClass[]
  readonly checkpoint: string
}

/** Conservative defaults keep router cost independent of total session size. */
export const DEFAULT_RISK_ROUTER_CONFIG: ResolvedRiskRouterConfig = Object.freeze({
  enabled: true,
  minimumScore: 4,
  maxRequestChars: 4_096,
  maxEvidenceChars: 8_192,
  skipCovered: true,
})

const RISK_PROFILES: readonly RiskProfile[] = [
  {
    risk: 'security',
    strong: [
      /(?:注入|越权|路径穿越|密钥泄露|令牌泄露|权限绕过|认证绕过|沙箱逃逸)/i,
      /(?:injection|path traversal|privilege escalation|auth(?:entication|orization)? bypass|token leak|secret leak|sandbox escape)/i,
      /(?:权限|认证|授权|凭据|密钥|令牌|permission|authentication|authorization|credential|secret|token).{0,36}(?:校验|绕过|泄露|暴露|边界|validate|bypass|leak|expos|boundary)/i,
    ],
    support: [/(?:安全|权限|认证|授权|凭据|密钥|security|permission|auth|credential|secret|token)/i],
    affinity: ['large', 'small'],
    checkpoint: 'Use at most one existing check or minimal reproduction for the most relevant trust or permission boundary. Never expose real credentials, and do not start a broad security audit.',
  },
  {
    risk: 'persistence',
    strong: [
      /(?:持久化|迁移|事务|崩溃恢复|断电恢复|部分写入|重启恢复|重新加载).{0,32}(?:状态|数据|文件|数据库|存储|缓存)?/i,
      /(?:persist(?:ence|ed)?|migration|transaction|crash recovery|partial write|restart|reload).{0,36}(?:state|data|file|database|storage|cache|recover|consisten)/i,
      /(?:localStorage|indexedDB|sqlite|database).{0,32}(?:reload|restart|migration|transaction|persist|recover)/i,
    ],
    support: [/(?:持久化|存储|数据库|迁移|事务|重启|persist|storage|database|migration|transaction|restart|reload)/i],
    affinity: ['large', 'frontend'],
    checkpoint: 'Use at most one existing check or minimal reproduction across the relevant save/reload, restart, migration, or partial-write boundary. Do not build new persistence infrastructure.',
  },
  {
    risk: 'concurrency',
    strong: [
      /(?:竞态|死锁|数据竞争|原子性|并发安全|锁顺序|乱序|并行写入)/i,
      /(?:race condition|deadlock|data race|atomicity|thread[- ]safe|lock ordering|out[- ]of[- ]order|concurrent write)/i,
      /(?:并发|并行|队列|concurren|parallel|queue).{0,32}(?:顺序|竞态|锁|原子|重复|ordering|race|lock|atomic|duplicate)/i,
    ],
    support: [/(?:并发|并行|异步|队列|锁|concurren|parallel|async|queue|lock)/i],
    affinity: ['large', 'batch'],
    checkpoint: 'Use at most one existing check or minimal reproduction for the relevant ordering, atomicity, or race boundary. Keep it deterministic and do not create a stress-test framework.',
  },
  {
    risk: 'retry',
    strong: [
      /(?:重试|超时).{0,32}(?:逻辑|机制|次数|失败|副作用|重复|恢复|请求|任务)|(?:退避|幂等|去重)/i,
      /(?:retry|timeout).{0,36}(?:logic|policy|attempt|failure|side effect|duplicate|recover|request|job)|(?:backoff|idempoten|deduplicat)/i,
      /(?:重试|retry).{0,32}(?:重复写入|重复发送|副作用|幂等|duplicate|side effect|idempoten)/i,
    ],
    support: [/(?:重试|超时|退避|幂等|retry|timeout|backoff|idempoten)/i],
    affinity: ['small', 'large'],
    checkpoint: 'Use at most one existing check or minimal reproduction for the relevant retry, timeout, or duplicate-side-effect boundary. Do not expand into unrelated failure modes.',
  },
  {
    risk: 'boundary',
    strong: [
      /(?:边界条件|边缘情况|空值|空数组|空输入|无效输入|上限|下限|溢出).{0,32}(?:处理|校验|解析|计算|值|输入)?/i,
      /(?:boundary condition|edge case|empty input|null value|invalid input|upper limit|lower limit|overflow).{0,36}(?:handl|validat|pars|comput|value|input)?/i,
      /(?:解析|校验|计算|索引|parser|validation|calculation|index).{0,28}(?:空|无效|最大|最小|null|empty|invalid|max|min|overflow)/i,
    ],
    support: [/(?:边界|空值|无效|上限|下限|boundary|edge case|null|empty|invalid|overflow)/i],
    affinity: ['small'],
    checkpoint: 'Use at most one existing check or minimal reproduction for the most relevant input or state boundary. Choose it from the changed behavior; do not enumerate unrelated edge cases.',
  },
  {
    risk: 'compatibility',
    strong: [
      /(?:向后兼容|兼容旧版|破坏性变更|协议版本|配置迁移|模式迁移|公开接口)/i,
      /(?:backward compatib|breaking change|protocol version|config migration|schema migration|public API|wire format)/i,
      /(?:配置|协议|模式|接口|config|protocol|schema|API).{0,32}(?:兼容|升级|迁移|旧版|compatib|upgrade|migration|legacy)/i,
    ],
    support: [/(?:兼容|协议|模式|公开接口|compatib|protocol|schema|public API|wire format)/i],
    affinity: ['large', 'small'],
    checkpoint: 'Use at most one existing contract or compatibility check for the changed public configuration, schema, protocol, or API surface. Do not test unrelated consumers.',
  },
  {
    risk: 'resource',
    strong: [
      /(?:资源泄漏|内存泄漏|句柄泄漏|清理失败|未释放|孤儿进程|监听器泄漏|临时文件泄漏)/i,
      /(?:resource leak|memory leak|handle leak|cleanup failure|not disposed|orphan process|listener leak|temporary file leak)/i,
      /(?:中止|失败|超时|abort|failure|timeout).{0,32}(?:清理|释放|关闭|终止|cleanup|dispose|close|terminate|unsubscribe)/i,
    ],
    support: [/(?:清理|释放|关闭|中止|cleanup|dispose|close|abort|listener|stream|socket|process)/i],
    affinity: ['large', 'small'],
    checkpoint: 'Use at most one existing check or minimal reproduction that observes cleanup on the relevant completion, failure, abort, or timeout path. Do not add leak-detection infrastructure.',
  },
  {
    risk: 'frontend',
    strong: [
      /(?:响应式|横向溢出|键盘导航|焦点管理|屏幕阅读器|无障碍|主题持久化|触摸交互)/i,
      /(?:responsive|horizontal overflow|keyboard navigation|focus management|screen reader|accessibility|theme persistence|touch interaction)/i,
      /(?:页面|界面|布局|表单|page|UI|layout|form).{0,32}(?:移动端|视口|溢出|键盘|焦点|无障碍|mobile|viewport|overflow|keyboard|focus|accessib)/i,
    ],
    support: [/(?:前端|页面|界面|布局|交互|frontend|page|UI|layout|interaction|responsive)/i],
    affinity: ['frontend'],
    checkpoint: 'Use at most one existing preview or check for the most relevant layout, input, or accessibility state identified by the request or current evidence. Do not create browser infrastructure.',
  },
  {
    risk: 'batch-integrity',
    strong: [
      /(?:批量|所有文件|全部文件|代码迁移|大规模迁移).{0,32}(?:计数|遗漏|部分失败|顺序|一致性|汇总)?/i,
      /(?:bulk|all files|codemod|mass migration).{0,36}(?:count|omission|partial failure|ordering|consisten|summary)?/i,
      /(?:部分失败|partial failure).{0,32}(?:批次|批量|batch|bulk)/i,
    ],
    support: [/(?:批量|所有文件|迁移|汇总|bulk|all files|codemod|migration|aggregate)/i],
    affinity: ['batch'],
    checkpoint: 'Use one representative existing check plus the aggregate invariant or count for the batch. Do not inspect every item when representative and aggregate evidence agree.',
  },
]

const DOCUMENTATION_TARGET = /(?:\bREADME\b|\bdocs?\/|documentation|\bcomments?\b|文档|注释|说明文字|帮助文本|copywriting|文案)/i
const RUNTIME_TARGET = /(?:\bsrc\/|\btests?\/|\.[cm]?[jt]sx?\b|函数|逻辑|运行时|测试|function|runtime|test|spec)/i
const FAILURE_CUE = /(?:✗|❌|\bfail(?:ed|ure|ing)?\b|\berror\b|\bexception\b|\btimed out\b|失败|错误|异常|执行超时)/i
const PASS_CUE = /(?:✓|✅|\bpass(?:ed|ing)?\b|\bok\b|\bsuccess(?:ful)?\b|通过|成功)/i
const CHECK_CUE = /(?:test|spec|check|assert|smoke|验证|测试|检查|断言|✓|✅|\bpass)/i

/** Validate and detach partial controls. */
export function resolveRiskRouterConfig(config: RiskRouterConfig = {}): ResolvedRiskRouterConfig {
  const resolved = {
    enabled: config.enabled ?? DEFAULT_RISK_ROUTER_CONFIG.enabled,
    minimumScore: config.minimumScore ?? DEFAULT_RISK_ROUTER_CONFIG.minimumScore,
    maxRequestChars: config.maxRequestChars ?? DEFAULT_RISK_ROUTER_CONFIG.maxRequestChars,
    maxEvidenceChars: config.maxEvidenceChars ?? DEFAULT_RISK_ROUTER_CONFIG.maxEvidenceChars,
    skipCovered: config.skipCovered ?? DEFAULT_RISK_ROUTER_CONFIG.skipCovered,
  }
  for (const key of ['minimumScore', 'maxRequestChars', 'maxEvidenceChars'] as const) {
    if (!Number.isInteger(resolved[key]) || resolved[key] < 1) {
      throw new Error(`adaptive-agent-policy: riskRouter.${key} must be a positive integer`)
    }
  }
  return Object.freeze(resolved)
}

/** Select at most one high-confidence, not-yet-covered risk. */
export function routeRisk(
  input: RiskRouterInput,
  rawConfig: RiskRouterConfig | ResolvedRiskRouterConfig = {},
): RiskRouteDecision {
  const config = resolveRiskRouterConfig(rawConfig)
  const request = boundText(input.requestText, config.maxRequestChars)
  const evidence = boundText(input.recentEvidence ?? '', config.maxEvidenceChars)
  const base = {
    requestCharsInspected: request.length,
    evidenceCharsInspected: evidence.length,
  }
  if (!config.enabled) return { ...base, risk: undefined, score: 0, reason: 'disabled' }
  if (input.taskClass === 'read') return { ...base, risk: undefined, score: 0, reason: 'read-only' }

  const documentationOnly = DOCUMENTATION_TARGET.test(request) && !RUNTIME_TARGET.test(request)
  const candidates = RISK_PROFILES.map((profile, priority) => {
    const requestStrong = documentationOnly ? 0 : matchCount(request, profile.strong)
    const requestSupport = documentationOnly ? 0 : matchCount(request, profile.support)
    const evidenceStrong = matchCount(evidence, profile.strong)
    const evidenceSupport = matchCount(evidence, profile.support)
    const evidenceRisk = evidenceStrong + evidenceSupport > 0
    let score = requestStrong > 0 ? 4 + Math.min(2, requestStrong - 1) : 0
    if (requestSupport > 0) score += 1
    if (evidenceStrong > 0 || evidenceSupport > 0) score += 1
    if (evidenceRisk && hasRiskFailure(evidence, profile)) score += 2
    if (score > 0 && profile.affinity.includes(input.taskClass)) score += 1
    return { profile, priority, score, requestStrong, covered: isCovered(evidence, profile) }
  }).sort((left, right) => (
    right.score - left.score
    || right.requestStrong - left.requestStrong
    || left.priority - right.priority
  ))

  const strongest = candidates[0]
  /* v8 ignore next -- the closed profile table is non-empty by construction. */
  if (strongest === undefined || strongest.score < config.minimumScore) {
    return { ...base, risk: undefined, score: strongest?.score ?? 0, reason: 'low-confidence' }
  }
  const winner = config.skipCovered
    ? candidates.find(candidate => candidate.score >= config.minimumScore && !candidate.covered)
    : strongest
  if (winner === undefined) {
    return { ...base, risk: undefined, score: strongest.score, reason: 'already-covered' }
  }
  return { ...base, risk: winner.profile.risk, score: winner.score, reason: 'selected' }
}

/** Return the bounded checkpoint instruction for a selected risk. */
export function riskCheckpoint(risk: RiskClass): string {
  const profile = RISK_PROFILES.find(candidate => candidate.risk === risk)
  /* v8 ignore next -- RiskClass and the profile table are closed together. */
  if (profile === undefined) throw new Error(`adaptive-agent-policy: unknown risk ${risk}`)
  return profile.checkpoint
}

function matchCount(text: string, patterns: readonly RegExp[]): number {
  return patterns.reduce((count, pattern) => count + Number(pattern.test(text)), 0)
}

function boundText(text: string, maximum: number): string {
  if (text.length <= maximum) return text
  const tail = Math.floor(maximum / 4)
  return `${text.slice(0, maximum - tail - 3)}\n…\n${text.slice(-tail)}`
}

function hasFailure(text: string): boolean {
  const neutralized = text
    .replace(/\b(?:0|zero)\s+(?:fail(?:ed|ures?)?|errors?)\b/gi, '')
    .replace(/(?:无|没有)失败/g, '')
  return FAILURE_CUE.test(neutralized)
}

function hasRiskFailure(evidence: string, profile: RiskProfile): boolean {
  return evidenceFragments(evidence).some((fragment) => {
    const mentionsRisk = matchCount(fragment, profile.strong) + matchCount(fragment, profile.support) > 0
    return mentionsRisk && hasFailure(fragment)
  })
}

function isCovered(evidence: string, profile: RiskProfile): boolean {
  if (evidence.length === 0) return false
  return evidenceFragments(evidence).some((fragment) => {
    const mentionsRisk = matchCount(fragment, profile.strong) + matchCount(fragment, profile.support) > 0
    return mentionsRisk && PASS_CUE.test(fragment) && CHECK_CUE.test(fragment) && !hasFailure(fragment)
  })
}

function evidenceFragments(evidence: string): string[] {
  const fragments: string[] = []
  const results = evidence.split(/(?=\[tool (?:result|error)\])/i)
  for (const result of results) {
    fragments.push(...result.split(/\r?\n/).filter(line => line.length > 0))
    const flattened = result.replace(/\s+/g, ' ')
    for (let offset = 0; offset < flattened.length; offset += 240) {
      fragments.push(flattened.slice(offset, offset + 360))
    }
  }
  return fragments
}
