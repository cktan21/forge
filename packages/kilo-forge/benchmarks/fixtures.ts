export const fixtures = [
  {
    name: "queue-ts",
    files: {
      "package.json": '{"name":"queue-fixture","scripts":{"test":"bun test"}}',
      "src/queue.ts": [
        "export function assignPatient(queue: string[]) {",
        "  return queue.shift()",
        "}",
        "export function waitingCount(queue: string[]) {",
        "  return queue.length",
        "}",
      ].join("\n"),
      "src/history.ts": ["export function assignmentHistory(events: string[]) {", "  return events.slice()", "}"].join(
        "\n",
      ),
      "tests/queue.test.ts": [
        'import { expect, test } from "bun:test"',
        'import { assignPatient } from "../src/queue"',
        'test("assign patient in arrival order", () => {',
        '  expect(assignPatient(["first", "second"])).toBe("first")',
        "})",
      ].join("\n"),
      "docs/queue.md": [
        "# Patient assignment",
        "Assign each waiting patient in arrival order.",
        "An empty queue currently returns undefined.",
        "See [assignment implementation](../src/queue.ts).",
      ].join("\n"),
      "README.md": "# Queue\nPatient assignment and assignment history utilities.",
      "src/theme.ts": 'export const theme = "light"',
    },
    tasks: [
      {
        id: "empty-queue",
        query: "Change the public assignPatient behavior for an empty patient queue and test it",
        required: ["src/queue.ts", "tests/queue.test.ts", "docs/queue.md"],
        supporting: ["package.json", "README.md"],
      },
      {
        id: "history-limit",
        query: "Add a limit option to assignmentHistory events",
        required: ["src/history.ts"],
        supporting: ["README.md", "package.json"],
      },
    ],
  },
  {
    name: "inventory-py",
    files: {
      "pyproject.toml": '[project]\nname = "inventory-fixture"\nversion = "0.1.0"',
      "inventory/stock.py": [
        "def reserve_stock(available, requested):",
        "    return available - requested",
        "",
        "def available_stock(available):",
        "    return available",
      ].join("\n"),
      "tests/test_stock.py": [
        "from inventory.stock import reserve_stock",
        "",
        "def test_reserve_stock():",
        "    assert reserve_stock(5, 2) == 3",
      ].join("\n"),
      "docs/stock.md": [
        "# Stock reservations",
        "reserve_stock subtracts requested stock from available stock.",
        "See [stock implementation](../inventory/stock.py).",
      ].join("\n"),
      "schema.sql": [
        "CREATE TABLE warehouse (id INTEGER PRIMARY KEY, name TEXT);",
        "CREATE TABLE reservation (id INTEGER PRIMARY KEY, warehouse_id INTEGER REFERENCES warehouse(id));",
      ].join("\n"),
      "docs/schema.md": [
        "# Reservation schema",
        "A reservation references a warehouse through warehouse_id.",
        "See [declared schema](../schema.sql).",
      ].join("\n"),
      "inventory/colors.py": 'COLOR = "blue"',
    },
    tasks: [
      {
        id: "stock-underflow",
        query: "Prevent reserve_stock from reserving more stock than available and document the behavior",
        required: ["inventory/stock.py", "tests/test_stock.py", "docs/stock.md"],
        supporting: ["pyproject.toml"],
      },
      {
        id: "reservation-index",
        query: "Add an index for reservation warehouse_id in the declared schema",
        required: ["schema.sql", "docs/schema.md"],
        supporting: [],
      },
    ],
  },
]
