import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as AdaptivePolicy from '../src/index.ts'
import {
  classifyTask,
  resolveConfig,
  type TaskProfileConfig,
} from '../src/index.ts'
import { AdaptiveToolResultPruner } from '../src/pruner/index.ts'

function profiles(): TaskProfileConfig[] {
  return resolveConfig().taskProfiles.map(profile => ({ ...profile }))
}

describe('adaptive policy', () => {
  it.each([
    ['分析性能下降原因，不要修改', 'read'],
    ['修复 src/retry.ts 的边界条件', 'small'],
    ['创建响应式静态网页仪表盘', 'frontend'],
    ['完成跨模块端到端架构改造', 'large'],
    ['批量修改所有文件中的旧 API', 'batch'],
  ] as const)('classifies %s as %s', (request, expected) => {
    expect(classifyTask(request)).toBe(expected)
  })

  it('ships a complete, detached, immutable policy', () => {
    const config = resolveConfig()
    expect(config.taskProfiles.map(profile => profile.taskClass))
      .toEqual(['read', 'small', 'frontend', 'large', 'batch'])
    expect(config.pruneLevels.map(level => level.name))
      .toEqual(['moderate', 'tight', 'critical'])
    expect(config.riskRouter).toEqual({
      enabled: true,
      minimumScore: 4,
      maxRequestChars: 4_096,
      maxEvidenceChars: 8_192,
      skipCovered: true,
    })
    expect(Object.isFrozen(config)).toBe(true)
  })

  it('rejects an incomplete profile table and a non-progressive level table', () => {
    expect(() => resolveConfig({ taskProfiles: profiles().slice(1) }))
      .toThrow(/missing task profiles/)
    expect(() => resolveConfig({
      pruneLevels: [
        {
          name: 'first',
          atStep: 10,
          atPressureRatio: 0.5,
          thresholdChars: 100,
          headChars: 20,
          tailChars: 10,
          protectRecentSteps: 1,
          minimumCharsRemoved: 1,
        },
        {
          name: 'backwards',
          atStep: 9,
          atPressureRatio: 0.6,
          thresholdChars: 80,
          headChars: 20,
          tailChars: 10,
          protectRecentSteps: 1,
          minimumCharsRemoved: 1,
        },
      ],
    })).toThrow(/must increase triggers/)
  })

  it('installs its private enhanced pruner automatically', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(TokenMeter)
    await ctx.plugin(SystemPrompt)

    await ctx.plugin(AdaptivePolicy)

    expect(ctx.get('adaptiveToolResultPruner')).toBeInstanceOf(AdaptiveToolResultPruner)
  })

  it('keeps one non-persistent system section stable within each policy phase', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(TokenMeter)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AdaptivePolicy)

    const request = createUserMessage({
      content: [{ type: 'text', text: '修复重试逻辑并保证幂等，避免重复请求' }],
      source: { kind: 'user' },
    })
    const events: Array<Record<string, unknown>> = [
      { type: 'user/message', data: request },
      { type: 'turn/start', data: { turn: 1 } },
    ]
    const agent = { session: { events }, options: {} } as unknown as Agent
    const policyAssembly = async () => ctx.systemPrompt.assemble({ agent })
    const policyText = async () => (await policyAssembly())
      .sections.find(entry => entry.name === 'adaptive-agent-policy:state')?.text
    const systemText = async () => renderPrompt(await policyAssembly())

    const normal = await policyText()
    const normalSystem = await systemText()
    expect(normal).toContain('<task_policy class="small">')
    expect(normal).not.toContain('<task_checkpoint')
    expect(await policyText()).toBe(normal)
    expect(await systemText()).toBe(normalSystem)

    for (let step = 1; step <= 4; step += 1) events.push({ type: 'step/start', data: { turn: 1, step } })
    const checkpoint = await policyText()
    const checkpointSystem = await systemText()
    expect(checkpoint).toContain('<task_checkpoint class="small" risk="retry">')
    expect(checkpoint).not.toContain('<task_policy')
    expect(await policyText()).toBe(checkpoint)
    expect(await systemText()).toBe(checkpointSystem)
    expect(checkpointSystem).not.toBe(normalSystem)

    for (let step = 5; step <= 8; step += 1) events.push({ type: 'step/start', data: { turn: 1, step } })
    const finalization = await policyText()
    const finalizationSystem = await systemText()
    expect(finalization).toContain('<task_finalization class="small">')
    expect(finalization).not.toContain('<task_checkpoint')
    expect(finalization).not.toContain('<task_policy')
    expect(await systemText()).toBe(finalizationSystem)
    expect(finalizationSystem).not.toBe(checkpointSystem)

    events.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    events.push({ type: 'turn/start', data: { turn: 2 } })
    expect(await policyText()).toBe(normal)
    const finalAssembly = await policyAssembly()
    expect(finalAssembly.contexts).not.toContainEqual(expect.objectContaining({
      name: 'adaptive-agent-policy:state',
    }))
    expect(JSON.stringify(events)).not.toMatch(/task_(?:policy|checkpoint|finalization)/)
    expect(events).toHaveLength(12)
  })
})
