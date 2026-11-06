import { deepStrictEqual, rejects } from "node:assert/strict"
import { embeddingHttp } from "../src/embedding-http"

const endpoint = process.env.FORGE_TEST_ENDPOINT
if (!endpoint) throw new Error("Missing test endpoint")
const transport = embeddingHttp({
  endpoint,
  model: "tls-fixture",
  dimensions: 2,
  key: "local-tls-test-key",
  timeout: 5000,
})
if (process.env.FORGE_TEST_ACCEPT === "1") {
  deepStrictEqual(await transport.embed(["TLS exact original"]), [[1, 0]])
} else {
  await rejects(transport.embed(["TLS exact original"]), { message: "Embedding request failed" })
}
console.log("TLS transport assertion passed")
