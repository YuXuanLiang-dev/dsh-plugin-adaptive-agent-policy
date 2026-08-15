import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
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

    await ctx.plugin(AdaptivePolicy)

    expect(ctx.get('adaptiveToolResultPruner')).toBeInstanceOf(AdaptiveToolResultPruner)
  })
})
