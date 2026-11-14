const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.ts'), 'utf8');
const engineSource = source.split('// ── Plugin ─')[0];
const motionDBSource = source.slice(source.indexOf('class MotionDB {'), source.indexOf('function registerGlobalAPI'));
const context = { console, setTimeout, clearTimeout, window: {} };
vm.runInNewContext(
  engineSource + motionDBSource
    + '\nglobalThis.__motiondbTest = { MotionDBEngine, MotionDB, bindParameters, assertReadOnlyQuery, parseMotionDBEmbedSource, computeERDLayout };',
  context,
);

const {
  MotionDBEngine,
  MotionDB,
  bindParameters,
  assertReadOnlyQuery,
  parseMotionDBEmbedSource,
  computeERDLayout,
} = context.__motiondbTest;

test('widget queries commit in memory without waiting for disk persistence', async () => {
  let releaseWrite;
  let signalWrite;
  const writeStarted = new Promise(resolve => { signalWrite = resolve; });
  const writes = [];
  const adapter = {
    exists: async () => true,
    write: async (filePath, payload) => {
      writes.push({ filePath, payload });
      signalWrite();
      await new Promise(resolve => { releaseWrite = resolve; });
    },
    rename: async () => {},
    remove: async () => {},
  };
  const plugin = { app: { vault: { adapter, createFolder: async () => {} }, workspace: { trigger: () => {} } } };
  const db = new MotionDB(plugin, 'motion-databases/Fast.motiondb.json');
  db.name = 'Fast';
  db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
  db.engine._dirty = false;

  await db.query("INSERT INTO notes VALUES (1, 'one')");
  await db.query("INSERT INTO notes VALUES (2, 'two')");
  assert.equal(db.engine.schema.notes.rows.length, 2);
  assert.equal(writes.length, 0);

  const flushing = db.flushSave();
  await writeStarted;
  assert.equal(writes.length, 1);
  assert.match(writes[0].payload, /"one"/);
  assert.match(writes[0].payload, /"two"/);
  releaseWrite();
  await flushing;
  assert.equal(db.engine._dirty, false);
});

test('executes relational queries and joins', () => {
  const db = new MotionDBEngine();
  db.exec('CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
  db.exec('CREATE TABLE books (id INTEGER PRIMARY KEY, author_id INTEGER REFERENCES authors(id), title TEXT)');
  db.exec("INSERT INTO authors VALUES (1, 'Ada')");
  db.exec("INSERT INTO books VALUES (10, 1, 'Notes')");
  const [result] = db.exec(
    'SELECT authors.name, books.title FROM authors JOIN books ON authors.id = books.author_id',
  );
  assert.deepEqual(Array.from(result.columns), ['name', 'title']);
  assert.deepEqual(Array.from(result.rows[0]), ['Ada', 'Notes']);
});

test('supports create, read, update, and delete operations', () => {
  const db = new MotionDBEngine();
  db.exec('CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL)');
  db.exec("INSERT INTO tasks (title) VALUES ('Draft')");
  assert.deepEqual(Array.from(db.exec('SELECT id, title FROM tasks')[0].rows[0]), [1, 'Draft']);
  db.exec("UPDATE tasks SET title = 'Published' WHERE id = 1");
  assert.equal(db.exec('SELECT title FROM tasks WHERE id = 1')[0].rows[0][0], 'Published');
  db.exec('DELETE FROM tasks WHERE id = 1');
  assert.equal(db.exec('SELECT * FROM tasks')[0].rows.length, 0);
});

test('rolls back a failed multi-statement batch', () => {
  const db = new MotionDBEngine();
  db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)');
  assert.throws(() => db.exec(
    "INSERT INTO items VALUES (1, 'first'); INSERT INTO items VALUES (1, 'duplicate')",
  ));
  assert.equal(db.schema.items.rows.length, 0);
});

test('schema IF NOT EXISTS no-ops do not mark the database dirty', () => {
  const db = new MotionDBEngine();
  db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)');
  db.exec('CREATE VIEW item_names AS SELECT name FROM items');
  db.exec('CREATE INDEX item_name_idx ON items (name)');
  db._dirty = false;

  db.exec('CREATE TABLE IF NOT EXISTS items (replacement TEXT)');
  db.exec('CREATE VIEW IF NOT EXISTS item_names AS SELECT id FROM items');
  db.exec('CREATE INDEX IF NOT EXISTS item_name_idx ON items (id)');

  assert.equal(db._dirty, false);
  assert.deepEqual(Array.from(db.schema.items.columns, column => column.name), ['id', 'name']);
  assert.deepEqual(Array.from(db.schema.items.indexes.item_name_idx.cols), ['name']);
});

