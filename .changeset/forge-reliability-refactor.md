---
"@kilocode/cli": patch
"@kilocode/forge": patch
---

Preserve valid inspection work when a model mixes tool calls with premature conclusions. Reuse revalidated evidence when explicitly retrying a failed conclusion, keep direct evidence in model context without duplicate excerpts, and show live waiting progress with clearer failure details.
