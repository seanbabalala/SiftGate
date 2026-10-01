import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
export function checkContextRangeTable({root, moduleFrom}) {
  const exact = moduleFrom(path.join(root, '../src/pricing/exact-decimal.ts'))
  const conditions = moduleFrom(path.join(root, '../src/pricing/pricing-conditions.ts'), {'./exact-decimal': exact})
  const model = moduleFrom(path.join(root, 'src/lib/context-range-table.ts'), {'../../../src/pricing/exact-decimal':exact,'../../../src/pricing/pricing-conditions':conditions})
  const plain = value => JSON.parse(JSON.stringify(value))
  const rule = (id, min, max, extra={}) => ({id,mode:'whole_request',priority:0,condition:{input_tokens:{min,...max===undefined?{}:{max}},...extra},rates:[{operation:'replace',component:{id:id+'-rate',dimension:'uncached_input_tokens',unit:'token',unit_size:'1000000',amount:'0.000000001'}}],multipliers:[{dimension:'uncached_input_tokens',factor:'2'}]})
  const pair = [rule('short','0','272001'),rule('long','272001')]
  assert.deepEqual(plain(model.contextRangeRows(pair).map(r=>r.conflicts)),[[],[]])
  const overlap = [pair[0],rule('long','272000')];assert.deepEqual(plain(model.contextRangeRows(overlap).map(r=>r.conflicts)),[[1],[0]])
  for (const [field,left,right] of [['service_tiers',['default'],['priority']],['time_tags',['peak'],['offpeak']],['media',{quality:['standard']},{quality:['hd']}]]) {
    const rules=[rule('a','0',undefined,{[field]:left}),rule('b','1',undefined,{[field]:right})]
    assert.deepEqual(plain(model.contextRangeRows(rules).map(r=>r.conflicts)),[[],[]],field+' excludes a false conflict')
  }
  const equivalentMedia = [rule('a','0',undefined,{media:{frame_rate:['24']}}),rule('b','1',undefined,{media:{frame_rate:['24.000']}})]
  const originalMedia = JSON.stringify(equivalentMedia)
  assert.deepEqual(plain(model.contextRangeRows(equivalentMedia).map(r=>r.conflicts)),[[1],[0]],'Normalize media exactly as the compiler before overlap inspection')
  assert.equal(JSON.stringify(equivalentMedia),originalMedia,'Inspection must not rewrite stored condition values')
  const priority=[...overlap.map(x=>structuredClone(x))];priority[1].priority=1;assert.deepEqual(plain(model.contextRangeRows(priority).map(r=>r.conflicts)),[[],[]])
  for(const [min,max] of [['','2'],['-1','2'],['1.1','2'],['1e3','2000'],['2','2'],['3','2'],['9'.repeat(31),undefined]])assert.equal(model.contextRangeRows([rule('bad',min,max)])[0].valid,false)
  assert.equal(model.contextRangeRows([rule('big','9007199254740993','9007199254740994')])[0].valid,true)
  assert.equal(model.contextRangeRows([{...pair[0],condition:{}}])[0].valid,true)
  assert.throws(()=>model.contextRangeRows(Array.from({length:129},(_,i)=>rule('r'+i,String(i),String(i+1)))))
  const content={currency:'USD',billing_dimensions:['uncached_input_tokens'],groups:[{id:'group',order:0,required:true,rules:pair}],source:{kind:'manual',reference:'https://example.test/rates'}}
  const before=JSON.stringify(content),edited=model.editContextRange(content,0,1,{min:'272000',max:'9007199254740993'});assert.equal(JSON.stringify(content),before)
  const expected=structuredClone(content);expected.groups[0].rules[1].condition.input_tokens={min:'272000',max:'9007199254740993'};assert.deepEqual(plain(edited),expected)
  assert.deepEqual(plain(model.editContextRange(content,0,0,undefined).groups[0].rules[0].condition),{})
  const jsx=(type,props)=>({type,props:props??{}}),changes=[],selected=[]
  const deps={'react':{useMemo:fn=>fn()},'react/jsx-runtime':{jsx,jsxs:jsx,Fragment:'fragment'},'react-i18next':{useTranslation:()=>({t:(k,args)=>args? k+JSON.stringify(args):k,i18n:{resolvedLanguage:'es'}})},'@/components/ui/button':{Button:'Button'},'@/lib/context-range-table':model,'@/lib/pricing-model':{ruleLabel:r=>r.id},'./pricing-fields':{PriceInput:'PriceInput'},'./cost-metadata':{CostValue:'CostValue'}}
  const file=path.join(root,'src/components/pricing/context-range-table.tsx'),exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require:k=>{assert.ok(deps[k],k);return deps[k]}},{filename:file})
  const nodes=(v,out=[])=>{if(!v||typeof v!=='object')return out;if(Array.isArray(v)){v.forEach(x=>nodes(x,out));return out}out.push(v);nodes(v.props?.children,out);return out}
  const render=(content,index=0,disabled=false)=>nodes(exports.ContextRangeTable({content,groupIndex:0,ruleIndex:index,select:i=>selected.push(i),onChange:c=>changes.push(c),disabled}))
  let tree=render(content);assert.equal(tree.filter(n=>n.type==='tr').length,3);const input=tree.filter(n=>n.type==='PriceInput')[2];input.props.onChange({target:{value:'272000'}});assert.equal(changes.at(-1).groups[0].rules[1].condition.input_tokens.min,'272000');assert.equal(JSON.stringify(content),before)
  tree=render({...content,groups:[{...content.groups[0],rules:Array.from({length:33},(_,i)=>rule('r'+i,String(i),String(i+1)))}]},16,true)
  assert.equal(tree.filter(n=>n.type==='tr').length,17);assert.ok(tree.filter(n=>n.type==='PriceInput').every(n=>n.props.disabled));assert.ok(tree.filter(n=>n.type==='input').every(n=>n.props.disabled))
  tree.find(n=>n.type==='Button'&&n.props.children==='next').props.onClick();assert.equal(selected.at(-1),32)
  const editor = fs.readFileSync(path.join(root,'src/components/pricing/price-book-editor.tsx'),'utf8'); assert.ok(editor.includes('<ContextRangeTable ')); assert.ok(/<fieldset[^>]*className="min-w-0/.test(editor), 'Fieldset must not expand its min-content width and clip the table outside its scroll container')
  console.log('Context range table contracts passed: exact boundaries, shared overlap predicate, tier/time/media/priority exclusions, hidden-field preservation and 16-row pagination.')
}
