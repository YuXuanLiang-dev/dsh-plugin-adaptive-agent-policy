# DSH Adaptive Agent Policy

[中文](README.md) | English

An unofficial standalone DeepSeek Harness plugin that adapts prompts, output caps, soft and hard step budgets,
and tool-result pruning to each task class. It reduces unproductive loops on larger work while keeping the
user-selected model and tool presentation stable.

> Status: `0.1.0-rc.1` initial standalone release candidate. DeepSeek Harness is still in developer preview. This
> plugin builds against its published `0.1.0-rc.6` package APIs; rerun the tests before each DSH upgrade.

## Attribution

| Project | Exact revision | Role | License |
|---|---|---|---|
| DeepSeek Harness | [`47f943859b`](https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a) | Base architecture, Agent Loop, event log, and plugin APIs | MIT |
| OpenCode | [`e23586af26`](https://github.com/anomalyco/opencode/tree/e23586af2623f1bc2e8e6965d2d7acf7bd03d5c3) | Design reference for model prompts, last-step handling, output limits, and compaction | MIT |
| This plugin | This repository | DSH-native implementation of the adaptive policy | MIT |

OpenCode is a design reference, not a runtime dependency. The specific references are
[`session/system.ts`](https://github.com/anomalyco/opencode/blob/e23586af2623f1bc2e8e6965d2d7acf7bd03d5c3/packages/opencode/src/session/system.ts),
[`session/prompt.ts`](https://github.com/anomalyco/opencode/blob/e23586af2623f1bc2e8e6965d2d7acf7bd03d5c3/packages/opencode/src/session/prompt.ts),
[`tool/truncate.ts`](https://github.com/anomalyco/opencode/blob/e23586af2623f1bc2e8e6965d2d7acf7bd03d5c3/packages/opencode/src/tool/truncate.ts),
and
[`session/compaction.ts`](https://github.com/anomalyco/opencode/blob/e23586af2623f1bc2e8e6965d2d7acf7bd03d5c3/packages/opencode/src/session/compaction.ts).
See [NOTICE.md](NOTICE.md) for the complete provenance statement. This project is not endorsed by DeepSeek or
OpenCode.

## Added capabilities

- Model-free multilingual task routing: `read`, `small`, `frontend`, `large`, and `batch`.
- Per-class maximum output tokens, soft checkpoints, and text-only hard final steps.
- Executable class-specific checks for small, large, and frontend tasks instead of generic review prompts.
- `moderate`, `tight`, and `critical` pruning selected by step count or context pressure.
- Recent-result protection, aggregate minimum savings, and replay-safe replacement events.
- One public plugin entry; its enhanced pruner uses a private service name and does not collide with DSH's
  upstream static pruner.

The plugin never changes the user's provider, model, reasoning effort, permissions, sandbox, or Native/Code tool
presentation.

## Design

```mermaid
flowchart LR
  U["Human request"] --> R["Deterministic task router"]
  R --> P["Task profile"]
  P --> L["Logged policy and output cap"]
  L --> S{"Step or context pressure"}
  S -->|Normal| L
  S -->|Prune| C["Replay-safe result pruning"]
  C --> L
  S -->|Soft| V["Executable checkpoint"]
  V --> L
  S -->|Hard| F["Text-only final step"]
```

Core principles:

1. **Proportional control.** A read-only investigation should not pay the loop cost of a cross-module refactor.
2. **Stable route and cache prefix.** Do not hot-switch the model or tool schema after tool history exists.
3. **Executable evidence over verbal review.** A checkpoint requests one valuable interaction check, not renewed
   broad exploration.
4. **Prune only when profitable.** History is untouched below the result-size and aggregate-saving thresholds.
5. **Model-visible means log-visible.** Policies, checkpoints, and finalization notices enter DSH's event log.
6. **Everything remains a plugin.** Routing policy and pruning service retain separate Cordis lifecycles.

## Installation

The package name was unclaimed when checked on 2026-08-15; check it again immediately before publishing.

```sh
pnpm add dsh-plugin-adaptive-agent-policy
```

Add one entry to a DSH Cordis composition that already provides `llm` and `tokenMeter`:

```yaml
- name: dsh-plugin-adaptive-agent-policy
  config: {}
```

The plugin installs its bundled enhanced pruner. It does not require a separate
`@deepseek-ai/dsh-compaction-tool-result-pruner` installation.

## Defaults

### Task profiles

| Class | Maximum output tokens | Soft step | Text-only hard step |
|---|---:|---:|---:|
| `read` | 16,384 | 4 | 8 |
| `small` | 32,768 | 5 | 9 |
| `frontend` | 32,768 | 8 | 14 |
| `large` | 65,536 | 10 | 18 |
| `batch` | 65,536 | 10 | 20 |

The maximum applies only when the Agent has no explicit `maxTokens`; a stricter caller or provider cap wins.

### Progressive pruning

| Level | Step | Pressure | Result threshold | Retained head / tail | Protected recent steps | Minimum saving |
|---|---:|---:|---:|---:|---:|---:|
| `moderate` | 6 | 45% | 16,384 chars | 12,288 / 2,048 | 2 | 8,192 chars |
| `tight` | 10 | 65% | 8,192 chars | 4,096 / 1,024 | 1 | 4,096 chars |
| `critical` | 14 | 75% | 4,096 chars | 2,048 / 1,024 | 1 | 2,048 chars |

Either the step or pressure trigger qualifies a level. If model context-window metadata is unavailable, pressure
routing is disabled and step routing continues.

## Benchmarks

The controlled 2026-08-15 comparison used the same `deepseek-v4-pro` High route, credential source, prompts, seed
workspaces, visible tests, and isolated session homes. Hidden checks were absent from model workspaces. Each row is
one run, not an average.

| Task | Variant | Steps | Total tokens | Time | Cache hit | Quality |
|---|---|---:|---:|---:|---:|---|
| Small retry fix | Original | 6 | 59,891 | 44.2s | 84.1% | 5/5; hidden boundary passed |
| Small retry fix | Final adaptive | 6 | 66,830 | 49.5s | 85.2% | 5/5; hidden boundary passed |
| Frontend dashboard | Original | 9 | 174,022 | 180.4s | 93.2% | 5/5; 390 px overflow |
| Frontend dashboard | Final adaptive | 7 | 162,141 | 194.0s | 92.7% | 5/5; no 390 px overflow; persisted theme |
| Cross-module queue | Original | 8 | 207,525 | 355.5s | 93.4% | 7/7; hidden transitions 2/2 |
| Cross-module queue | Final adaptive | 6 | 158,420 | 255.0s | 91.4% | 7/7; hidden transitions 2/2 |

| Aggregate | Original | Final adaptive | Delta |
|---|---:|---:|---:|
| Total tokens | 441,438 | 387,391 | -12.2% |
| Wall time | 580.2s | 498.6s | -14.1% |

Large work used 23.7% fewer tokens and finished 28.3% faster at equal quality. Small work paid an 11.6% token
premium to retain the interaction boundary. Frontend used 6.8% fewer tokens but took 7.5% longer while fixing
mobile overflow. Normal benchmark sessions emitted no prune replacements because no stale large result qualified;
unit and integration tests exercise all three pruning levels separately.

An early broad-prompt iteration induced the frontend agent to build a CDP verifier, expanding the run to 30
steps, 1.316M tokens, and 675.7 seconds. The final policy therefore uses deterministic classes, one executable
class-specific check, bounded frontend verification, and a text-only last step instead of generic prompt stacking.

These are single samples from a nondeterministic model and support a direction, not a universal or statistically
significant performance claim.

## Development and publication

```sh
pnpm install
pnpm run check
npm login
npm publish --tag next
```

## Known limits

- Text routing can conservatively misclassify ambiguous tasks; it deliberately avoids a routing model call.
- Character pruning is not token-exact and does not understand the semantic importance of removed content.
- A text-only hard step bounds runaway loops but can stop work that genuinely needs more tool steps; tune profiles
  from repeated workload evidence.
- DSH is evolving quickly; this release currently treats `0.1.0-rc.6` as its compatibility boundary.

## License

[MIT](LICENSE). Redistributions should retain the provenance statement in [NOTICE.md](NOTICE.md).
