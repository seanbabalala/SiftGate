import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pureResolver } from './check-price-inheritance.mjs'

export function checkMediaSpecification({ root, moduleFrom, model }) {
  const form=moduleFrom(path.join(root,'src/lib/media-specification-form.ts'))
  const original=model.newPriceBook('image'), fixed=form.fixedMediaSpecification(original,'resolution','1080p')
  assert.equal(original.media_specification,undefined)
  assert.equal(fixed.media_specification.fixed.resolution,'1080p')
  assert.deepEqual(JSON.parse(JSON.stringify(form.fixedMediaSpecification(fixed,'resolution',null).media_specification)),{fixed:{}})
  assert.equal(form.enableMediaSpecification(fixed,false).media_specification,undefined)
  assert.equal(form.fixedMediaSpecification(original,'quality','').media_specification.fixed.quality,'','Never infer a value for a newly selected fixed specification')
  assert.equal(form.inheritedMediaSpecification(form.fixedMediaSpecification(original,'resolution','720p'),fixed).media_specification.fixed.resolution,'1080p')
  assert.equal(form.inheritedMediaSpecification(fixed,original).media_specification,undefined)
  const context=form.simulatedMediaSources({resolution:'720p',operation:'generation',generation_count:'2'},'provider_result','generic-v1')
  assert.deepEqual(JSON.parse(JSON.stringify(context)),{media_adapter:'generic-v1',media_estimated:false,media_sources:{resolution:'provider_result',operation:'operation',generation_count:'request_parameter'}})
  const {compilePriceBook}=pureResolver(root)
  const content={...fixed,billing_dimensions:['image_count'],groups:[{id:'base',order:0,required:true,rules:[{id:'base',priority:0,mode:'whole_request',condition:{},rates:[{operation:'replace',component:{id:'image',dimension:'image_count',unit:'image',unit_size:'1',amount:'0.1'}}]}]}]}
  assert.equal(compilePriceBook(content,{book_id:'b',version_id:'v'}).document().media_specification.fixed.resolution,'1080p')
  assert.throws(()=>compilePriceBook(form.fixedMediaSpecification(content,'width','0'),{book_id:'b',version_id:'v'}))
  const editor=fs.readFileSync(path.join(root,'src/components/pricing/price-book-editor.tsx'),'utf8'),simulator=fs.readFileSync(path.join(root,'src/components/pricing/price-simulator.tsx'),'utf8')
  assert.ok(editor.includes('MediaSpecificationEditor content={content} onChange={change}'))
  assert.ok(simulator.includes('mediaSource, mediaAdapter, fx, compared]'),'Source changes invalidate old simulation results')
  assert.ok(simulator.includes('media_specification ? simulatedMediaSources'))
  assert.ok(simulator.includes('MediaSpecificationEvidence trace={cost.selection.media_specification}'))
  for(const locale of ['en','zh','zh-TW','ja','ko','th','es']){
    const strings=JSON.parse(fs.readFileSync(path.join(root,`src/locales/${locale}/pricing.json`)))
    for(const key of ['title','enabled','help','source','adapter','fixed','value','inputSource','inputAdapter','supplied','effective','conflict','legacy','declarations','unknown','invalid',...['request_parameter','provider_result','operation','model_fixed','unspecified'].map(k=>'source.'+k)])assert.ok(strings['mediaSpec.'+key],locale+':'+key)
  }
  console.log('Media specification form contracts passed: explicit fixed/adapter selection, no invented defaults, simulation identity, immutable copies, pure server validation and seven locales.')
}
