import { benchmark, type Fixture } from "./knowledge"

function pdf(pages: string[]) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...pages.flatMap((page, index) => {
      const text = `BT /F1 12 Tf 40 720 Td (${page}) Tj ET`
      return [
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1000 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
        `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
      ]
    }),
  ]
  let text = "%PDF-1.4\n"
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(text.length)
    text += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const start = text.length
  return `${text}xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`
}

// Authored development cases. Do not count these as unseen, independent labels.
export const documents: Fixture[] = [
  {
    name: "dispatcher",
    files: {
      "src/dispatch.ts": "export function dispatch(epoch: number, current: number, expires: number, now: number) {\n  // Lease ownership is invalid after the renewal deadline or a newer epoch.\n  return epoch === current && now < expires\n}",
      "src/metrics.ts": "export const renewalCounter = 0 // aggregate lease renewal metrics",
    },
    documents: {
      "reference.pdf": pdf([
        "Lease ownership requires an epoch check before dispatch. Reject stale writers.",
        "Lease ownership also expires at the renewal deadline. Refuse expired holders.",
        "Metrics for renewal counters are aggregated every minute.",
      ]),
      "handbook.md": "# Retry limits\nDispatch retries use bounded exponential backoff after transient failures.\n# Metrics\nRenewal counters describe monitoring, not authorization.\n# Presentation\nThe dashboard palette is blue.",
    },
    tasks: [
      { id: "authorization", query: "Explain both lease ownership checks before dispatch", required: ["src/dispatch.ts", "reference.pdf#page:1", "reference.pdf#page:2"], supporting: [] },
      { id: "transient-failure", query: "Find the policy for retrying a transient dispatch failure", required: ["handbook.md#Retry limits"], supporting: ["src/dispatch.ts"] },
      { id: "monitoring", query: "How are renewal metrics aggregated?", required: ["reference.pdf#page:3", "src/metrics.ts"], supporting: ["handbook.md#Metrics"] },
    ],
  },
  {
    name: "archive",
    files: {
      "archive/lifecycle.py": "def eligible(age, retention, hold):\n    # A legal hold overrides retention expiry before erasure.\n    return age > retention and not hold\n",
      "archive/audit.py": "def record_erasure(identifier):\n    # Keep a deletion receipt without the erased payload.\n    return {'receipt': identifier}\n",
    },
    documents: {
      "operations.md": "# Retention\nRetention expiry permits erasure only after checking legal holds.\n# Legal holds\nA legal hold blocks erasure until an authorized release.\n# Receipts\nDeletion receipts preserve the identifier and timestamp, never the erased payload.\n# Capacity\nStorage occupancy warnings trigger at eighty percent.",
      "reference.pdf": pdf([
        "Erasure receipts are retained for audit. Do not retain the erased payload.",
        "Storage snapshots are separate backups with their own retention period.",
      ]),
    },
    tasks: [
      { id: "hold", query: "Explain why expired retention does not always permit erasure", required: ["archive/lifecycle.py", "operations.md#Retention", "operations.md#Legal holds"], supporting: [] },
      { id: "receipt", query: "What may remain in an erasure receipt after payload deletion?", required: ["archive/audit.py", "operations.md#Receipts", "reference.pdf#page:1"], supporting: [] },
      { id: "backups", query: "Find the separate retention rule for backup snapshots", required: ["reference.pdf#page:2"], supporting: ["operations.md#Retention"] },
    ],
  },
]

if (import.meta.main) console.log(JSON.stringify(await benchmark(documents), null, 2))
