import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('..', import.meta.url))
const source = readFileSync(`${root}/src/lib/reasoning-effort-display.ts`, 'utf8')
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
const { formatReasoningEffort } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`)
for (const budgetLabel of ['Thinking Budget', '思考预算']) {
  for (const effort of [null, undefined, '', 'unknown']) {
    assert.equal(formatReasoningEffort(effort, 16384, budgetLabel, '—'), budgetLabel)
    assert.equal(formatReasoningEffort(effort, 0, budgetLabel, '—'), budgetLabel)
  }
  for (const effort of ['low', 'medium', 'high', 'max', 'none']) {
    assert.equal(formatReasoningEffort(effort, 16384, budgetLabel, '—'), effort)
  }
  for (const budget of [null, undefined, NaN, Infinity, -1]) {
    assert.equal(formatReasoningEffort(null, budget, budgetLabel, '—'), '—')
    assert.equal(formatReasoningEffort('unknown', budget, budgetLabel, '—'), 'unknown')
  }
}
for (const page of ['LogsPage', 'RouteExplanationPage']) {
  assert(readFileSync(`${root}/src/pages/${page}.tsx`, 'utf8').includes('formatReasoningEffort('), `${page} must render budget-only rows without inventing effort tiers`)
}
console.log('Reasoning effort display checks passed: explicit tiers preserved; budgets are not guessed as high/max.')
