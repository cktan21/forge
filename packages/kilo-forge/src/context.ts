import type { Match, Selection } from "./schema"
import { literals, stopwords, terms, tokens } from "./util"
import { order } from "./order"
import { stem } from "./stem"

const identity = (word: string) => word

function language(literal: Set<string>) {
  const cache = new Map<string, string>()
  const exact = new Set([...literal].map((word) => word.normalize("NFD").replace(/\p{M}/gu, "")))
  return (word: string) => {
    const prior = cache.get(word)
    if (prior) return prior
    // Literal query components and inflection families occupy separate namespaces.
    const value = exact.has(word) ? `=${word}` : `~${stem(word)}`
    cache.set(word, value)
    return value
  }
}

function split(text: string, separator = " ") {
  // Keep initialisms intact while separating the following word, as in HTTPServer.
  return text.replace(/([A-Z])([A-Z][a-z])/g, `$1${separator}$2`).replace(/([a-z])([A-Z])/g, `$1${separator}$2`)
}

function words(text: string) {
  const normalized = text.normalize("NFD").replace(/\p{M}/gu, "")
  return [...new Set([
    ...terms(split(normalized)),
    ...normalized.toLowerCase().match(/[\p{L}\p{N}]+(?:[./_:-][\p{L}\p{N}]+)+|[\p{L}\p{N}]{2,}/gu) ?? [],
  ])]
}

function pairs(text: string, normalize = identity) {
  const normalized = split(text.normalize("NFD").replace(/\p{M}/gu, "")).toLowerCase()
  return new Set(normalized.split(/[.!?;:,\r\n]+|\b(?:and|or)\b/).flatMap((part) => {
    const words = (part.match(/[\p{L}\p{N}]{2,}/gu) ?? []).filter((word) => !stopwords.has(word)).map(normalize)
    return words.slice(1).flatMap((word, index) => words.at(index) === word ? [] : [`${words.at(index)} ${word}`])
  }))
}

function assertion(text: string) {
  const plain = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+[^\r\n]*/gm, "")
  let topical = false
  const content = plain.replace(/[^.!?;\r\n]+/g, (sentence) => {
    // These constructions mention a subject without asserting facts about it.
    // Retain the reference itself so a query for that reference can still match.
    const nominal = sentence.match(/^.*?\b(?:is|are)\s+(?:(?:a|an|the)\s+)?(?:title|name|topic|theme)s?\s+of\s+(.+)$/i)
      ?? sentence.match(/^.*?\b(?:is|are)\s+indexed\s+in\s+(.+)$/i)
      ?? sentence.match(/^.*?\bappear(?:s)?\s+in\s+(?:(?:a|an|the)\s+)(.+)$/i)
    if (nominal) {
      topical = true
      return nominal.at(1)!
    }
    const mention = sentence.match(/^(.+?\b(?:discuss(?:es)?|explore(?:s)?|depict(?:s)?))\s+.+$/i)
    if (mention) {
      topical = true
      return mention.at(1)!
    }
    const caption = sentence.match(/^[^:]+:\s+((?:a|an)\s+.+)$/i)
    if (caption) {
      topical = true
      return caption.at(1)!
    }
    return sentence
  })
  // A bare noun phrase under a heading is an index hint, not an assertion.
  const fragment = plain.trim().match(/^(?:a|an)\s+[\p{L}-]+\s+of\s+(?:[\p{L}-]+\s*){1,4}\.?$/iu)
  return { text: content, topical: topical || (plain !== text && !!fragment) }
}

