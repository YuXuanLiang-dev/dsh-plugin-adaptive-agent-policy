import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  resolveRiskRouterConfig,
  riskCheckpoint,
  routeRisk,
  type RiskClass,
  type RoutedTaskClass,
} from '../src/risk-router.ts'

function selected(taskClass: RoutedTaskClass, requestText: string, recentEvidence = ''): RiskClass | undefined {
  return routeRisk({ taskClass, requestText, recentEvidence }).risk
}

describe('risk router cross-domain coverage', () => {
  it.each([
    ['small', '修复 parser 对空输入的校验逻辑', 'boundary'],
    ['small', 'Handle invalid input in the request parser', 'boundary'],
    ['small', '修复重试逻辑，失败后不能重复发送请求', 'retry'],
    ['large', 'Implement retry policy with idempotent side effects', 'retry'],
    ['large', '修复队列并发时的乱序竞态', 'concurrency'],
    ['large', 'Prevent the worker deadlock and lock ordering issue', 'concurrency'],
    ['large', '数据库迁移后需要支持重启恢复状态', 'persistence'],
    ['frontend', 'Keep the theme persisted in localStorage after reload', 'persistence'],
    ['small', '阻止下载接口中的路径穿越', 'security'],
    ['large', 'Validate the token permission boundary to prevent auth bypass', 'security'],
    ['large', '配置 schema 升级必须保持向后兼容', 'compatibility'],
    ['small', 'Avoid a breaking change in the public API wire format', 'compatibility'],
    ['frontend', '实现表单的键盘导航和无障碍焦点管理', 'frontend'],
    ['frontend', 'Fix responsive layout horizontal overflow', 'frontend'],
    ['large', '中止任务时必须清理监听器，避免资源泄漏', 'resource'],
    ['small', 'Terminate the orphan process and dispose handles after abort', 'resource'],
    ['batch', '批量迁移所有文件并校验汇总计数，不能遗漏', 'batch-integrity'],
    ['batch', 'Codemod all files while preserving the aggregate after partial failure', 'batch-integrity'],
  ] as const)('routes %s request %s to %s', (taskClass, request, expected) => {
    expect(selected(taskClass, request)).toBe(expected)
  })

  it('chooses one highest-confidence risk when several are present', () => {
    const decision = routeRisk({
      taskClass: 'small',
      requestText: 'Fix retry idempotency and also prevent path traversal token leaks at the permission boundary',
    })
    expect(decision).toMatchObject({ risk: 'security', reason: 'selected' })
  })

  it('falls through a covered top risk to one explicit uncovered risk', () => {
    const decision = routeRisk({
      taskClass: 'small',
      requestText: 'Fix retry idempotency and prevent path traversal token leaks at the permission boundary',
      recentEvidence: '✓ path traversal security permission test passed',
    })
    expect(decision).toMatchObject({ risk: 'retry', reason: 'selected' })
  })

  it('can route from a concrete failed tool result when the request is generic', () => {
    const decision = routeRisk({
      taskClass: 'large',
      requestText: 'Refactor worker scheduling',
      recentEvidence: '[tool error]\nFAIL: race condition detected while ordering two workers',
    })
    expect(decision).toMatchObject({ risk: 'concurrency', reason: 'selected' })
  })
})

