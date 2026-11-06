import type { SelectionInfo } from "./schema"
import { semantic } from "./semantic"

export function summary(value?: SelectionInfo) {
  if (!value) return "Selection history unavailable for this capture."
  const selected = value.candidates.filter((item) => item.state === "selected").length
  return `Selection history: ${value.total} scoped candidates; ${selected} selected and ${value.candidates.length - selected} omitted records retained; ${value.unrecorded} records outside the history limit; ${value.withheld} candidates withheld. ${value.tokens}/${value.budget} estimated evidence tokens.`
}

export function channels(value?: SelectionInfo) {
  if (!value?.channels) return ["Retrieval channel history unavailable for this capture."]
  return [
    ...value.channels.map((channel) => `${channel.name}: ${channel.state}; ${channel.candidates} scoped hits, ${channel.withheld} withheld or unmapped hits.${channel.name === "semantic" ? ` ${semantic(channel.readiness)}${channel.readiness ? " Readiness was observed at lookup start." : ""}` : ""}`),
    "Channel ranks and scores precede fusion and are not comparable across channels. Counts describe returned hits, not exhaustive corpus coverage. Only retained candidate metadata is shown.",
  ]
}
