import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(`${root}/package.json`, 'utf8')) as {
  files?: string[]
  dsh?: { bundle?: { patch?: string } }
}
const bundlePatch = readFileSync(`${root}/cordis.patch.yml`, 'utf8')

describe('published DSH bundle', () => {
  it('declares and ships the official profile bundle patch', () => {
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.files).toContain('cordis.patch.yml')
  })

  it('inserts the public plugin entry with stable identity', () => {
    expect(bundlePatch).toContain('id: adaptive-agent-policy')
    expect(bundlePatch).toContain('name: dsh-plugin-adaptive-agent-policy')
    expect(bundlePatch).toContain('config: {}')
  })
})
