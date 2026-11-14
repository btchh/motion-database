# DataviewJS and Motion Database

Motion Database exposes `window.motiondb` while the plugin is enabled.
DataviewJS provides `dv` for reading page metadata and rendering results. Use a
`dataviewjs` code block to call Motion Database; a regular `dataview` block
cannot call JavaScript APIs.

## Requirements

1. Install and enable Motion Database.
2. Install and enable Dataview.
3. In Dataview settings, enable **JavaScript queries**.

DataviewJS runs JavaScript with access to your vault. Enable it only if you
trust the scripts in your vault. See the [DataviewJS API overview](https://blacksmithgu.github.io/obsidian-dataview/api/intro/)
and [code block reference](https://blacksmithgu.github.io/obsidian-dataview/api/code-reference/).

## Quick start: create, query, render

This block creates the `Reading Log` database if it does not exist, creates
the table once, and renders books whose status matches the current note's
`status` property. If that property is missing, it uses `reading`. Add or edit
rows in the Motion Database view. The note can set its filter with YAML such
as `status: reading`.

````markdown
---
status: reading
---

```dataviewjs
const databaseName = "Reading Log";
const db = await window.motiondb.create(databaseName);

await db.query(`
  CREATE TABLE IF NOT EXISTS books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'to-read'
  )
`);
await db.flushSave();

const status = String(dv.current().status ?? "reading");
const books = await window.motiondb.select(
  databaseName,
  "SELECT title, status FROM books WHERE status = $1 ORDER BY title",
  [status]
);

if (books.length === 0) {
  dv.paragraph(`No books marked "${status}" yet.`);
} else {
  dv.table(
    ["Title", "Status"],
    books.map(book => [book.title, book.status])
  );
}
```
````

`create()` can also return an existing database. `CREATE TABLE IF NOT EXISTS`
makes the schema setup safe when Dataview reruns the block. The `$1` SQL
parameter is filled from `[status]`; use parameters for values from note
properties or user input instead of concatenating those values into SQL.

## API reference

| Call | Returns | Use |
| --- | --- | --- |
| `window.motiondb.create(name)` | `Promise<MotionDB>` | Create or open a database. |
| `window.motiondb.open(name)` | `Promise<MotionDB>` | Open an existing database; rejects if it cannot be found. |
| `window.motiondb.list()` | `Promise<{name, tables[]}[]>` | List database names and their tables. |
| `window.motiondb.select(name, sql, params?)` | `Promise<object[]>` | Run a query and return plain row objects. |
| `window.motiondb.query(name, sql, params?)` | `Promise<Result[]>` | Run SQL and return raw results, one per statement. |
| `window.motiondb.seed(name)` | `Promise<{ok, errors}>` | Add the built-in Northwind demo schema and data to an existing database. |
| `window.motiondb.subscribe(callback)` | `() => void` | Listen for saved database changes; returns an unsubscribe function. |

`select()` returns rows like `[{ title: "The Dispossessed", status: "reading" }]`.
`query()` returns row results as `{ type: "rows", columns, rows }` and write
results as `{ type: "ok", message, count }`. SQL errors reject the promise.
Positional parameters use `$1`, `$2`, and so on:

````markdown
```dataviewjs
const rows = await window.motiondb.select(
  "Reading Log",
  "SELECT title FROM books WHERE status = $1 AND title LIKE $2 ORDER BY title",
  ["reading", "The%"]
);

dv.table(["Title"], rows.map(book => [book.title]));
```
````

`window.motiondb.version` reports the public API version. The current API
version is `2`.

## Add or update data

For ordinary editing, use the Motion Database view or an interactive
`motiondb` note embed. If another integration needs to write, use bound
parameters. Writes are saved in the background after `query()` returns. Call
`flushSave()` on the database instance when your integration must wait for the
vault write to finish.

````markdown
```dataviewjs
const db = await window.motiondb.open("Reading Log");
await db.query(
  "INSERT INTO books (title, status) VALUES ($1, $2)",
  ["A Wizard of Earthsea", "to-read"]
);
await db.flushSave();
dv.paragraph("Book saved.");
```
````

Dataview blocks rerun when views refresh. Do not put a non-idempotent `INSERT`
in a block that renders repeatedly unless you want a new row on every run.

## Optional demo database

To explore the SQL engine with fictional Northwind sample data, create a new
database and seed it once:

````markdown
```dataviewjs
const name = "Northwind Demo";
await window.motiondb.create(name);
const result = await window.motiondb.seed(name);
dv.paragraph(`Created ${result.ok} statements; ${result.errors.length} errors.`);
```
````

Run `seed()` only once for a fresh demo database. It inserts sample rows, so
repeating it can produce duplicate-key errors.

## Use the API from another Obsidian plugin

The same global is available to another plugin after Motion Database loads.
Check it before use, then register the returned unsubscribe function with the
plugin lifecycle if you subscribe to changes. For TypeScript, add the
`MotionDatabasePublicApi` declaration from `src/global.d.ts` to your plugin's
types; the example assumes that declaration is present:

```ts
const api = window.motiondb;
if (!api) throw new Error("Motion Database is not enabled.");

const db = await api.open("Reading Log");
const rows = await api.select(
  "Reading Log",
  "SELECT title FROM books WHERE status = $1",
  ["reading"]
);

const unsubscribe = api.subscribe(change => {
  if (change.name === "Reading Log") refreshView();
});
this.register(unsubscribe);
```

The change object contains `name` and `filePath`. Use `api.create(name)` for
create-or-open behavior. `api.open(name)` requires an existing database.

## Related ways to display data

- Use a read-only `motiondb` code block to embed a table or SQL result directly
  in a note; add `interactive: true` to edit a table with a primary key.
- Use the built-in SQL terminal for direct SQL work.
- Use the **Motion Database query** Bases layout on Obsidian 1.10 or later.

See the main [README](README.md) for those examples and
[SQL compatibility](COMPATIBILITY.md) for the supported grammar.
