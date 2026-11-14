# Motion Database

Motion Database stores relational databases in your Obsidian vault. Create
tables and query them with SQL, then use the results in notes, DataviewJS, or
another Obsidian plugin.

## Install and create a database

1. Install and enable **Motion Database** in Obsidian.
2. Open the command palette and run **Motion Database: Open or create**, or
   click the database icon in the ribbon.
3. Create or open a database in the Motion Database home view.

Databases are stored as JSON files under `motion-databases/` at the vault root.
Back up that folder with the rest of your vault. The plugin release contains
the plugin code, not your database files.

## Use SQL in the Motion Database view

Open a database, then use its SQL terminal. For example:

```sql
CREATE TABLE books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'to-read'
);

INSERT INTO books (title, status) VALUES ('The Dispossessed', 'reading');
SELECT title, status FROM books ORDER BY title;
```

The engine supports a PostgreSQL-inspired SQL subset. See
[SQL compatibility](COMPATIBILITY.md) for supported statements and differences.

## Use Motion Database from DataviewJS

Install and enable Dataview as well as Motion Database. In Dataview settings,
turn on **Enable JavaScript queries**. DataviewJS can access your vault and run
JavaScript, so only enable scripts you trust. See the [DataviewJS API
overview](https://blacksmithgu.github.io/obsidian-dataview/api/intro/) and
[code block reference](https://blacksmithgu.github.io/obsidian-dataview/api/code-reference/).

Use a `dataviewjs` block. Dataview provides `dv` for rendering; Motion Database
provides the global `window.motiondb` for opening the database and running SQL.
This example creates a database and table if needed, then renders matching
rows. Set `status: reading` in the note's YAML properties to choose the filter;
add or edit rows in the Motion Database view.

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
  dv.paragraph(`No books marked "${status}" yet. Add a row in Motion Database.`);
} else {
  dv.table(
    ["Title", "Status"],
    books.map(book => [book.title, book.status])
  );
}
```
````

The `$1` placeholder is bound to the first value in `[status]`. Use bound
parameters for values that come from note properties or user input; do not
build SQL by concatenating those values into the query string. More examples
are in the [DataviewJS integration guide](DATAVIEWJS_GUIDE.md).

## Call the API from another plugin

The same global API is available to other Obsidian plugins after Motion
Database loads. `create()` creates a database if needed; `open()` expects an
existing database. `list()` returns database names and table names.

```js
const api = window.motiondb;
if (!api) throw new Error("Enable Motion Database before this integration.");

const databases = await api.list();
const db = await api.create("Reading Log");
const books = await api.select(
  "Reading Log",
  "SELECT title FROM books WHERE status = $1 ORDER BY title",
  ["reading"]
);
```

Use `select()` for row objects (`[{ title: "..." }]`). Use `query()` when you
need raw result objects: each statement returns either `{ type: "rows",
columns, rows }` or `{ type: "ok", message, count }`.

Writes through `query()` are saved in the background. If your integration must
wait until a write reaches the vault, use the open database instance and
`flushSave()`:

```js
const db = await window.motiondb.open("Reading Log");
await db.query(
  "INSERT INTO books (title, status) VALUES ($1, $2)",
  ["A Wizard of Earthsea", "to-read"]
);
await db.flushSave();
```

Other available calls include `window.motiondb.seed(name)` for the built-in
Northwind demo data and `window.motiondb.subscribe(callback)` for database
change notifications. The current public API version is available as
`window.motiondb.version`. The source repository includes TypeScript API
declarations in `src/global.d.ts`; copy a compatible declaration into your
plugin if you want compile-time types for `window.motiondb`.

## Embed a table or query in a note

For a simple table, use a `motiondb` block instead of DataviewJS:

````markdown
```motiondb
database: Reading Log
table: books
limit: 25
```
````

Table embeds are read-only by default. Add `interactive: true` to edit rows in
the note; the table must have a primary key. For a filtered or sorted result,
put one read-only SQL query after the database line:

````markdown
```motiondb
database: Reading Log
SELECT title, status FROM books WHERE status = 'reading' ORDER BY title
```
````

Column display formats are configured in the table's **Structure** dialog and
are shared by the database view and embeds.

## Dataview, Bases, and other integrations

- **DataviewJS:** call `window.motiondb.select()` or
  `window.motiondb.query()` inside a `dataviewjs` block, then render with
  `dv.table()`, `dv.list()`, or other Dataview methods.
- **Bases:** on Obsidian 1.10 or later, select the **Motion Database query**
  layout and provide a database name and read-only SQL query.
- **Other plugins:** call the global API after Motion Database loads. Use
  `subscribe()` when a plugin needs to refresh after database changes.

## Development

The maintained source is `src/main.ts`; Obsidian loads the generated
`main.js`.

1. Install Node.js 20 or later.
2. Run `npm install`.
3. Run `npm run dev` while developing or `npm run build` for a release.
4. Run `npm test` to execute the SQL engine regression suite.

## Data and compatibility

Writes are serialized per database and saved through a temporary snapshot
before replacing the previous file. The plugin is local-first; it is not a
PostgreSQL server and does not provide network connections or multi-process
database access. See [SQL compatibility](COMPATIBILITY.md).
