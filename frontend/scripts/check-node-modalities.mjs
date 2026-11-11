import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('..', import.meta.url))
const helperSource = readFileSync(`${root}/src/lib/node-modalities-form.ts`, 'utf8')
const javascript = ts.transpileModule(helperSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
const { deriveModalities, modelBucketModalities, chatModelCapabilities } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`)

assert.deepEqual(deriveModalities(['responses'], ['vision']), ['text', 'vision'], 'An operator-selected vision capability must remain image input, not image generation.')
assert.deepEqual(deriveModalities(['messages'], [], ['text', 'image']), ['text', 'image'], 'Editing a multimodal node must preserve existing image input support.')
assert.deepEqual(deriveModalities(['chat'], [], ['text', 'vision']), ['text', 'vision'], 'Legacy vision declarations must survive unrelated node edits.')
assert.deepEqual(deriveModalities(['chat'], []), ['text'], 'Do not grant vision to a text-only node without a declaration.')
assert.deepEqual(deriveModalities(['embeddings'], ['vision'], ['text', 'image']), ['text', 'embedding'], 'Removing chat endpoints must not add chat image input to embedding-only nodes.')
assert.deepEqual(deriveModalities(['images'], []), ['image'], 'Image generation remains independent of chat image input.')
assert.deepEqual(deriveModalities(['rerank', 'audio', 'video', 'realtime'], []), ['rerank', 'audio', 'video', 'realtime'])
assert.equal(modelBucketModalities('models'), undefined, 'Adding a chat price must not manufacture a text-only model override.')
assert.deepEqual(modelBucketModalities('embedding_models'), ['text', 'embedding'])
assert.deepEqual(modelBucketModalities('image_models'), ['image'])
assert.deepEqual(modelBucketModalities('realtime_models'), ['text', 'audio', 'realtime'])
const references = [
  { id: 'text-only', modalities: ['text'], input_types: ['text'] },
  { id: 'vision-model', modalities: ['text', 'image'], input_types: ['text', 'image'] },
]
const declared = chatModelCapabilities(['text-only', 'vision-model', 'custom-model'], references)
assert.deepEqual(declared, {
  'text-only': { modalities: ['text'], input_types: ['text'] },
  'vision-model': { modalities: ['text', 'image'], input_types: ['text', 'image'] },
}, 'Mixed nodes must keep known text-only model constraints and known image input declarations independent of prices.')
declared['vision-model'].modalities.push('audio')
assert.deepEqual(references[1].modalities, ['text', 'image'], 'Building a payload must not mutate the shared catalog.')
assert.deepEqual(chatModelCapabilities([], references), {}, 'Inactive chat models must not gain declarations.')
const special = chatModelCapabilities(['__proto__'], [{ id: '__proto__', modalities: ['text'] }])
assert(Object.hasOwn(special, '__proto__'), 'A model ID must remain a data key, never change the declaration object prototype.')
assert.equal(Object.getPrototypeOf(special), Object.prototype)
assert.deepEqual(special.__proto__.modalities, ['text'])

const formSource = readFileSync(`${root}/src/components/nodes/NodeFormModal.tsx`, 'utf8')
assert(formSource.includes('deriveModalities(form.selectedCapabilities, form.capabilities, editNode?.modalities)'), 'Node edits must pass operator vision and existing modality declarations to the payload builder.')
assert(formSource.includes('modelBucketModalities(bucket)'), 'Model price metadata must use the safe bucket declaration helper.')
assert(formSource.includes('presetInfo?.catalog.models') && formSource.includes('...declaredChatCapabilities[model]'), 'Catalog model input declarations must survive both unpriced creation and explicit price edits.')
assert(!formSource.includes('BUCKET_MODALITIES[bucket]'), 'The old hard-coded chat text override must not remain in the price builder.')
console.log('Node modality form checks passed: vision declarations survive saves, and chat prices do not disable image input.')