test('a transaction error restores BEGIN state and closes the transaction', () => {
  const db = new MotionDBEngine();
  db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)');
  db.exec("INSERT INTO items VALUES (1, 'original')");
  db.exec('BEGIN');
  db.exec("INSERT INTO items VALUES (2, 'temporary')");
  db.exec('SAVEPOINT later');
  db.exec("INSERT INTO items VALUES (3, 'also temporary')");
  assert.throws(() => db.exec("INSERT INTO items VALUES (1, 'duplicate')"));
  assert.equal(db._inTx, false);
  assert.deepEqual(Array.from(db.schema.items.rows, row => row.id), [1]);
});

test('binds PostgreSQL-style parameters without touching quoted text', () => {
  const sql = bindParameters(
    "SELECT '$1' AS literal, name FROM users WHERE age >= $1 AND active = $2",
    [18, true],
  );
  assert.equal(
    sql,
    "SELECT '$1' AS literal, name FROM users WHERE age >= 18 AND active = TRUE",
  );
  assert.throws(() => bindParameters('SELECT $2', [1]), /was not provided/);
});

test('embedded query guard rejects writes', () => {
  assert.doesNotThrow(() => assertReadOnlyQuery('SELECT * FROM users'));
  assert.throws(() => assertReadOnlyQuery('DELETE FROM users'), /read-only/);
  assert.throws(() => assertReadOnlyQuery('SELECT * FROM users; DELETE FROM users'), /read-only/);
});

test('parses table and SQL note embeds', () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(parseMotionDBEmbedSource('database: Work\ntable: tasks\nlimit: 25'))),
    { database: 'Work', table: 'tasks', sql: '', limit: 25, interactive: false, properties: {} },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(parseMotionDBEmbedSource('database: Work\nSELECT * FROM tasks'))),
    { database: 'Work', table: '', sql: 'SELECT * FROM tasks', limit: null, interactive: false, properties: {} },
  );
  assert.throws(
    () => parseMotionDBEmbedSource('database: Work\ntable: tasks\nSELECT * FROM tasks'),
    /either.*table.*SQL query/i,
  );
  assert.throws(() => parseMotionDBEmbedSource('database: Work\ntable: tasks\nlimit: 0'), /positive whole number/);
  assert.equal(
    parseMotionDBEmbedSource('database: Work\ntable: tasks\ninteractive: true').interactive,
    true,
  );
  assert.throws(
    () => parseMotionDBEmbedSource('database: Work\ninteractive: true\nSELECT * FROM tasks'),
    /only be used with.*table/i,
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(parseMotionDBEmbedSource(
      'database: Work\ntable: tasks\nproperties: cover=image; done=checkbox; completion=progress(100); priority=rating(stars,5); love=hearts(7); score=rating(number,10)',
    ).properties)),
    {
      cover: { type: 'image' },
      done: { type: 'checkbox' },
      completion: { type: 'progress', max: 100 },
      priority: { type: 'rating', style: 'stars', max: 5 },
      love: { type: 'rating', style: 'hearts', max: 7 },
      score: { type: 'rating', style: 'number', max: 10 },
    },
  );
  assert.throws(
    () => parseMotionDBEmbedSource('database: Work\ntable: tasks\nproperties: score=rainbows'),
    /Unknown display type/,
  );
});

test('ERD layout keeps differently sized table cards from overlapping', () => {
  const schemas = {
    authors: { columns: [{ name: 'id' }, { name: 'name' }] },
    books: {
      columns: [
        { name: 'id' },
        { name: 'author_id', fk: { table: 'authors', col: 'id' } },
        ...Array.from({ length: 14 }, (_, index) => ({ name: `field_${index}` })),
      ],
    },
    publishers: { columns: [{ name: 'id' }, { name: 'name' }, { name: 'country' }] },
    editions: {
      columns: [
        { name: 'id' },
        { name: 'book_id', fk: { table: 'books', col: 'id' } },
        { name: 'publisher_id', fk: { table: 'publishers', col: 'id' } },
      ],
    },
  };
  const names = Object.keys(schemas);
  const { positions } = computeERDLayout(names, name => schemas[name], { verticalGap: 20 });

  for (let left = 0; left < names.length; left++) {
    for (let right = left + 1; right < names.length; right++) {
      const a = positions[names[left]];
      const b = positions[names[right]];
      const overlaps = a.x < b.x + b.w && a.x + a.w > b.x
        && a.y < b.y + b.h && a.y + a.h > b.y;
      assert.equal(overlaps, false, `${names[left]} overlaps ${names[right]}`);
    }
  }
  assert.ok(positions.books.x > positions.authors.x);
  assert.ok(positions.editions.x > positions.books.x);
});
