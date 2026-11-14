# Motion Database

Motion Database is a local-first relational database embedded in an Obsidian
vault. It provides a PostgreSQL-familiar SQL subset through a native workspace
and a DataviewJS API.

## Development

Obsidian executes the generated `main.js`. The maintained source is
`src/main.ts`.

The first migration preserves the legacy engine in one TypeScript entry point
so behavior remains reviewable against the previous release. It is explicitly
marked as transitional; the regression suite is the safety net for splitting
the parser, executor, persistence service, integrations, and views into fully
typed modules.

1. Install Node.js 20 or later.
2. Run `npm install`.
3. Run `npm run dev` while developing, or `npm run build` for a release.

## Data safety

Database files live in `motion-databases/`. Writes are serialized per
database and staged through a temporary file before replacing the stored
snapshot. All plugin views and public API calls share one in-memory database
instance per file.

## Public API

```js
await motiondb.create('My Database'); // safe to call when bootstrapping an app

const rows = await motiondb.select('My Database',
  'SELECT * FROM customers ORDER BY name');

await motiondb.query('My Database',
  "INSERT INTO customers (name) VALUES ('Ada')");
```

Public write calls persist before their promises resolve. A transaction can
span calls to `motiondb.query`; changes are persisted when `COMMIT`
completes and discarded when `ROLLBACK` completes.

### Markdown query blocks

Embed a whole table in any note with a `motiondb` code block:

````markdown
```motiondb
database: My Database
table: customers
```
````

Add `limit: 100` to show only the first 100 rows. Embedded tables update when
the database changes and are read-only by default.

To edit cells directly from the note, add `interactive: true`. Interactive
tables must have a primary key. Click a non-key cell, then press Enter or click
away to save; press Escape to cancel. Use **Add row** above the table to insert
records; blank fields use the column default or `NULL`. Use the trash button in the pinned row-actions column to delete a row after confirmation.

Column presentation is part of the database schema, so every view and embed is
consistent. Open a table's **Structure** dialog and choose a presentation for
each column:

- Boolean values can use a checkbox presentation and still store true/false.
- Numeric values can display as stars, hearts, or a number rating with a
  configurable maximum. Changing the presentation does not change the value.

Legacy embed-level `properties:` and `types:` lines are still understood for
older notes, but new embeds inherit their presentation from the column.

For filtered or sorted results, put one read-only SQL query after the database
line instead:

````markdown
```motiondb
database: My Database
SELECT id, name FROM customers ORDER BY name
```
````

### Bases

On Obsidian 1.10 or later, choose the **Motion Database query** layout for a
Base view. Configure the database name and one read-only SQL statement in the
view options. Bases continues to own its file query model; this layout uses the
supported custom-view API to present Motion Database results inside the Bases
workspace.

See [DATAVIEWJS_GUIDE.md](DATAVIEWJS_GUIDE.md) for more examples.

## Editor utility

The command palette includes **Motion Database: Editor: Prefix selected lines
with blockquote**. Select one or more lines and run it to add `> ` to every
selected line. Assign a shortcut in **Settings → Hotkeys**. Unlike Obsidian's
toggle command, repeated use adds another quote level instead of removing it.

## Compatibility

The SQL engine is PostgreSQL-inspired, not a complete PostgreSQL server. The
supported grammar and behavioral differences will be tracked explicitly as the
engine is hardened.

Row actions stay visible while tables scroll horizontally. Desktop and embedded tables reserve room for their buttons, mobile controls use larger touch targets, and embedded prose wraps instead of forcing unbounded column widths. New rows in the database editor use the same editing and deletion handlers as existing rows. Embedded cell keyboard shortcuts apply to the cell itself, allowing spaces and Enter to work normally inside its input.

Embedded tables use natural column widths when wider than the pane. Short values stay on one line when they fit their column; longer text wraps at 24rem on desktop and 16rem on mobile. Row actions remain pinned while scrolling.
