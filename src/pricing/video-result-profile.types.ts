/** Versioned, explicitly selected result schemas. Never inferred from a model name or hostname. */
export const VIDEO_RESULT_PROFILES = [
  "generic-v1",
  "gemini-veo-rest-v1",
  "runway-task-v1",
] as const;
export type VideoResultProfile = (typeof VIDEO_RESULT_PROFILES)[number];
export type NativeVideoResultProfile = Exclude<
  VideoResultProfile,
  "generic-v1"
>;
