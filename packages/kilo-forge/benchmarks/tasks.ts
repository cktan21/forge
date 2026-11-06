type Case = { name: string; code: string }
export type Task = {
  id: string
  language: "typescript" | "python"
  prompt: string
  files: Record<string, string>
  tests?: string[]
  checks: Case[]
  solution: Record<string, string>
  relevant?: string[]
  constraints?: string[]
  provenance?: {
    repository: string
    revision: string
    files: string[]
    scope: "selected-files"
    snapshot: string
    definition: string
  }
}

const queue = {
  "package.json": '{"name":"dispatch","type":"module","scripts":{"test":"bun test tests"}}',
  "README.md": "# Dispatch\nQueue and audit utilities. Run `bun test tests`.\nPublic exports live in src/index.ts.",
  "src/index.ts": 'export { enqueue, take } from "./queue"\nexport { history } from "./history"\n',
  "src/queue.ts": [
    "export type Patient = { id: string; name: string }",
    "export function enqueue(queue: Patient[], patient: Patient) { queue.push(patient); return queue.length }",
    "export function take(queue: Patient[]) { return queue.shift() }",
  ].join("\n"),
  "src/history.ts": [
    "export type Event = { id: string; actor: string; time: number }",
    "export function history(events: Event[]) { return events.slice() }",
  ].join("\n"),
  "tests/queue.test.ts": [
    'import { expect, test } from "bun:test"',
    'import { enqueue, take, history } from "../src/index"',
    'test("queue preserves FIFO", () => { const q = []; enqueue(q, {id:"a",name:"A"}); enqueue(q, {id:"b",name:"B"}); expect(take(q)?.id).toBe("a"); expect(q.length).toBe(1) })',
    'test("history returns a copy", () => { const e = [{id:"1",actor:"nurse",time:1}]; expect(history(e)).toEqual(e); expect(history(e)).not.toBe(e) })',
  ].join("\n"),
  "docs/api.md":
    "# Dispatch API\n`enqueue` appends a patient. `take` removes the oldest patient or returns undefined.\n`history` returns a copy of events in input order.",
  "src/theme.ts": 'export const theme = "light"\n',
}

const inventory = {
  "README.md": "# Warehouse\nStock reservation helpers and SQLite schema. Run `python3 -m unittest discover -s tests`.",
  "warehouse/__init__.py": "from .stock import reserve\n",
  "warehouse/stock.py": "def reserve(available, requested):\n    return available - requested\n",
  "warehouse/report.py": "def total(values):\n    return sum(values)\n",
  "schema.sql": [
    "PRAGMA foreign_keys = ON;",
    "CREATE TABLE warehouse (id INTEGER PRIMARY KEY, name TEXT NOT NULL);",
    "CREATE TABLE reservation (id INTEGER PRIMARY KEY, warehouse_id INTEGER NOT NULL REFERENCES warehouse(id), reference TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active');",
  ].join("\n"),
  "tests/test_stock.py":
    "import unittest\nfrom warehouse import reserve\n\nclass Stock(unittest.TestCase):\n    def test_reserve(self):\n        self.assertEqual(reserve(5, 2), 3)\n",
  "docs/stock.md":
    "# Reservations\n`reserve(available, requested)` subtracts requested stock from available stock.\nBoth arguments represent unit counts.",
  "docs/schema.md":
    "# Storage\nA reservation belongs to a warehouse. Reference strings identify requests; state is active or canceled.\nRun schema.sql against a fresh SQLite database.",
}

