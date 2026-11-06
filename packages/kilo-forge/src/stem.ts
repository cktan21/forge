// English Porter morphology, used only for nonliteral document-ranking terms.
const second = Object.entries({
  ational: "ate", tional: "tion", enci: "ence", anci: "ance", izer: "ize",
  bli: "ble", alli: "al", entli: "ent", eli: "e", ousli: "ous",
  ization: "ize", ation: "ate", ator: "ate", alism: "al", iveness: "ive",
  fulness: "ful", ousness: "ous", aliti: "al", iviti: "ive", biliti: "ble", logi: "log",
}).sort((a, b) => b[0].length - a[0].length)
const third = Object.entries({
  icate: "ic", ative: "", alize: "al", iciti: "ic", ical: "ic", ful: "", ness: "",
}).sort((a, b) => b[0].length - a[0].length)

function vowels(word: string) {
  const values: boolean[] = []
  for (const letter of word) values.push(/[aeiou]/.test(letter) || (letter === "y" && values.at(-1) === false))
  return values
}

function measure(word: string) {
  const values = vowels(word)
  return values.reduce((sum, vowel, index) => sum + (index > 0 && !vowel && values.at(index - 1) === true ? 1 : 0), 0)
}

function short(word: string) {
  const values = vowels(word)
  return values.length >= 3 && values.at(-3) === false && values.at(-2) === true &&
    values.at(-1) === false && !/[wxy]$/.test(word)
}

function replace(word: string, rules: readonly [string, string][]) {
  const rule = rules.find((rule) => word.endsWith(rule[0]))
  if (!rule) return word
  const base = word.slice(0, -rule[0].length)
  return measure(base) > 0 ? base + rule[1] : word
}

export function stem(input: string) {
  if (input.length < 3 || input.length > 64 || !/^[a-z]+$/.test(input)) return input
  let word = (() => {
    if (input.endsWith("sses") || input.endsWith("ies")) return input.slice(0, -2)
    if (!input.endsWith("ss") && input.endsWith("s")) return input.slice(0, -1)
    return input
  })()
  word = (() => {
    if (word.endsWith("eed")) return measure(word.slice(0, -3)) > 0 ? word.slice(0, -1) : word
    const suffix = word.endsWith("ed") ? "ed" : word.endsWith("ing") ? "ing" : undefined
    const base = suffix ? word.slice(0, -suffix.length) : ""
    if (!suffix || !vowels(base).some(Boolean)) return word
    if (/(at|bl|iz)$/.test(base)) return base + "e"
    if (/([^aeioulsz])\1$/.test(base) && vowels(base).at(-1) === false) return base.slice(0, -1)
    if (measure(base) === 1 && short(base)) return base + "e"
    return base
  })()
  if (word.endsWith("y") && vowels(word.slice(0, -1)).some(Boolean)) word = word.slice(0, -1) + "i"
  word = replace(word, second)
  word = replace(word, third)
  const suffix = ["ement", "ance", "ence", "able", "ible", "ment", "ant", "ent", "ion", "ism", "ate", "iti", "ous", "ive", "ize", "al", "er", "ic", "ou"].find((suffix) => word.endsWith(suffix))
  if (suffix) {
    const base = word.slice(0, -suffix.length)
    if (measure(base) > 1 && (suffix !== "ion" || /[st]$/.test(base))) word = base
  }
  if (word.endsWith("e")) {
    const base = word.slice(0, -1)
    const count = measure(base)
    if (count > 1 || (count === 1 && !short(base))) word = base
  }
  if (word.endsWith("ll") && measure(word) > 1) word = word.slice(0, -1)
  return word
}
