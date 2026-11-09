import { Option, Schema } from "effect"

const Credentials = Schema.Struct({
  openai: Schema.Struct({
    type: Schema.Literal("oauth"),
    access: Schema.String.check(Schema.isMinLength(1)),
    refresh: Schema.String.check(Schema.isMinLength(1)),
    expires: Schema.Finite,
    accountId: Schema.optional(Schema.String),
  }),
})

export function account(value: unknown, now = Date.now()) {
  const result = Schema.decodeUnknownOption(Credentials)(value)
  if (Option.isNone(result)) throw new Error("A valid OpenAI ChatGPT OAuth credential is required; API keys are not accepted")
  const auth = result.value
  // Avoid rotating a shared account's refresh token in a disposable benchmark home.
  if (auth.openai.expires < now + 3_600_000)
    throw new Error("Reconnect ChatGPT before evaluation: the access token must remain valid for at least one hour")
  return auth
}

if (import.meta.main) {
  const { run } = await import("./free")
  await run({ subscription: true })
}