function body(match: Match) {
  return match.source.kind === "document"
    ? match.source.text.replace(/^[ \t]{0,3}#{1,6}[ \t]+[^\r\n]*/gm, "").replace(/(^|[.!?;\r\n])[^.!?;:\r\n]+:[ \t]+/g, "$1")
    : match.source.text
}

function grounding(matches: readonly Match[], query?: { text: string }) {
  const normalize = language(new Set(literals(split(query?.text ?? "", "_"))))
  const wanted = new Set(words(query?.text ?? "").filter((word) => !stopwords.has(word)).map(normalize))
  if (wanted.size < 2) return new Set<string>()
  const candidates = matches.filter((match) => match.source.status === "current" && match.source.method === "collection-section")
    .map((match) => {
      const content = assertion(match.source.text)
      const terms = new Set(words(content.text).filter((word) => !stopwords.has(word)).map(normalize))
      const support = [...wanted].filter((word) => terms.has(word))
      return { match, content, terms, support }
    })
  const focus = /^\s*which\b/i.test(query?.text ?? "")
    ? new Set(candidates.filter((item) => item.content.topical && item.support.length >= 2).flatMap((item) => item.support))
    : new Set<string>()
  const predicates = new Set([...(query?.text ?? "").matchAll(/\bwho\s+([\p{L}]+s)\b/giu)].map((match) => normalize(match.at(1)!.toLowerCase())))
  const direct = candidates.some((item) => !item.content.topical && item.support.length >= 2)
  return new Set(candidates.filter((item) => {
    if (/semantic/i.test(item.match.reason)) return false
    if (focus.size) return item.support.filter((word) => focus.has(word)).length < 2
    if (direct && item.support.length === 1 && predicates.has(item.support.at(0)!)) return true
    return direct && item.content.topical && item.support.length === 0
  }).map((item) => item.match.source.id))
}

function relevance(matches: readonly Match[], query?: { text: string }) {
  const literal = new Set(literals(split(query?.text ?? "", "_")))
  const requested = words(query?.text ?? "").filter((word) => literal.has(word) || !stopwords.has(word))
  if (!requested.length) return matches
  const states = [identity, language(literal)].map((normalize) => {
    const wanted = [...new Set(requested.map(normalize))]
    const ordered = [...pairs(query?.text ?? "", normalize)]
    // Topic headings are useful lookup hints, but not evidence of a relationship.
    // Keep their terms eligible without multiplying a heading's overlap and pairs.
    const passages = new Map(matches.filter((match) => match.source.status === "current" && match.source.text).map((match) => [
      match.source.id,
      new Set(words(`${match.source.uri} ${match.source.label} ${match.source.detail.heading ?? ""} ${match.source.text}`).map(normalize)),
    ]))
    const frequencies = new Map(wanted.map((word) => [
      word,
      new Set(matches.filter((match) => passages.get(match.source.id)?.has(word)).map((match) => match.source.uri)).size,
    ]))
    return { normalize, wanted, ordered, passages, frequencies }
  })
  return matches.map((match) => {
    const state = states.at(match.source.kind === "document" ? 1 : 0)!
    const text = state.passages.get(match.source.id)
    // Each query term shares unit squared weight across its matching documents.
    // File, symbol and window views must not inflate document frequency.
    // Common terms cannot multiply raw overlap; weak or nonliteral matches retain
    // their retrieval score, including FTS stemming and semantic channel evidence.
    const count = state.wanted.reduce((sum, word) => sum + (text?.has(word) ? 1 / Math.sqrt(state.frequencies.get(word)!) : 0), 0)
    const content = new Set(words(body(match)).filter((word) => !stopwords.has(word)).map(state.normalize))
    const support = state.wanted.reduce((sum, word) => sum + (content.has(word) ? 1 / Math.sqrt(state.frequencies.get(word)!) : 0), 0)
    // Bounded passage-only pair coverage distinguishes relationships from term lists.
    // Count participating query words, not pair occurrences, so repetition adds no weight.
    const adjacent = pairs(body(match), state.normalize)
    const connected = new Set(state.ordered.filter((pair) => adjacent.has(pair)).flatMap((pair) => pair.split(" ")))
    const coverage = connected.size / state.wanted.length
    // Multiple discriminative terms receive linear, not quadratic, credit.
    // Normalize only pair credit for body length; preserve base term relevance.
    // Single/common-only matches keep their score; code keeps path/metadata credit.
    // Compound lookup aliases are not additional words in the original passage.
    const density = new Set(terms(split(body(match).normalize("NFD").replace(/\p{M}/gu, ""))).filter((word) => !stopwords.has(word)).map(state.normalize)).size
    const length = Math.sqrt(Math.max(1, density / state.wanted.length))
    const weight = match.source.kind === "document"
      ? Math.max(1, Math.sqrt(count), support > 1 ? 2 * support * (1 + coverage / length) + count - support : 1)
      : Math.max(1, count * count) * (1 + coverage)
    return { ...match, score: match.score * weight }
  })
}

export function render(match: Match) {
  const source = match.source
  const version = source.method === "context7" ? `; project ${source.detail.projectVersion}; docs ${source.detail.documentationVersion}; ${source.detail.compatibility}` : ""
  return `[${source.id}] ${source.uri}:${source.start}-${source.end} (${source.kind}; ${source.status}; ${source.method}${source.detail.page ? `; page ${source.detail.page}` : ""}${version})\n${source.text}\n`
}

export function fuse(lists: readonly (readonly Match[])[], limit = 100) {
  const values = new Map<string, Match>()
  for (const list of lists) {
    const seen = new Set<string>()
    for (const match of list) {
      // Adapter hits can resolve to the same original. Only independent
      // channels corroborate it; repeated rows neither vote nor consume ranks.
      if (seen.has(match.source.id)) continue
      const rank = seen.size
      seen.add(match.source.id)
      const prior = values.get(match.source.id)
      values.set(match.source.id, { ...match, score: (prior?.score ?? 0) + 1 / (60 + rank + 1), reason: prior ? `${prior.reason}; ${match.reason}` : match.reason })
    }
  }
  return [...values.values()].sort((a, b) => b.score - a.score || order(a.source, b.source)).slice(0, limit)
}

function redundant(a: Match, b: Match) {
  if (a.source.id === b.source.id) return true
  if (a.source.hash === b.source.hash && a.source.text === b.source.text) return true
  if (a.source.uri !== b.source.uri) return false
  if (a.source.detail.page !== b.source.detail.page) return false
  return (a.source.start <= b.source.start && a.source.end >= b.source.end)
    || (b.source.start <= a.source.start && b.source.end >= a.source.end)
}

export function select(matches: readonly Match[], budget: number, method: "ranked" | "greedy" | "knapsack" = "greedy", required: readonly string[] = [], query?: { text: string }): Selection {
  const limit = Math.max(0, Math.min(100_000, Math.floor(budget)))
  if (required.length) {
    const pins = [...new Set(required)].map((key) => {
      const match = matches.find((item) => item.source.id === key && item.source.status === "current" && item.source.text)
      if (!match) throw new Error(`Pinned excerpt is unavailable or has no text: ${key}`)
      return match
    })
    const cost = pins.reduce((sum, item) => sum + tokens(render(item)) + 1, 0)
    if (cost > limit) throw new Error(`Pinned excerpts need ${cost} estimated tokens, exceeding the ${limit} budget. Unpin or narrow the selection.`)
    const rest = select(matches.filter((item) => !pins.some((pin) => redundant(pin, item))), limit - cost, method, [], query)
    const selected = [...pins, ...rest.matches]
    const text = selected.map(render).join("\n")
    const chosen = new Set(selected.map((item) => item.source.id))
    const omitted = matches.filter((item) => !chosen.has(item.source.id)).map((item) => item.source.id)
    return { ...rest, matches: selected, text, tokens: tokens(text), budget: limit, omitted, reasons: Object.fromEntries(omitted.map((key) => [key, rest.reasons?.[key] ?? "Overlaps a required pinned excerpt"])) }
  }
  const unique: Match[] = []
  const ungrounded = grounding(matches, query)
  const ranked = relevance(matches, query)
  for (const match of ranked) {
    if (match.source.status !== "current") continue
    if (ungrounded.has(match.source.id)) continue
    if (!match.source.text || tokens(render(match)) + 1 > limit) continue
    if (unique.some((prior) => prior.source.id === match.source.id)) continue
    unique.push(match)
  }
  const costs = new Map(unique.map((match) => [match.source.id, tokens(render(match)) + 1]))
  const literal = new Set(literals(split(query?.text ?? "", "_")))
  const queries = [identity, language(literal)].map((normalize) => ({
    normalize,
    wanted: [...new Set(words(query?.text ?? "").filter((word) => literal.has(word) || !stopwords.has(word)).map(normalize))],
    ordered: pairs(query?.text ?? "", normalize),
  }))
  const features = new Map(unique.map((match) => {
    const state = queries.at(match.source.kind === "document" ? 1 : 0)!
    const content = new Set(words(body(match)).map(state.normalize))
    const adjacent = pairs(body(match), state.normalize)
    const support = state.wanted.filter((word) => content.has(word))
    const hints = new Set(words(`${match.source.uri} ${match.source.label} ${match.source.detail.heading ?? ""} ${match.source.text}`).map(state.normalize))
    return [match.source.id, new Set([
      ...(support.length ? support : state.wanted.filter((word) => hints.has(word))),
      ...[...state.ordered].filter((pair) => adjacent.has(pair)),
    ])]
  }))
  const selected: Match[] = []
  if (method === "knapsack") {
    const items = unique.slice(0, 100)
    const conflicts = items.map((match) => items.map((other) => redundant(match, other)))
    const overlaps = conflicts.map((row, index) => row.some((value, other) => value && index !== other))
    // Only equal-priority graph twins are interchangeable. Preserve admission
    // and every other slot: equal score/cost alone says nothing about conflicts.
    const groups: number[][] = []
    items.forEach((match, index) => {
      const group = groups.find((group) => {
        const other = group.at(0)!
        return match.score === items.at(other)!.score &&
          costs.get(match.source.id) === costs.get(items.at(other)!.source.id) &&
          conflicts.at(index)!.every((value, next) =>
            next === index || next === other || value === conflicts.at(other)!.at(next))
      })
      if (group) group.push(index)
      if (!group) groups.push([index])
    })
    const pending = items.map((_, index) => index)
    const compare = (a: number, b: number) => order(items.at(a)!.source, items.at(b)!.source)
    for (const group of groups) {
      const sorted = group.toSorted(compare)
      group.forEach((index, offset) => { pending[index] = sorted.at(offset)! })
    }
    // Arbitrary equal-value states are interchangeable only without conflicts.
    // Uniform alternatives already have canonical slots and need no DP tie work.
    const precise = !overlaps.some(Boolean) && groups.length > 1
    const canonical = precise ? pending.toSorted(compare) : []
    const ranks = new Map<number, number>()
    canonical.forEach((index, rank) => {
      const prior = rank ? canonical.at(rank - 1) : undefined
      ranks.set(index, prior != null && compare(prior, index) === 0 ? ranks.get(prior)! : rank)
    })
    // Reuse rank counts instead of allocating lists or retaining per-choice keys.
    const left = new Uint8Array(precise ? items.length : 0)
    const right = new Uint8Array(left.length)
    const values = new Float64Array(limit + 1)
    // Persistent linked choices avoid reusing an item after in-place DP updates.
    type Choice = { index: number; value: number; prior?: Choice }
    const choices: Array<Choice | undefined> = []
    function preferred(index: number, prior: Choice | undefined, other: Choice | undefined) {
      left.fill(0)
      right.fill(0)
      left[ranks.get(index)!] = 1
      let a = 1
      let b = 0
      for (let item = prior; item; item = item.prior) {
        const rank = ranks.get(item.index)!
        left[rank] = left.at(rank)! + 1
        a++
      }
      for (let item = other; item; item = item.prior) {
        const rank = ranks.get(item.index)!
        right[rank] = right.at(rank)! + 1
        b++
      }
      for (let rank = 0; rank < left.length; rank++) {
        const count = Math.min(left.at(rank)!, right.at(rank)!)
        a -= count
        b -= count
        // A proper prefix sorts before the longer canonical evidence list.
        if (left.at(rank) !== right.at(rank)) return left.at(rank)! > right.at(rank)! ? b > 0 : a === 0
      }
      return false
    }
    function prune(item: Choice | undefined, index: number): Choice | undefined {
      if (!item) return undefined
      const prior = prune(item.prior, index)
      if (conflicts.at(index)!.at(item.index)) return prior
      if (prior === item.prior) return item
      return { index: item.index, value: unique.at(item.index)!.score + (prior?.value ?? 0), prior }
    }
    pending.forEach((index) => {
      const match = items.at(index)!
      const cost = costs.get(match.source.id)!
      for (let space = limit; space >= cost; space--) {
        const estimate = values[space - cost]! + match.score
        if (estimate < values[space]! || (!precise && estimate === values[space]!)) continue
        // Replace overlapping evidence rather than suppressing an unselected alternative.
        const prior = overlaps.at(index) ? prune(choices[space - cost], index) : choices[space - cost]
        const value = (prior?.value ?? 0) + match.score
        if (value < values[space]! || value <= 0) continue
        // Zero-score originals cannot seed a state; do not append them on ties either.
        if (value === values[space]! && (match.score === 0 || !precise || !preferred(index, prior, choices[space]))) continue
        values[space] = value
        choices[space] = { index, value, prior }
      }
    })
    for (let item = choices[limit]; item; item = item.prior) selected.push(unique.at(item.index)!)
  }
  if (method !== "knapsack") {
    const pending = [...unique]
    const covered = new Set<string>()
    const priority = (match: Match) => {
      const content = features.get(match.source.id)!
      const novelty = match.source.method === "collection-section" && content.size
        ? [...content].filter((word) => !covered.has(word)).length / content.size
        : 1
      // Shared query features do not make distinct facts irrelevant.
      return match.score * (1 + novelty) / (method === "ranked" ? 1 : costs.get(match.source.id)!)
    }
    let remaining = limit
    while (pending.length) {
      pending.sort((a, b) => priority(b) - priority(a) || (method === "ranked" ? b.score - a.score : b.score / costs.get(b.source.id)! - a.score / costs.get(a.source.id)!) || order(a.source, b.source))
      const match = pending.shift()!
      const cost = costs.get(match.source.id)!
      if (cost > remaining) continue
      if (selected.some((prior) => redundant(prior, match))) continue
      selected.push(match)
      for (const word of features.get(match.source.id)!) covered.add(word)
      remaining -= cost
    }
  }
  const chosen = new Set(selected.map((match) => match.source.id))
  const text = selected.map(render).join("\n")
  const omitted = matches.filter((match) => !chosen.has(match.source.id))
  return {
    matches: selected, text, tokens: tokens(text), budget: limit, estimator: "utf8-bytes-conservative",
    omitted: omitted.map((match) => match.source.id),
    reasons: Object.fromEntries(omitted.map((match) => [match.source.id, match.source.status !== "current" ? "Source is not current" : ungrounded.has(match.source.id) ? "Topic mention does not answer the requested relationship" : selected.some((item) => redundant(item, match)) ? "Overlaps selected evidence" : "Not selected within the evidence budget"])),
  }
}
