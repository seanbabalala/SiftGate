import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

export function checkPricingEditorLocale(root) {
  const files = [path.join(root, 'src/pages/pricing-page.tsx'), ...fs.readdirSync(path.join(root, 'src/components/pricing')).filter(n => n.endsWith('.tsx')).map(n => path.join(root, 'src/components/pricing', n))]
  const missing = []
  for (const file of files) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const visit = node => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && /^toLocale(?:String|DateString|TimeString)$/.test(node.expression.name.text) && !node.arguments.length)
        missing.push(path.relative(root, file) + ':' + (source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1))
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  assert.deepEqual(missing, [], 'Pricing displays must use the selected interface locale, not the browser default')
  console.log('Pricing display locale contract passed: no implicit browser locale in pricing page/components.')
}