export const tasks: Task[] = [
  {
    id: "atomic-batch",
    language: "typescript",
    files: queue,
    prompt:
      "Add enqueueBatch(queue, patients) to the public API. Append patients in input order and return the resulting queue length. Reject empty or whitespace-only IDs and duplicate IDs, either within the batch or already in the queue, by throwing Error. Validate the whole batch before changing the queue; on any error it must remain unchanged. An empty batch is a no-op. Preserve the existing enqueue and take behavior, add tests, and update the API docs. IDs otherwise compare exactly; do not trim or rewrite valid IDs.",
    checks: [
      {
        name: "public-export-and-order",
        code: 'const api = await import("./src/index"); const q = [{id:"a",name:"A"}]; assert.equal(api.enqueueBatch(q,[{id:"b",name:"B"},{id:"c",name:"C"}]),3); assert.deepEqual(q.map(x=>x.id),["a","b","c"]);',
      },
      {
        name: "existing-duplicate-is-atomic",
        code: 'const api = await import("./src/index"); assert.equal(typeof api.enqueueBatch,"function"); const q = [{id:"a",name:"A"}]; const before = structuredClone(q); assert.throws(()=>api.enqueueBatch(q,[{id:"b",name:"B"},{id:"a",name:"Again"}])); assert.deepEqual(q,before);',
      },
      {
        name: "batch-duplicate-is-atomic",
        code: 'const api = await import("./src/index"); assert.equal(typeof api.enqueueBatch,"function"); const q = []; assert.throws(()=>api.enqueueBatch(q,[{id:"x",name:"X"},{id:"x",name:"Y"}])); assert.deepEqual(q,[]);',
      },
      {
        name: "blank-id-is-atomic",
        code: 'const api = await import("./src/index"); assert.equal(typeof api.enqueueBatch,"function"); for (const id of ["","  ","\\t"]) { const q=[]; assert.throws(()=>api.enqueueBatch(q,[{id:"ok",name:"ok"},{id,name:"bad"}])); assert.deepEqual(q,[]); }',
      },
      {
        name: "empty-batch-and-exact-ids",
        code: 'const api = await import("./src/index"); const q=[{id:"a",name:"A"}]; assert.equal(api.enqueueBatch(q,[]),1); assert.equal(api.enqueueBatch(q,[{id:" a ",name:"B"}]),2); assert.equal(q[1].id," a ");',
      },
      {
        name: "legacy-behavior",
        code: 'const api = await import("./src/index"); const q=[]; assert.equal(api.enqueue(q,{id:"a",name:"A"}),1); assert.equal(api.enqueue(q,{id:"a",name:"Again"}),2); assert.equal(api.take(q).name,"A"); assert.equal(api.take(q).name,"Again"); assert.equal(api.take(q),undefined);',
      },
    ],
    solution: {
      "src/index.ts": `${queue["src/index.ts"]}export { enqueueBatch } from "./queue"\n`,
      "src/queue.ts": `${queue["src/queue.ts"]}\nexport function enqueueBatch(queue: Patient[], patients: Patient[]) { const ids = new Set(queue.map(p => p.id)); for (const p of patients) { if (!p.id.trim() || ids.has(p.id)) throw new Error("Invalid ID"); ids.add(p.id) } queue.push(...patients); return queue.length }\n`,
    },
  },
  {
    id: "history-pagination",
    language: "typescript",
    files: queue,
    prompt:
      "Extend the public history(events, options?) API with actor filtering and offset/limit pagination. Filter by exact actor first, then slice in existing input order. Defaults are offset=0 and no limit; limit=0 returns empty. Throw RangeError if supplied offset or limit is negative, fractional, NaN, or infinite. Never mutate the array or its events. Keep calls without options backward compatible. Add tests and update the API docs.",
    checks: [
      {
        name: "filter-before-pagination",
        code: 'const {history}=await import("./src/index"); const e=[{id:"1",actor:"a",time:3},{id:"2",actor:"b",time:1},{id:"3",actor:"a",time:2},{id:"4",actor:"a",time:0}]; assert.deepEqual(history(e,{actor:"a",offset:1,limit:1}).map(x=>x.id),["3"]);',
      },
      {
        name: "zero-limit-and-large-offset",
        code: 'const {history}=await import("./src/index"); const e=[{id:"1",actor:"a",time:1}]; assert.deepEqual(history(e,{limit:0}),[]); assert.deepEqual(history(e,{offset:99}),[]);',
      },
      {
        name: "invalid-offset",
        code: 'const {history}=await import("./src/index"); for (const offset of [-1,0.5,NaN,Infinity,-Infinity]) assert.throws(()=>history([],{offset}),RangeError);',
      },
      {
        name: "invalid-limit",
        code: 'const {history}=await import("./src/index"); for (const limit of [-1,0.5,NaN,Infinity,-Infinity]) assert.throws(()=>history([],{limit}),RangeError);',
      },
      {
        name: "immutable-and-backward-compatible",
        code: 'const {history}=await import("./src/index"); const e=Object.freeze([Object.freeze({id:"1",actor:"a",time:9}),Object.freeze({id:"2",actor:"a",time:1})]); const out=history(e); assert.deepEqual(out,e); assert.notEqual(out,e); assert.deepEqual(history(e,{actor:"a"}),e);',
      },
      {
        name: "empty-actor-is-an-exact-filter",
        code: 'const {history}=await import("./src/index"); const e=[{id:"1",actor:"",time:1},{id:"2",actor:"b",time:2}]; assert.deepEqual(history(e,{actor:""}).map(x=>x.id),["1"]);',
      },
    ],
    solution: {
      "src/history.ts":
        'export type Event = { id: string; actor: string; time: number }\nexport function history(events: Event[], options: {actor?: string; offset?: number; limit?: number} = {}) { for (const n of [options.offset, options.limit]) if (n !== undefined && (!Number.isInteger(n) || n < 0)) throw new RangeError("Invalid pagination"); const filtered = options.actor === undefined ? events : events.filter(e => e.actor === options.actor); const offset = options.offset ?? 0; return filtered.slice(offset, options.limit === undefined ? undefined : offset + options.limit) }\n',
    },
  },
  {
    id: "stock-validation",
    language: "python",
    files: inventory,
    prompt:
      "Make warehouse.reserve validate stock counts: available and requested must be nonnegative Python integers, and booleans must be rejected. Throw ValueError for invalid counts or if requested exceeds available; otherwise return the remaining count. Keep the public import working and allow zero and arbitrarily large integers. Add tests and update the stock docs. Do not add third-party dependencies.",
    checks: [
      {
        name: "reject-underflow",
        code: "from warehouse import reserve\nwith self.assertRaises(ValueError): reserve(2, 3)",
      },
      {
        name: "reject-negative-counts",
        code: "from warehouse import reserve\nfor a,b in [(-1,0),(1,-1),(-2,-3)]:\n    with self.assertRaises(ValueError): reserve(a,b)",
      },
      {
        name: "reject-booleans",
        code: "from warehouse import reserve\nfor a,b in [(True,0),(1,False),(False,True)]:\n    with self.assertRaises(ValueError): reserve(a,b)",
      },
      {
        name: "reject-nonintegers",
        code: "from warehouse import reserve\nfor a,b in [(2.0,1),(2,1.0),(None,0),('2',1),(2,float('nan'))]:\n    with self.assertRaises(ValueError): reserve(a,b)",
      },
      {
        name: "zero-boundaries",
        code: "from warehouse import reserve\nself.assertEqual(reserve(0,0),0)\nself.assertEqual(reserve(10,10),0)\nself.assertEqual(reserve(10,0),10)",
      },
      {
        name: "arbitrary-precision-and-legacy",
        code: "from warehouse import reserve\nself.assertEqual(reserve(10**100,1),10**100-1)\nself.assertEqual(reserve(5,2),3)",
      },
    ],
    solution: {
      "warehouse/stock.py":
        "def reserve(available, requested):\n    if type(available) is not int or type(requested) is not int or available < 0 or requested < 0 or requested > available:\n        raise ValueError('Invalid stock counts')\n    return available - requested\n",
    },
  },
  {
    id: "active-reservation-uniqueness",
    language: "python",
    files: inventory,
    prompt:
      "Update the fresh-install SQLite schema so active reservations have a unique (warehouse_id, reference) pair. Canceled reservations must not block reusing a reference, multiple canceled copies must remain allowed, and the same reference in different warehouses is valid. Retain the existing foreign key and columns. Add a schema regression test runnable by the existing unittest command and update the schema docs. This task only covers fresh installs, not upgrading existing databases.",
    checks: [
      {
        name: "reject-active-duplicate",
        code: "db = self.database()\ndb.execute(\"INSERT INTO reservation VALUES (1,1,'r','active')\")\nwith self.assertRaises(sqlite3.IntegrityError): db.execute(\"INSERT INTO reservation VALUES (2,1,'r','active')\")",
      },
      {
        name: "canceled-duplicates-allowed",
        code: "db = self.database()\nfor i in range(1,4): db.execute(\"INSERT INTO reservation VALUES (?,1,'r','canceled')\",(i,))\ndb.execute(\"INSERT INTO reservation VALUES (4,1,'r','active')\")\nself.assertEqual(db.execute('SELECT COUNT(*) FROM reservation').fetchone()[0],4)",
      },
      {
        name: "cross-warehouse-allowed",
        code: "db = self.database()\ndb.execute(\"INSERT INTO reservation VALUES (1,1,'r','active')\")\ndb.execute(\"INSERT INTO reservation VALUES (2,2,'r','active')\")\nself.assertEqual(db.execute('SELECT COUNT(*) FROM reservation').fetchone()[0],2)",
      },
      {
        name: "reactivation-conflict",
        code: "db = self.database()\ndb.execute(\"INSERT INTO reservation VALUES (1,1,'r','active')\")\ndb.execute(\"INSERT INTO reservation VALUES (2,1,'r','canceled')\")\nwith self.assertRaises(sqlite3.IntegrityError): db.execute(\"UPDATE reservation SET state='active' WHERE id=2\")",
      },
      {
        name: "cancel-and-reuse",
        code: "db = self.database()\ndb.execute(\"INSERT INTO reservation VALUES (1,1,'r','active')\")\ndb.execute(\"UPDATE reservation SET state='canceled' WHERE id=1\")\ndb.execute(\"INSERT INTO reservation VALUES (2,1,'r','active')\")",
      },
      {
        name: "foreign-key-preserved",
        code: "db = self.database()\nwith self.assertRaises(sqlite3.IntegrityError): db.execute(\"INSERT INTO reservation VALUES (1,99,'r','active')\")",
      },
    ],
    solution: {
      "schema.sql": `${inventory["schema.sql"]}\nCREATE UNIQUE INDEX active_reference ON reservation(warehouse_id, reference) WHERE state = 'active';\n`,
    },
  },
]
