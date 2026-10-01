import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

/** Exercise the real Dialog root's effect cleanup; native keyboard behavior is checked separately in a browser. */
export function checkDialogFocus(root) {
  const file = path.join(root, 'src/components/ui/dialog.tsx')
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText
  const trigger = () => ({ isConnected: true, calls: [], focus(options) { this.calls.push(options); documentFixture.activeElement = this } })
  let documentFixture
  function fixture(overflow = '') {
    documentFixture = { body: { style: { overflow } }, activeElement: null }
    const effects = [], exports = {}
    const react = { useRef: current => ({ current }), useEffect: effect => effects.push(effect), useCallback: callback => callback,
      createContext: value => ({ Provider: 'provider', value }), useContext: context => context.value }
    const dependencies = {
      react, 'react-dom': { createPortal: value => value },
      'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
      'framer-motion': { AnimatePresence: 'presence', motion: { div: 'div' } }, '@/lib/utils': { cn: (...values) => values.join(' ') },
    }
    vm.runInNewContext(code, { exports, document: documentFixture, require: name => {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected Dialog dependency: ${name}`)
      return dependencies[name]
    } }, { filename: file })
    return { render(open) { const count = effects.length; exports.Dialog({ open, onOpenChange() {}, children: null }); return effects.slice(count).map(effect => effect()) }, document: documentFixture }
  }

  let checks = 0
  {
    const f = fixture(), button = trigger(); f.document.activeElement = button
    const cleanups = f.render(true); assert.equal(f.document.body.style.overflow, 'hidden')
    f.document.activeElement = { isConnected: false }
    cleanups.forEach(cleanup => cleanup?.())
    assert.equal(button.calls.length, 1, 'Unmounting an open conditional Dialog must restore its trigger')
    assert.equal(button.calls[0]?.preventScroll, true, 'Restoring focus must not jump the underlying page')
    assert.equal(f.document.body.style.overflow, '')
    checks++
  }
  {
    const f = fixture('hidden'), button = trigger(); f.document.activeElement = button
    f.render(false).forEach(cleanup => cleanup?.())
    assert.equal(f.document.body.style.overflow, 'hidden', 'A closed Dialog must not unlock another open dialog')
    assert.equal(button.calls.length, 0)
    checks++
  }
  {
    const f = fixture('scroll'), button = trigger(); f.document.activeElement = button
    const cleanups = f.render(true); button.isConnected = false
    cleanups.forEach(cleanup => cleanup?.())
    assert.equal(button.calls.length, 0, 'Detached triggers must not receive focus')
    assert.equal(f.document.body.style.overflow, 'scroll', 'Restore the prior inline overflow value')
    checks++
  }
  {
    const f = fixture('auto'), outer = trigger(), inner = trigger(); f.document.activeElement = outer
    const outerCleanup = f.render(true); f.document.activeElement = inner
    const innerCleanup = f.render(true); f.document.activeElement = {}
    innerCleanup.forEach(cleanup => cleanup?.())
    assert.equal(f.document.body.style.overflow, 'hidden')
    assert.equal(inner.calls.length, 1); assert.equal(f.document.activeElement, inner)
    outerCleanup.forEach(cleanup => cleanup?.())
    assert.equal(f.document.body.style.overflow, 'auto')
    assert.equal(outer.calls.length, 1); assert.equal(f.document.activeElement, outer)
    checks++
  }
  {
    const f = fixture(), button = trigger(); f.document.activeElement = button
    const cleanups = f.render(true)
    cleanups.forEach(cleanup => cleanup?.()) // React cleans the previous effect before the open=false effect.
    f.render(false).forEach(cleanup => cleanup?.())
    assert.equal(button.calls.length, 1); assert.equal(f.document.body.style.overflow, '')
    checks++
  }
  {
    const f = fixture('clip'); f.render(true).forEach(cleanup => cleanup?.())
    assert.equal(f.document.body.style.overflow, 'clip')
    checks++
  }
  console.log(`Dialog effect contracts passed: ${checks} cleanup/closed/detached/nested/controlled/null-focus cases; browser keyboard checks remain separate.`)
}
