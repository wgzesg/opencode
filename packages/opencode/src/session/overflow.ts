import type { Config } from "@/config/config"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { Log } from "@/util/log"
import type { MessageV2 } from "./message-v2"

const COMPACTION_BUFFER = 20_000
const log = Log.create({ service: "session.overflow" })

export function isOverflow(input: { cfg: Config.Info; tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }) {
  if (input.cfg.compaction?.auto === false) return false
  const context = input.model.limit.context
  if (context === 0) return false

  const count =
    input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write

  const reserved =
    input.cfg.compaction?.reserved ?? Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model))
  const usable = input.model.limit.input
    ? input.model.limit.input - reserved
    : context - ProviderTransform.maxOutputTokens(input.model)
  const overflow = count >= usable

  log.info("context check", {
    token_count: count,
    usable_tokens: usable,
    utilization_pct: usable > 0 ? Math.round((count / usable) * 100) : 0,
    overflow,
    input_tokens: input.tokens.input,
    output_tokens: input.tokens.output,
    reasoning_tokens: input.tokens.reasoning,
    cache_read: input.tokens.cache.read,
    cache_write: input.tokens.cache.write,
    model: input.model.id,
  })

  return overflow
}