describe('risk router restraint', () => {
  it.each([
    ['small', '修复 README 中 retry 的拼写错误'],
    ['small', 'Rename timeoutLabel in src/view.ts'],
    ['frontend', 'Build a static hero page with warm colors'],
    ['large', 'Refactor the internal architecture without behavior changes'],
    ['small', 'Change the button color to blue'],
    ['small', 'Process the text and close the issue'],
    ['frontend', 'Write documentation for the authentication UI'],
    ['small', 'Update a comment mentioning an empty input'],
  ] as const)('does not invent a risk for %s request %s', (taskClass, request) => {
    expect(selected(taskClass, request)).toBeUndefined()
  })

  it('never adds an executable check to a read-only task', () => {
    const decision = routeRisk({
      taskClass: 'read',
      requestText: '审查认证绕过与路径穿越风险，不要修改',
    })
    expect(decision).toMatchObject({ risk: undefined, reason: 'read-only' })
  })

  it('does not route an unrelated generic failure', () => {
    const decision = routeRisk({
      taskClass: 'small',
      requestText: 'Update the title text',
      recentEvidence: '[tool error]\nSnapshot test failed: expected title A',
    })
    expect(decision).toMatchObject({ risk: undefined, reason: 'low-confidence' })
  })

  it('does not combine an unrelated failure with a risk word from another result', () => {
    const decision = routeRisk({
      taskClass: 'small',
      requestText: 'Update the title text',
      recentEvidence: '[tool result]\nREADME mentions retry\n[tool error]\nSnapshot failed: title mismatch',
    })
    expect(decision).toMatchObject({ risk: undefined, reason: 'low-confidence' })
  })

  it.each([
    '✓ retry timeout idempotency test passed',
    'retry policy spec: 12 passed, 0 failed',
    '重试与幂等测试通过',
  ])('skips a targeted check when recent output already covers it: %s', (evidence) => {
    const decision = routeRisk({
      taskClass: 'small',
      requestText: '修复重试逻辑并保证幂等',
      recentEvidence: evidence,
    })
    expect(decision).toMatchObject({ risk: undefined, reason: 'already-covered' })
  })

  it('does not treat a failing named test as coverage', () => {
    const decision = routeRisk({
      taskClass: 'small',
      requestText: '修复重试逻辑并保证幂等',
      recentEvidence: 'retry timeout idempotency spec FAILED',
    })
    expect(decision).toMatchObject({ risk: 'retry', reason: 'selected' })
  })

  it('supports explicit disable, threshold, and coverage controls', () => {
    const input = { taskClass: 'small' as const, requestText: 'Prevent path traversal in the file API' }
    expect(routeRisk(input, { enabled: false }).reason).toBe('disabled')
    expect(routeRisk(input, { minimumScore: 20 }).risk).toBeUndefined()
    expect(routeRisk({
      ...input,
      recentEvidence: '✓ path traversal security test passed',
    }, { skipCovered: false }).risk).toBe('security')
  })
})

describe('risk router bounded cost and anti-overfitting', () => {
  it('bounds both inputs before matching, while retaining useful tails', () => {
    const decision = routeRisk({
      taskClass: 'small',
      requestText: `${'request '.repeat(20_000)}prevent path traversal`,
      recentEvidence: `${'result '.repeat(30_000)}security test failed with path traversal`,
    }, { maxRequestChars: 512, maxEvidenceChars: 768 })
    expect(decision.risk).toBe('security')
    expect(decision.requestCharsInspected).toBeLessThanOrEqual(512)
    expect(decision.evidenceCharsInspected).toBeLessThanOrEqual(768)
  })

  it('validates router limits and returns detached defaults', () => {
    expect(resolveRiskRouterConfig()).toEqual({
      enabled: true,
      minimumScore: 4,
      maxRequestChars: 4_096,
      maxEvidenceChars: 8_192,
      skipCovered: true,
    })
    expect(() => resolveRiskRouterConfig({ maxEvidenceChars: 0 })).toThrow(/positive integer/)
  })

  it('keeps every targeted instruction to one bounded check', () => {
    const risks: RiskClass[] = [
      'boundary', 'retry', 'concurrency', 'persistence', 'security',
      'compatibility', 'frontend', 'resource', 'batch-integrity',
    ]
    for (const risk of risks) {
      const text = riskCheckpoint(risk)
      expect(text).toMatch(/(?:at most one|Use one)/)
      expect(text.length).toBeLessThan(260)
    }
  })

  it('contains no benchmark-specific viewport or pairwise recipe', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8')
    expect(source).not.toMatch(/390\s*px/i)
    expect(source).not.toContain('neutral or empty value with an extreme or failure value')
    expect(source).not.toContain('failure, abort, or retry with ordering')
  })
})
