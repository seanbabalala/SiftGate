const bucketModalities: Record<string, string[]> = {
  embedding_models: ['text', 'embedding'],
  rerank_models: ['rerank'],
  image_models: ['image'],
  audio_models: ['audio'],
  video_models: ['video'],
  realtime_models: ['text', 'audio', 'realtime'],
}

export function modelBucketModalities(bucket: string): string[] | undefined {
  // A chat price does not declare whether that model accepts image input.
  const modalities = bucketModalities[bucket]
  return modalities ? [...modalities] : undefined
}

interface ModelInputDeclaration {
  modalities: string[]
  input_types?: string[]
}

export function chatModelCapabilities(
  models: string[],
  references: (ModelInputDeclaration & { id: string })[],
): Record<string, ModelInputDeclaration> {
  const byId = new Map(references.map(model => [model.id, model]))
  const result = new Map<string, ModelInputDeclaration>()
  for (const model of models) {
    const reference = byId.get(model)
    if (!reference?.modalities.length) continue
    result.set(model, {
      modalities: [...reference.modalities],
      ...(reference.input_types?.length ? { input_types: [...reference.input_types] } : {}),
    })
  }
  return Object.fromEntries(result)
}

export function deriveModalities(
  selectedCapabilities: string[],
  capabilities: string[],
  existingModalities: string[] = [],
): string[] {
  const modalities = new Set<string>()
  const hasChat = selectedCapabilities.some(capability =>
    ['chat', 'responses', 'messages', 'gemini'].includes(capability),
  )
  if (hasChat) {
    modalities.add('text')
    for (const modality of existingModalities) {
      if (modality === 'vision' || modality === 'image') modalities.add(modality)
    }
    if (capabilities.includes('vision') && !modalities.has('vision') && !modalities.has('image')) {
      modalities.add('vision')
    }
  }
  if (selectedCapabilities.includes('embeddings')) {
    modalities.add('text')
    modalities.add('embedding')
  }
  if (selectedCapabilities.includes('rerank')) modalities.add('rerank')
  if (selectedCapabilities.includes('images')) modalities.add('image')
  if (selectedCapabilities.includes('audio')) modalities.add('audio')
  if (selectedCapabilities.includes('video')) modalities.add('video')
  if (selectedCapabilities.includes('realtime')) modalities.add('realtime')
  return [...modalities]
}
