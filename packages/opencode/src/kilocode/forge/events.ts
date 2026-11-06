import { BusEvent } from "@/bus/bus-event"
import { Change } from "@kilocode/forge/schema"

// Payloads only invalidate views. Scoped HTTP reads remain authoritative.
export const Changed = BusEvent.define("forge.changed", Change)
