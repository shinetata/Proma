/**
 * GPT-6 model-family recognition shared by channel, runtime, and UI code.
 *
 * Astra can carry hyphenated SKU suffixes returned by Codex. Sol accepts the
 * GPT-6.1 dotted minor version, and Luna stays an exact ID family so nearby
 * names are never routed as an official model by mistake.
 */
const GPT_6_ASTRA_FAMILY_PATTERN = /^gpt-6-astra(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/
const GPT_6_SOL_FAMILY_PATTERN = /^gpt-6(?:\.1)?-sol(?:-\d+)?$/
const GPT_6_61_SOL_FAMILY_PATTERN = /^gpt-6\.1-sol(?:-\d+)?$/
const GPT_6_LUNA_FAMILY_PATTERN = /^gpt-6-luna(?:-\d+)?$/

function normalizeModelId(modelId: string | undefined): string | undefined {
  return modelId?.trim().toLowerCase().replace(/\[1m\]$/i, '')
}

export function isGpt6AstraFamily(modelId: string | undefined): boolean {
  const normalized = normalizeModelId(modelId)
  return normalized !== undefined && GPT_6_ASTRA_FAMILY_PATTERN.test(normalized)
}

export function isGpt6SolFamily(modelId: string | undefined): boolean {
  const normalized = normalizeModelId(modelId)
  return normalized !== undefined && GPT_6_SOL_FAMILY_PATTERN.test(normalized)
}

/** GPT-6.1 Sol 需要与 GPT-6 Sol 区分的场景（Fast Mode 档位、上下文窗口推断）。 */
export function isGpt61SolFamily(modelId: string | undefined): boolean {
  const normalized = normalizeModelId(modelId)
  return normalized !== undefined && GPT_6_61_SOL_FAMILY_PATTERN.test(normalized)
}

export function isGpt6LunaFamily(modelId: string | undefined): boolean {
  const normalized = normalizeModelId(modelId)
  return normalized !== undefined && GPT_6_LUNA_FAMILY_PATTERN.test(normalized)
}