import {
  BasesView,
  App,
  ItemView,
  MarkdownRenderChild,
  Modal,
  Notice,
  Plugin,
  QueryController,
  setIcon,
  Setting,
  WorkspaceLeaf,
} from 'obsidian';

// ── Motion Database Engine ────────────────────────────────────────────────────
// A self-contained relational DB engine in pure JS.
// Supports: CREATE/DROP/ALTER TABLE, INSERT, SELECT (with JOIN, WHERE, ORDER BY,
//           GROUP BY, LIMIT, OFFSET, aggregates), UPDATE, DELETE, TRUNCATE,
//           PRIMARY KEY AUTOINCREMENT, FOREIGN KEY, NOT NULL, UNIQUE, DEFAULT.

// ── Tokenizer ─────────────────────────────────────────────────────────────────

const TT = {
  KEYWORD: 'KEYWORD', IDENT: 'IDENT', NUMBER: 'NUMBER', STRING: 'STRING',
  STAR: 'STAR', COMMA: 'COMMA', LPAREN: 'LPAREN', RPAREN: 'RPAREN',
  SEMI: 'SEMI', DOT: 'DOT', EQ: 'EQ', NEQ: 'NEQ', LT: 'LT', LTE: 'LTE',
  GT: 'GT', GTE: 'GTE', PLUS: 'PLUS', MINUS: 'MINUS', SLASH: 'SLASH',
  PERCENT: 'PERCENT', CONCAT: 'CONCAT', EOF: 'EOF',
};
type TokenType = typeof TT[keyof typeof TT];
type TokenValue = string | number | null;
interface Token {
  type: TokenType;
  value: TokenValue;
  raw?: string;
}

type SqlScalar = string | number | boolean | null;
type DbRow = Record<string, unknown>;
interface ForeignKeyDefinition {
  table: string;
  col: string;
  onDelete: ReferentialAction;
  onUpdate: ReferentialAction;
}
interface DbColumn {
  name: string;
  type: string;
  pk: boolean;
  ai: boolean;
  notNull: boolean;
  unique: boolean;
  default?: unknown;
  fk: ForeignKeyDefinition | null;
  presentation?: ColumnPresentation;
}
type ColumnPresentation = { type: 'default' } | { type: 'checkbox' } | { type: 'rating'; style: 'stars' | 'hearts' | 'number'; max: number };
interface IndexDefinition { cols: string[]; unique: boolean }
interface DbTable {
  columns: DbColumn[];
  rows: DbRow[];
  seq: number;
  indexes?: Record<string, IndexDefinition>;
  _derived?: boolean;
  _temp?: boolean;
  _view?: boolean;
}
interface ViewDefinition { query: SelectStatement; sql: string }
type ViewMap = Record<string, ViewDefinition>;
interface DbSchema {
  [name: string]: DbTable | ViewMap | undefined;
  __views__?: ViewMap;
}
type ReferentialAction = 'CASCADE' | 'RESTRICT' | 'NO ACTION' | 'SET NULL' | 'SET DEFAULT';
type SqlExpr =
  | { type: 'LIT'; value: SqlScalar }
  | { type: 'COL'; table: string | null; col: string }
  | { type: 'STAR' }
  | { type: 'BINOP'; op: string; left: SqlExpr; right: SqlExpr }
  | { type: 'NOT' | 'NEG'; expr: SqlExpr }
  | { type: 'BETWEEN'; expr: SqlExpr; lo: SqlExpr; hi: SqlExpr }
  | { type: 'IN' | 'NOT_IN'; expr: SqlExpr; values?: SqlExpr[]; subquery?: SelectStatement }
  | { type: 'IS_NULL' | 'IS_NOT_NULL'; expr: SqlExpr }
  | { type: 'AGG'; fn: 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX'; distinct: boolean; arg: SqlExpr }
  | { type: 'FUNC'; name: string; args: SqlExpr[] }
  | { type: 'COALESCE'; args: SqlExpr[] }
  | { type: 'CASE'; baseExpr: SqlExpr | null; branches: Array<{ cond: SqlExpr; val: SqlExpr }>; else_: SqlExpr | null }
  | { type: 'SUBQUERY'; query: SelectStatement };
type SelectColumn = { type: 'STAR' } | { type: 'EXPR'; expr: SqlExpr; alias: string | null };
function isSelectExpressionColumn(column: SelectColumn): column is Extract<SelectColumn, { type: 'EXPR' }> {
  return column.type === 'EXPR';
}
type FromRef = { name?: string | null; table?: string | null; subquery?: SelectStatement; alias: string | null };
type JoinKind = 'INNER' | 'LEFT' | 'RIGHT' | 'CROSS' | 'FULL';
type JoinClause = FromRef & { kind: JoinKind; on: SqlExpr | null };
type OrderClause = { expr: SqlExpr; dir: 'ASC' | 'DESC' };
interface EquiJoinKey { leftAlias: string; leftCol: string; rightCol: string }
type ColumnConstraint =
  | { type: 'PRIMARY_KEY'; autoincrement: boolean }
  | { type: 'AUTOINCREMENT' | 'NOT_NULL' | 'UNIQUE' }
  | { type: 'DEFAULT'; value: SqlExpr }
  | { type: 'FOREIGN_KEY'; refTable: string; refCol: string | null; onDelete: ReferentialAction; onUpdate: ReferentialAction };
type TableConstraint =
  | { type: 'PRIMARY_KEY'; columns: string[] }
  | { type: 'UNIQUE'; columns: string[] }
  | { type: 'FOREIGN_KEY'; col: string; refTable: string; refCol: string; onDelete: ReferentialAction; onUpdate: ReferentialAction };
type ColumnDefinition = { name: string; dataType: { name: string; size: TokenValue }; constraints: ColumnConstraint[] };
interface SelectStatement {
  type: 'SELECT'; distinct: boolean; columns: SelectColumn[]; from: FromRef; joins: JoinClause[];
  where: SqlExpr | null; groupBy: SqlExpr[]; having: SqlExpr | null; orderBy: OrderClause[];
  limit: SqlExpr | null; offset: SqlExpr | null;
  compound: { op: string; all: boolean; right: SelectStatement } | null;
}
type SqlStatement = SelectStatement
  | { type: 'INSERT'; table: string; columns: string[] | null; rows: SqlExpr[][] }
  | { type: 'UPDATE'; table: string; sets: Array<{ col: string; val: SqlExpr }>; where: SqlExpr | null }
  | { type: 'DELETE'; table: string; where: SqlExpr | null }
  | { type: 'CREATE_TABLE'; name: string; ifNotExists: boolean; columns: ColumnDefinition[]; constraints: TableConstraint[] }
  | { type: 'CREATE_VIEW'; name: string; ifNotExists: boolean; query: SelectStatement; _originalSql: string }
  | { type: 'CREATE_INDEX'; name: string; table: string; cols: string[]; unique: boolean; ifNotExists: boolean }
  | { type: 'DROP_TABLE'; name: string; ifExists: boolean }
  | { type: 'DROP_VIEW'; name: string; ifExists: boolean }
  | { type: 'DROP_INDEX'; name: string; ifExists: boolean }
  | { type: 'ALTER_ADD_COLUMN'; table: string; column: ColumnDefinition }
  | { type: 'ALTER_MODIFY_COLUMN'; table: string; column: ColumnDefinition }
  | { type: 'ALTER_DROP_COLUMN'; table: string; column: string }
  | { type: 'ALTER_RENAME_TABLE'; table: string; newName: string }
  | { type: 'ALTER_RENAME_COLUMN'; table: string; from: string; to: string }
  | { type: 'TRUNCATE'; table: string }
  | { type: 'SHOW_TABLES' }
  | { type: 'SHOW_DATABASES' }
  | { type: 'BEGIN' }
  | { type: 'COMMIT' }
  | { type: 'ROLLBACK' }
  | { type: 'DESCRIBE'; table: string }
  | { type: 'PRAGMA'; name: string; arg: string | null }
  | { type: 'SAVEPOINT'; name: string }
  | { type: 'RELEASE'; name: string }
  | { type: 'ROLLBACK_TO'; name: string }
  | { type: 'EXPLAIN'; stmt: SqlStatement }
  | { type: 'WITH'; recursive: boolean; ctes: Array<{ name: string; query: SelectStatement }>; stmt: SqlStatement };
type SqlResult =
  | { type: 'ok'; message: string; count?: number; _committed?: boolean; _rolledBack?: boolean }
  | { type: 'rows'; columns: string[]; rows: unknown[][] };
type RowsResult = Extract<SqlResult, { type: 'rows' }>;
type EvalRow = DbRow & { __grp__?: EvalRow[]; __outer__?: EvalRow };
type SqlRenderResult = SqlResult | { type: 'error'; message: string };
type SqlOutputBlock = (
  | { type: 'result'; result: SqlRenderResult }
  | { type: 'error'; message: string }
) & { sql?: string | null; timestamp?: string | null; elapsed?: number };

interface MotionDatabasePluginAPI extends Plugin {
  databases: Map<string, MotionDB>;
  getDatabase(filePath: string): Promise<MotionDB>;
  registerDatabase(db: MotionDB): MotionDB;
  deleteDatabase(filePath: string): Promise<void>;
  openHome(): Promise<void>;
  openInLeaf(filePath: string): Promise<void>;
}

type PropertyFormat =
  | { type: 'text' | 'default' | 'checkbox' | 'image' | 'media' }
  | { type: 'progress'; max?: number }
  | { type: 'rating'; style: 'stars' | 'hearts' | 'number'; max: number };
type PropertyFormats = Record<string, PropertyFormat>;
interface EmbedPropertyRenderOptions {
  app?: App;
  sourcePath?: string;
  editable?: boolean;
  onChange?: (value: unknown) => void;
}
interface QueryResultsOptions extends EmbedPropertyRenderOptions {
  label?: string | null;
  interactive?: boolean;
  formats?: PropertyFormats;
  canEdit?: (rowIndex: number, columnIndex: number) => boolean;
  canAdd?: (columnIndex: number) => boolean;
  onEdit?: (rowIndex: number, columnIndex: number, value: unknown) => Promise<void>;
  onDelete?: (rowIndex: number) => Promise<void>;
  onAdd?: (values: Array<{ columnIndex: number; value: unknown }>) => Promise<void>;
}
interface EmbedMediaResource { raw: string; src: string; extension: string }
interface DatabaseSummary {
  filePath: string;
  name: string;
  tables: number;
  rows: number;
  views: number;
  mtime: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSqlScalar(value: unknown): value is SqlScalar {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseSqlDate(value: unknown): Date | null {
  if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isDbTable(value: unknown): value is DbTable {
  if (!isRecord(value) || !Array.isArray(value.columns) || !Array.isArray(value.rows) || typeof value.seq !== 'number') return false;
  const validColumns = value.columns.every(column => isRecord(column)
    && typeof column.name === 'string'
    && typeof column.type === 'string'
    && typeof column.pk === 'boolean'
    && typeof column.ai === 'boolean'
    && typeof column.notNull === 'boolean'
    && typeof column.unique === 'boolean'
    && (column.fk === null || (isRecord(column.fk)
      && typeof column.fk.table === 'string'
      && typeof column.fk.col === 'string'
      && typeof column.fk.onDelete === 'string'
      && typeof column.fk.onUpdate === 'string')));
  const validRows = value.rows.every(row => isRecord(row));
  return validColumns && validRows;
}

function isSqlExpr(value: unknown): value is SqlExpr {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  const expr = (candidate: unknown): boolean => isSqlExpr(candidate);
  switch (value.type) {
    case 'LIT': return value.value === null || ['string', 'number', 'boolean'].includes(typeof value.value);
    case 'COL': return (value.table === null || typeof value.table === 'string') && typeof value.col === 'string';
    case 'STAR': return true;
    case 'BINOP': return typeof value.op === 'string' && expr(value.left) && expr(value.right);
    case 'NOT': case 'NEG': case 'IS_NULL': case 'IS_NOT_NULL': return expr(value.expr);
    case 'BETWEEN': return expr(value.expr) && expr(value.lo) && expr(value.hi);
    case 'IN': case 'NOT_IN': return expr(value.expr)
      && (Array.isArray(value.values) ? value.values.every(expr) : isSelectStatement(value.subquery));
    case 'AGG': return ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'].includes(String(value.fn))
      && typeof value.distinct === 'boolean' && expr(value.arg);
    case 'FUNC': return typeof value.name === 'string' && Array.isArray(value.args) && value.args.every(expr);
    case 'COALESCE': return Array.isArray(value.args) && value.args.every(expr);
    case 'CASE': return (value.baseExpr === null || expr(value.baseExpr))
      && Array.isArray(value.branches)
      && value.branches.every(branch => isRecord(branch) && expr(branch.cond) && expr(branch.val))
      && (value.else_ === null || expr(value.else_));
    case 'SUBQUERY': return isSelectStatement(value.query);
    default: return false;
  }
}

function isSelectStatement(value: unknown): value is SelectStatement {
  if (!isRecord(value) || value.type !== 'SELECT' || typeof value.distinct !== 'boolean') return false;
  const validColumn = (column: unknown): boolean => isRecord(column)
    && (column.type === 'STAR' || ((column.type === undefined || column.type === 'EXPR')
      && isSqlExpr(column.expr) && (column.alias === null || typeof column.alias === 'string')));
  const validFrom = (from: unknown): boolean => isRecord(from)
    && (from.name === null || from.name === undefined || typeof from.name === 'string')
    && (from.table === null || from.table === undefined || typeof from.table === 'string')
    && (from.alias === null || typeof from.alias === 'string')
    && (from.subquery === undefined || isSelectStatement(from.subquery));
  const validOrder = (order: unknown): boolean => isRecord(order)
    && isSqlExpr(order.expr) && (order.dir === 'ASC' || order.dir === 'DESC');
  return Array.isArray(value.columns) && value.columns.length > 0 && value.columns.every(validColumn)
    && validFrom(value.from)
    && Array.isArray(value.joins) && value.joins.every(join => isRecord(join)
      && ['INNER', 'LEFT', 'RIGHT', 'CROSS', 'FULL'].includes(String(join.kind))
      && validFrom(join)
      && (join.on === null || isSqlExpr(join.on)))
    && (value.where === null || isSqlExpr(value.where))
    && Array.isArray(value.groupBy) && value.groupBy.every(isSqlExpr)
    && (value.having === null || isSqlExpr(value.having))
    && Array.isArray(value.orderBy) && value.orderBy.every(validOrder)
    && (value.limit === null || isSqlExpr(value.limit))
    && (value.offset === null || isSqlExpr(value.offset))
    && (value.compound === null || (isRecord(value.compound)
      && typeof value.compound.op === 'string'
      && typeof value.compound.all === 'boolean'
      && isSelectStatement(value.compound.right)));
}

function isViewMap(value: unknown): value is ViewMap {
  return isRecord(value) && Object.values(value).every(view => isRecord(view)
    && typeof view.sql === 'string'
    && isSelectStatement(view.query));
}

function isDbSchema(value: unknown): value is DbSchema {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([name, entry]) => name === '__views__'
    ? isViewMap(entry)
    : isDbTable(entry));
}

function normalizeLegacySelectColumnTags(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(normalizeLegacySelectColumnTags);
    return;
  }
  if (!isRecord(value)) return;
  if (value.type === 'SELECT' && Array.isArray(value.columns)) {
    for (const column of value.columns) {
      if (isRecord(column) && column.type === undefined && isSqlExpr(column.expr)) {
        column.type = 'EXPR';
      }
    }
  }
  Object.values(value).forEach(normalizeLegacySelectColumnTags);
}

const KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET',
  'DELETE', 'CREATE', 'DROP', 'ALTER', 'TABLE', 'ADD', 'COLUMN', 'RENAME', 'TO',
  'TRUNCATE', 'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'AUTOINCREMENT', 'AUTO_INCREMENT',
  'NOT', 'NULL', 'UNIQUE', 'DEFAULT', 'CHECK', 'INDEX', 'ON', 'AND', 'OR', 'IN', 'LIKE',
  'IS', 'BETWEEN', 'LIKE', 'ILIKE', 'ORDER', 'BY', 'ASC', 'DESC', 'GROUP', 'HAVING', 'LIMIT', 'OFFSET',
  'JOIN', 'INNER', 'LEFT', 'RIGHT', 'CROSS', 'FULL', 'OUTER', 'AS', 'DISTINCT',
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'IF', 'NOT', 'EXISTS', 'DATABASE', 'DATABASES', 'TABLES', 'PRAGMA', 'SHOW', 'DESCRIBE', 'DESC',
  'INTEGER', 'INT', 'TEXT', 'REAL', 'FLOAT', 'DOUBLE', 'BOOLEAN', 'BOOL', 'DATE', 'BLOB',
  'VARCHAR', 'CHAR', 'NUMERIC', 'SERIAL', 'BIGINT', 'SMALLINT',
  'TRUE', 'FALSE', 'CONSTRAINT', 'CASCADE', 'RESTRICT', 'SET', 'NO', 'ACTION',
  'RETURNING',
  'VIEW', 'MATERIALIZED', 'CREATE', 'INDEX', 'ON', 'UNIQUE',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'TRANSACTION', 'SAVEPOINT', 'RELEASE',
  'EXPLAIN', 'ANALYZE', 'WITH', 'RECURSIVE', 'UNION', 'INTERSECT', 'EXCEPT', 'ALL',
  'REPLACE', 'IGNORE', 'OR', 'CONFLICT', 'DO', 'NOTHING', 'UPDATE',
  'OVER', 'PARTITION', 'ROW_NUMBER', 'RANK', 'DENSE_RANK',
]);

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const s = sql.trim();

  while (i < s.length) {
    // Skip whitespace
    if (/\s/.test(s[i])) { i++; continue; }
    // Comments
    if (s[i] === '-' && s[i + 1] === '-') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (s[i] === '/' && s[i + 1] === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      if (i >= s.length) throw new Error('Unterminated SQL comment');
      i += 2; continue;
    }

    // String literals
    if (s[i] === "'" || s[i] === '"') {
      const q = s[i]; let v = ''; let closed = false; i++;
      while (i < s.length) {
        if (s[i] === q && s[i + 1] === q) { v += q; i += 2; } // SQL '' escape
        else if (s[i] === q) { i++; closed = true; break; }          // end of string
        else if (s[i] === '\\' && s[i + 1] === q) { v += q; i += 2; } // backslash escape
        else v += s[i++];
      }
      if (!closed) throw new Error('Unterminated SQL string');
      tokens.push({ type: TT.STRING, value: v }); continue;
    }

    // Numbers (unary minus is handled by parseUnary — don't consume '-' here)
    if (/[0-9]/.test(s[i])) {
      let v = s[i++];
      while (i < s.length && /[0-9.]/.test(s[i])) v += s[i++];
      if (!/^\d+(?:\.\d*)?$/.test(v) || !Number.isFinite(Number(v))) throw new Error(`Invalid number: ${v}`);
      tokens.push({ type: TT.NUMBER, value: Number(v) }); continue;
    }

    // Identifiers / keywords
    if (/[a-zA-Z_`]/.test(s[i])) {
      let v = '';
      const backtick = s[i] === '`';
      if (backtick) i++;
      while (i < s.length && (/[a-zA-Z0-9_]/.test(s[i]) || (backtick && s[i] !== '`'))) v += s[i++];
      if (backtick) {
        if (s[i] !== '`') throw new Error('Unterminated SQL identifier');
        i++;
      }
      const up = v.toUpperCase();
      tokens.push({ type: KEYWORDS.has(up) ? TT.KEYWORD : TT.IDENT, value: backtick ? v : up, raw: v }); continue;
    }

    // Operators and punctuation
    const two = s.slice(i, i + 2);
    if (two === '<>') { tokens.push({ type: TT.NEQ, value: '<>' }); i += 2; continue; }
    if (two === '!=') { tokens.push({ type: TT.NEQ, value: '!=' }); i += 2; continue; }
    if (two === '<=') { tokens.push({ type: TT.LTE, value: '<=' }); i += 2; continue; }
    if (two === '>=') { tokens.push({ type: TT.GTE, value: '>=' }); i += 2; continue; }
    if (two === '||') { tokens.push({ type: TT.CONCAT, value: '||' }); i += 2; continue; }

    const MAP: Record<string, TokenType> = {
      '*': TT.STAR, ',': TT.COMMA, '(': TT.LPAREN, ')': TT.RPAREN, ';': TT.SEMI,
      '.': TT.DOT, '=': TT.EQ, '<': TT.LT, '>': TT.GT, '+': TT.PLUS,
      '-': TT.MINUS, '/': TT.SLASH, '%': TT.PERCENT
    };
    if (MAP[s[i]]) { tokens.push({ type: MAP[s[i]], value: s[i] }); i++; continue; }
    throw new Error(`Unexpected character: ${s[i]} at position ${i}`);
  }

  tokens.push({ type: TT.EOF, value: null });
  return tokens;
}

// ── Parser ─────────────────────────────────────────────────────────────────────

class Parser {
  tokens: Token[];
  pos: number;

  constructor(tokens: Token[]) { this.tokens = tokens; this.pos = 0; }

  peek(): Token { return this.tokens[this.pos]; }
  next(): Token { return this.tokens[this.pos++]; }
  expect(type: TokenType, value?: TokenValue): Token {
    const t = this.next();
    if (t.type !== type || (value !== undefined && t.value !== value))
      throw new Error(`Expected ${value || type}, got '${t.value}'`);
    return t;
  }
  match(type: TokenType, value?: TokenValue): Token | null {
    const t = this.peek();
    if (t.type === type && (value === undefined || t.value === value)) { this.pos++; return t; }
    return null;
  }
  matchKw(kw: string): Token | null { return this.match(TT.KEYWORD, kw); }
  isKw(kw: string): boolean { const t = this.peek(); return t.type === TT.KEYWORD && t.value === kw; }
  isIdent(): boolean { const t = this.peek(); return t.type === TT.IDENT || t.type === TT.KEYWORD; }

  identifier(): string {
    const t = this.peek();
    if (t.type === TT.IDENT || t.type === TT.KEYWORD) {
      this.pos++;
      if (typeof t.raw === 'string') return t.raw;
      if (typeof t.value === 'string') return t.value;
    }
    throw new Error(`Expected identifier, got '${t.value}'`);
  }

  parse(): SqlStatement[] {
    const stmts: SqlStatement[] = [];
    while (this.peek().type !== TT.EOF) {
      if (this.match(TT.SEMI)) continue;
      stmts.push(this.parseStatement());
      this.match(TT.SEMI);
    }
    return stmts;
  }

  parseStatement(): SqlStatement {
    const t = this.peek();
    if (t.type !== TT.KEYWORD) throw new Error(`Expected SQL statement, got '${t.value}'`);
    switch (t.value) {
      case 'SELECT': return this.parseSelect();
      case 'INSERT': return this.parseInsert();
      case 'UPDATE': return this.parseUpdate();
      case 'DELETE': return this.parseDelete();
      case 'CREATE': return this.parseCreate();
      case 'DROP': return this.parseDrop();
      case 'ALTER': return this.parseAlter();
      case 'TRUNCATE': return this.parseTruncate();
      case 'SHOW': return this.parseShow();
      case 'DESCRIBE': case 'DESC': return this.parseDescribe();
      case 'PRAGMA': return this.parsePragma();
      case 'BEGIN': this.next(); this.matchKw('TRANSACTION'); return { type: 'BEGIN' };
      case 'COMMIT': this.next(); this.matchKw('TRANSACTION'); return { type: 'COMMIT' };
      case 'ROLLBACK': return this.parseRollback();
      case 'SAVEPOINT': return this.parseSavepoint();
      case 'RELEASE': return this.parseRelease();
      case 'EXPLAIN': return this.parseExplain();
      case 'WITH': return this.parseWith();
      default: throw new Error(`Unknown statement: ${t.value}`);
    }
  }

  // ── SELECT ──
  parseSelect(): SelectStatement {
    this.expect(TT.KEYWORD, 'SELECT');
    const distinct = !!this.matchKw('DISTINCT');
    const columns = this.parseSelectColumns();
    this.expect(TT.KEYWORD, 'FROM');
    const from = this.parseFromClause();
    const joins = this.parseJoins();
    const where = this.matchKw('WHERE') ? this.parseExpr() : null;
    const groupBy = this.matchKw('GROUP') ? (this.expect(TT.KEYWORD, 'BY'), this.parseExprList()) : [];
    const having = this.matchKw('HAVING') ? this.parseExpr() : null;
    const orderBy = this.matchKw('ORDER') ? (this.expect(TT.KEYWORD, 'BY'), this.parseOrderList()) : [];
    const limit = this.matchKw('LIMIT') ? this.parseExpr() : null;
    const offset = this.matchKw('OFFSET') ? this.parseExpr() : null;
    // UNION / INTERSECT / EXCEPT
    let compound: SelectStatement['compound'] = null;
    if (this.isKw('UNION') || this.isKw('INTERSECT') || this.isKw('EXCEPT')) {
      const op = String(this.next().value);
      const all = !!this.matchKw('ALL');
      const right = this.parseSelect();
      compound = { op, all, right };
    }
    return { type: 'SELECT', distinct, columns, from, joins, where, groupBy, having, orderBy, limit, offset, compound };
  }

  parseSelectColumns(): SelectColumn[] {
    if (this.match(TT.STAR)) return [{ type: 'STAR' }];
    const cols: Array<Exclude<SelectColumn, { type: 'STAR' }>> = [];
    cols.push(this.parseSelectColumn());
    while (this.match(TT.COMMA)) cols.push(this.parseSelectColumn());
    return cols;
  }

  parseSelectColumn(): Exclude<SelectColumn, { type: 'STAR' }> {
    const expr = this.parseExpr();
    let alias: string | null = null;
    if (this.matchKw('AS')) {
      alias = this.identifier();
    } else if (this.isIdent() && !this.isKw('FROM') && !this.isKw('WHERE') && !this.isKw('ORDER') && !this.isKw('GROUP') && !this.isKw('HAVING') && !this.isKw('LIMIT') && !this.isKw('OFFSET') && !this.isKw('UNION') && !this.isKw('INTERSECT') && !this.isKw('EXCEPT')) {
      // Implicit alias: SELECT COUNT(*) c FROM ... (no AS keyword).
      // Note: a missing comma between two columns (SELECT a b FROM t) is silently
      // reinterpreted as "a AS b" rather than a parse error — same trade-off every
      // major SQL dialect makes for implicit aliases.
      alias = this.identifier();
    }
    return { type: 'EXPR', expr, alias };
  }

  parseFromClause(): FromRef {
    // Derived table: FROM (SELECT ...) alias
    if (this.peek().type === TT.LPAREN && this.tokens[this.pos + 1]?.type === TT.KEYWORD && this.tokens[this.pos + 1]?.value === 'SELECT') {
      this.next(); // consume (
      const subquery = this.parseSelect();
      this.expect(TT.RPAREN);
      const alias = this.matchKw('AS') ? this.identifier() : (this.isIdent() ? this.identifier() : null);
      if (!alias) throw new Error('Derived table in FROM clause must have an alias, e.g. FROM (SELECT ...) t');
      return { name: null, subquery, alias };
    }
    const name = this.identifier();
    const alias = this.matchKw('AS') ? this.identifier() : (this.isIdent() && !this.isKw('WHERE') && !this.isKw('JOIN') && !this.isKw('INNER') && !this.isKw('LEFT') && !this.isKw('RIGHT') && !this.isKw('CROSS') && !this.isKw('FULL') && !this.isKw('ORDER') && !this.isKw('GROUP') && !this.isKw('HAVING') && !this.isKw('LIMIT') && !this.isKw('OFFSET') && !this.isKw('ON') && !this.isKw('UNION') && !this.isKw('INTERSECT') && !this.isKw('EXCEPT') ? this.identifier() : null);
    return { name, alias };
  }

  parseJoins(): JoinClause[] {
    const joins: JoinClause[] = [];
    while (true) {
      let kind: JoinKind = 'INNER';
      if (this.matchKw('LEFT')) { this.matchKw('OUTER'); kind = 'LEFT'; }
      else if (this.matchKw('RIGHT')) { this.matchKw('OUTER'); kind = 'RIGHT'; }
      else if (this.matchKw('INNER')) { this.expect(TT.KEYWORD, 'JOIN'); kind = 'INNER'; }
      else if (this.matchKw('CROSS')) { kind = 'CROSS'; }
      else if (this.matchKw('FULL')) { this.matchKw('OUTER'); kind = 'FULL'; }
      else if (this.matchKw('JOIN')) { kind = 'INNER'; }
      else break;
      // Consume JOIN for LEFT/RIGHT/CROSS/FULL (INNER already consumed it above; bare JOIN consumed it in matchKw)
      if (kind !== 'INNER') this.matchKw('JOIN');
      // Derived table: JOIN (SELECT ...) alias ON ...
      let table: string | null = null;
      let subquery: SelectStatement | null = null;
      if (this.peek().type === TT.LPAREN && this.tokens[this.pos + 1]?.type === TT.KEYWORD && this.tokens[this.pos + 1]?.value === 'SELECT') {
        this.next(); // consume (
        subquery = this.parseSelect();
        this.expect(TT.RPAREN);
      } else {
        table = this.identifier();
      }
      // Support both explicit alias (AS alias) and implicit alias (table alias)
      let alias: string | null = null;
      if (this.matchKw('AS')) {
        alias = this.identifier();
      } else if (this.isIdent() && !this.isKw('ON') && !this.isKw('WHERE') && !this.isKw('JOIN') && !this.isKw('INNER') && !this.isKw('LEFT') && !this.isKw('RIGHT') && !this.isKw('CROSS') && !this.isKw('FULL') && !this.isKw('ORDER') && !this.isKw('GROUP') && !this.isKw('HAVING') && !this.isKw('LIMIT') && !this.isKw('OFFSET') && !this.isKw('UNION') && !this.isKw('INTERSECT') && !this.isKw('EXCEPT')) {
        alias = this.identifier();
      }
      if (subquery && !alias) throw new Error('Derived table in JOIN must have an alias, e.g. JOIN (SELECT ...) t ON ...');
      const on = this.matchKw('ON') ? this.parseExpr() : null;
      joins.push({ kind, table, subquery, alias, on });
    }
    return joins;
  }

  parseOrderList(): OrderClause[] {
    const parseDir = (): OrderClause['dir'] => { if (this.matchKw('DESC')) return 'DESC'; this.matchKw('ASC'); return 'ASC'; };
    const list: OrderClause[] = [{ expr: this.parseExpr(), dir: parseDir() }];
    while (this.match(TT.COMMA)) list.push({ expr: this.parseExpr(), dir: parseDir() });
    return list;
  }

  parseExprList(): SqlExpr[] {
    const list: SqlExpr[] = [this.parseExpr()];
    while (this.match(TT.COMMA)) list.push(this.parseExpr());
    return list;
  }

  // ── INSERT ──
  parseInsert(): Extract<SqlStatement, { type: 'INSERT' }> {
    this.expect(TT.KEYWORD, 'INSERT');
    this.expect(TT.KEYWORD, 'INTO');
    const table = this.identifier();
    let columns: string[] | null = null;
    if (this.match(TT.LPAREN)) {
      columns = [];
      columns.push(this.identifier());
      while (this.match(TT.COMMA)) columns.push(this.identifier());
      this.expect(TT.RPAREN);
    }
    this.expect(TT.KEYWORD, 'VALUES');
    const rows: SqlExpr[][] = [];
    do {
      this.expect(TT.LPAREN);
      const vals: SqlExpr[] = [this.parseExpr()];
      while (this.match(TT.COMMA)) vals.push(this.parseExpr());
      this.expect(TT.RPAREN);
      rows.push(vals);
    } while (this.match(TT.COMMA));
    return { type: 'INSERT', table, columns, rows };
  }

  // ── UPDATE ──
  parseUpdate(): Extract<SqlStatement, { type: 'UPDATE' }> {
    this.expect(TT.KEYWORD, 'UPDATE');
    const table = this.identifier();
    this.expect(TT.KEYWORD, 'SET');
    const sets: Array<{ col: string; val: SqlExpr }> = [];
    do {
      const col = this.identifier();
      this.expect(TT.EQ);
      const val = this.parseExpr();
      sets.push({ col, val });
    } while (this.match(TT.COMMA));
    const where = this.matchKw('WHERE') ? this.parseExpr() : null;
    return { type: 'UPDATE', table, sets, where };
  }

  // ── DELETE ──
  parseDelete(): Extract<SqlStatement, { type: 'DELETE' }> {
    this.expect(TT.KEYWORD, 'DELETE');
    this.expect(TT.KEYWORD, 'FROM');
    const table = this.identifier();
    const where = this.matchKw('WHERE') ? this.parseExpr() : null;
    return { type: 'DELETE', table, where };
  }

  // ── CREATE TABLE / VIEW / INDEX ──
  parseCreate(): Extract<SqlStatement, { type: 'CREATE_TABLE' | 'CREATE_VIEW' | 'CREATE_INDEX' }> {
    const startPos = this.pos;
    this.expect(TT.KEYWORD, 'CREATE');
    const unique = !!this.matchKw('UNIQUE');
    if (this.matchKw('VIEW')) {
      const ine = !!(this.matchKw('IF') && this.matchKw('NOT') && this.matchKw('EXISTS'));
      return this.parseCreateView(ine, startPos);
    }
    if (this.matchKw('INDEX')) {
      return this.parseCreateIndex(unique);
    }
    this.expect(TT.KEYWORD, 'TABLE');
    const ifNotExists = !!(this.matchKw('IF') && this.matchKw('NOT') && this.matchKw('EXISTS'));
    const name = this.identifier();
    this.expect(TT.LPAREN);
    const columns: ColumnDefinition[] = [];
    const constraints: TableConstraint[] = [];
    while (this.peek().type !== TT.RPAREN) {
      if (this.isKw('PRIMARY') || this.isKw('FOREIGN') || this.isKw('UNIQUE') || this.isKw('CONSTRAINT')) {
        constraints.push(this.parseTableConstraint());
      } else {
        columns.push(this.parseColumnDef());
      }
      if (!this.match(TT.COMMA)) break;
      if (this.peek().type === TT.RPAREN) break;
    }
    this.expect(TT.RPAREN);
    return { type: 'CREATE_TABLE', name, ifNotExists, columns, constraints };
  }

  parseColumnDef(): ColumnDefinition {
    const name = this.identifier();
    const dataType = this.parseDataType();
    const constraints: ColumnConstraint[] = [];
    while (true) {
      if (this.matchKw('PRIMARY')) {
        this.expect(TT.KEYWORD, 'KEY');
        const ai = !!(this.matchKw('AUTOINCREMENT') || this.matchKw('AUTO_INCREMENT'));
        constraints.push({ type: 'PRIMARY_KEY', autoincrement: ai });
      } else if (this.matchKw('NOT')) {
        this.expect(TT.KEYWORD, 'NULL');
        constraints.push({ type: 'NOT_NULL' });
      } else if (this.matchKw('UNIQUE')) {
        constraints.push({ type: 'UNIQUE' });
      } else if (this.matchKw('DEFAULT')) {
        constraints.push({ type: 'DEFAULT', value: this.parseExpr() });
      } else if (this.matchKw('REFERENCES')) {
        const refTable = this.identifier();
        let refCol: string | null = null;
        if (this.match(TT.LPAREN)) { refCol = this.identifier(); this.expect(TT.RPAREN); }
        let onDelete: ReferentialAction = 'NO ACTION';
        let onUpdate: ReferentialAction = 'NO ACTION';
        while (this.matchKw('ON')) {
          const action = this.next().value;
          const rule = this._parseFKAction();
          if (action === 'DELETE') onDelete = rule; else onUpdate = rule;
        }
        constraints.push({ type: 'FOREIGN_KEY', refTable, refCol, onDelete, onUpdate });
      } else if (this.matchKw('AUTOINCREMENT') || this.matchKw('AUTO_INCREMENT')) {
        constraints.push({ type: 'AUTOINCREMENT' });
      } else break;
    }
    return { name, dataType, constraints };
  }

  parseDataType(): ColumnDefinition['dataType'] {
    const name = this.identifier();
    let size: TokenValue = null;
    if (this.match(TT.LPAREN)) {
      size = this.next().value;
      this.match(TT.COMMA) && this.next();
      this.expect(TT.RPAREN);
    }
    return { name: name.toUpperCase(), size };
  }

  // Parses a referential action: CASCADE | RESTRICT | SET NULL | SET DEFAULT | NO ACTION
  _parseFKAction(): ReferentialAction {
    if (this.matchKw('CASCADE')) return 'CASCADE';
    if (this.matchKw('RESTRICT')) return 'RESTRICT';
    if (this.matchKw('NO')) { this.matchKw('ACTION'); return 'NO ACTION'; }
    if (this.matchKw('SET')) {
      if (this.matchKw('NULL')) return 'SET NULL';
      if (this.matchKw('DEFAULT')) return 'SET DEFAULT';
      return 'SET NULL'; // fallback
    }
    return 'NO ACTION';
  }

  parseTableConstraint(): TableConstraint {
    this.matchKw('CONSTRAINT') && this.identifier();
    if (this.matchKw('PRIMARY')) {
      this.expect(TT.KEYWORD, 'KEY');
      this.expect(TT.LPAREN);
      const cols = [this.identifier()];
      while (this.match(TT.COMMA)) cols.push(this.identifier());
      this.expect(TT.RPAREN);
      return { type: 'PRIMARY_KEY', columns: cols };
    }
    if (this.matchKw('FOREIGN')) {
      this.expect(TT.KEYWORD, 'KEY');
      this.expect(TT.LPAREN);
      const col = this.identifier();
      this.expect(TT.RPAREN);
      this.expect(TT.KEYWORD, 'REFERENCES');
      const refTable = this.identifier();
      this.expect(TT.LPAREN);
      const refCol = this.identifier();
      this.expect(TT.RPAREN);
      let onDelete: ReferentialAction = 'NO ACTION';
      let onUpdate: ReferentialAction = 'NO ACTION';
      while (this.matchKw('ON')) {
        const action = this.next().value; // DELETE or UPDATE
        const rule = this._parseFKAction();
        if (action === 'DELETE') onDelete = rule;
        else onUpdate = rule;
      }
      return { type: 'FOREIGN_KEY', col, refTable, refCol, onDelete, onUpdate };
    }
    if (this.matchKw('UNIQUE')) {
      this.expect(TT.LPAREN);
      const cols: string[] = [this.identifier()];
      while (this.match(TT.COMMA)) cols.push(this.identifier());
      this.expect(TT.RPAREN);
      return { type: 'UNIQUE', columns: cols };
    }
    throw new Error('Unknown constraint');
  }

  // ── CREATE VIEW ──
  parseCreateView(ifNotExists: boolean, startPos: number): Extract<SqlStatement, { type: 'CREATE_VIEW' }> {
    const name = this.identifier();
    this.expect(TT.KEYWORD, 'AS');
    const query = this.parseSelect();
    const _originalSql = this.tokens
      .slice(startPos ?? 0, this.pos)
      .map(t => t.raw || t.value)
      .filter(v => v != null)
      .join(' ')
      .trim();
    return { type: 'CREATE_VIEW', name, ifNotExists, query, _originalSql };
  }

  // ── CREATE INDEX ──
  parseCreateIndex(unique: boolean): Extract<SqlStatement, { type: 'CREATE_INDEX' }> {
    this.matchKw('INDEX');
    const ifNotExists = !!(this.matchKw('IF') && this.matchKw('NOT') && this.matchKw('EXISTS'));
    const name = this.identifier();
    this.expect(TT.KEYWORD, 'ON');
    const table = this.identifier();
    this.expect(TT.LPAREN);
    const cols = [this.identifier()];
    while (this.match(TT.COMMA)) cols.push(this.identifier());
    this.expect(TT.RPAREN);
    return { type: 'CREATE_INDEX', name, table, cols, unique, ifNotExists };
  }

  // ── DROP ──
  parseDrop(): Extract<SqlStatement, { type: 'DROP_TABLE' | 'DROP_VIEW' | 'DROP_INDEX' }> {
    this.expect(TT.KEYWORD, 'DROP');
    if (this.matchKw('VIEW')) {
      const ifExists = !!(this.matchKw('IF') && this.matchKw('EXISTS'));
      const name = this.identifier();
      return { type: 'DROP_VIEW', name, ifExists };
    }
    if (this.matchKw('INDEX')) {
      const ifExists = !!(this.matchKw('IF') && this.matchKw('EXISTS'));
      const name = this.identifier();
      return { type: 'DROP_INDEX', name, ifExists };
    }
    this.expect(TT.KEYWORD, 'TABLE');
    const ifExists = !!(this.matchKw('IF') && this.matchKw('EXISTS'));
    const name = this.identifier();
    return { type: 'DROP_TABLE', name, ifExists };
  }

  // ── ALTER ──
  parseAlter(): Extract<SqlStatement, { type: 'ALTER_ADD_COLUMN' | 'ALTER_MODIFY_COLUMN' | 'ALTER_DROP_COLUMN' | 'ALTER_RENAME_TABLE' | 'ALTER_RENAME_COLUMN' }> {
    this.expect(TT.KEYWORD, 'ALTER');
    this.expect(TT.KEYWORD, 'TABLE');
    const table = this.identifier();
    if (this.matchKw('ADD')) {
      this.matchKw('COLUMN');
      const col = this.parseColumnDef();
      return { type: 'ALTER_ADD_COLUMN', table, column: col };
    }
    if (this.matchKw('DROP')) {
      this.matchKw('COLUMN');
      const col = this.identifier();
      return { type: 'ALTER_DROP_COLUMN', table, column: col };
    }
    if (this.matchKw('RENAME')) {
      if (this.matchKw('TO')) {
        const newName = this.identifier();
        return { type: 'ALTER_RENAME_TABLE', table, newName };
      }
      this.matchKw('COLUMN');
      const from = this.identifier();
      this.expect(TT.KEYWORD, 'TO');
      const to = this.identifier();
      return { type: 'ALTER_RENAME_COLUMN', table, from, to };
    }
    if (this.matchKw('MODIFY') || this.matchKw('ALTER')) {
      this.matchKw('COLUMN');
      const col = this.parseColumnDef();
      return { type: 'ALTER_MODIFY_COLUMN', table, column: col };
    }
    throw new Error('Unknown ALTER clause');
  }

  // ── TRUNCATE ──
  parseTruncate(): Extract<SqlStatement, { type: 'TRUNCATE' }> {
    this.expect(TT.KEYWORD, 'TRUNCATE');
    this.matchKw('TABLE');
    const table = this.identifier();
    return { type: 'TRUNCATE', table };
  }

  // ── SHOW ──
  parseShow(): Extract<SqlStatement, { type: 'SHOW_TABLES' | 'SHOW_DATABASES' }> {
    this.expect(TT.KEYWORD, 'SHOW');
    if (this.matchKw('TABLES')) return { type: 'SHOW_TABLES' };
    if (this.matchKw('DATABASES')) return { type: 'SHOW_DATABASES' };
    throw new Error('Unknown SHOW');
  }

  // ── DESCRIBE ──
  parseDescribe(): Extract<SqlStatement, { type: 'DESCRIBE' }> {
    this.next();
    const table = this.identifier();
    return { type: 'DESCRIBE', table };
  }

  // ── PRAGMA ──
  parsePragma(): Extract<SqlStatement, { type: 'PRAGMA' }> {
    this.expect(TT.KEYWORD, 'PRAGMA');
    const name = this.identifier();
    let arg: string | null = null;
    if (this.match(TT.LPAREN)) { arg = this.identifier(); this.expect(TT.RPAREN); }
    else if (this.match(TT.EQ)) { arg = this.identifier(); }
    return { type: 'PRAGMA', name, arg };
  }

  // ── ROLLBACK / SAVEPOINT / RELEASE ──
  parseRollback(): Extract<SqlStatement, { type: 'ROLLBACK' | 'ROLLBACK_TO' }> {
    this.expect(TT.KEYWORD, 'ROLLBACK');
    this.matchKw('TRANSACTION');
    if (this.matchKw('TO')) {
      this.matchKw('SAVEPOINT');
      const name = this.identifier();
      return { type: 'ROLLBACK_TO', name };
    }
    return { type: 'ROLLBACK' };
  }

  parseSavepoint(): Extract<SqlStatement, { type: 'SAVEPOINT' }> {
    this.expect(TT.KEYWORD, 'SAVEPOINT');
    const name = this.identifier();
    return { type: 'SAVEPOINT', name };
  }

  parseRelease(): Extract<SqlStatement, { type: 'RELEASE' }> {
    this.expect(TT.KEYWORD, 'RELEASE');
    this.matchKw('SAVEPOINT');
    const name = this.identifier();
    return { type: 'RELEASE', name };
  }

  // ── EXPLAIN ──
  parseExplain(): Extract<SqlStatement, { type: 'EXPLAIN' }> {
    this.expect(TT.KEYWORD, 'EXPLAIN');
    this.matchKw('ANALYZE');
    const stmt = this.parseStatement();
    return { type: 'EXPLAIN', stmt };
  }

  // ── WITH (CTE) ──
  parseWith(): Extract<SqlStatement, { type: 'WITH' }> {
    this.expect(TT.KEYWORD, 'WITH');
    const recursive = !!this.matchKw('RECURSIVE');
    const ctes: Array<{ name: string; query: SelectStatement }> = [];
    do {
      const name = this.identifier();
      this.matchKw('AS'); // WITH name AS (...) — AS is standard but optional here
      this.expect(TT.LPAREN);
      const query = this.parseSelect();
      this.expect(TT.RPAREN);
      ctes.push({ name, query });
    } while (this.match(TT.COMMA));
    const stmt = this.parseStatement();
    return { type: 'WITH', recursive, ctes, stmt };
  }

  // ── Expression parser (Pratt) ──────────────────────────────────────────────

  parseExpr(minPrec = 0): SqlExpr {
    let left = this.parseUnary();
    while (true) {
      const op = this.getBinaryOp();
      if (!op || op.prec < minPrec) break;
      this.pos += (op.skip || 1);
      if (op.op === 'BETWEEN') {
        const lo = this.parseExpr(op.prec + 1);
        this.expect(TT.KEYWORD, 'AND');
        const hi = this.parseExpr(op.prec + 1);
        left = { type: 'BETWEEN', expr: left, lo, hi };
        continue;
      }
      if (op.op === 'IN') {
        this.expect(TT.LPAREN);
        if (this.isKw('SELECT')) {
          const query = this.parseSelect();
          this.expect(TT.RPAREN);
          left = { type: 'IN', expr: left, subquery: query };
          continue;
        }
        const vals: SqlExpr[] = [this.parseExpr()];
        while (this.match(TT.COMMA)) vals.push(this.parseExpr());
        this.expect(TT.RPAREN);
        left = { type: 'IN', expr: left, values: vals };
        continue;
      }
      if (op.op === 'NOT IN') {
        this.expect(TT.LPAREN);
        if (this.isKw('SELECT')) {
          const query = this.parseSelect();
          this.expect(TT.RPAREN);
          left = { type: 'NOT_IN', expr: left, subquery: query };
          continue;
        }
        const vals: SqlExpr[] = [this.parseExpr()];
        while (this.match(TT.COMMA)) vals.push(this.parseExpr());
        this.expect(TT.RPAREN);
        left = { type: 'NOT_IN', expr: left, values: vals };
        continue;
      }
      if (op.op === 'IS NULL') { left = { type: 'IS_NULL', expr: left }; continue; }
      if (op.op === 'IS NOT NULL') { left = { type: 'IS_NOT_NULL', expr: left }; continue; }
      const right = this.parseExpr(op.prec + (op.right ? 0 : 1));
      left = { type: 'BINOP', op: op.op, left, right };
    }
    return left;
  }

  getBinaryOp(): { op: string; prec: number; skip?: number; right?: boolean } | null {
    const t = this.peek(), n = this.tokens[this.pos + 1];
    if (t.type === TT.KEYWORD && t.value === 'IS') {
      if (n?.type === TT.KEYWORD && n?.value === 'NOT' && this.tokens[this.pos + 2]?.value === 'NULL')
        return { op: 'IS NOT NULL', prec: 7, skip: 3 };
      if (n?.type === TT.KEYWORD && n?.value === 'NULL') return { op: 'IS NULL', prec: 7, skip: 2 };
    }
    if (t.type === TT.KEYWORD && t.value === 'NOT' && n?.value === 'IN') return { op: 'NOT IN', prec: 7, skip: 2 };
    const MAP = {
      [TT.EQ]: { op: '=', prec: 7 }, [TT.NEQ]: { op: '!=', prec: 7 },
      [TT.LT]: { op: '<', prec: 7 }, [TT.LTE]: { op: '<=', prec: 7 },
      [TT.GT]: { op: '>', prec: 7 }, [TT.GTE]: { op: '>=', prec: 7 },
      [TT.PLUS]: { op: '+', prec: 11 }, [TT.MINUS]: { op: '-', prec: 11 },
      [TT.STAR]: { op: '*', prec: 12 }, [TT.SLASH]: { op: '/', prec: 12 },
      [TT.PERCENT]: { op: '%', prec: 12 },
      [TT.CONCAT]: { op: '||', prec: 10 },
    };
    if (MAP[t.type]) return MAP[t.type];
    if (t.type === TT.KEYWORD) {
      if (t.value === 'AND') return { op: 'AND', prec: 5 };
      if (t.value === 'OR') return { op: 'OR', prec: 4 };
      if (t.value === 'LIKE') return { op: 'LIKE', prec: 7 };
      if (t.value === 'ILIKE') return { op: 'ILIKE', prec: 7 };
      if (t.value === 'NOT') return null;
      if (t.value === 'IN') return { op: 'IN', prec: 7 };
      if (t.value === 'BETWEEN') return { op: 'BETWEEN', prec: 7 };
    }
    return null;
  }

  parseUnary(): SqlExpr {
    if (this.match(TT.KEYWORD, 'NOT')) { return { type: 'NOT', expr: this.parseUnary() }; }
    if (this.match(TT.MINUS)) { return { type: 'NEG', expr: this.parseUnary() }; }
    return this.parsePrimary();
  }

  parsePrimary(): SqlExpr {
    const t = this.peek();

    // Literals
    if (t.type === TT.NUMBER) { this.pos++; return { type: 'LIT', value: t.value }; }
    if (t.type === TT.STRING) { this.pos++; return { type: 'LIT', value: t.value }; }
    if (t.type === TT.KEYWORD && t.value === 'NULL') { this.pos++; return { type: 'LIT', value: null }; }
    if (t.type === TT.KEYWORD && t.value === 'TRUE') { this.pos++; return { type: 'LIT', value: true }; }
    if (t.type === TT.KEYWORD && t.value === 'FALSE') { this.pos++; return { type: 'LIT', value: false }; }

    // Aggregate functions
    const AGG: readonly string[] = ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'];
    if (t.type === TT.KEYWORD && typeof t.value === 'string' && AGG.includes(t.value)) {
      const fn = t.value as 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX'; this.pos++;
      this.expect(TT.LPAREN);
      const distinct = !!this.matchKw('DISTINCT');
      let arg: SqlExpr;
      if (this.match(TT.STAR)) arg = { type: 'STAR' };
      else arg = this.parseExpr();
      this.expect(TT.RPAREN);
      return { type: 'AGG', fn, distinct, arg };
    }

    // COALESCE
    if (t.type === TT.KEYWORD && t.value === 'COALESCE') {
      this.pos++; this.expect(TT.LPAREN);
      const args: SqlExpr[] = [this.parseExpr()];
      while (this.match(TT.COMMA)) args.push(this.parseExpr());
      this.expect(TT.RPAREN);
      return { type: 'COALESCE', args };
    }

    // CASE
    if (t.type === TT.KEYWORD && t.value === 'CASE') {
      this.pos++;
      // Simple CASE: CASE expr WHEN val THEN result ...
      // Searched CASE: CASE WHEN cond THEN result ...
      const baseExpr = this.isKw('WHEN') || this.isKw('ELSE') || this.isKw('END') ? null : this.parseExpr();
      const branches: Array<{ cond: SqlExpr; val: SqlExpr }> = [];
      while (this.matchKw('WHEN')) {
        const cond = this.parseExpr();
        this.expect(TT.KEYWORD, 'THEN');
        const val = this.parseExpr();
        branches.push({ cond, val });
      }
      const else_ = this.matchKw('ELSE') ? this.parseExpr() : null;
      this.expect(TT.KEYWORD, 'END');
      return { type: 'CASE', baseExpr: baseExpr || null, branches, else_ };
    }

    // Subexpr or subquery
    if (t.type === TT.LPAREN) {
      this.pos++;
      // Peek ahead — if it's SELECT it's a subquery
      if (this.isKw('SELECT')) {
        const query = this.parseSelect();
        this.expect(TT.RPAREN);
        return { type: 'SUBQUERY', query };
      }
      const e = this.parseExpr(); this.expect(TT.RPAREN); return e;
    }

    // Column ref: table.col or col
    if (t.type === TT.IDENT || t.type === TT.KEYWORD) {
      this.pos++;
      const name = t.raw ?? String(t.value);
      if (this.match(TT.DOT)) {
        const col = this.identifier();
        // Could be a function call
        if (this.match(TT.LPAREN)) {
          const args: SqlExpr[] = [];
          if (!this.match(TT.RPAREN)) {
            args.push(this.parseExpr());
            while (this.match(TT.COMMA)) args.push(this.parseExpr());
            this.expect(TT.RPAREN);
          }
          return { type: 'FUNC', name: `${name}.${col}`, args };
        }
        return { type: 'COL', table: name, col };
      }
      // Function call
      if (this.match(TT.LPAREN)) {
        const args: SqlExpr[] = [];
        if (!this.match(TT.RPAREN)) {
          if (this.match(TT.STAR)) args.push({ type: 'STAR' });
          else args.push(this.parseExpr());
          while (this.match(TT.COMMA)) args.push(this.parseExpr());
          this.expect(TT.RPAREN);
        }
        return { type: 'FUNC', name: name.toUpperCase(), args };
      }
      return { type: 'COL', table: null, col: name };
    }

    throw new Error(`Unexpected token in expression: '${t.value}'`);
  }
}

// ── Executor ───────────────────────────────────────────────────────────────────

class MotionDBEngine {
  schema: DbSchema;
  _txStack: Array<{ name: string | null; snapshot: DbSchema }> = [];
  _inTx = false;
  _dirty = false;
  _lastInsertRowId: unknown = null;
  _lastChangeCount = 0;

  constructor() {
    // schema: { tableName: { columns:[{name,type,pk,ai,notNull,unique,default,fk}], rows:[], seq:0 } }
    this.schema = {};
  }

  // ── Public: execute SQL string ─────────────────────────────────────────────

  exec(sql: string): SqlResult[] {
    const tokens = tokenize(sql);
    const parser = new Parser(tokens);
    const stmts = parser.parse();
    const results: SqlResult[] = [];
    const WRITES = new Set(['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'CREATE_TABLE', 'DROP_TABLE',
      'ALTER_ADD_COLUMN', 'ALTER_DROP_COLUMN', 'ALTER_RENAME_TABLE', 'ALTER_RENAME_COLUMN',
      'ALTER_MODIFY_COLUMN', 'CREATE_VIEW', 'DROP_VIEW', 'CREATE_INDEX', 'DROP_INDEX', 'COMMIT', 'RELEASE']);
    const effectiveStatement = (stmt: SqlStatement): SqlStatement => stmt.type === 'WITH' ? effectiveStatement(stmt.stmt) : stmt;
    const knownNoop = (stmt: SqlStatement): boolean => {
      if (stmt.type === 'CREATE_TABLE') return Boolean(stmt.ifNotExists && this.schema[stmt.name.toLowerCase()]);
      if (stmt.type === 'CREATE_VIEW') return Boolean(stmt.ifNotExists && this.schema.__views__?.[stmt.name.toLowerCase()]);
      if (stmt.type === 'CREATE_INDEX') {
        const table = this.schema[stmt.table.toLowerCase()];
        return Boolean(stmt.ifNotExists && isDbTable(table) && table.indexes?.[stmt.name]);
      }
      return false;
    };
    // Treat a multi-statement batch atomically when it is executed outside an
    // explicit transaction. A later execution error must not leave successful
    // earlier statements applied only in memory.
    const batchSnapshot = !this._inTx && stmts.some(s => { const inner = effectiveStatement(s); return WRITES.has(inner.type) && !knownNoop(inner); })
      ? this._snapshot()
      : null;
    for (const stmt of stmts) {
      try {
        results.push(this.execStmt(stmt));
      } catch (e) {
        if (this._inTx) {
          this._doRollback();
          throw new Error(`${errorMessage(e)}\n[Transaction automatically rolled back]`);
        }
        if (batchSnapshot) this.schema = batchSnapshot;
        throw e;
      }
    }
    // IF NOT EXISTS / IF EXISTS statements that find the requested schema
    // state are reads in practice.  Do not rewrite the entire database file
    // for those no-ops; embedded widgets commonly use them as bootstraps.
    const mutated = stmts.some((stmt, index) => {
      if (!WRITES.has(effectiveStatement(stmt).type)) return false;
      const result = results[index];
      const message = result?.type === 'ok' ? String(result.message || '') : '';
      return !/\b(?:already exists|does not exist)\b/i.test(message);
    });
    if (!this._inTx && mutated) this._dirty = true;
    return results;
  }

  execStmt(stmt: SqlStatement): SqlResult {
    switch (stmt.type) {
      case 'SELECT': return this.execSelect(stmt);
      case 'INSERT': return this.execInsert(stmt);
      case 'UPDATE': return this.execUpdate(stmt);
      case 'DELETE': return this.execDelete(stmt);
      case 'CREATE_TABLE': return this.execCreateTable(stmt);
      case 'DROP_TABLE': return this.execDropTable(stmt);
      case 'ALTER_ADD_COLUMN': return this.execAlterAdd(stmt);
      case 'ALTER_DROP_COLUMN': return this.execAlterDrop(stmt);
      case 'ALTER_RENAME_TABLE': return this.execAlterRenameTable(stmt);
      case 'ALTER_RENAME_COLUMN': return this.execAlterRenameColumn(stmt);
      case 'ALTER_MODIFY_COLUMN': return this.execAlterModify(stmt);
      case 'TRUNCATE': return this.execTruncate(stmt);
      case 'SHOW_TABLES': return this.execShowTables();
      case 'CREATE_VIEW': return this.execCreateView(stmt);
      case 'DROP_VIEW': return this.execDropView(stmt);
      case 'CREATE_INDEX': return this.execCreateIndex(stmt);
      case 'DROP_INDEX': return this.execDropIndex(stmt);
      case 'BEGIN': return this.execBegin();
      case 'COMMIT': return this.execCommit();
      case 'ROLLBACK': return this.execRollback();
      case 'SAVEPOINT': return this.execSavepoint(stmt);
      case 'RELEASE': return this.execRelease(stmt);
      case 'ROLLBACK_TO': return this.execRollbackTo(stmt);
      case 'EXPLAIN': return this.execExplain(stmt);
      case 'WITH': return this.execWith(stmt);
      case 'SHOW_DATABASES': return { type: 'rows', columns: ['Database'], rows: [['motion_db']] };
      case 'DESCRIBE': return this.execDescribe(stmt);
      case 'PRAGMA': return this.execPragma(stmt);
      default: throw new Error('Unimplemented SQL statement.');
    }
  }

  // ── CREATE TABLE ──────────────────────────────────────────────────────────

  execCreateTable(stmt: Extract<SqlStatement, { type: 'CREATE_TABLE' }>): SqlResult {
    const name = stmt.name.toLowerCase();
    if (this.schema[name]) {
      if (stmt.ifNotExists) return { type: 'ok', message: `Table '${name}' already exists.` };
      throw new Error(`Table '${name}' already exists.`);
    }

    const columns = stmt.columns.map(cd => {
      const col = {
        name: cd.name.toLowerCase(),
        type: this.normalizeType(cd.dataType.name),
        pk: false, ai: false, notNull: false, unique: false,
        default: undefined, fk: null,
      };
      for (const c of cd.constraints) {
        if (c.type === 'PRIMARY_KEY') { col.pk = true; col.ai = c.autoincrement; col.notNull = true; }
        if (c.type === 'AUTOINCREMENT') { col.ai = true; }
        if (c.type === 'NOT_NULL') { col.notNull = true; }
        if (c.type === 'UNIQUE') { col.unique = true; }
        if (c.type === 'DEFAULT') { col.default = this.evalExpr(c.value, {}); }
        if (c.type === 'FOREIGN_KEY') { col.fk = { table: c.refTable.toLowerCase(), col: (c.refCol || 'id').toLowerCase(), onDelete: c.onDelete || 'NO ACTION', onUpdate: c.onUpdate || 'NO ACTION' }; }
      }
      return col;
    });

    // Table-level constraints
    for (const c of stmt.constraints || []) {
      if (c.type === 'PRIMARY_KEY') {
        c.columns.forEach(cn => { const col = columns.find(x => x.name === cn.toLowerCase()); if (col) { col.pk = true; col.notNull = true; } });
      }
      if (c.type === 'FOREIGN_KEY') {
        const col = columns.find(x => x.name === c.col.toLowerCase());
        if (col) col.fk = { table: c.refTable.toLowerCase(), col: c.refCol.toLowerCase(), onDelete: c.onDelete, onUpdate: c.onUpdate };
      }
      if (c.type === 'UNIQUE') {
        c.columns.forEach(cn => { const col = columns.find(x => x.name === cn.toLowerCase()); if (col) col.unique = true; });
      }
    }

    this.schema[name] = { columns, rows: [], seq: 0 };
    return { type: 'ok', message: `Table '${name}' created.` };
  }

  normalizeType(t: string): string {
    const map: Record<string, string> = {
      'INT': 'INTEGER', 'BIGINT': 'INTEGER', 'SMALLINT': 'INTEGER', 'SERIAL': 'INTEGER',
      'FLOAT': 'REAL', 'DOUBLE': 'REAL', 'NUMERIC': 'REAL',
      'VARCHAR': 'TEXT', 'CHAR': 'TEXT', 'BLOB': 'TEXT',
      'BOOL': 'INTEGER', 'BOOLEAN': 'INTEGER',
    };
    return map[t] || t;
  }

  coerceValue(val: unknown, colType: string): unknown {
    if (val === null || val === undefined) return null;
    switch (colType) {
      case 'INTEGER': {
        if (typeof val === 'boolean') return val ? 1 : 0;
        const n = Number(val);
        return isNaN(n) ? null : Math.trunc(n);
      }
      case 'REAL': {
        const n = Number(val);
        return isNaN(n) ? null : n;
      }
      case 'TEXT': return String(val);
      case 'DATE': return String(val);
      default: return val;
    }
  }

  // ── DROP TABLE ────────────────────────────────────────────────────────────

  execDropTable(stmt: Extract<SqlStatement, { type: 'DROP_TABLE' }>): SqlResult {
    const name = stmt.name.toLowerCase();
    if (!this.schema[name]) {
      if (stmt.ifExists) return { type: 'ok', message: `Table '${name}' does not exist.` };
      throw new Error(`Table '${name}' does not exist.`);
    }
    // Refuse if another table has a FK pointing at this table
    for (const [tname, tbl] of Object.entries(this.schema)) {
      if (tname === name || tname === '__views__') continue;
      if (!isDbTable(tbl)) continue;
      const ref = tbl.columns?.find(c => c.fk?.table === name);
      if (ref) throw new Error(`Cannot drop table '${name}': table '${tname}' has a FOREIGN KEY on column '${ref.name}' that references it. Drop or alter '${tname}' first.`);
    }
    delete this.schema[name];
    return { type: 'ok', message: `Table '${name}' dropped.` };
  }

  // ── ALTER TABLE ───────────────────────────────────────────────────────────

  execAlterAdd(stmt: Extract<SqlStatement, { type: 'ALTER_ADD_COLUMN' }>): SqlResult {
    const tbl = this.getTable(stmt.table);
    const cd = stmt.column;
    const col = {
      name: cd.name.toLowerCase(), type: this.normalizeType(cd.dataType.name),
      pk: false, ai: false, notNull: false, unique: false, default: undefined, fk: null,
    };
    for (const c of cd.constraints) {
      if (c.type === 'NOT_NULL') col.notNull = true;
      if (c.type === 'UNIQUE') col.unique = true;
      if (c.type === 'DEFAULT') col.default = this.evalExpr(c.value, {});
    }
    if (tbl.columns.find(c => c.name === col.name)) throw new Error(`Column '${col.name}' already exists.`);
    tbl.columns.push(col);
    tbl.rows.forEach(r => { r[col.name] = col.default ?? null; });
    return { type: 'ok', message: `Column '${col.name}' added to '${stmt.table.toLowerCase()}'.` };
  }

  execAlterDrop(stmt: Extract<SqlStatement, { type: 'ALTER_DROP_COLUMN' }>): SqlResult {
    const tname = stmt.table.toLowerCase();
    const tbl = this.getTable(tname);
    const cn = stmt.column.toLowerCase();
    const col = tbl.columns.find(c => c.name === cn);
    if (!col) throw new Error(`Column '${cn}' not found.`);
    if (col.pk) throw new Error(`Cannot drop primary key column '${cn}'. Drop the table and recreate it instead.`);
    // Refuse if another table has a FK pointing at this column
    for (const [otherName, otherTbl] of Object.entries(this.schema)) {
      if (otherName === '__views__' || !isDbTable(otherTbl)) continue;
      const ref = otherTbl.columns.find(c => c.fk?.table === tname && c.fk?.col === cn);
      if (ref) throw new Error(`Cannot drop '${cn}': table '${otherName}' has a FOREIGN KEY on '${ref.name}' that references it.`);
    }
    tbl.columns = tbl.columns.filter(c => c.name !== cn);
    tbl.rows.forEach(r => delete r[cn]);
    return { type: 'ok', message: `Column '${cn}' dropped.` };
  }

  execAlterRenameTable(stmt: Extract<SqlStatement, { type: 'ALTER_RENAME_TABLE' }>): SqlResult {
    const old = stmt.table.toLowerCase(), nw = stmt.newName.toLowerCase();
    const table = this.schema[old];
    if (!isDbTable(table)) throw new Error(`Table '${old}' not found.`);
    if (this.schema[nw]) throw new Error(`Table '${nw}' already exists.`);
    this.schema[nw] = table;
    delete this.schema[old];
    // Update any FK references in other tables that pointed at the old name
    for (const tbl of Object.values(this.schema)) {
      if (!isDbTable(tbl)) continue;
      tbl.columns.forEach(c => { if (c.fk?.table === old) c.fk.table = nw; });
    }
    return { type: 'ok', message: `Table renamed to '${nw}'.` };
  }

  execAlterRenameColumn(stmt: Extract<SqlStatement, { type: 'ALTER_RENAME_COLUMN' }>): SqlResult {
    const tname = stmt.table.toLowerCase();
    const tbl = this.getTable(tname);
    const from = stmt.from.toLowerCase(), to = stmt.to.toLowerCase();
    const col = tbl.columns.find(c => c.name === from);
    if (!col) throw new Error(`Column '${from}' not found.`);
    if (from !== to && tbl.columns.some(c => c.name === to)) throw new Error(`Column '${to}' already exists.`);
    col.name = to;
    for (const index of Object.values(tbl.indexes || {})) {
      index.cols = index.cols.map(c => c === from ? to : c);
    }
    // Rebuild each row (rather than delete+reassign) so the renamed key keeps
    // its original position — delete+reassign would otherwise move it to the
    // end of the row's key order, desyncing SELECT * output from the schema.
    tbl.rows.forEach((r, i) => {
      const rebuilt = {};
      for (const k of Object.keys(r)) { rebuilt[k === from ? to : k] = r[k]; }
      tbl.rows[i] = rebuilt;
    });
    // Update any FK references in other tables that pointed at the old column name on this table
    for (const otherTbl of Object.values(this.schema)) {
      if (!isDbTable(otherTbl)) continue;
      otherTbl.columns.forEach(c => { if (c.fk?.table === tname && c.fk.col === from) c.fk.col = to; });
    }
    return { type: 'ok', message: `Column renamed to '${to}'.` };
  }

  execAlterModify(stmt: Extract<SqlStatement, { type: 'ALTER_MODIFY_COLUMN' }>): SqlResult {
    const tbl = this.getTable(stmt.table);
    const cd = stmt.column;
    const col = tbl.columns.find(c => c.name === cd.name.toLowerCase());
    if (!col) throw new Error(`Column '${cd.name}' not found.`);
    col.type = this.normalizeType(cd.dataType.name);
    for (const c of cd.constraints) {
      if (c.type === 'NOT_NULL') col.notNull = true;
      if (c.type === 'UNIQUE') col.unique = true;
      if (c.type === 'DEFAULT') col.default = this.evalExpr(c.value, {});
    }
    return { type: 'ok', message: `Column '${col.name}' modified.` };
  }

  // ── TRUNCATE ──────────────────────────────────────────────────────────────

  execTruncate(stmt: Extract<SqlStatement, { type: 'TRUNCATE' }>): SqlResult {
    const tname = stmt.table.toLowerCase();
    const tbl = this.getTable(tname);
    // Refuse if any other table has FK rows referencing this one
    for (const [otherName, otherTbl] of Object.entries(this.schema)) {
      if (otherName === '__views__' || !isDbTable(otherTbl)) continue;
      for (const col of otherTbl.columns) {
        if (!col.fk || col.fk.table !== tname) continue;
        if (otherTbl.rows.some(r => r[col.name] !== null && r[col.name] !== undefined))
          throw new Error(`FOREIGN KEY constraint failed: cannot truncate '${tname}' — table '${otherName}' has rows referencing it via '${col.name}'.`);
      }
    }
    tbl.rows = []; tbl.seq = 0;
    return { type: 'ok', message: `Table '${tname}' truncated.` };
  }

  // ── INSERT ────────────────────────────────────────────────────────────────

  execInsert(stmt: Extract<SqlStatement, { type: 'INSERT' }>): SqlResult {
    const tbl = this.getTable(stmt.table);
    const cols = stmt.columns ? stmt.columns.map(c => c.toLowerCase()) : tbl.columns.filter(c => !c.ai).map(c => c.name);
    let count = 0;

    for (const valExprs of stmt.rows) {
      if (valExprs.length !== cols.length)
        throw new Error(`Column count mismatch: expected ${cols.length}, got ${valExprs.length}`);

      const row: DbRow = {};
      // Pre-create every column key up front, in schema order, so the row
      // object's own key order (used by SELECT * / DataviewJS output) always
      // matches the declared column order — regardless of which columns the
      // INSERT listed or that the AI value itself is computed later.
      // (AI's actual VALUE is still assigned after the constraint check below,
      // to avoid leaking the seq counter on a failed insert — only its key
      // POSITION is reserved here.)
      tbl.columns.forEach(c => {
        row[c.name] = c.ai ? null : (c.default ?? null);
      });

      cols.forEach((cn, i) => {
        const col = tbl.columns.find(c => c.name === cn);
        if (!col) throw new Error(`Unknown column '${cn}'`);
        row[cn] = this.coerceValue(this.evalExpr(valExprs[i], {}), col.type);
      });

      // Assign AI value only now — after user-supplied values are set but before constraint check.
      // This way a failed constraint does NOT advance the seq counter.
      tbl.columns.forEach(c => {
        if (c.ai && (row[c.name] === null || row[c.name] === undefined)) { row[c.name] = tbl.seq + 1; }
      });

      // Constraints
      this.enforceConstraints(tbl, row, null);
      // Commit the seq increment only after constraints pass.
      // Also sync seq upward if an explicit value was supplied that exceeds current seq
      // (e.g. INSERT INTO t (id,v) VALUES (50,'x') must set seq=50 so next auto gets 51).
      tbl.columns.forEach(c => {
        if (!c.ai) return;
        const v = Number(row[c.name]);
        if (!isNaN(v) && v > tbl.seq) tbl.seq = v;
      });
      tbl.rows.push(row);
      // Track last inserted rowid for LAST_INSERT_ROWID()
      const pkCol = tbl.columns.find(c => c.pk);
      if (pkCol) this._lastInsertRowId = row[pkCol.name];
      count++;
    }
    this._lastChangeCount = count;
    return { type: 'ok', message: `${count} row(s) inserted.`, count };
  }

  // ── UPDATE ────────────────────────────────────────────────────────────────

  private applyRowUpdate(tname: string, tbl: DbTable, row: DbRow, patch: DbRow): void {
    // FK child-reference check / cascade actions when a referenced column value changes
    for (const [otherName, otherTbl] of Object.entries(this.schema)) {
      if (otherName === '__views__' || !isDbTable(otherTbl)) continue;
      for (const col of otherTbl.columns) {
        if (!col.fk || col.fk.table !== tname) continue;
        const oldVal = row[col.fk.col], newVal = patch[col.fk.col];
        if (oldVal === newVal) continue;
        const childRows = otherTbl.rows.filter(r => r[col.name] === oldVal);
        if (!childRows.length) continue;
        const action = (col.fk.onUpdate || 'NO ACTION').toUpperCase();
        if (action === 'CASCADE') {
          childRows.forEach(cr => { cr[col.name] = newVal; });
        } else if (action === 'SET NULL') {
          childRows.forEach(cr => { cr[col.name] = null; });
        } else if (action === 'SET DEFAULT') {
          childRows.forEach(cr => { cr[col.name] = col.default ?? null; });
        } else {
          throw new Error(`FOREIGN KEY constraint failed: cannot update '${tname}.${col.fk.col}' — table '${otherName}' has rows referencing value ${oldVal}`);
        }
      }
    }

    this.enforceConstraints(tbl, patch, row);
    Object.assign(row, patch);
  }

  updateRowByReference(tableName: string, targetRow: DbRow, values: Record<string, unknown>): void {
    const tname = tableName.toLowerCase();
    const tbl = this.getTable(tname);
    if (!tbl.rows.includes(targetRow)) throw new Error('This row is no longer in the table. Refresh and try again.');

    const patch: DbRow = { ...targetRow };
    Object.entries(values).forEach(([name, value]) => {
      const col = tbl.columns.find(column => column.name === name.toLowerCase());
      if (!col) throw new Error(`Unknown column '${name}'`);
      patch[col.name] = this.coerceValue(value, col.type);
    });

    const snapshot = this._snapshot();
    try {
      this.applyRowUpdate(tname, tbl, targetRow, patch);
      this._dirty = true;
      this._lastChangeCount = 1;
    } catch (error) {
      this.schema = snapshot;
      throw error;
    }
  }

  execUpdate(stmt: Extract<SqlStatement, { type: 'UPDATE' }>): SqlResult {
    const tname = stmt.table.toLowerCase();
    const tbl = this.getTable(tname);
    let count = 0;
    tbl.rows.forEach(row => {
      const ctx = this.rowCtx(tname, row);
      if (stmt.where && !this.toBool(this.evalExpr(stmt.where, ctx))) return;
      const patch: DbRow = { ...row };
      stmt.sets.forEach(s => {
        const cn = s.col.toLowerCase();
        const col = tbl.columns.find(c => c.name === cn);
        if (!col) throw new Error(`Unknown column '${cn}'`);
        patch[cn] = this.coerceValue(this.evalExpr(s.val, ctx), col.type);
      });
      this.applyRowUpdate(tname, tbl, row, patch);
      count++;
    });
    this._lastChangeCount = count;
    return { type: 'ok', message: `${count} row(s) updated.`, count };
  }

  // ── DELETE ────────────────────────────────────────────────────────────────

  execDelete(stmt: Extract<SqlStatement, { type: 'DELETE' }>): SqlResult {
    const tname = stmt.table.toLowerCase();
    const tbl = this.getTable(tname);
    const before = tbl.rows.length;

    const toDelete = stmt.where
      ? tbl.rows.filter(row => this.toBool(this.evalExpr(stmt.where, this.rowCtx(tname, row))))
      : tbl.rows.slice();

    // Enforce referential integrity / apply cascade actions for each row being deleted
    for (const row of toDelete) {
      for (const [otherName, otherTbl] of Object.entries(this.schema)) {
        if (otherName === '__views__' || !isDbTable(otherTbl)) continue;
        for (const col of otherTbl.columns) {
          if (!col.fk || col.fk.table !== tname) continue;
          const pkVal = row[col.fk.col];
          if (pkVal === null || pkVal === undefined) continue;
          const childRows = otherTbl.rows.filter(r => r[col.name] === pkVal);
          if (!childRows.length) continue;
          const action = (col.fk.onDelete || 'NO ACTION').toUpperCase();
          if (action === 'CASCADE') {
            // Recursively delete child rows
            const childPkCol = otherTbl.columns.find(c => c.pk);
            if (childPkCol) {
              for (const cr of childRows) {
                this.execDelete({
                  type: 'DELETE', table: otherName,
                  where: { type: 'BINOP', op: '=', left: { type: 'COL', table: null, col: childPkCol.name }, right: { type: 'LIT', value: this.requireSqlScalar(cr[childPkCol.name]) } }
                });
              }
            } else {
              childRows.forEach(cr => { const i = otherTbl.rows.indexOf(cr); if (i !== -1) otherTbl.rows.splice(i, 1); });
            }
          } else if (action === 'SET NULL') {
            childRows.forEach(cr => { cr[col.name] = null; });
          } else if (action === 'SET DEFAULT') {
            childRows.forEach(cr => { cr[col.name] = col.default ?? null; });
          } else {
            // RESTRICT / NO ACTION — block
            throw new Error(`FOREIGN KEY constraint failed: cannot delete from '${tname}' — table '${otherName}' has rows referencing ${tname}(${col.fk.col})=${pkVal}`);
          }
        }
      }
    }

    if (stmt.where) {
      tbl.rows = tbl.rows.filter(row => !this.toBool(this.evalExpr(stmt.where, this.rowCtx(tname, row))));
    } else {
      tbl.rows = [];
    }
    const count = before - tbl.rows.length;
    this._lastChangeCount = count;
    return { type: 'ok', message: `${count} row(s) deleted.`, count };
  }

  // ── SELECT ────────────────────────────────────────────────────────────────

  execSelect(stmt: SelectStatement, outerCtx?: EvalRow): RowsResult {
    // Build working set from FROM + JOINs
    let rows: EvalRow[] = this.buildFromRows(stmt);

    // Attach the outer row context (for correlated subqueries) so COL lookups
    // inside this query can fall through to the enclosing query's scope.
    if (outerCtx) rows = rows.map(r => Object.assign(r, { __outer__: outerCtx }));

    // WHERE
    if (stmt.where) rows = rows.filter(r => this.toBool(this.evalExpr(stmt.where, r)));

    // GROUP BY / aggregates
    const hasAgg = stmt.columns.some(c => isSelectExpressionColumn(c) && this.hasAggregate(c.expr));
    if (stmt.groupBy?.length || hasAgg) {
      rows = this.execGroupBy(stmt, rows);
    } else {
      // ORDER BY must happen BEFORE projection so table.col refs (e.g. p.name) still resolve.
      // Bare identifiers that match a SELECT alias (e.g. computed columns) are resolved
      // back to their source expression first, since the raw joined ctx has no such key.
      if (stmt.orderBy?.length) {
        rows.sort((a, b) => {
          for (const o of stmt.orderBy) {
            let oexpr = o.expr;
            if (oexpr.type === 'COL' && !oexpr.table) {
              const columnName = oexpr.col.toLowerCase();
              const matched = stmt.columns.filter(isSelectExpressionColumn).find(c => c.alias?.toLowerCase() === columnName);
              if (matched) oexpr = matched.expr;
            }
            const va = this.evalExpr(oexpr, a), vb = this.evalExpr(oexpr, b);
            const c = this.cmp(va, vb);
            if (c !== 0) return o.dir === 'DESC' ? -c : c;
          }
          return 0;
        });
      }
      // Now project
      rows = rows.map(ctx => {
        const out: DbRow = {};
        stmt.columns.forEach(c => {
          if (isSelectExpressionColumn(c)) {
            const key = c.alias || this.exprName(c.expr);
            out[key] = this.evalExpr(c.expr, ctx);
          } else {
            Object.assign(out, this.flatCtx(ctx));
          }
        });
        return out;
      });
    }

    // HAVING — re-evaluate aggregates using stored group rows
    if (stmt.having) rows = rows.filter(r => this.toBool(this.evalExpr(stmt.having, r.__grp__?.[0] ?? r, r.__grp__)));

    // Strip __grp__ and build an alias-augmented row so ORDER BY by alias or expression works.
    if (stmt.groupBy?.length || hasAgg) {
      const nonStarCols = stmt.columns.filter(isSelectExpressionColumn);
      rows = rows.map(r => {
        const { __grp__, ...rest } = r;
        // Add alias keys alongside positional keys so ORDER BY `alias` resolves.
        nonStarCols.forEach((c, i) => {
          const alias = c.alias;
          if (alias) rest[alias] = rest[`__col_${i}__`];
        });
        return rest;
      });
    }

    // ORDER BY for aggregate queries. By this point __grp__ has been stripped, so
    // AGG expressions can no longer be re-evaluated directly (evalAgg needs groupRows).
    // Resolve ORDER BY expressions against the already-computed __col_N__ slots instead —
    // by alias first, then by structural match against the SELECT expression itself.
    if ((stmt.groupBy?.length || hasAgg) && stmt.orderBy?.length) {
      const nonStarCols = stmt.columns.filter(isSelectExpressionColumn);
      const resolveAggOrderVal = (expr: SqlExpr, row: DbRow): unknown => {
        if (expr.type === 'COL' && !expr.table) {
          const i = nonStarCols.findIndex(c => c.alias && c.alias.toLowerCase() === expr.col.toLowerCase());
          if (i !== -1) return row[`__col_${i}__`];
        }
        const i = nonStarCols.findIndex(c => JSON.stringify(c.expr) === JSON.stringify(expr));
        if (i !== -1) return row[`__col_${i}__`];
        return this.evalExpr(expr, row);
      };
      rows.sort((a, b) => {
        for (const o of stmt.orderBy) {
          const va = resolveAggOrderVal(o.expr, a), vb = resolveAggOrderVal(o.expr, b);
          const c = this.cmp(va, vb);
          if (c !== 0) return o.dir === 'DESC' ? -c : c;
        }
        return 0;
      });
    }

    // DISTINCT — fast key using null-byte separator
    if (stmt.distinct) {
      const seen = new Set();
      rows = rows.filter(r => {
        const k = Object.values(r).map(v => v === null ? '\x01' : toDisplayString(v)).join('\x00');
        if (seen.has(k)) return false; seen.add(k); return true;
      });
    }

    // OFFSET / LIMIT
    if (stmt.offset) { const n = Number(this.evalExpr(stmt.offset, {})); rows = rows.slice(n); }
    if (stmt.limit) { const n = Number(this.evalExpr(stmt.limit, {})); rows = rows.slice(0, n); }

    const columns = this.resultColumns(stmt.columns, rows[0], stmt.from?.name?.toLowerCase());
    // Rows from execGroupBy use positional __col_N__ keys — use index-based extraction
    // to avoid collisions when two columns share the same generated name (e.g. two
    // unaliased COALESCE or SUM(CASE WHEN...) expressions).
    const usePositional = rows.length > 0 && '__col_0__' in rows[0];
    let result: Extract<SqlResult, { type: 'rows' }> = {
      type: 'rows', columns, rows: rows.map(r =>
        usePositional
          ? columns.map((_, i) => r[`__col_${i}__`] ?? null)
          : columns.map(c => r[c] ?? null)
      )
    };

    // UNION / INTERSECT / EXCEPT
    if (stmt.compound) {
      const right = this.execSelect(stmt.compound.right);
      if (right.type !== 'rows') throw new Error('A compound SELECT must return rows.');
      const lRows = result.rows;
      const rRows = right.rows;
      // Fast row key — null-byte separated, \x01 sentinel for null values
      const rowKey = (row: unknown[]): string => row.map(v => v === null ? '\x01' : toDisplayString(v)).join('\x00');
      if (stmt.compound.op === 'UNION') {
        const combined = [...lRows, ...rRows];
        if (stmt.compound.all) {
          result.rows = combined;
        } else {
    const seen = new Set<string>();
          result.rows = combined.filter(r => { const k = rowKey(r); if (seen.has(k)) return false; seen.add(k); return true; });
        }
      } else if (stmt.compound.op === 'INTERSECT') {
        const rSet = new Set(rRows.map(rowKey));
        result.rows = lRows.filter(r => rSet.has(rowKey(r)));
      } else if (stmt.compound.op === 'EXCEPT') {
        const rSet = new Set(rRows.map(rowKey));
        result.rows = lRows.filter(r => !rSet.has(rowKey(r)));
      }
    }
    return result;
  }

  // ── Extract equi-join keys from an ON expression ──────────────────────────
  // leftAliases is a Set of every alias already present in the accumulated left-hand
  // row set (the base table plus every table joined so far — not just the first one,
  // so third+ joins in a chain can still match their ON clause against any earlier
  // table). Returns [{leftAlias, leftCol, rightCol}] for every a.x = b.y pair, or
  // null if the expression isn't a pure equality / AND-of-equalities.
  _extractEquiKeys(expr: SqlExpr | null, leftAliases: Set<string>, rightAlias: string): EquiJoinKey[] | null {
    if (!expr) return null;
    if (expr.type === 'BINOP' && expr.op === 'AND') {
      const l = this._extractEquiKeys(expr.left, leftAliases, rightAlias);
      const r = this._extractEquiKeys(expr.right, leftAliases, rightAlias);
      if (l && r) return [...l, ...r];
      return null;
    }
    if (expr.type === 'BINOP' && expr.op === '=') {
      const a = expr.left, b = expr.right;
      if (a.type === 'COL' && b.type === 'COL') {
        const at = (a.table || '').toLowerCase(), bt = (b.table || '').toLowerCase();
        // An unqualified column can only be resolved to "the left side" when there's
        // exactly one candidate alias — with 2+ tables already joined it's ambiguous,
        // so we bail out to the nested-loop fallback rather than guess wrong.
        const aIsLeft = (at && leftAliases.has(at)) || (at === '' && leftAliases.size === 1);
        const bIsLeft = (bt && leftAliases.has(bt)) || (bt === '' && leftAliases.size === 1);
        if (aIsLeft && (bt === rightAlias || bt === '')) {
          const resolvedLeft = at || [...leftAliases][0];
          return [{ leftAlias: resolvedLeft, leftCol: a.col.toLowerCase(), rightCol: b.col.toLowerCase() }];
        }
        if (bIsLeft && (at === rightAlias || at === '')) {
          const resolvedLeft = bt || [...leftAliases][0];
          return [{ leftAlias: resolvedLeft, leftCol: b.col.toLowerCase(), rightCol: a.col.toLowerCase() }];
        }
      }
    }
    return null;
  }

  // Resolve a FROM/JOIN reference into a table-like {columns,rows} object.
  // Handles plain table/view names as well as derived tables: (SELECT ...) alias.
  _resolveFromRef(ref: FromRef): DbTable {
    if (ref.subquery) {
      const result = this.execSelect(ref.subquery);
      const cols = result.columns.map(c => ({ name: c, type: 'TEXT', pk: false, ai: false, notNull: false, unique: false, default: undefined, fk: null }));
      const rows = result.rows.map(row => { const r = {}; result.columns.forEach((c, i) => { r[c] = row[i]; }); return r; });
      return { columns: cols, rows, seq: rows.length, _derived: true };
    }
    // FROM clauses use `name`, JOIN clauses use `table` — accept either.
    const tableName = ref.name ?? ref.table;
    if (typeof tableName !== 'string') throw new Error('A table name is required for this query reference.');
    return this.getTable(tableName);
  }

  buildFromRows(stmt: SelectStatement): EvalRow[] {
    const tname = !stmt.from.subquery && typeof stmt.from.name === 'string' ? stmt.from.name.toLowerCase() : null;
    const alias = stmt.from.alias?.toLowerCase() || tname;
    if (!alias) throw new Error('Derived table in FROM clause must have an alias');
    const tbl = this._resolveFromRef(stmt.from);
    let rows: EvalRow[] = tbl.rows.map(r => ({ [alias]: r }));
    // Track alias -> table def so RIGHT/FULL JOIN can build correctly-shaped null rows
    // for the left side even when tables are referenced by alias, not real name.
    const aliasTables: Record<string, DbTable> = { [alias]: tbl };

    for (const join of stmt.joins || []) {
      const jname = !join.subquery && typeof join.table === 'string' ? join.table.toLowerCase() : null;
      const jalias = join.alias?.toLowerCase() || jname;
      if (!jalias) throw new Error('Derived table in JOIN must have an alias');
      const jtbl = this._resolveFromRef(join);
      aliasTables[jalias] = jtbl;
      const result: EvalRow[] = [];

      // Try hash join for equi-join conditions (dramatically faster than nested loop).
      // leftAliases covers every table joined so far (not just the first one) so
      // chained joins (t1 JOIN t2 ON ... JOIN t3 ON t2.x = t3.y) still hash-join.
      const leftAliases = new Set(Object.keys(aliasTables).filter(k => k !== jalias));
      const equiKeys = (join.kind === 'INNER' || join.kind === 'LEFT')
        ? this._extractEquiKeys(join.on, leftAliases, jalias)
        : null;

      if (equiKeys && equiKeys.length && join.kind === 'INNER') {
        // Build hash map on right (join) table
        const hmap = new Map<string, DbRow[]>();
        for (const r of jtbl.rows) {
          const key = equiKeys.map(k => r[k.rightCol] ?? '\x01null').join('\x00');
          if (!hmap.has(key)) hmap.set(key, []);
          hmap.get(key)?.push(r);
        }
        for (const l of rows) {
          const key = equiKeys.map(k => {
            const leftTable = l[k.leftAlias];
            const value = isRecord(leftTable) ? leftTable[k.leftCol] : undefined;
            return value === null || value === undefined ? '\x01null' : String(value);
          }).join('\x00');
          const matches = hmap.get(key) ?? [];
          // Verify any non-equi parts of the ON condition
          for (const r of matches) {
            const ctx = { ...l, [jalias]: r };
            if (!join.on || this.toBool(this.evalExpr(join.on, ctx))) result.push(ctx);
          }
        }
      } else if (equiKeys && equiKeys.length && join.kind === 'LEFT') {
        // Hash left join
        const hmap = new Map<string, DbRow[]>();
        for (const r of jtbl.rows) {
          const key = equiKeys.map(k => r[k.rightCol] ?? '\x01null').join('\x00');
          if (!hmap.has(key)) hmap.set(key, []);
          hmap.get(key)?.push(r);
        }
        for (const l of rows) {
          const key = equiKeys.map(k => {
            const leftTable = l[k.leftAlias];
            const value = isRecord(leftTable) ? leftTable[k.leftCol] : undefined;
            return value === null || value === undefined ? '\x01null' : String(value);
          }).join('\x00');
          const candidates = hmap.get(key) ?? [];
          const matches = candidates.filter(r => this.toBool(this.evalExpr(join.on, { ...l, [jalias]: r })));
          if (matches.length) matches.forEach(r => result.push({ ...l, [jalias]: r }));
          else result.push({ ...l, [jalias]: this.nullRow(jtbl) });
        }
      } else if (join.kind === 'CROSS' || !join.on) {
        for (const l of rows) for (const r of jtbl.rows) result.push({ ...l, [jalias]: r });
      } else if (join.kind === 'LEFT') {
        for (const l of rows) {
          const matches = jtbl.rows.filter(r => this.toBool(this.evalExpr(join.on, { ...l, [jalias]: r })));
          if (matches.length) matches.forEach(r => result.push({ ...l, [jalias]: r }));
          else result.push({ ...l, [jalias]: this.nullRow(jtbl) });
        }
      } else if (join.kind === 'RIGHT') {
        for (const r of jtbl.rows) {
          const matches = rows.filter(l => this.toBool(this.evalExpr(join.on, { ...l, [jalias]: r })));
          if (matches.length) matches.forEach(l => result.push({ ...l, [jalias]: r }));
          else {
            const nullLeft: Record<string, unknown> = {};
            for (const k of Object.keys(rows[0] || {})) {
              const leftTable = aliasTables[k];
              if (leftTable) nullLeft[k] = this.nullRow(leftTable);
            }
            result.push({ ...nullLeft, [jalias]: r });
          }
        }
      } else if (join.kind === 'FULL') {
        const matchedRight = new Set<number>();
        for (const l of rows) {
          const matches = jtbl.rows.filter((r, ri) => { const m = this.toBool(this.evalExpr(join.on, { ...l, [jalias]: r })); if (m) matchedRight.add(ri); return m; });
          if (matches.length) matches.forEach(r => result.push({ ...l, [jalias]: r }));
          else result.push({ ...l, [jalias]: this.nullRow(jtbl) });
        }
        jtbl.rows.forEach((r, ri) => {
          if (!matchedRight.has(ri)) {
            const nullLeft: Record<string, unknown> = {};
            for (const k of Object.keys(rows[0] || {})) {
              const leftTable = aliasTables[k];
              if (leftTable) nullLeft[k] = this.nullRow(leftTable);
            }
            result.push({ ...nullLeft, [jalias]: r });
          }
        });
      } else {
        // Generic nested loop fallback
        for (const l of rows) for (const r of jtbl.rows)
          if (this.toBool(this.evalExpr(join.on, { ...l, [jalias]: r }))) result.push({ ...l, [jalias]: r });
      }
      rows = result;
      // After first join the left alias in subsequent joins may be one of many table aliases;
      // update alias to the join's alias for chained multi-join key extraction
    }
    return rows;
  }

  execGroupBy(stmt: SelectStatement, rows: EvalRow[]): EvalRow[] {
    const groups = new Map<string, EvalRow[]>();
    const sep = '\x00';
    // GROUP BY grp where `grp` is a SELECT ... AS grp alias must group by that
    // column's source expression (e.g. a CASE/computed column), not by a literal
    // column named "grp" that doesn't exist on the row — mirrors the alias
    // resolution ORDER BY already does elsewhere in this file.
    const resolvedGroupBy = (stmt.groupBy || []).map(e => {
      if (e.type === 'COL' && !e.table) {
        const columnName = e.col.toLowerCase();
        const matched = stmt.columns.filter(isSelectExpressionColumn).find(c => c.alias?.toLowerCase() === columnName);
        if (matched) return matched.expr;
      }
      return e;
    });
    rows.forEach(ctx => {
      const key = resolvedGroupBy.map(e => {
        const v = this.evalExpr(e, ctx);
        return v === null ? '\x01null' : String(v);
      }).join(sep);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(ctx);
    });
    if (!groups.size && (stmt.groupBy?.length === 0)) groups.set('', rows);
    const nonStarCols = stmt.columns.filter(isSelectExpressionColumn);
    const out: EvalRow[] = [];
    groups.forEach(grpRows => {
      // Use positional keys (__col_0__, __col_1__, ...) to prevent collisions when
      // two columns share the same generated name (e.g. two COALESCE expressions
      // or two SUM(CASE WHEN ...) columns without aliases).
      const row: EvalRow = {};
      nonStarCols.forEach((c, i) => {
        row[`__col_${i}__`] = this.evalExpr(c.expr, grpRows[0], grpRows);
      });
      row.__grp__ = grpRows;
      out.push(row);
    });
    return out;
  }

  resultColumns(colDefs: SelectColumn[], sampleRow?: Record<string, unknown>, tblName?: string | null): string[] {
    const nonStar = colDefs.filter(isSelectExpressionColumn);
    if (sampleRow) {
      if (colDefs.length === 1 && colDefs[0].type === 'STAR') return Object.keys(sampleRow);
      return nonStar.map(c => c.alias || this.exprName(c.expr));
    }
    if (colDefs.length === 1 && colDefs[0].type === 'STAR') {
      if (tblName) {
        const table = this.schema[tblName];
        if (isDbTable(table)) return table.columns.map(c => c.name);
      }
      return [];
    }
    return nonStar.map(c => c.alias || this.exprName(c.expr));
  }

  // ── SHOW / DESCRIBE / PRAGMA ──────────────────────────────────────────────

  execShowTables(): SqlResult {
    const tables = Object.keys(this.schema).filter(n => n !== '__views__');
    const views = Object.keys(this.schema.__views__ || {});
    const rows = [...tables.map(n => [n, 'TABLE']), ...views.map(n => [n, 'VIEW'])];
    return { type: 'rows', columns: ['Name', 'Type'], rows };
  }

  execShowIndexes(tname: string): SqlResult {
    const tbl = this.getTable(tname);
    const rows = Object.entries(tbl.indexes || {}).map(([name, idx]) => [name, idx.cols.join(','), idx.unique ? 'YES' : 'NO']);
    return { type: 'rows', columns: ['Index', 'Columns', 'Unique'], rows };
  }

  execDescribe(stmt: Extract<SqlStatement, { type: 'DESCRIBE' }>): SqlResult {
    const tbl = this.getTable(stmt.table);
    const columns = ['Field', 'Type', 'Null', 'Key', 'Default', 'Extra'];
    const rows = tbl.columns.map(c => [
      c.name, c.type,
      c.notNull ? 'NO' : 'YES',
      c.pk ? 'PRI' : c.unique ? 'UNI' : c.fk ? 'MUL' : '',
      c.default ?? 'NULL',
      c.ai ? 'auto_increment' : '',
    ]);
    return { type: 'rows', columns, rows };
  }

  execPragma(stmt: Extract<SqlStatement, { type: 'PRAGMA' }>): SqlResult {
    const name = stmt.name.toLowerCase();
    if (name === 'table_info') {
      const tbl = this.getTable(stmt.arg);
      const columns = ['cid', 'name', 'type', 'notnull', 'dflt_value', 'pk'];
      const rows = tbl.columns.map((c, i) => [i, c.name, c.type, c.notNull ? 1 : 0, c.default ?? null, c.pk ? 1 : 0]);
      return { type: 'rows', columns, rows };
    }
    if (name === 'foreign_key_list') {
      const tbl = this.getTable(stmt.arg);
      const columns = ['id', 'seq', 'table', 'from', 'to'];
      const rows = tbl.columns.filter(c => c.fk).map((c, i) => [i, 0, c.fk.table, c.name, c.fk.col]);
      return { type: 'rows', columns, rows };
    }
    return { type: 'rows', columns: ['value'], rows: [[null]] };
  }

  // ── Constraint enforcement ────────────────────────────────────────────────

  enforceUniqueIndex(tbl: DbTable, row: DbRow, oldRow: DbRow | null, index: IndexDefinition) {
    // SQL UNIQUE permits multiple tuples containing NULL.
    if (index.cols.some(c => row[c] === null || row[c] === undefined)) return;
    if (tbl.rows.some(r => r !== oldRow && index.cols.every(c => r[c] === row[c])))
      throw new Error(`UNIQUE constraint failed: '${index.cols.join(', ')}'`);
  }

  enforceConstraints(tbl: DbTable, row: DbRow, oldRow: DbRow | null) {
    for (const index of Object.values(tbl.indexes || {})) {
      if (index.unique) this.enforceUniqueIndex(tbl, row, oldRow, index);
    }
    for (const col of tbl.columns) {
      const val = row[col.name];
      if (col.notNull && (val === null || val === undefined) && !col.ai)
        throw new Error(`NOT NULL constraint failed: '${col.name}'`);
      if ((col.unique || col.pk) && val !== null && val !== undefined) {
        const dup = tbl.rows.find(r => r !== oldRow && r[col.name] === val);
        if (dup) throw new Error(`${col.pk ? 'PRIMARY KEY' : 'UNIQUE'} constraint failed: '${col.name}'`);
      }
      if (col.fk && val !== null && val !== undefined) {
        const ref = this.schema[col.fk.table];
        if (isDbTable(ref) && !ref.rows.find(r => r[col.fk.col] === val))
          throw new Error(`FOREIGN KEY constraint failed: '${col.name}' references ${col.fk.table}(${col.fk.col})`);
      }
    }
  }

  // ── Expression evaluator ──────────────────────────────────────────────────

  evalExpr(expr: SqlExpr, ctx: EvalRow, groupRows?: EvalRow[]): unknown {
    if (!expr) return null;
    switch (expr.type) {
      case 'LIT': return expr.value;
      case 'COL': {
        const tbl = expr.table?.toLowerCase();
        const col = expr.col.toLowerCase();
        // Walk from the current scope outward through __outer__ (set by correlated
        // subquery evaluation) so inner scopes shadow outer scopes, matching SQL rules.
        let c: EvalRow | null = ctx;
        while (c) {
          if (tbl) {
            const tableRow = c[tbl];
            if (isRecord(tableRow)) return tableRow[col] ?? null;
          } else {
            for (const k of Object.keys(c)) {
              if (k === '__outer__') continue;
              const tableRow = c[k];
              if (isRecord(tableRow) && col in tableRow) return tableRow[col];
            }
            // Flat ctx (post-projection rows)
            if (col in c) return c[col] ?? null;
          }
          c = c.__outer__ ?? null;
        }
        return null;
      }
      case 'STAR': return '*';
      case 'NEG': {
        const value = this.evalExpr(expr.expr, ctx, groupRows);
        return value == null ? null : -this.toNum(value);
      }
      case 'NOT': {
        const value = this.evalExpr(expr.expr, ctx, groupRows);
        return value == null ? null : !this.toBool(value);
      }
      case 'BINOP': return this.evalBinop(expr, ctx, groupRows);
      case 'AGG': return this.evalAgg(expr, ctx, groupRows);
      case 'IS_NULL': return this.evalExpr(expr.expr, ctx, groupRows) === null;
      case 'IS_NOT_NULL': return this.evalExpr(expr.expr, ctx, groupRows) !== null;
      case 'BETWEEN': {
        const v = this.evalExpr(expr.expr, ctx, groupRows);
        const lo = this.evalExpr(expr.lo, ctx, groupRows), hi = this.evalExpr(expr.hi, ctx, groupRows);
        const lower = v == null || lo == null ? null : this.cmp(v, lo) >= 0;
        const upper = v == null || hi == null ? null : this.cmp(v, hi) <= 0;
        return lower === false || upper === false ? false : lower == null || upper == null ? null : true;
      }
      case 'IN':
      case 'NOT_IN': {
        const v = this.evalExpr(expr.expr, ctx, groupRows);
        const values = expr.subquery
          ? this.execSelect(expr.subquery, ctx).rows.map(row => row[0])
          : expr.values.map(ve => this.evalExpr(ve, ctx, groupRows));
        let result;
        if (!values.length) result = false;
        else if (v == null) result = null;
        else if (values.some(value => value != null && this.cmp(v, value) === 0)) result = true;
        else result = values.some(value => value == null) ? null : false;
        return expr.type === 'NOT_IN' && result != null ? !result : result;
      }
      case 'COALESCE': {
        for (const a of expr.args) { const v = this.evalExpr(a, ctx, groupRows); if (v !== null && v !== undefined) return v; }
        return null;
      }
      case 'CASE': {
        if (expr.baseExpr) {
          // Simple CASE: CASE base WHEN val THEN result
          const base = this.evalExpr(expr.baseExpr, ctx, groupRows);
          for (const b of expr.branches) {
            const value = this.evalExpr(b.cond, ctx, groupRows);
            if (base != null && value != null && this.cmp(base, value) === 0)
              return this.evalExpr(b.val, ctx, groupRows);
          }
        } else {
          // Searched CASE: CASE WHEN cond THEN result
          for (const b of expr.branches) {
            if (this.toBool(this.evalExpr(b.cond, ctx, groupRows)))
              return this.evalExpr(b.val, ctx, groupRows);
          }
        }
        return expr.else_ ? this.evalExpr(expr.else_, ctx, groupRows) : null;
      }
      case 'SUBQUERY': {
        const result = this.execSelect(expr.query, ctx);
        // Scalar subquery — return first column of first row
        if (result.rows.length === 0) return null;
        return result.rows[0][0] ?? null;
      }
      case 'FUNC': return this.evalFunc(expr, ctx, groupRows);
      default: return null;
    }
  }

  evalBinop(expr: Extract<SqlExpr, { type: 'BINOP' }>, ctx: EvalRow, groupRows?: EvalRow[]): unknown {
    // Preserve UNKNOWN while retaining short-circuit evaluation.
    if (expr.op === 'AND' || expr.op === 'OR') {
      const l = this.evalExpr(expr.left, ctx, groupRows);
      if (expr.op === 'AND' && l != null && !this.toBool(l)) return false;
      if (expr.op === 'OR' && l != null && this.toBool(l)) return true;
      const r = this.evalExpr(expr.right, ctx, groupRows);
      if (expr.op === 'AND' && r != null && !this.toBool(r)) return false;
      if (expr.op === 'OR' && r != null && this.toBool(r)) return true;
      return l == null || r == null ? null : this.toBool(r);
    }

    const l = this.evalExpr(expr.left, ctx, groupRows);
    const r = this.evalExpr(expr.right, ctx, groupRows);
    switch (expr.op) {
      // SQL three-valued logic: any comparison with NULL yields NULL (unknown), not true/false
      case '=': return (l === null || r === null) ? null : l === r;
      case '!=': return (l === null || r === null) ? null : l !== r;
      case '<': return (l === null || r === null) ? null : this.cmp(l, r) < 0;
      case '<=': return (l === null || r === null) ? null : this.cmp(l, r) <= 0;
      case '>': return (l === null || r === null) ? null : this.cmp(l, r) > 0;
      case '>=': return (l === null || r === null) ? null : this.cmp(l, r) >= 0;
      case '+': return (l === null || l === undefined || r === null || r === undefined) ? null : this.toNum(l) + this.toNum(r);
      case '-': return (l === null || l === undefined || r === null || r === undefined) ? null : this.toNum(l) - this.toNum(r);
      case '*': return (l === null || l === undefined || r === null || r === undefined) ? null : this.toNum(l) * this.toNum(r);
      case '/': { if (l === null || l === undefined || r === null || r === undefined) return null; const d = this.toNum(r); return d === 0 ? null : this.toNum(l) / d; }
      case '%': return (l === null || l === undefined || r === null || r === undefined) ? null : this.toNum(l) % this.toNum(r);
      case '||': return l == null || r == null ? null : String(l) + String(r);
      case 'LIKE': return l == null || r == null ? null : this.likeMatch(String(l), String(r), false);
      case 'ILIKE': return l == null || r == null ? null : this.likeMatch(String(l), String(r), true);
      default: return null;
    }
  }

  evalAgg(expr: Extract<SqlExpr, { type: 'AGG' }>, ctx: EvalRow, groupRows: EvalRow[] = []): unknown {
    if (!groupRows) return null;
    // Pass the per-row context WITH groupRows so nested CASE WHEN inside an aggregate
    // can itself call evalExpr on sub-expressions that need the full groupRows context.
    let vals = groupRows.map(r => this.evalExpr(expr.arg, r, groupRows)).filter(v => v !== null && v !== undefined);
    if (expr.distinct) vals = [...new Map(vals.map(v => [JSON.stringify(v), v])).values()];
    switch (expr.fn) {
      case 'COUNT': return expr.arg?.type === 'STAR' ? groupRows.length : vals.length;
      case 'SUM': return vals.length ? vals.reduce<number>((sum, value) => sum + this.toNum(value), 0) : null;
      case 'AVG': return vals.length ? vals.reduce<number>((sum, value) => sum + this.toNum(value), 0) / vals.length : null;
      case 'MIN': return vals.length ? vals.reduce((a, b) => this.cmp(a, b) < 0 ? a : b) : null;
      case 'MAX': return vals.length ? vals.reduce((a, b) => this.cmp(a, b) > 0 ? a : b) : null;
      default: return null;
    }
  }

  evalFunc(expr: Extract<SqlExpr, { type: 'FUNC' }>, ctx: EvalRow, groupRows?: EvalRow[]): unknown {
    const args = expr.args.map(a => this.evalExpr(a, ctx, groupRows));
    switch (expr.name.toUpperCase()) {
      case 'UPPER': return String(args[0] ?? '').toUpperCase();
      case 'LOWER': return String(args[0] ?? '').toLowerCase();
      case 'LENGTH': return String(args[0] ?? '').length;
      case 'TRIM': return String(args[0] ?? '').trim();
      case 'LTRIM': return String(args[0] ?? '').trimStart();
      case 'RTRIM': return String(args[0] ?? '').trimEnd();
      case 'SUBSTR': { const s = String(args[0] ?? ''); const start = Math.max(0, Number(args[1] ?? 1) - 1); return args[2] != null ? s.slice(start, start + Number(args[2])) : s.slice(start); }
      case 'REPLACE': return String(args[0] ?? '').replaceAll(String(args[1] ?? ''), String(args[2] ?? ''));
      case 'ABS': return Math.abs(Number(args[0] ?? 0));
      case 'ROUND': { const places = Number(args[1] ?? 0); return Math.round(Number(args[0] ?? 0) * (10 ** places)) / (10 ** places); }
      case 'FLOOR': return Math.floor(Number(args[0] ?? 0));
      case 'CEIL': return Math.ceil(Number(args[0] ?? 0));
      case 'CEILING': return Math.ceil(Number(args[0] ?? 0));
      case 'POWER': case 'POW': return Math.pow(Number(args[0] ?? 0), Number(args[1] ?? 0));
      case 'SQRT': return Math.sqrt(Number(args[0] ?? 0));
      case 'MOD': return Number(args[0] ?? 0) % Number(args[1] ?? 1);
      case 'SIGN': { const n = Number(args[0] ?? 0); return n > 0 ? 1 : n < 0 ? -1 : 0; }
      case 'GREATEST': return args.slice(1).reduce<unknown>((best, value) => this.cmp(best, value) >= 0 ? best : value, args[0] ?? null);
      case 'LEAST': return args.slice(1).reduce<unknown>((best, value) => this.cmp(best, value) <= 0 ? best : value, args[0] ?? null);
      case 'CONCAT': return args.map(a => a ?? '').join('');
      case 'INSTR': { const s = String(args[0] ?? ''), q = String(args[1] ?? ''); const i = s.indexOf(q); return i === -1 ? 0 : i + 1; }
      case 'LPAD': { const s = String(args[0] ?? ''); const n = Number(args[1] ?? 0); const p = String(args[2] ?? ' '); return s.length >= n ? s : p.repeat(Math.ceil((n - s.length) / p.length)).slice(0, n - s.length) + s; }
      case 'RPAD': { const s = String(args[0] ?? ''); const n = Number(args[1] ?? 0); const p = String(args[2] ?? ' '); return s.length >= n ? s : s + p.repeat(Math.ceil((n - s.length) / p.length)).slice(0, n - s.length); }
      case 'REPEAT': return String(args[0] ?? '').repeat(Math.max(0, Number(args[1] ?? 0)));
      case 'REVERSE': return String(args[0] ?? '').split('').reverse().join('');
      case 'CHAR_LENGTH': case 'CHARACTER_LENGTH': return String(args[0] ?? '').length;
      case 'LEFT': { const s = String(args[0] ?? ''); return s.slice(0, Number(args[1] ?? 0)); }
      case 'RIGHT': { const s = String(args[0] ?? ''); const n = Number(args[1] ?? 0); return n <= 0 ? '' : s.slice(-n); }
      case 'COALESCE': for (const a of args) { if (a !== null && a !== undefined) return a; } return null;
      case 'IFNULL': return args[0] ?? args[1] ?? null;
      case 'NULLIF': return args[0] === args[1] ? null : args[0];
      case 'IIF': case 'IF': return this.toBool(args[0]) ? args[1] : args[2];
      case 'NOW': return new Date().toISOString();
      case 'DATE': { const date = parseSqlDate(args[0]); return date ? date.toISOString().slice(0, 10) : null; }
      case 'STRFTIME': {
        // strftime(format, date) — support common patterns
        if (!args[1]) return null;
        const d = parseSqlDate(args[1]);
        if (!d) return null;
        const fmt = String(args[0] ?? '');
        return fmt.replace('%Y', String(d.getFullYear()))
          .replace('%m', String(d.getMonth() + 1).padStart(2, '0'))
          .replace('%d', String(d.getDate()).padStart(2, '0'))
          .replace('%H', String(d.getHours()).padStart(2, '0'))
          .replace('%M', String(d.getMinutes()).padStart(2, '0'))
          .replace('%S', String(d.getSeconds()).padStart(2, '0'));
      }
      case 'DATE_DIFF': {
        if (!args[0] || !args[1]) return null;
        const first = parseSqlDate(args[0]), second = parseSqlDate(args[1]);
        return first && second ? Math.floor((first.getTime() - second.getTime()) / 86400000) : null;
      }
      case 'DATE_ADD': case 'DATE_SUB': {
        if (!args[0]) return null;
        const d = parseSqlDate(args[0]);
        if (!d) return null;
        const n = Number(args[1] ?? 0) * (expr.name.toUpperCase() === 'DATE_SUB' ? -1 : 1);
        d.setDate(d.getDate() + n);
        return d.toISOString().slice(0, 10);
      }
      case 'TYPEOF': return typeof args[0];
      case 'CAST': return args[0]; // simplified
      case 'LAST_INSERT_ROWID': return this._lastInsertRowId ?? null;
      case 'LAST_INSERT_ID': return this._lastInsertRowId ?? null;
      case 'CHANGES': return this._lastChangeCount ?? 0;
      default: return null;
    }
  }

  likeMatch(str: unknown, pattern: unknown, caseInsensitive = false): boolean {
    const re = String(pattern).replace(/[.+*^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
    return new RegExp(`^${re}$`, caseInsensitive ? 'i' : '').test(String(str));
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  getTable(name: string): DbTable {
    const n = name.toLowerCase();
    const table = this.schema[n];
    if (isDbTable(table)) return table;
    // Check if it's a view — materialise it on the fly
    const view = this.schema.__views__?.[n];
    if (view) {
      const result = this.execSelect(view.query);
      const cols = result.columns.map(c => ({ name: c, type: 'TEXT', pk: false, ai: false, notNull: false, unique: false, default: undefined, fk: null }));
      const rows = result.rows.map(row => { const r = {}; result.columns.forEach((c, i) => { r[c] = row[i]; }); return r; });
      return { columns: cols, rows, seq: rows.length, _view: true };
    }
    throw new Error(`Table '${n}' does not exist.`);
  }

  rowCtx(alias: string, row: DbRow): Record<string, unknown> { return { [alias]: row }; }

  flatCtx(ctx: Record<string, unknown>): DbRow {
    const out = {};
    for (const k of Object.keys(ctx)) {
      if (k === '__outer__') continue;
      if (ctx[k] && typeof ctx[k] === 'object') Object.assign(out, ctx[k]);
    }
    return out;
  }

  nullRow(tbl: DbTable): DbRow {
    const r = {}; tbl.columns.forEach(c => { r[c.name] = null; }); return r;
  }

  hasAggregate(expr: SqlExpr): boolean {
    if (!expr || typeof expr !== 'object') return false;
    if (expr.type === 'AGG') return true;
    return Object.values(expr).some(v => {
      if (Array.isArray(v)) return v.some(x => isSqlExpr(x) && this.hasAggregate(x));
      if (isSqlExpr(v)) return this.hasAggregate(v);
      return false;
    });
  }

  exprName(expr: SqlExpr): string {
    if (expr.type === 'COL') return expr.col;
    if (expr.type === 'AGG') return expr.arg?.type === 'STAR' ? `${expr.fn}(*)` : `${expr.fn}(${this.exprName(expr.arg)})`;
    if (expr.type === 'FUNC') return expr.name;
    if (expr.type === 'LIT') return String(expr.value);
    return 'expr';
  }

  toBool(v: unknown): boolean { return v !== null && v !== undefined && v !== false && v !== 0 && v !== ''; }
  requireSqlScalar(value: unknown): SqlScalar {
    if (!isSqlScalar(value)) throw new Error('A primary key value must be a SQL scalar.');
    return value;
  }
  toNum(v: unknown): number { const n = Number(v); return isNaN(n) ? 0 : n; }

  cmp(a: unknown, b: unknown): number {
    if (a === b) return 0;
    if (a === null || a === undefined) return 1;
    if (b === null || b === undefined) return -1;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return String(a).localeCompare(String(b), undefined, { numeric: true });
  }

  // ── VIEW ─────────────────────────────────────────────────────────────────

  execCreateView(stmt: Extract<SqlStatement, { type: 'CREATE_VIEW' }>): SqlResult {
    const name = stmt.name.toLowerCase();
    if (!this.schema.__views__) this.schema.__views__ = {};
    if (this.schema.__views__[name]) {
      if (stmt.ifNotExists) return { type: 'ok', message: `View '${name}' already exists.` };
      throw new Error(`View '${name}' already exists.`);
    }
    this.schema.__views__[name] = { query: stmt.query, sql: stmt._originalSql || '' };
    return { type: 'ok', message: `View '${name}' created.` };
  }

  execDropView(stmt: Extract<SqlStatement, { type: 'DROP_VIEW' }>): SqlResult {
    const name = stmt.name.toLowerCase();
    if (!this.schema.__views__?.[name]) {
      if (stmt.ifExists) return { type: 'ok', message: `View '${name}' does not exist.` };
      throw new Error(`View '${name}' does not exist.`);
    }
    delete this.schema.__views__[name];
    return { type: 'ok', message: `View '${name}' dropped.` };
  }

  // ── INDEX ─────────────────────────────────────────────────────────────────

  execCreateIndex(stmt: Extract<SqlStatement, { type: 'CREATE_INDEX' }>): SqlResult {
    const tbl = this.getTable(stmt.table);
    if (!tbl.indexes) tbl.indexes = {};
    if (tbl.indexes[stmt.name]) {
      if (stmt.ifNotExists) return { type: 'ok', message: `Index '${stmt.name}' already exists.` };
      throw new Error(`Index '${stmt.name}' already exists.`);
    }
    // Validate columns exist
    stmt.cols.forEach(c => { if (!tbl.columns.find(x => x.name === c.toLowerCase())) throw new Error(`Column '${c}' not found.`); });
    const index = { cols: stmt.cols.map(c => c.toLowerCase()), unique: stmt.unique };
    if (index.unique) {
      for (const row of tbl.rows) this.enforceUniqueIndex(tbl, row, row, index);
    }
    tbl.indexes[stmt.name] = index;
    return { type: 'ok', message: `Index '${stmt.name}' created on '${stmt.table}'.` };
  }

  execDropIndex(stmt: Extract<SqlStatement, { type: 'DROP_INDEX' }>): SqlResult {
    for (const tname of Object.keys(this.schema)) {
      const tbl = this.schema[tname];
      if (!isDbTable(tbl)) continue;
      if (tbl.indexes?.[stmt.name]) {
        delete tbl.indexes[stmt.name];
        return { type: 'ok', message: `Index '${stmt.name}' dropped.` };
      }
    }
    throw new Error(`Index '${stmt.name}' not found.`);
  }

  // ── TRANSACTIONS ─────────────────────────────────────────────────────────
  // Full snapshot/restore semantics:
  //   BEGIN          → deep-clone schema onto a stack frame
  //   COMMIT         → discard the stack frame (changes are kept)
  //   ROLLBACK       → restore schema from top of stack
  //   SAVEPOINT sp   → push another frame onto the stack
  //   RELEASE sp     → merge top frame down (commit to parent)
  //   ROLLBACK TO sp → restore to named frame without ending the transaction

  _snapshot(): DbSchema {
    const snapshot: unknown = JSON.parse(JSON.stringify(this.schema));
    if (!isDbSchema(snapshot)) throw new Error('Database schema could not be cloned safely.');
    return snapshot;
  }

  _doRollback() {
    // A statement error aborts the complete transaction. Savepoint rollback
    // remains available through the explicit ROLLBACK TO command.
    if (this._txStack && this._txStack.length > 0) {
      this.schema = this._txStack[0].snapshot;
    }
    this._txStack = [];
    this._inTx = false;
  }

  execBegin(): SqlResult {
    if (this._inTx) {
      // Nested BEGIN: treat as an implicit SAVEPOINT rather than silently overwriting
      throw new Error('Cannot BEGIN: a transaction is already active. Use SAVEPOINT for nested transactions.');
    }
    this._inTx = true;
    this._txStack = [{ name: null, snapshot: this._snapshot() }];
    return { type: 'ok', message: 'Transaction started.' };
  }

  execCommit(): SqlResult {
    if (!this._inTx) return { type: 'ok', message: 'No active transaction.' };
    this._txStack = [];
    this._inTx = false;
    return { type: 'ok', message: 'Transaction committed.', _committed: true };
  }

  execRollback(): SqlResult {
    if (!this._inTx) return { type: 'ok', message: 'No active transaction.' };
    // Restore to the outermost BEGIN snapshot
    this.schema = this._txStack[0].snapshot;
    this._txStack = [];
    this._inTx = false;
    return { type: 'ok', message: 'Transaction rolled back.', _rolledBack: true };
  }

  execSavepoint(stmt: Extract<SqlStatement, { type: 'SAVEPOINT' }>): SqlResult {
    const name = stmt.name.toLowerCase();
    if (!this._inTx) {
      // Auto-begin if not already in a transaction (matches SQLite behaviour)
      this._inTx = true;
      this._txStack = [];
    }
    if (this._txStack.find(f => f.name === name))
      throw new Error(`Savepoint '${name}' already exists.`);
    this._txStack.push({ name, snapshot: this._snapshot() });
    return { type: 'ok', message: `Savepoint '${name}' set.` };
  }

  execRelease(stmt: Extract<SqlStatement, { type: 'RELEASE' }>): SqlResult {
    const name = stmt.name.toLowerCase();
    const idx = this._txStack.findIndex(f => f.name === name);
    if (idx === -1) throw new Error(`Savepoint '${name}' does not exist.`);
    // Drop this frame and everything above it — changes since the savepoint are kept
    this._txStack.splice(idx);
    // If the stack is now empty we've committed back to the outermost level
    if (this._txStack.length === 0) this._inTx = false;
    return { type: 'ok', message: `Savepoint '${name}' released.` };
  }

  execRollbackTo(stmt: Extract<SqlStatement, { type: 'ROLLBACK_TO' }>): SqlResult {
    const name = stmt.name.toLowerCase();
    const idx = this._txStack.findIndex(f => f.name === name);
    if (idx === -1) throw new Error(`Savepoint '${name}' does not exist.`);
    // Restore schema to that savepoint's snapshot but keep the frame —
    // the transaction is still open, further statements can follow
    const snapshot: unknown = JSON.parse(JSON.stringify(this._txStack[idx].snapshot));
    if (!isDbSchema(snapshot)) throw new Error('Savepoint schema could not be restored safely.');
    this.schema = snapshot;
    // Drop all frames above this one (they are invalidated)
    this._txStack.splice(idx + 1);
    return { type: 'ok', message: `Rolled back to savepoint '${name}'.` };
  }

  // ── EXPLAIN ───────────────────────────────────────────────────────────────

  execExplain(stmt: Extract<SqlStatement, { type: 'EXPLAIN' }>): SqlResult {
    const inner = stmt.stmt;
    const lines: string[][] = [];
    lines.push(['Step', 'Operation', 'Detail']);
    if (inner.type === 'SELECT') {
      lines.push(['1', 'SCAN', `Table: ${inner.from?.name || '?'}`]);
      if (inner.joins?.length) inner.joins.forEach((j, i) => lines.push([String(i + 2), `${j.kind} JOIN`, `Table: ${j.table}`]));
      if (inner.where) lines.push([String(lines.length), 'FILTER', 'WHERE clause']);
      if (inner.groupBy?.length) lines.push([String(lines.length), 'GROUP BY', inner.groupBy.length + ' column(s)']);
      if (inner.orderBy?.length) lines.push([String(lines.length), 'SORT', inner.orderBy.map(o => o.dir).join(', ')]);
      if (inner.limit) lines.push([String(lines.length), 'LIMIT', 'Applied']);
    } else {
      lines.push(['1', inner.type, 'Statement executed']);
    }
    return { type: 'rows', columns: lines[0], rows: lines.slice(1) };
  }

  // ── WITH (CTE) ────────────────────────────────────────────────────────────

  execWith(stmt: Extract<SqlStatement, { type: 'WITH' }>): SqlResult {
    // CTE names shadow persisted tables only for the duration of this query.
    const originals = new Map<string, { exists: boolean; value: DbSchema[string] }>();
    try {
      for (const cte of stmt.ctes) {
        const name = cte.name.toLowerCase();
        const result = this.execSelect(cte.query);
        if (!originals.has(name)) originals.set(name, {
          exists: Object.keys(this.schema).includes(name),
          value: this.schema[name],
        });
        const cols: DbColumn[] = result.columns.map(c => ({ name: c, type: 'TEXT', pk: false, ai: false, notNull: false, unique: false, fk: null }));
        const rows: DbRow[] = result.rows.map(row => Object.fromEntries(result.columns.map((c, i) => [c, row[i]])));
        this.schema[name] = { columns: cols, rows, seq: rows.length, _temp: true };
      }
      return this.execStmt(stmt.stmt);
    } finally {
      for (const [name, original] of originals) {
        if (original.exists) this.schema[name] = original.value;
        else delete this.schema[name];
      }
    }
  }

  // ── Serialize / deserialize ───────────────────────────────────────────────

  serialize(): string { return JSON.stringify(this.schema); }
  deserialize(serialized: string): void {
    const schema: unknown = JSON.parse(serialized);
    if (!isDbSchema(schema)) throw new Error('Database file has an invalid schema.');
    normalizeLegacySelectColumnTags(schema);
    this.schema = schema;
  }
}

function toDisplayString(value: unknown, nullishAsEmpty = false): string {
  if (value === null) return nullishAsEmpty ? '' : 'null';
  if (value === undefined) return nullishAsEmpty ? '' : 'undefined';
  if (Array.isArray(value)) return value.join(',');
  if (value instanceof Date) return value.toString();
  if (typeof value === 'object' || typeof value === 'function' || typeof value === 'symbol') return String(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return 'undefined';
}

function toSqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('SQL parameters cannot contain NaN or Infinity.');
    return String(value);
  }
  if (value instanceof Date) value = value.toISOString();
  if (typeof value === 'object') value = JSON.stringify(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

function bindParameters(sql: string, parameters: unknown[] = []): string {
  if (!sql.includes('$')) return sql;
  let output = '';
  let quote = null;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    const next = sql[i + 1];
    if (lineComment) {
      output += char;
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      output += char;
      if (char === '*' && next === '/') {
        output += next;
        i++;
        blockComment = false;
      }
      continue;
    }
    if (quote) {
      output += char;
      if (char === quote && next === quote) {
        output += next;
        i++;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '-' && next === '-') {
      output += char + next;
      i++;
      lineComment = true;
      continue;
    }
    if (char === '/' && next === '*') {
      output += char + next;
      i++;
      blockComment = true;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      output += char;
      continue;
    }
    if (char === '$' && /[0-9]/.test(next || '')) {
      let end = i + 1;
      while (end < sql.length && /[0-9]/.test(sql[end])) end++;
      const position = Number(sql.slice(i + 1, end));
      if (position < 1 || position > parameters.length) {
        throw new Error(`SQL parameter $${position} was not provided.`);
      }
      output += toSqlLiteral(parameters[position - 1]);
      i = end - 1;
      continue;
    }
    output += char;
  }
  return output;
}

function isReadOnlyStatement(stmt: SqlStatement | undefined): boolean {
  if (!stmt) return false;
  if (['SELECT', 'SHOW_TABLES', 'SHOW_DATABASES', 'DESCRIBE', 'PRAGMA', 'EXPLAIN'].includes(stmt.type)) return true;
  return stmt.type === 'WITH'
    && (stmt.ctes || []).every(cte => cte.query?.type === 'SELECT')
    && isReadOnlyStatement(stmt.stmt);
}

function assertReadOnlyQuery(sql: string): void {
  const statements = new Parser(tokenize(sql)).parse();
  if (statements.length !== 1 || !isReadOnlyStatement(statements[0])) {
    throw new Error('Embedded and Bases queries must contain one read-only statement.');
  }
}

interface MotionDBEmbedConfig {
  database: string;
  table: string;
  sql: string;
  limit: number | null;
  interactive: boolean;
  properties: PropertyFormats;
}

function parseMotionDBEmbedSource(source: string): MotionDBEmbedConfig {
  const lines = String(source ?? '').trim().split(/\r?\n/);
  const options: Record<string, string> = {};
  let sqlStart = lines.length;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    const match = line.match(/^(database|table|limit|interactive|properties|types)\s*:\s*(.*)$/i);
    if (!match) {
      sqlStart = index;
      break;
    }
    const key = match[1].toLowerCase() === 'types' ? 'properties' : match[1].toLowerCase();
    if (options[key] !== undefined) throw new Error(`Duplicate ${key} option in Motion Database embed.`);
    options[key] = match[2].trim();
  }

  const database = options.database || '';
  const table = options.table || '';
  const sql = lines.slice(sqlStart).join('\n').trim();
  if (!database) throw new Error('Add “database: Database name” to the embed.');
  if (table && sql) throw new Error('Use either “table:” or a SQL query in a Motion Database embed, not both.');
  if (!table && !sql) throw new Error('Add “table: Table name” or a read-only SQL query to the embed.');

  let limit: number | null = null;
  if (options.limit !== undefined) {
    if (!table) throw new Error('The “limit:” option can only be used with “table:”. Use SQL LIMIT for queries.');
    if (!/^[1-9]\d*$/.test(options.limit)) throw new Error('The embed limit must be a positive whole number.');
    limit = Number(options.limit);
    if (!Number.isSafeInteger(limit)) throw new Error('The embed limit is too large.');
  }

  let interactive = false;
  if (options.interactive !== undefined) {
    if (!table) throw new Error('The “interactive:” option can only be used with “table:”.');
    if (!/^(true|false)$/i.test(options.interactive)) {
      throw new Error('The “interactive:” option must be true or false.');
    }
    interactive = options.interactive.toLowerCase() === 'true';
  }

  const properties = parseEmbedPropertyFormats(options.properties || '');

  return { database, table, sql, limit, interactive, properties };
}

function parseEmbedPropertyFormats(source: string): PropertyFormats {
  const formats: PropertyFormats = {};
  if (!String(source || '').trim()) return formats;

  String(source).split(';').forEach(entry => {
    const separator = entry.indexOf('=');
    if (separator < 1) {
      throw new Error('Each embed property must use “column=type”, separated with semicolons.');
    }
    const column = entry.slice(0, separator).trim();
    const declaration = entry.slice(separator + 1).trim().toLowerCase();
    if (!column || !declaration) throw new Error('Embed property columns and types cannot be blank.');

    let format: PropertyFormat | null = null;
    if (declaration === 'text' || declaration === 'image' || declaration === 'media' || declaration === 'checkbox') {
      format = { type: declaration };
    } else {
      let match = declaration.match(/^progress(?:\(\s*(\d+(?:\.\d+)?)\s*\))?$/);
      if (match) format = { type: 'progress', max: match[1] ? Number(match[1]) : 100 };
      match = match || declaration.match(/^(stars|hearts|number)(?:\(\s*(\d+(?:\.\d+)?)\s*\))?$/);
      const shorthandStyle = match?.[1];
      if (!format && (shorthandStyle === 'stars' || shorthandStyle === 'hearts' || shorthandStyle === 'number')) {
        format = { type: 'rating', style: shorthandStyle, max: match?.[2] ? Number(match[2]) : 5 };
      }
      match = declaration.match(/^rating\(\s*(stars|hearts|number)(?:\s*,\s*(\d+(?:\.\d+)?))?\s*\)$/);
      const explicitStyle = match?.[1];
      if (!format && (explicitStyle === 'stars' || explicitStyle === 'hearts' || explicitStyle === 'number')) {
        format = { type: 'rating', style: explicitStyle, max: match?.[2] ? Number(match[2]) : 5 };
      }
    }

    if (!format) {
      throw new Error(`Unknown display type “${declaration}” for “${column}”. Use text, image, media, checkbox, progress(max), or rating(stars|hearts|number, max).`);
    }
    if ('max' in format && format.max !== undefined && (!Number.isFinite(format.max) || format.max <= 0)) {
      throw new Error(`The maximum for “${column}” must be greater than zero.`);
    }
    formats[column] = format;
  });
  return formats;
}

interface ERDPosition { x: number; y: number; w: number; h: number }
interface ERDLayout {
  positions: Record<string, ERDPosition>;
  totalW: number;
  totalH: number;
  CARD_W: number;
  CARD_H_BASE: number;
  ROW_H: number;
  GAP_X: number;
}

function computeERDLayout(
  tables: string[],
  getTable: (name: string) => DbTable,
  options: Partial<{ cardWidth: number; headerHeight: number; rowHeight: number; padding: number; horizontalGap: number; verticalGap: number }> = {},
): ERDLayout {
  const CARD_W = options.cardWidth || 240;
  const CARD_H_BASE = options.headerHeight || 42;
  const ROW_H = options.rowHeight || 24;
  const PAD = options.padding || 48;
  const GAP_X = options.horizontalGap || 180;
  const GAP_Y = options.verticalGap || 36;
  const positions: Record<string, ERDPosition> = {};
  const depthMemo: Record<string, number> = {};

  const getDepth = (tableName: string, visiting: Set<string> = new Set<string>()): number => {
    if (depthMemo[tableName] !== undefined) return depthMemo[tableName];
    if (visiting.has(tableName)) return 0;
    const nextVisiting = new Set(visiting);
    nextVisiting.add(tableName);
    const references = getTable(tableName).columns
      .filter(column => column.fk && tables.includes(column.fk.table))
      .map(column => column.fk.table);
    const depth = references.length
      ? Math.max(...references.map(reference => getDepth(reference, nextVisiting) + 1))
      : 0;
    depthMemo[tableName] = depth;
    return depth;
  };

  const orderedDepths = [...new Set(tables.map(table => getDepth(table)))].sort((a, b) => a - b);
  const depthColumns = new Map(orderedDepths.map(depth => [depth, [] as string[]]));
  [...tables].sort((a, b) => a.localeCompare(b)).forEach(table => {
    const columnTables = depthColumns.get(getDepth(table));
    if (!columnTables) throw new Error(`Missing layout column for table '${table}'.`);
    columnTables.push(table);
  });
  const columnHeights = orderedDepths.map(depth => {
    const columnTables = depthColumns.get(depth);
    if (!columnTables) throw new Error(`Missing layout column for depth ${depth}.`);
    return columnTables.reduce((height, table) => (
      height + CARD_H_BASE + getTable(table).columns.length * ROW_H
    ), 0) + Math.max(0, columnTables.length - 1) * GAP_Y;
  });
  const maxColumnHeight = Math.max(...columnHeights);

  orderedDepths.forEach((depth, columnIndex) => {
    const columnTables = depthColumns.get(depth);
    if (!columnTables) throw new Error(`Missing layout column for depth ${depth}.`);
    let y = PAD + (maxColumnHeight - columnHeights[columnIndex]) / 2;
    const x = PAD + columnIndex * (CARD_W + GAP_X);
    columnTables.forEach(table => {
      const h = CARD_H_BASE + getTable(table).columns.length * ROW_H;
      positions[table] = { x, y, w: CARD_W, h };
      y += h + GAP_Y;
    });
  });

  return {
    positions,
    totalW: PAD * 2 + orderedDepths.length * CARD_W + Math.max(0, orderedDepths.length - 1) * GAP_X,
    totalH: PAD * 2 + maxColumnHeight,
    CARD_W,
    CARD_H_BASE,
    ROW_H,
    GAP_X,
  };
}

// ── Plugin ────────────────────────────────────────────────────────────────────

const VIEW_TYPE = 'motion-database';
const VIEW_TYPE_HOME = 'motion-database-home';
const DB_DIR = 'motion-databases';

function setButtonContent(button: HTMLElement, icon: string, label: string): HTMLElement {
  button.empty();
  setIcon(button, icon);
  button.createSpan({ text: label });
  button.setAttribute('aria-label', label);
  return button;
}

// ── Per-database wrapper ───────────────────────────────────────────────────────

class MotionDB {
  static _backedUpPaths = new Set<string>();
  plugin: MotionDatabasePluginAPI;
  filePath: string;
  engine: MotionDBEngine;
  name: string;
  _saveChain: Promise<void>;
  _saveTimer: number | null;
  _directoryReady: boolean;
  _deleted = false;
  _loadPromise: Promise<void> | null = null;

  constructor(plugin: MotionDatabasePluginAPI, filePath: string) {
    this.plugin = plugin;
    this.filePath = filePath;
    this.engine = new MotionDBEngine();
    this.name = 'Untitled';
    this._saveChain = Promise.resolve();
    this._saveTimer = null;
    this._directoryReady = false;
  }

  nameFromPath(): string { return this.filePath.split('/').pop()?.replace(/\.motiondb\.json$/, '') || 'Untitled'; }

  async load() {
    // Never read this instance while one of its writes is still in flight.
    await this._saveChain.catch(() => { });
    const fileExisted = await this.plugin.app.vault.adapter.exists(this.filePath);
    let lastErr: unknown = null;

    if (!fileExisted) {
      this.name = this.nameFromPath();
      await this.save();
      return;
    }

    // Try a few times with a short backoff. A JSON.parse failure here is very
    // often NOT real corruption — it's a torn read that landed while save()
    // was still flushing bytes to disk. This is especially likely for a
    // freshly-created database (rapid autosave/seed/import writes) that's
    // also being queried concurrently, e.g. by a DataviewJS block. Retrying
    // almost always succeeds once the write settles, instead of us wrongly
    // declaring the file corrupted.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const raw = await this.plugin.app.vault.adapter.read(this.filePath);
        const data: unknown = JSON.parse(raw);
        if (!isRecord(data)) throw new Error('Database file must contain a JSON object.');
        this.name = typeof data.name === 'string' && data.name ? data.name : this.nameFromPath();
        if (data.schema !== undefined) {
          if (!isDbSchema(data.schema)) throw new Error('Database file has an invalid schema.');
          this.engine.deserialize(JSON.stringify(data.schema));
        }
        return; // success
      } catch (e) {
        lastErr = e;
        if (attempt < 2) await new Promise<void>(resolve => window.setTimeout(resolve, 60 * (attempt + 1)));
      }
    }

    // IMPORTANT: only overwrite-and-reset for a brand new file. If the file
    // already existed and still fails to parse after retries (genuine
    // corruption), back it up instead of silently discarding the data — and
    // keep the name derived from the filename so motiondb.open() can still
    // find it by filename, rather than orphaning it under 'Untitled' forever.
    this.name = this.nameFromPath();
    if (fileExisted) {
      // Only back up once per file per session. Writing a fresh, uniquely
      // timestamped backup on every failed load is itself a vault write —
      // which can trigger another load elsewhere (e.g. a live DataviewJS
      // query re-running on any vault change), fail the same way, back up
      // again, and repeat indefinitely. Capping it to one write breaks that
      // feedback loop even if the file really is corrupted.
      MotionDB._backedUpPaths = MotionDB._backedUpPaths || new Set();
      if (!MotionDB._backedUpPaths.has(this.filePath)) {
        MotionDB._backedUpPaths.add(this.filePath);
        try {
          const raw = await this.plugin.app.vault.adapter.read(this.filePath);
          await this.plugin.app.vault.adapter.write(`${this.filePath}.corrupted-${Date.now()}.bak`, raw);
        } catch (backupError) {
          console.error('[MotionDB] Could not back up unreadable database:', this.filePath, backupError);
        }
      }
      console.error('[MotionDB] Database could not be loaded — the original was not overwritten:', this.filePath, lastErr);
      throw new Error(`Database “${this.name}” could not be read. The original file was preserved and a backup was attempted.`);
    }
  }

  async save(): Promise<void> {
    if (this._deleted) throw new Error(`Database “${this.name}” has been deleted.`);
    // Capture state now, then serialize disk writes for this database so a
    // slower, older save can never overwrite a newer one.
    const payload = JSON.stringify({
      formatVersion: 1,
      name: this.name,
      schema: this.engine.schema,
    }, null, 2);
    const operation = this._saveChain.catch(error => {
      console.warn('[MotionDB] Continuing save queue after a previous save failed:', this.filePath, error);
    }).then(async () => {
      const vault = this.plugin.app.vault;
      const adapter = vault.adapter;
      const dir = this.filePath.substring(0, this.filePath.lastIndexOf('/'));
      if (dir && !this._directoryReady) {
        if (!(await adapter.exists(dir))) await vault.createFolder(dir);
        this._directoryReady = true;
      }

      // Write a complete temporary file first. Desktop adapters can normally
      // replace the destination via rename; retain a compatible fallback.
      const tempPath = `${this.filePath}.tmp`;
      await adapter.write(tempPath, payload);
      try {
        await adapter.rename(tempPath, this.filePath);
      } catch {
        await adapter.write(this.filePath, payload);
        try {
          if (await adapter.exists(tempPath)) await adapter.remove(tempPath);
        } catch (cleanupError) {
          console.warn('[MotionDB] Could not remove temporary save file:', tempPath, cleanupError);
        }
      }

      if (window._motionDBRegistry) window._motionDBRegistry[this.name] = this;
      this.plugin.app.workspace.trigger('motion-database:changed', {
        name: this.name,
        filePath: this.filePath,
      });
    });
    this._saveChain = operation;
    return operation;
  }

  scheduleSave(delay = 90): void {
    if (this._deleted || this.engine._inTx || !this.engine._dirty) return;
    if (this._saveTimer) window.clearTimeout(this._saveTimer);
    this._saveTimer = window.setTimeout(() => {
      this._saveTimer = null;
      void this.flushSave().catch(error => console.error('[MotionDB] Background save failed:', this.filePath, error));
    }, delay);
  }

  async flushSave(): Promise<void> {
    if (this._saveTimer) { window.clearTimeout(this._saveTimer); this._saveTimer = null; }
    if (this._deleted || this.engine._inTx || !this.engine._dirty) return this._saveChain;
    this.engine._dirty = false;
    try {
      await this.save();
    } catch (error) {
      this.engine._dirty = true;
      throw error;
    }
    // A write may have arrived while the captured payload was being flushed.
    if (this.engine._dirty) this.scheduleSave();
    return this._saveChain;
  }

  cancelScheduledSave(): void {
    if (this._saveTimer) window.clearTimeout(this._saveTimer);
    this._saveTimer = null;
  }

  exec(sql: string): SqlResult[] { return this.engine.exec(sql); }

  async query(sql: string, parameters: unknown[] = []): Promise<SqlResult[]> {
    const results = this.exec(bindParameters(sql, parameters));
    if (!this.engine._inTx && this.engine._dirty) {
      this.scheduleSave();
    }
    return results;
  }

  tables(): string[] { return Object.keys(this.engine.schema).filter(k => k !== '__views__'); }

  tableData(name: string): DbTable | null {
    const tbl = this.engine.schema[name.toLowerCase()];
    if (!isDbTable(tbl)) return null;
    return tbl;
  }
}

// ── Global DataviewJS API ─────────────────────────────────────────────────────

function registerGlobalAPI(plugin: MotionDatabasePluginAPI): void {
  window._motionDBRegistry = {};
  // Dashboard/widget embeds often request the same small result set during the
  // same render burst. Share those reads briefly so multiple instances do not
  // repeat parsing, joins, and object materialization on the UI thread.
  const selectCache = new Map<string, { expires: number; promise: Promise<DbRow[]> }>();

  // ── Sample database SQL (Northwind-style: customers, products, orders, order_items) ──
  const SAMPLE_SQL = `
CREATE TABLE IF NOT EXISTS categories (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  name    TEXT NOT NULL UNIQUE,
  description TEXT
);

CREATE TABLE IF NOT EXISTS suppliers (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  name    TEXT NOT NULL,
  country TEXT NOT NULL,
  contact TEXT
);

CREATE TABLE IF NOT EXISTS products (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  category_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  unit_price  REAL NOT NULL DEFAULT 0,
  stock       INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (category_id) REFERENCES categories(id),
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
);

CREATE TABLE IF NOT EXISTS customers (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  name    TEXT NOT NULL,
  email   TEXT UNIQUE,
  country TEXT NOT NULL,
  city    TEXT
);

CREATE TABLE IF NOT EXISTS orders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  order_date  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);

CREATE TABLE IF NOT EXISTS order_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  quantity   INTEGER NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL,
  FOREIGN KEY (order_id)   REFERENCES orders(id),
  FOREIGN KEY (product_id) REFERENCES products(id)
);

INSERT INTO categories (name, description) VALUES
  ('Beverages',    'Soft drinks, coffees, teas, beers, and ales'),
  ('Condiments',   'Sweet and savory sauces, relishes, spreads'),
  ('Confections',  'Desserts, candies, and sweet breads'),
  ('Dairy',        'Cheeses and dairy products'),
  ('Grains',       'Breads, crackers, pasta, and cereal'),
  ('Meat',         'Prepared meats and seafood'),
  ('Produce',      'Dried fruit and bean curd'),
  ('Seafood',      'Seaweed and fish');

INSERT INTO suppliers (name, country, contact) VALUES
  ('Exotic Liquids',          'UK',      'Charlotte Cooper'),
  ('New Orleans Delights',    'USA',     'Shelley Burke'),
  ('Grandma Kellys Homestead','USA',     'Regina Murphy'),
  ('Tokyo Traders',           'Japan',   'Yoshi Nagase'),
  ('Cooperativa de Quesos',   'Spain',   'Antonio del Valle'),
  ('Mayumi''s',               'Japan',   'Mayumi Ohno'),
  ('Pavlova Ltd',             'Australia','Ian Devling'),
  ('Specialty Biscuits',      'UK',      'Peter Wilson');

INSERT INTO products (name, category_id, supplier_id, unit_price, stock) VALUES
  ('Chai',                    1, 1, 18.00,  39),
  ('Chang',                   1, 1, 19.00,  17),
  ('Aniseed Syrup',           2, 1, 10.00,  13),
  ('Chef Anton''s Cajun',     2, 2, 22.00,  53),
  ('Chef Anton''s Gumbo Mix', 2, 2,  0.00,   0),
  ('Grandma''s Boysenberry',  2, 3, 25.00,  20),
  ('Uncle Bob''s Pears',      7, 3, 30.00,  15),
  ('Northwoods Cranberry',    2, 3, 40.00,   6),
  ('Mishi Kobe Niku',         6, 4, 97.00,  29),
  ('Ikura',                   8, 4, 31.00,  31),
  ('Queso Cabrales',          4, 5, 21.00,  22),
  ('Queso Manchego',          4, 5, 38.00,  86),
  ('Konbu',                   8, 6,  6.00,  24),
  ('Tofu',                    7, 6, 23.25,  35),
  ('Genen Shouyu',            2, 6, 15.50,  39),
  ('Pavlova',                 3, 7, 17.45,  29),
  ('Alice Mutton',            6, 7, 39.00,   0),
  ('Carnarvon Tigers',        8, 7, 62.50,  42),
  ('Tea',                     1, 8,  9.00,  25),
  ('Flotemysost',             4, 8, 21.50,  26);

INSERT INTO customers (name, email, country, city) VALUES
  ('Maria Anders',      'maria@alfreds.com',     'Germany',   'Berlin'),
  ('Ana Trujillo',      'ana@trujillo.com',       'Mexico',    'México D.F.'),
  ('Antonio Moreno',    'antonio@taqueria.com',   'Mexico',    'México D.F.'),
  ('Thomas Hardy',      'thomas@aroundhorn.com',  'UK',        'London'),
  ('Christina Berglund','christina@berglund.com', 'Sweden',    'Luleå'),
  ('Hanna Moos',        'hanna@moos.com',         'Germany',   'Mannheim'),
  ('Frédérique Citeaux','fred@blondel.com',       'France',    'Strasbourg'),
  ('Martín Sommer',     'martin@sommer.com',      'Spain',     'Madrid'),
  ('Laurence Lebihan',  'laurence@lebihan.com',   'France',    'Marseille'),
  ('Elizabeth Lincoln', 'liz@bottoms.com',        'Canada',    'Tsawassen');

INSERT INTO orders (customer_id, order_date, status) VALUES
  (1, '2024-07-04', 'shipped'),
  (1, '2024-07-08', 'shipped'),
  (2, '2024-07-09', 'delivered'),
  (3, '2024-07-10', 'pending'),
  (4, '2024-07-11', 'shipped'),
  (5, '2024-07-12', 'delivered'),
  (6, '2024-07-13', 'pending'),
  (7, '2024-07-14', 'shipped'),
  (8, '2024-07-15', 'delivered'),
  (9, '2024-07-16', 'pending'),
  (10,'2024-07-17', 'shipped'),
  (1, '2024-07-18', 'pending'),
  (3, '2024-07-19', 'shipped'),
  (5, '2024-07-20', 'delivered'),
  (7, '2024-07-21', 'pending');

INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES
  (1,  1,  12, 18.00),
  (1,  2,   5, 19.00),
  (2,  4,   2, 22.00),
  (2, 16,   6, 17.45),
  (3,  3,  20, 10.00),
  (3,  7,   3, 30.00),
  (4, 11,   4, 21.00),
  (4, 12,   2, 38.00),
  (5,  9,   1, 97.00),
  (5, 10,  10, 31.00),
  (6, 13,  15,  6.00),
  (6, 14,   8, 23.25),
  (7,  1,   6, 18.00),
  (7, 19,  10,  9.00),
  (8, 15,   5, 15.50),
  (8, 20,   3, 21.50),
  (9,  5,   2,  0.00),
  (9,  6,   4, 25.00),
  (10, 17,  2, 39.00),
  (10, 18,  1, 62.50),
  (11, 2,   8, 19.00),
  (11, 4,   3, 22.00),
  (12, 1,   4, 18.00),
  (12, 11,  6, 21.00),
  (13, 7,   2, 30.00),
  (13, 16,  5, 17.45),
  (14, 3,  12, 10.00),
  (14, 13,  9,  6.00),
  (15, 9,   1, 97.00),
  (15, 10,  4, 31.00);

CREATE VIEW IF NOT EXISTS order_totals AS
  SELECT o.id AS order_id, c.name AS customer, o.order_date, o.status,
         SUM(oi.quantity * oi.unit_price) AS total
  FROM orders o
  JOIN customers c ON o.customer_id = c.id
  JOIN order_items oi ON oi.order_id = o.id
  GROUP BY o.id;

CREATE VIEW IF NOT EXISTS product_revenue AS
  SELECT p.name AS product, cat.name AS category,
         SUM(oi.quantity) AS units_sold,
         ROUND(SUM(oi.quantity * oi.unit_price), 2) AS revenue
  FROM order_items oi
  JOIN products p ON oi.product_id = p.id
  JOIN categories cat ON p.category_id = cat.id
  GROUP BY p.id;
`;

  window.motiondb = {
    /**
     * Create a database and return its open instance. This gives embedded
     * DataviewJS applications a supported bootstrap path instead of requiring
     * the database to be created manually in the panel first.
     */
    create: async (name) => {
      const trimmed = String(name ?? '').trim();
      if (!trimmed) throw new Error('Database name is required.');

      const registryKey = Object.keys(window._motionDBRegistry)
        .find(key => key.toLowerCase() === trimmed.toLowerCase());
      const existing = registryKey ? window._motionDBRegistry[registryKey] : null;
      if (existing) {
        window._motionDBRegistry[trimmed] = existing;
        return existing;
      }

      const fileName = trimmed.replace(/[\\/:*?"<>|]/g, '_');
      const filePath = `${DB_DIR}/${fileName}.motiondb.json`;
      if (await plugin.app.vault.adapter.exists(filePath)) {
        const db = await plugin.getDatabase(filePath);
        if (db.name.toLowerCase() !== trimmed.toLowerCase()) {
          throw new Error(`The database file "${fileName}" already belongs to "${db.name}".`);
        }
        window._motionDBRegistry[db.name] = db;
        window._motionDBRegistry[trimmed] = db;
        return db;
      }

      const db = new MotionDB(plugin, filePath);
      db.name = trimmed;
      await db.save();
      plugin.registerDatabase(db);
      return db;
    },

    /**
     * Open (or return cached) a MotionDB instance by name.
     * @param {string} name  — exact database name as set in the UI
     */
    open: async (name) => {
      if (window._motionDBRegistry[name]) return window._motionDBRegistry[name];

      // Fast path: most databases are saved as `${name}.motiondb.json`, so try
      // that file directly first. This avoids loading every other database in
      // the vault just to answer a query for one — each extra load() is one
      // more chance to race a concurrent save() elsewhere (e.g. an active
      // import) and misfire the corruption-recovery path.
      const guessPath = `${DB_DIR}/${name}.motiondb.json`;
      try {
        if (await plugin.app.vault.adapter.exists(guessPath)) {
          const guessDb = await plugin.getDatabase(guessPath);
          if (guessDb.name === name) { window._motionDBRegistry[name] = guessDb; return guessDb; }
        }
      } catch (error) {
        console.warn('[MotionDB] Fast database lookup failed; trying a full scan:', name, error);
      }

      let files: string[] = [];
      try {
        const d = await plugin.app.vault.adapter.list(DB_DIR);
        files = (d.files || []).filter(f => f.endsWith('.motiondb.json'));
      } catch (error) {
        console.error('[MotionDB] Could not list database files:', error);
      }
      let byFilename: MotionDB | null = null;
      for (const fp of files) {
        if (fp === guessPath) continue; // already tried above
        const db = await plugin.getDatabase(fp);
        if (db.name === name) { window._motionDBRegistry[name] = db; return db; }
        if (!byFilename && db.nameFromPath() === name) byFilename = db;
      }
      // Fallback: internal name didn't match (e.g. a previously-corrupted file
      // whose name field no longer matches), but the filename itself does.
      if (byFilename) { window._motionDBRegistry[name] = byFilename; return byFilename; }
      throw new Error(`Database "${name}" not found. Open it in the Motion Database panel first.`);
    },

    /**
     * Execute SQL against a named database. Returns array of result objects.
     * Each result: { type:'rows', columns:string[], rows:any[][] } or { type:'ok', message, count }
     *
     * DataviewJS usage:
     *   const [result] = await motiondb.query('mydb', 'SELECT * FROM users');
     *   dv.table(result.columns, result.rows);
     */
    query: async (dbName, sql, parameters = []) => {
      const db = await window.motiondb.open(dbName);
      const result = await db.query(sql, parameters);
      selectCache.clear();
      return result;
    },

    /**
     * Execute SQL and return plain objects (one per row) — easier for DataviewJS.
     *
     *   const rows = await motiondb.select('mydb', 'SELECT * FROM users WHERE age > 18');
     *   // rows = [{ id:1, name:'Alice', age:25 }, ...]
     *   dv.table(Object.keys(rows[0]), rows.map(r => Object.values(r)));
     */
    select: async (dbName, sql, parameters = []) => {
      const key = `${dbName}\u0000${sql}\u0000${JSON.stringify(parameters)}`;
      if (selectCache.size > 128) {
        const now = Date.now();
        for (const [cacheKey, entry] of selectCache) if (entry.expires <= now) selectCache.delete(cacheKey);
        if (selectCache.size > 128) {
          const oldestKey = [...selectCache.keys()][0];
          if (oldestKey !== undefined) selectCache.delete(oldestKey);
        }
      }
      let cached = selectCache.get(key);
      if (!cached || cached.expires <= Date.now()) {
        const promise = (async () => {
          const db = await window.motiondb.open(dbName);
          const results = await db.query(sql, parameters);
          const result = results[0];
          if (!result || result.type !== 'rows') return [];
          return result.rows.map(row => {
            const obj: DbRow = {};
            result.columns.forEach((col, i) => { obj[col] = row[i]; });
            return obj;
          });
        })().catch(error => { selectCache.delete(key); throw error; });
        cached = { expires: Date.now() + 1500, promise };
        selectCache.set(key, cached);
      }
      const rows = await cached.promise;
      return rows.map(row => ({ ...row }));
    },

    /**
     * List all databases and their tables.
     */
    list: async () => {
      let files: string[] = [];
      try {
        const d = await plugin.app.vault.adapter.list(DB_DIR);
        files = (d.files || []).filter(f => f.endsWith('.motiondb.json'));
      } catch (error) {
        console.error('[MotionDB] Could not list databases:', error);
        return [];
      }
      const out: Array<{ name: string; tables: string[] }> = [];
      for (const fp of files) {
        const db = await plugin.getDatabase(fp);
        out.push({ name: db.name, tables: db.tables() });
      }
      return out;
    },

    /**
     * Run raw SQL directly on an open database instance (skip name lookup).
     * Useful after motiondb.open().
     */
    exec: async (db, sql, parameters = []) => db.query(sql, parameters),

    /**
     * Seed a database with the built-in Northwind sample data.
     * Creates tables: categories, suppliers, products, customers, orders, order_items
     * Creates views:  order_totals, product_revenue
     *
     *   await motiondb.seed('mydb');
     */
    seed: async (dbName) => {
      const db = await window.motiondb.open(dbName);
      // Pass the entire SQL block to exec() — it handles multiple statements correctly
      // and doesn't break on semicolons inside string literals (unlike a naive split).
      let results: Array<SqlResult | { type: 'error'; message: string }> = [];
      try {
        results = await db.query(SAMPLE_SQL);
      } catch (e) {
        results.push({ type: 'error', message: errorMessage(e) });
      }
      const ok = results.filter(r => r.type === 'ok').length;
      const errs = results.filter(r => r.type === 'error');
      return { ok, errors: errs };
    },

    version: 2,

    subscribe: (callback) => {
      const ref = plugin.app.workspace.on('motion-database:changed', callback);
      return () => plugin.app.workspace.offref(ref);
    },
  };
}

// ── View ──────────────────────────────────────────────────────────────────────

class MotionDatabaseView extends ItemView {
  plugin: MotionDatabasePluginAPI;
  db: MotionDB | null;
  activeTab: string;
  sqlHistory: string[];
  historyIdx: number;
  sqlOutput: string;
  sqlOutputBlocks: SqlOutputBlock[];
  sqlInitial?: string;
  _saveTimer: number | null;
  file: { name: string; path: string; extension: string };

  constructor(leaf: WorkspaceLeaf, plugin: MotionDatabasePluginAPI) {
    super(leaf);
    this.plugin = plugin;
    this.db = null;
    this.activeTab = 'tables';
    this.navigation = true;
    this.sqlHistory = [];
    this.historyIdx = -1;
    this.sqlOutput = '';
    this.sqlOutputBlocks = [];
    // Stub — third-party plugins (e.g. editor-width-slider) read activeLeaf.view.file.name
    // on every leaf change. Without this they throw TypeError on null.
    this.file = { name: 'Motion Database', path: '', extension: '' };
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return this.db?.name || 'Motion Database'; }
  getIcon() { return 'database'; }

  async onOpen() {
    this.containerEl.addClass('mdb-root');
    this.render();
  }

  // Return empty state — we don't want Obsidian to persist db views across restarts.
  // Databases are opened explicitly from the Home view.
  getState() { return {}; }

  async setState(state: unknown, _result: unknown) {
    // Called by Obsidian during same-session tab history navigation only.
    // On startup we return {} from getState so filePath is never in saved state.
    if (!isRecord(state) || typeof state.filePath !== 'string') return;
    if (state.filePath === this.db?.filePath) return;
    try {
      const exists = await this.plugin.app.vault.adapter.exists(state.filePath);
      if (exists) await this.loadDB(state.filePath);
    } catch { /* ignore */ }
  }

  async loadDB(filePath: string): Promise<void> {
    try {
      this.db = await this.plugin.getDatabase(filePath);
      window._motionDBRegistry = window._motionDBRegistry || {};
      window._motionDBRegistry[this.db.name] = this.db;
      // Keep file stub in sync so third-party plugins see a sensible name
      this.file = { name: this.db.name, path: filePath, extension: 'motiondb' };
      this.activeTab = 'tables';
      this.render();
    } catch (e) {
      console.error('[MotionDB] Failed to load database:', filePath, e);
      new Notice(`Failed to load database: ${errorMessage(e)}`, 6000);
      this.db = null;
      this.render();
    }
  }

  async persist() {
    if (this.db) {
      await this.db.save();
      if (this.db.engine) this.db.engine._dirty = false;
    }
  }
  async persistAndRender() { await this.persist(); this.render(); }

  // Debounced save — fires 1 s after the last write, only if data is actually dirty.
  // Skipped entirely while a transaction is open — only COMMIT flushes to disk.
  // A single exec() call with 500 INSERTs schedules exactly one save, not 500.
  _scheduleSave() {
    if (this.db?.engine?._inTx) return;
    if (!this.db?.engine?._dirty) return;        // nothing changed — skip
    if (this._saveTimer) window.clearTimeout(this._saveTimer);
    this._saveTimer = window.setTimeout(() => {
      this._saveTimer = null;
      if (this.db && this.db.engine._dirty) {
        void this.db.save().then(() => {
          if (this.db) this.db.engine._dirty = false;
        }).catch(error => {
          console.error('[MotionDB] Debounced save failed:', this.db?.filePath, error);
        });
      }
    }, 1000); // 1 s debounce — coalesces rapid writes without feeling sluggish
  }

  // ── Shell ──────────────────────────────────────────────────────────────────

  render() {
    const root = this.containerEl;
    root.empty();

    const db = this.db;
    if (!db) {
      // Transient state — view was just created, loadDB is about to be called.
      // Show a neutral placeholder. Do NOT self-destruct here because this runs
      // before openInLeaf has a chance to call loadDB.
      root.createDiv({ cls: 'mdb-view-loading', text: 'Loading…' });
      return;
    }

    // ── Sidebar ──
    // Shared workspace header: database identity lives above navigation, just
    // like the home view header.
    const workspaceHeader = root.createDiv({ cls: 'mdb-home-header mdb-workspace-header' });
    const backBtn = workspaceHeader.createEl('button', { cls: 'clickable-icon mdb-workspace-back' });
    setIcon(backBtn, 'arrow-left');
    backBtn.setAttribute('aria-label', 'Back to databases');
    backBtn.onclick = () => this.plugin.openHome();

    const headerIcon = workspaceHeader.createDiv({ cls: 'mdb-home-logo mdb-workspace-logo' });
    setIcon(headerIcon, 'database');
    const headerIdentity = workspaceHeader.createDiv({ cls: 'mdb-home-title-wrap' });
    const titleEl = headerIdentity.createSpan({ cls: 'mdb-home-title mdb-workspace-title', text: db.name });
    headerIdentity.createDiv({ cls: 'mdb-home-subtitle', text: 'Local database' });
    const savedState = workspaceHeader.createDiv({ cls: 'mdb-workspace-status' });
    setIcon(savedState, 'hard-drive');
    savedState.createSpan({ text: 'Vault file' });

    titleEl.contentEditable = 'true'; titleEl.spellcheck = false;
    let nameBlurHandled = false;
    titleEl.onblur = () => {
      if (nameBlurHandled) return;
      nameBlurHandled = true;
      db.name = titleEl.textContent.trim() || 'Untitled';
      void this.persistAndRender().catch(error => {
        console.error('[MotionDB] Could not save the database name:', error);
        new Notice('Could not save the database name.');
      });
    };
    titleEl.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); } };

    const layout = root.createDiv({ cls: 'mdb-layout' });
    const sidebar = layout.createDiv({ cls: 'mdb-sidebar' });
    const content = layout.createDiv({ cls: 'mdb-content' });

    // Match Obsidian's Settings navigation semantics and visual tokens rather
    // than inheriting the application's regular button treatment.
    const sidebarItem = (parent: HTMLElement, className: string, onActivate: () => void): HTMLDivElement => {
      const el = parent.createDiv({ cls: `vertical-tab-nav-item ${className}` });
      el.setAttribute('role', 'button');
      el.tabIndex = 0;
      el.onclick = onActivate;
      el.onkeydown = event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onActivate();
        }
      };
      return el;
    };
    const navItem = (label: string, icon: string, id: string): HTMLDivElement => {
      const el = sidebarItem(sidebar, 'mdb-nav-item' + (this.activeTab === id ? ' is-active' : ''), () => {
        this.activeTab = id;
        this.render();
      });
      const iconEl = el.createSpan({ cls: 'mdb-nav-icon' });
      setIcon(iconEl, icon);
      el.createSpan({ cls: 'mdb-nav-label', text: label });
      return el;
    };

    navItem('Overview', 'layout-dashboard', 'dashboard');
    navItem('Tables', 'table-2', 'tables');
    navItem('SQL', 'square-terminal', 'sql');
    navItem('Relationships', 'workflow', 'erd');
    navItem('SQL reference', 'book-open', 'cheatsheet');

    // New table + Import CSV Settings-style actions
    const newTblBtn = sidebarItem(sidebar, 'mdb-nav-item mdb-sidebar-action', () => {
      new NewTableModal(this.app, db, () => this.persistAndRender()).open();
    });
    setButtonContent(newTblBtn, 'plus', 'New table');
    const importSideBtn = sidebarItem(sidebar, 'mdb-nav-item mdb-sidebar-action', () => this.importCSV());
    setButtonContent(importSideBtn, 'upload', 'Import CSV');

    // ── Content ──
    if (this.activeTab === 'dashboard') this.renderDashboard(content);
    else if (this.activeTab === 'tables') this.renderTablesOverview(content);
    else if (this.activeTab === 'sql') this.renderSQLTerminal(content);
    else if (this.activeTab === 'erd') this.renderERD(content);
    else if (this.activeTab === 'cheatsheet') this.renderCheatsheet(content);
    else this.renderTableView(content, this.activeTab);
  }

  // ── Export / Import ────────────────────────────────────────────────────────

  exportCSV(tableName: string): void {
    const db = this.db;
    if (!db) return;
    const tbl = db.tableData(tableName);
    if (!tbl) return;
    const headers = tbl.columns.map(c => c.name);
    const rows = tbl.rows.map(r => headers.map(h => {
      const v = r[h];
      if (v === null || v === undefined) return '';
      const s = String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
    }));
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.body.createEl('a');
    a.href = url; a.download = `${tableName}.csv`; a.click();
    a.remove();
    URL.revokeObjectURL(url);
    new Notice(`Exported ${tbl.rows.length} rows to ${tableName}.csv`);
  }

  // ── CSV type inference ────────────────────────────────────────────────────
  inferCSVType(values: string[]): 'INTEGER' | 'REAL' | 'TEXT' {
    // Sample up to 50 non-empty values and decide INTEGER / REAL / TEXT
    const samples = values.filter(v => v !== null && v.trim() !== '' && v.trim().toUpperCase() !== 'NULL').slice(0, 50);
    if (!samples.length) return 'TEXT';
    const allInt = samples.every(v => /^-?\d+$/.test(v.trim()));
    if (allInt) return 'INTEGER';
    const allReal = samples.every(v => /^-?\d*\.?\d+([eE][+-]?\d+)?$/.test(v.trim()));
    if (allReal) return 'REAL';
    return 'TEXT';
  }

  // ── Smart CSV import — creates table automatically if needed ───────────────
  importCSV(tableName: string | null = null): void {
    const input = document.body.createEl('input');
    input.type = 'file'; input.accept = '.csv';
    input.onchange = async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      const db = this.db;
      if (!db) return;

      // Normalise line endings
      const text = (await file.text()).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      if (lines.length < 1) { new Notice('CSV file is empty.'); return; }

      const headers = this.parseCSVLine(lines[0]).map(h => h.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_') || 'col');

      // ── Auto-create table if no target table given ──
      let targetTable = tableName;
      if (!targetTable) {
        // Derive table name from filename, sanitised
        const baseName = file.name.replace(/\.csv$/i, '').toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '') || 'imported';
        targetTable = baseName;

        // If table already exists, ask user whether to append or replace
        const existing = db.tableData(targetTable);
        if (existing) {
          // Table exists — confirm append; resolve(false) on cancel so we don't hang
          const confirmed = await new Promise<boolean>(resolve => {
            new ConfirmModal(
              this.app,
              `Table "${targetTable}" already exists. Append the CSV data to it?`,
              () => resolve(true),
              () => resolve(false)
            ).open();
          });
          if (!confirmed) return;
        } else {
          // Infer column types from data rows
          const dataRows = lines.slice(1, 52).map(l => this.parseCSVLine(l)); // sample up to 50 rows
          const colValues = headers.map((_, i) => dataRows.map(row => row[i] ?? ''));
          const colTypes = headers.map((_, i) => this.inferCSVType(colValues[i]));

          // Build CREATE TABLE — always add an auto-increment id as first column
          const colDefs = headers.map((h, i) => `${h} ${colTypes[i]}`).join(',\n  ');
          const createSQL = `CREATE TABLE ${targetTable} (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  ${colDefs}\n)`;

          try {
            db.exec(createSQL);
          } catch (err) {
            new Notice(`Could not create table "${targetTable}": ${errorMessage(err)}`, 6000);
            return;
          }
        }
      }

      // ── Insert rows ──
      const tbl = db.tableData(targetTable);
      if (!tbl) {
        new Notice(`Table "${targetTable}" could not be loaded after import setup.`, 6000);
        return;
      }
      const dbCols = tbl.columns.map(c => c.name);
      // Map CSV headers to matching table columns (skip AI columns)
      const matchedCols = headers.filter(h => dbCols.includes(h) && !tbl.columns.find(c => c.name === h)?.ai);

      if (!matchedCols.length) {
        new Notice(`No matching columns found between CSV and table "${targetTable}".`, 6000);
        return;
      }

      let imported = 0;
      const errorList: Array<{ row: number; message: string }> = [];
      for (let i = 1; i < lines.length; i++) {
        try {
          const vals = this.parseCSVLine(lines[i]);
          const sqlCols = matchedCols.join(', ');
          const sqlVals = matchedCols.map(col => {
            const v = vals[headers.indexOf(col)];
            if (v === undefined || v === null || v.trim() === '' || v.trim().toUpperCase() === 'NULL') return 'NULL';
            return `'${v.replace(/'/g, "''")}'`;
          }).join(', ');
          db.exec(`INSERT INTO ${targetTable} (${sqlCols}) VALUES (${sqlVals})`);
          imported++;
        } catch (err) {
          errorList.push({ row: i + 1, message: errorMessage(err) });
        }
      }

      await this.persistAndRender();

      if (!errorList.length) {
        new Notice(`✓ Imported ${imported} rows into "${targetTable}"`);
      } else {
        const sample = errorList[0];
        new Notice(
          `Imported ${imported} rows into "${targetTable}"\n` +
          `${errorList.length} error(s) — first at row ${sample.row}: ${sample.message}`,
          8000
        );
        console.warn(`[MotionDB] CSV import errors for ${targetTable}:`, errorList.slice(0, 20));
      }

      // If we auto-created, switch to the new table
      if (!tableName) {
        this.activeTab = targetTable;
        this.render();
      }
    };
    input.click();
  }

  parseCSVLine(line: string): string[] {
    const result: string[] = []; let cur = ''; let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') {
        if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
        else inQuote = !inQuote;
      } else if (line[i] === ',' && !inQuote) {
        result.push(cur); cur = '';
      } else {
        cur += line[i];
      }
    }
    result.push(cur);
    return result;
  }

  // ── Dashboard ──────────────────────────────────────────────────────────────

  renderDashboard(el: HTMLElement): void {
    const hdr = el.createDiv({ cls: 'mdb-content-hdr' });
    hdr.createEl('h2', { cls: 'mdb-content-title', text: 'Overview' });

    const d = this.db;
    if (!d) return;
    const tables = d.tables();
    const totalRows = tables.reduce((s, t) => (s + (d.tableData(t)?.rows?.length || 0)), 0);
    const views = Object.keys(d.engine.schema.__views__ || {});

    // Stats cards
    const cards = el.createDiv({ cls: 'mdb-dash-cards' });
    const card = (icon: string, val: string | number, label: string): void => {
      const c = cards.createDiv({ cls: 'mdb-dash-card' });
      const iconEl = c.createDiv({ cls: 'mdb-dash-card-icon' });
      setIcon(iconEl, icon);
      c.createDiv({ cls: 'mdb-dash-card-val', text: String(val) });
      c.createDiv({ cls: 'mdb-dash-card-label', text: label });
    };
    card('table-2', tables.length, 'Tables');
    card('eye', views.length, 'Views');
    card('rows-3', totalRows, 'Rows');
    card('square-terminal', this.sqlHistory?.length || 0, 'Queries');

    // Table stats
    el.createEl('h3', { cls: 'mdb-section-title', text: 'Tables' });
    if (!tables.length) {
      el.createDiv({ cls: 'mdb-empty', text: 'No tables yet.' });
    } else {
      const tbl = el.createEl('table', { cls: 'mdb-result-table' });
      const thead = tbl.createEl('thead').createEl('tr');
      ['Table', 'Columns', 'Rows', 'Indexes', 'PK', 'Has FK'].forEach(h => thead.createEl('th', { text: h }));
      const tbody = tbl.createEl('tbody');
      tables.forEach(t => {
        const td = d.tableData(t);
        if (!td) return;
        const tr = tbody.createEl('tr');
        const nameTd = tr.createEl('td');
        const link = nameTd.createEl('a', { text: t, cls: 'mdb-dash-link' });
        link.onclick = () => { this.activeTab = t; this.render(); };
        [
          td.columns.length,
          td.rows.length,
          Object.keys(td.indexes || {}).length,
          td.columns.find(c => c.pk) ? td.columns.find(c => c.pk).name : '—',
          td.columns.some(c => c.fk) ? 'Yes' : 'No',
        ].forEach(v => tr.createEl('td', { text: String(v) }));
      });
    }

    // Views
    if (views.length) {
      el.createEl('h3', { cls: 'mdb-section-title', text: 'Views' });
      const vtbl = el.createEl('table', { cls: 'mdb-result-table' });
      const vth = vtbl.createEl('thead').createEl('tr');
      ['View', 'Definition'].forEach(h => vth.createEl('th', { text: h }));
      const vtbody = vtbl.createEl('tbody');
      views.forEach(v => {
        const vdef = d.engine.schema.__views__?.[v];
        if (!vdef) return;
        const tr = vtbody.createEl('tr');
        tr.createEl('td', { text: v });
        const defCell = tr.createEl('td');
        if (vdef.sql) {
          defCell.createEl('code', { text: vdef.sql.length > 120 ? vdef.sql.slice(0, 120) + '…' : vdef.sql, cls: 'mdb-null' });
        } else {
          defCell.createSpan({ text: 'SELECT …', cls: 'mdb-null' });
        }
      });
    }

    // Recent queries
    if (this.sqlHistory?.length) {
      el.createEl('h3', { cls: 'mdb-section-title', text: 'Recent Queries' });
      const qtbl = el.createEl('table', { cls: 'mdb-result-table' });
      const qth = qtbl.createEl('thead').createEl('tr');
      ['#', 'Query'].forEach(h => qth.createEl('th', { text: h }));
      const qtbody = qtbl.createEl('tbody');
      this.sqlHistory.slice(0, 10).forEach((q, i) => {
        const tr = qtbody.createEl('tr');
        tr.createEl('td', { text: String(i + 1) });
        const qtd = tr.createEl('td');
        const ql = qtd.createEl('a', { text: q.length > 80 ? q.slice(0, 80) + '…' : q, cls: 'mdb-dash-link' });
        ql.onclick = () => { this.activeTab = 'sql'; this.sqlInitial = q; this.sqlOutput = ''; this.render(); };
      });
    }
  }

  // ── ERD ────────────────────────────────────────────────────────────────────

  renderERD(el: HTMLElement): void {
    const hdr = el.createDiv({ cls: 'mdb-content-hdr' });
    hdr.createEl('h2', { cls: 'mdb-content-title', text: 'Relationships' });

    const db = this.db;
    if (!db) return;
    const tables = db.tables();
    if (!tables.length) {
      el.createDiv({ cls: 'mdb-empty', text: 'No tables to diagram.' });
      return;
    }

    // ── Canvas container ──
    const wrap = el.createDiv({ cls: 'mdb-erd-wrap' });

    const svg = el.createSvg('svg');
    svg.classList.add('mdb-erd-svg');
    wrap.appendChild(svg);

    const ns = 'http://www.w3.org/2000/svg';
    const mk = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] => {
      const element = document.createElementNS(ns, tag);
      Object.entries(attrs).forEach(([key, value]) => element.setAttribute(key, String(value)));
      return element;
    };

    // ── Layout ──
    const {
      positions, totalW, totalH,
      CARD_W, CARD_H_BASE, ROW_H, GAP_X,
    } = computeERDLayout(tables, table => {
      const definition = db.tableData(table);
      if (!definition) throw new Error(`Table '${table}' is missing from the database schema.`);
      return definition;
    });
    svg.setAttribute('width', String(totalW));
    svg.setAttribute('height', String(totalH));

    // ── Pan / Zoom state ──
    let panX = 0, panY = 0, zoom = 1;
    let dragging = false, lastX = 0, lastY = 0;

    const canvas = mk('g');
    svg.appendChild(canvas);

    const applyTransform = () => {
      canvas.setAttribute('transform', `translate(${panX},${panY}) scale(${zoom})`);
    };

    // Fit diagram to viewport on first render
    const fitToView = () => {
      const wrapW = wrap.clientWidth || 600;
      const wrapH = wrap.clientHeight || 400;
      const scaleX = (wrapW - 40) / totalW;
      const scaleY = (wrapH - 40) / totalH;
      zoom = Math.min(scaleX, scaleY, 1); // never zoom in beyond 100%
      panX = (wrapW - totalW * zoom) / 2;
      panY = (wrapH - totalH * zoom) / 2;
      applyTransform();
    };

    // ── Mouse drag (pan) ──
    wrap.onmousedown = (e: MouseEvent) => {
      if (e.target instanceof Element && e.target.closest('g[data-table]')) return;
      dragging = true; lastX = e.clientX; lastY = e.clientY;
      wrap.classList.add('is-panning');
    };

    // Use named handlers so we can remove them when this ERD instance is torn down
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging) return;
      panX += e.clientX - lastX;
      panY += e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      applyTransform();
    };
    const onMouseUp = () => {
      if (dragging) {
        dragging = false;
        wrap.classList.remove('is-panning');
      }
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);

    // Clean up window listeners when this ERD panel is removed from the DOM.
    // Observe the immediate parent only — far cheaper than subtree:true on document.body.
    const cleanup = new MutationObserver(() => {
      if (!wrap.isConnected) {
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
        cleanup.disconnect();
      }
    });
    // Wait one microtask so wrap is guaranteed to be in the DOM before we start observing
    void Promise.resolve().then(() => {
      if (wrap.parentNode) cleanup.observe(wrap.parentNode, { childList: true });
    }).catch(error => console.error('[MotionDB] Could not observe ERD cleanup:', error));

    // ── Touch drag (pan) ──
    let lastTouchX = 0, lastTouchY = 0;
    wrap.addEventListener('touchstart', (e) => { lastTouchX = e.touches[0].clientX; lastTouchY = e.touches[0].clientY; }, { passive: true });
    wrap.addEventListener('touchmove', (e) => {
      panX += e.touches[0].clientX - lastTouchX;
      panY += e.touches[0].clientY - lastTouchY;
      lastTouchX = e.touches[0].clientX; lastTouchY = e.touches[0].clientY;
      applyTransform();
      e.preventDefault();
    }, { passive: false });

    // ── Scroll (zoom) ──
    wrap.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      const rect = wrap.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      // Zoom around mouse position
      panX = mouseX - (mouseX - panX) * delta;
      panY = mouseY - (mouseY - panY) * delta;
      zoom = Math.max(0.2, Math.min(3, zoom * delta));
      applyTransform();
    }, { passive: false });

    // ── Reset / Fit button ──
    const fitBtn = hdr.createEl('button', { cls: 'mdb-btn' });
    setButtonContent(fitBtn, 'maximize-2', 'Fit');
    fitBtn.onclick = () => fitToView();

    // ── Arrowhead marker ──
    const defs = mk('defs');
    const markerId = `mdb-arrow-${Math.random().toString(36).slice(2)}`;
    const marker = mk('marker', { id: markerId, markerWidth: '8', markerHeight: '6', refX: '8', refY: '3', orient: 'auto' });
    marker.appendChild(mk('polygon', { points: '0 0, 8 3, 0 6', fill: 'var(--interactive-accent)' }));
    defs.appendChild(marker);
    canvas.appendChild(defs);

    // ── Draw FK arrows first (behind tables) ──
    tables.forEach(t => {
      const tbl = db.tableData(t);
      if (!tbl) return;
      tbl.columns.filter(c => c.fk).forEach((c, columnIndex) => {
        const src = positions[t];
        const dst = positions[c.fk.table];
        if (!src || !dst) return;

        // Anchor at the foreign-key row so multiple relationships remain
        // visually distinct instead of piling onto the table header.
        let x1: number;
        let y1 = src.y + CARD_H_BASE + columnIndex * ROW_H + ROW_H / 2;
        let x2: number;
        let y2: number;
        let cx1: number;
        let cx2: number;
        if (src === dst) {
          x1 = src.x + CARD_W;
          x2 = src.x + CARD_W;
          y2 = src.y + CARD_H_BASE / 2;
          cx1 = x1 + 70;
          cx2 = x2 + 70;
        } else if (dst.x >= src.x) {
          x1 = src.x + CARD_W;
          x2 = dst.x; y2 = dst.y + CARD_H_BASE / 2;
          cx1 = x1 + GAP_X / 2; cx2 = x2 - GAP_X / 2;
        } else {
          x1 = src.x;
          x2 = dst.x + CARD_W; y2 = dst.y + CARD_H_BASE / 2;
          cx1 = x1 - GAP_X / 2; cx2 = x2 + GAP_X / 2;
        }

        const path = mk('path', {
          d: `M${x1},${y1} C${cx1},${y1} ${cx2},${y2} ${x2},${y2}`,
          stroke: 'var(--interactive-accent)', 'stroke-width': '1.5',
          fill: 'none', 'marker-end': `url(#${markerId})`,
          opacity: '0.7',
        });
        canvas.appendChild(path);

        // FK label at midpoint
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2 - 6;
        const lbl = mk('text', { x: mx, y: my, 'font-size': '9', fill: 'var(--text-faint)', 'text-anchor': 'middle' });
        lbl.textContent = c.name;
        canvas.appendChild(lbl);
      });
    });

    // ── Draw table cards ──
    tables.forEach(t => {
      const tbl = db.tableData(t);
      const p = positions[t];
      if (!tbl || !p) return;
      const g = mk('g', { transform: `translate(${p.x},${p.y})`, cursor: 'pointer' });
      g.setAttribute('data-table', t);

      // Card body
      g.appendChild(mk('rect', {
        x: 0, y: 0, width: CARD_W, height: p.h, rx: '4', ry: '4',
        fill: 'var(--background-primary)', stroke: 'var(--background-modifier-border)', 'stroke-width': '1'
      }));

      // Header bar
      g.appendChild(mk('rect', {
        x: 0, y: 0, width: CARD_W, height: CARD_H_BASE, rx: '4', ry: '4',
        fill: 'var(--background-secondary-alt)'
      }));
      // Square off bottom of header
      g.appendChild(mk('rect', {
        x: 0, y: CARD_H_BASE - 8, width: CARD_W, height: 8,
        fill: 'var(--background-secondary-alt)'
      }));

      // Table name
      const titleBg = mk('text', {
        x: CARD_W / 2, y: CARD_H_BASE / 2 + 5, 'text-anchor': 'middle',
        'font-size': '12', 'font-weight': '600', fill: 'var(--text-normal)',
        'dominant-baseline': 'middle'
      });
      titleBg.textContent = t.length > 24 ? t.slice(0, 23) + '…' : t;
      g.appendChild(titleBg);

      // Row count badge
      const rowCount = tbl.rows.length;
      const badge = mk('text', {
        x: CARD_W - 8, y: CARD_H_BASE / 2 + 5, 'text-anchor': 'end',
        'font-size': '9', fill: 'var(--text-faint)', 'dominant-baseline': 'middle'
      });
      badge.textContent = `${rowCount} row${rowCount !== 1 ? 's' : ''}`;
      g.appendChild(badge);

      // Column rows
      tbl.columns.forEach((c, i) => {
        const cy = CARD_H_BASE + i * ROW_H;

        // Alternating row background
        if (i % 2 === 0) {
          g.appendChild(mk('rect', {
            x: 0, y: cy, width: CARD_W, height: ROW_H,
            fill: 'var(--background-secondary)', opacity: '0.5'
          }));
        }

        // Column name
        const nameText = mk('text', {
          x: 10, y: cy + ROW_H / 2 + 1, 'font-size': '10',
          fill: 'var(--text-normal)', 'dominant-baseline': 'middle'
        });
        nameText.textContent = c.name;
        g.appendChild(nameText);

        // Badges (PK / FK / AI / NN)
        const badges: Array<[string, string]> = [];
        if (c.pk) badges.push(['PK', 'var(--background-modifier-border)']);
        if (c.fk) badges.push(['FK', 'var(--background-modifier-border)']);
        if (c.ai) badges.push(['AI', 'var(--background-modifier-border)']);

        let bx = CARD_W - 8;
        // Type label
        const typeText = mk('text', {
          x: bx - (badges.length * 24), y: cy + ROW_H / 2 + 1,
          'font-size': '9', fill: 'var(--text-faint)', 'text-anchor': 'end', 'dominant-baseline': 'middle'
        });
        typeText.textContent = c.type;
        g.appendChild(typeText);

        // Badge pills
        badges.reverse().forEach(([label, color]) => {
          const pill = mk('g');
          pill.appendChild(mk('rect', {
            x: bx - 18, y: cy + 4, width: 18, height: 14,
            rx: '3', ry: '3', fill: color, opacity: '0.85'
          }));
          const bt = mk('text', {
            x: bx - 9, y: cy + ROW_H / 2 + 1, 'font-size': '8',
            fill: 'var(--text-normal)', 'text-anchor': 'middle', 'dominant-baseline': 'middle', 'font-weight': '600'
          });
          bt.textContent = label;
          pill.appendChild(bt);
          g.appendChild(pill);
          bx -= 22;
        });

        // Row divider
        if (i < tbl.columns.length - 1) {
          g.appendChild(mk('line', {
            x1: 0, y1: cy + ROW_H, x2: CARD_W, y2: cy + ROW_H,
            stroke: 'var(--background-modifier-border)', 'stroke-width': '0.5', opacity: '0.5'
          }));
        }
      });

      // Click to browse table
      g.onclick = (e) => {
        if (!dragging) { this.activeTab = t; this.render(); }
      };

      canvas.appendChild(g);
    });

    // Fit on next frame (after layout is available)
    window.requestAnimationFrame(() => fitToView());
  }

  // ── Cheatsheet ──────────────────────────────────────────────────────────────

  renderCheatsheet(el: HTMLElement): void {
    el.createEl('h2', { cls: 'mdb-content-title', text: 'SQL reference' });

    const S = (sql: string, desc: string): [string, string] => [sql, desc];

    const sections: Array<{ title: string; color: string; rows: Array<[string, string]> }> = [
      {
        title: 'Meta Commands (Terminal)', color: 'var(--color-blue)',
        rows: [
          S('\\dt', 'List all tables and views'),
          S('\\d tablename', 'Describe a table structure'),
          S('\\s', 'Show query history'),
          S('USE dbname  /  \\c dbname', 'Switch to a different database'),
          S('\\q  /  clear', 'Clear terminal output'),
        ]
      },
      {
        title: 'Foreign Keys — Connecting Tables', color: 'var(--color-red)',
        rows: [
          S('CREATE TABLE departments (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)',
            'Step 1: create the parent table with a PK'),
          S('CREATE TABLE employees (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, dept_id INTEGER, FOREIGN KEY (dept_id) REFERENCES departments(id))',
            'Step 2: create child table with FK column + REFERENCES'),
          S('INSERT INTO departments (name) VALUES (\'Engineering\')',
            'Step 3: insert parent row first'),
          S('INSERT INTO employees (name, dept_id) VALUES (\'Alice\', 1)',
            'Step 4: insert child row referencing parent id'),
          S('SELECT e.name, d.name AS dept FROM employees e JOIN departments d ON e.dept_id = d.id',
            'Step 5: query across both tables with JOIN'),
          S('SELECT * FROM employees WHERE dept_id = (SELECT id FROM departments WHERE name = \'Engineering\')',
            'Subquery: get employees in a named department'),
        ]
      },
      {
        title: 'DDL — Data Definition Language', color: 'var(--color-purple)',
        rows: [
          S('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT UNIQUE, age INTEGER DEFAULT 0)',
            'Create a table with common constraints'),
          S('CREATE TABLE IF NOT EXISTS users (...)',
            'Create only if it does not already exist'),
          S('DROP TABLE users', 'Delete table and all its data permanently'),
          S('DROP TABLE IF EXISTS users', 'Drop only if it exists (no error otherwise)'),
          S('ALTER TABLE users ADD COLUMN phone TEXT', 'Add a new column'),
          S('ALTER TABLE users DROP COLUMN phone', 'Remove a column'),
          S('ALTER TABLE users RENAME COLUMN old_name TO new_name', 'Rename a column'),
          S('ALTER TABLE users RENAME TO members', 'Rename a table'),
          S('ALTER TABLE users MODIFY COLUMN name TEXT NOT NULL', 'Change column type or constraints'),
          S('TRUNCATE TABLE users', 'Delete all rows but keep the table structure'),
          S('CREATE VIEW active_users AS SELECT * FROM users WHERE active = 1',
            'Create a virtual table (saved query)'),
          S('DROP VIEW active_users', 'Delete a view'),
          S('CREATE INDEX idx_email ON users (email)', 'Create an index for faster queries'),
          S('CREATE UNIQUE INDEX idx_email ON users (email)', 'Create a unique index'),
          S('DROP INDEX idx_email', 'Remove an index'),
        ]
      },
      {
        title: 'DML — Data Manipulation Language', color: 'var(--color-green)',
        rows: [
          S("INSERT INTO users (name, email) VALUES ('Alice', 'alice@example.com')",
            'Insert a single row'),
          S("INSERT INTO users (name) VALUES ('Bob'), ('Carol'), ('Dave')",
            'Insert multiple rows at once'),
          S("UPDATE users SET age = 31 WHERE name = 'Alice'", 'Update specific rows'),
          S('UPDATE users SET age = age + 1', 'Update all rows (no WHERE = affects all)'),
          S('DELETE FROM users WHERE id = 5', 'Delete specific rows'),
          S('DELETE FROM users', 'Delete all rows (keeps table structure)'),
        ]
      },
      {
        title: 'SELECT — Querying Data', color: 'var(--color-orange)',
        rows: [
          S('SELECT * FROM users', 'All columns, all rows'),
          S('SELECT id, name, email FROM users', 'Specific columns only'),
          S('SELECT DISTINCT country FROM users', 'Unique values only (removes duplicates)'),
          S("SELECT * FROM users WHERE age > 18 AND country = 'PH'", 'Filter with AND condition'),
          S("SELECT * FROM users WHERE name LIKE '%alice%'", 'Pattern match — % is wildcard, _ is one char'),
          S('SELECT * FROM users WHERE id IN (1, 2, 3)', 'Match against a list of values'),
          S('SELECT * FROM users WHERE age BETWEEN 18 AND 65', 'Range filter (inclusive)'),
          S('SELECT * FROM users WHERE email IS NULL', 'Find rows where a value is missing'),
          S('SELECT * FROM users WHERE email IS NOT NULL', 'Find rows where a value exists'),
          S('SELECT * FROM users ORDER BY age DESC, name ASC', 'Sort by multiple columns'),
          S('SELECT * FROM users LIMIT 10 OFFSET 20', 'Pagination: skip 20, take 10 (page 3)'),
          S('SELECT * FROM users ORDER BY id DESC LIMIT 1', 'Get the most recently inserted row'),
          S("SELECT id, name, CASE WHEN age < 18 THEN 'minor' WHEN age < 65 THEN 'adult' ELSE 'senior' END AS group FROM users",
            'Computed column with CASE WHEN'),
          S('SELECT id, COALESCE(phone, email, name) AS contact FROM users',
            'COALESCE: return first non-NULL value'),
        ]
      },
      {
        title: 'Aggregates & Grouping', color: 'var(--color-yellow)',
        rows: [
          S('SELECT COUNT(*) FROM users', 'Count all rows'),
          S('SELECT COUNT(email) FROM users', 'Count non-NULL values only'),
          S('SELECT SUM(price), AVG(price), MIN(price), MAX(price) FROM orders',
            'Numeric aggregate functions'),
          S('SELECT country, COUNT(*) AS total FROM users GROUP BY country',
            'Group and count per country'),
          S('SELECT dept, AVG(salary) FROM employees GROUP BY dept HAVING AVG(salary) > 50000',
            'HAVING filters groups (like WHERE but after GROUP BY)'),
          S('SELECT dept, COUNT(*) AS headcount, ROUND(AVG(salary), 2) AS avg_pay FROM employees GROUP BY dept ORDER BY avg_pay DESC',
            'Full aggregate example with sort'),
        ]
      },
      {
        title: 'JOINs — Combining Tables', color: 'var(--color-red)',
        rows: [
          S('SELECT u.name, o.total FROM users u JOIN orders o ON u.id = o.user_id',
            'INNER JOIN — only rows with a match in both tables'),
          S('SELECT u.name, o.total FROM users u LEFT JOIN orders o ON u.id = o.user_id',
            'LEFT JOIN — all users, NULL for orders they do not have'),
          S('SELECT a.name AS employee, b.name AS manager FROM employees a JOIN employees b ON a.manager_id = b.id',
            'Self join — joining a table to itself'),
          S('SELECT u.name, COUNT(o.id) AS orders FROM users u LEFT JOIN orders o ON u.id = o.user_id GROUP BY u.id',
            'JOIN with COUNT — how many orders per user'),
          S('SELECT u.name, d.name AS dept, COUNT(o.id) AS orders FROM users u JOIN departments d ON u.dept_id = d.id LEFT JOIN orders o ON u.id = o.user_id GROUP BY u.id',
            'Three-table JOIN'),
        ]
      },
      {
        title: 'UNION, INTERSECT, EXCEPT', color: 'var(--color-cyan)',
        rows: [
          S('SELECT name FROM customers UNION SELECT name FROM suppliers',
            'Combine results and remove duplicates'),
          S('SELECT name FROM customers UNION ALL SELECT name FROM suppliers',
            'Combine results and keep duplicates'),
          S('SELECT id FROM active_users INTERSECT SELECT id FROM premium_users',
            'Rows that exist in BOTH result sets'),
          S('SELECT id FROM all_users EXCEPT SELECT id FROM banned_users',
            'Rows in first set but NOT in second'),
        ]
      },
      {
        title: 'CTEs — WITH Clause', color: 'var(--color-green)',
        rows: [
          S("WITH recent AS (SELECT * FROM orders WHERE date > '2024-01-01') SELECT * FROM recent WHERE total > 100",
            'Named subquery — cleaner than nesting'),
          S('WITH dept_avg AS (SELECT dept, AVG(salary) AS avg FROM employees GROUP BY dept) SELECT e.name, d.avg FROM employees e JOIN dept_avg d ON e.dept = d.dept',
            'Reuse the same subquery multiple times'),
        ]
      },
      {
        title: 'Scalar Functions', color: 'var(--color-blue)',
        rows: [
          S('UPPER(name), LOWER(email)', 'Change string case'),
          S('LENGTH(name)', 'String length in characters'),
          S('TRIM(name), LTRIM(name), RTRIM(name)', 'Remove leading/trailing whitespace'),
          S('SUBSTR(name, 1, 3)', 'Extract substring (1-indexed)'),
          S('REPLACE(name, old, new)', 'Replace all occurrences'),
          S("CONCAT(first_name, ' ', last_name)", 'Join strings together'),
          S('ABS(n), ROUND(n, 2), FLOOR(n), CEIL(n)', 'Math functions'),
          S('COALESCE(phone, email, name)', 'First non-NULL value from the list'),
          S('NULLIF(a, b)', 'Returns NULL if a equals b'),
          S("IFNULL(phone, 'N/A')", 'Replace NULL with a default value'),
          S('NOW()', 'Current date and time'),
        ]
      },
      {
        title: 'Transactions', color: 'var(--color-pink)',
        rows: [
          S('BEGIN;', 'Start a transaction block'),
          S('INSERT INTO ...; UPDATE ...;', 'Run multiple statements'),
          S('COMMIT;', 'Save all changes in the transaction'),
          S('ROLLBACK;', 'Undo all changes since BEGIN'),
        ]
      },
      {
        title: 'Inspection & Utilities', color: 'var(--color-cyan)',
        rows: [
          S('SHOW TABLES', 'List all tables and views in the database'),
          S('DESCRIBE users', 'Show column info: name, type, nullability, key, default'),
          S('PRAGMA table_info(users)', 'SQLite-style column info'),
          S('PRAGMA foreign_key_list(employees)', 'Show all foreign keys on a table'),
          S('EXPLAIN SELECT * FROM users WHERE email IS NOT NULL', 'Show query execution plan'),
        ]
      },
    ];

    sections.forEach(section => {
      const s = el.createDiv({ cls: 'mdb-cheat-section' });
      const sh = s.createDiv({ cls: 'mdb-cheat-section-hdr' });
      sh.createSpan({ text: section.title, cls: 'mdb-cheat-section-title' });

      const tbl = s.createEl('table', { cls: 'mdb-result-table mdb-cheat-table' });
      const tbody = tbl.createEl('tbody');
      section.rows.forEach(([sql, desc]) => {
        const tr = tbody.createEl('tr');
        const codeTd = tr.createEl('td', { cls: 'mdb-cheat-code' });
        codeTd.createEl('code', { text: sql });
        tr.createEl('td', { cls: 'mdb-cheat-desc', text: desc });
        codeTd.title = 'Click to copy to terminal';
        codeTd.onclick = () => { this.activeTab = 'sql'; this.sqlInitial = sql; this.sqlOutput = ''; this.render(); };
      });
    });
  }

  // ── Tables overview ────────────────────────────────────────────────────────

  renderTablesOverview(el: HTMLElement): void {
    const hdr = el.createDiv({ cls: 'mdb-content-hdr' });
    hdr.createEl('h2', { cls: 'mdb-content-title', text: 'Tables' });
    const newBtn = hdr.createEl('button', { cls: 'mdb-btn mdb-btn-primary' });
    setButtonContent(newBtn, 'plus', 'New table');
    newBtn.onclick = () => new NewTableModal(this.app, this.db, () => this.persistAndRender()).open();
    const importBtn = hdr.createEl('button', { cls: 'mdb-btn' });
    setButtonContent(importBtn, 'upload', 'Import CSV');
    importBtn.onclick = () => this.importCSV();

    const db = this.db;
    if (!db) return;
    const tables = db.tables();
    if (!tables.length) {
      const empty = el.createDiv({ cls: 'mdb-empty' });
      const emptyIcon = empty.createDiv({ cls: 'mdb-empty-icon' });
      setIcon(emptyIcon, 'table-2');
      empty.createEl('h3', { text: 'No tables yet' });
      empty.createEl('p', { text: 'Create a table or import existing CSV data.' });
      const row = empty.createDiv({ cls: 'mdb-empty-actions' });
      const csvBtn = row.createEl('button', { cls: 'mdb-btn mdb-btn-primary' });
      setButtonContent(csvBtn, 'upload', 'Import CSV');
      csvBtn.onclick = () => this.importCSV();
      const sqlBtn = row.createEl('button', { cls: 'mdb-btn' });
      setButtonContent(sqlBtn, 'square-terminal', 'Open SQL');
      sqlBtn.onclick = () => { this.activeTab = 'sql'; this.render(); };
      return;
    }

    const grid = el.createDiv({ cls: 'mdb-tables-grid' });
    tables.forEach(t => {
      const tbl = db.tableData(t);
      if (!tbl) return;
      const card = grid.createDiv({ cls: 'mdb-table-card' });
      const ch = card.createDiv({ cls: 'mdb-table-card-hdr' });
      const cardIcon = ch.createSpan({ cls: 'mdb-table-card-icon' });
      setIcon(cardIcon, 'table-2');
      ch.createSpan({ cls: 'mdb-table-card-name', text: t });
      ch.createSpan({
        cls: 'mdb-table-card-count',
        text: `${tbl.rows.length} ${tbl.rows.length === 1 ? 'row' : 'rows'}`,
      });

      const actions = card.createDiv({ cls: 'mdb-table-card-actions' });
      const openBtn = actions.createEl('button', { cls: 'mdb-btn' });
      setButtonContent(openBtn, 'arrow-right', 'Open');
      openBtn.onclick = () => { this.activeTab = t; this.render(); };
      const descBtn = actions.createEl('button', { cls: 'mdb-btn' });
      setButtonContent(descBtn, 'text-search', 'Describe');
      descBtn.onclick = () => { this.activeTab = 'sql'; this.sqlInitial = `DESCRIBE ${t};`; this.render(); };
      const dropBtn = actions.createEl('button', { cls: 'mdb-btn mdb-btn-danger mdb-btn-icon' });
      setIcon(dropBtn, 'trash-2');
      dropBtn.setAttribute('aria-label', `Delete ${t}`);
      dropBtn.title = 'Delete table';
      dropBtn.onclick = () => {
        const modal = new ConfirmModal(this.app, `Drop table "${t}"? This cannot be undone.`, async () => {
          this.db.exec(`DROP TABLE ${t}`);
          await this.persistAndRender();
        });
        modal.open();
      };
    });
  }

  // ── SQL Terminal ───────────────────────────────────────────────────────────

  renderSQLTerminal(el: HTMLElement): void {
    const db = this.db;
    if (!db) return;
    const hdr = el.createDiv({ cls: 'mdb-content-hdr' });
    const titleWrap = hdr.createDiv({ cls: 'mdb-sql-title-wrap' });
    titleWrap.createEl('h2', { cls: 'mdb-content-title', text: 'SQL' });
    titleWrap.createSpan({ cls: 'mdb-sql-prompt-db', text: db.name });

    // Editor
    const textarea = el.createEl('textarea', { cls: 'mdb-sql-editor' });
    textarea.placeholder = 'Write a SQL query…';
    textarea.value = this.sqlInitial || '';
    this.sqlInitial = null;

    // Controls
    const controls = el.createDiv({ cls: 'mdb-sql-controls' });
    const runBtn = controls.createEl('button', { cls: 'mdb-btn mdb-btn-primary' });
    setButtonContent(runBtn, 'play', 'Run');
    runBtn.type = 'button';
    const clearBtn = controls.createEl('button', { cls: 'mdb-btn' });
    setButtonContent(clearBtn, 'eraser', 'Clear');
    clearBtn.type = 'button';
    clearBtn.setAttribute('aria-label', 'Clear query and results');
    clearBtn.title = 'Clear query and results';

    const snippetsEl = controls.createDiv({ cls: 'mdb-sql-snippets' });
    const snippets: Array<[string, string]> = [
      ['\\dt', '\\dt'],
      ['SELECT *', 'SELECT * FROM '],
      ['CREATE TABLE', 'CREATE TABLE my_table (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  name TEXT NOT NULL\n);'],
      ['INSERT', "INSERT INTO  (col1, col2)\nVALUES ('val1', 'val2');"],
      ['DESCRIBE', 'DESCRIBE '],
    ];
    snippets.forEach(([label, sql]) => {
      const btn = snippetsEl.createEl('button', { cls: 'mdb-snippet-btn', text: label });
      btn.type = 'button';
      btn.onclick = () => { textarea.value = sql; textarea.focus(); };
    });

    // Output area — newest on top
    const outputEl = el.createDiv({ cls: 'mdb-sql-output' });
    const clearTerminal = () => {
      textarea.value = '';
      outputEl.empty();
      this.sqlOutputBlocks = [];
      this.historyIdx = -1;
      textarea.focus();
    };

    // Restore persisted output blocks — prepend oldest first so newest ends up on top
    if (this.sqlOutputBlocks && this.sqlOutputBlocks.length) {
      this.sqlOutputBlocks.forEach(block => {
        this._renderOutputBlock(outputEl, block, false);
      });
    }

    const runSQL = async () => {
      const raw = textarea.value.trim();
      if (!raw) return;

      if (this.sqlHistory[0] !== raw) {
        this.sqlHistory.unshift(raw);
        if (this.sqlHistory.length > 100) this.sqlHistory.pop();
      }
      this.historyIdx = -1;

      const start = Date.now();
      const timestamp = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

      const metaResult = this.handleMetaCommand(raw);
      if (metaResult !== null) {
        if (metaResult === '__CLEAR__') {
          clearTerminal();
          return;
        }
        if (metaResult === '__HISTORY__') {
          this._storeAndPrependBlock(outputEl, {
            type: 'result',
            sql: '\\s', timestamp, elapsed: 0,
            result: { type: 'rows', columns: ['#', 'Query'], rows: this.sqlHistory.map((q, i) => [i + 1, q]) }
          });
          return;
        }
        if ('__switch__' in metaResult) {
          const target = metaResult.__switch__.toLowerCase();
          const files = await this.getDBFiles();
          let fp: string | null = null;
          for (const f of files) {
            const stem = f.split('/').pop()?.replace('.motiondb.json', '') || '';
            if (stem.toLowerCase() === target) { fp = f; break; }
          }
          if (!fp) {
            for (const f of files) {
              const db = await this.plugin.getDatabase(f);
              if (db.name.toLowerCase() === target) { fp = f; break; }
            }
          }
          if (!fp) {
            this._storeAndPrependBlock(outputEl, {
              type: 'error', sql: raw, timestamp, elapsed: Date.now() - start,
              message: `Database "${metaResult.__switch__}" not found.`
            });
            return;
          }
          await this.loadDB(fp);
          return;
        }
        this._storeAndPrependBlock(outputEl, { type: 'result', sql: raw, timestamp, elapsed: Date.now() - start, result: metaResult });
        return;
      }

      try {
        const results = db.exec(raw);
        const elapsed = Date.now() - start;
        // If the batch included a COMMIT, write to disk immediately (bypass debounce).
        // If it included a ROLLBACK, don't write — the data was intentionally discarded.
        const hasCommit = results.some(result => result.type === 'ok' && result._committed);
        const hasRollback = results.some(result => result.type === 'ok' && result._rolledBack);
        if (hasCommit) {
          await this.db.save();
          if (this.db.engine) this.db.engine._dirty = false;
        } else if (!hasRollback) {
          this._scheduleSave();
        }
        results.forEach((result, i) => {
          this._storeAndPrependBlock(outputEl, {
            type: 'result',
            sql: i === 0 ? raw : null,
            timestamp: i === 0 ? timestamp : null,
            elapsed, result
          });
        });
      } catch (err) {
        this._storeAndPrependBlock(outputEl, { type: 'error', sql: raw, timestamp, elapsed: Date.now() - start, message: errorMessage(err) });
      }
    };

    const executeFromUI = () => {
      void runSQL().catch(error => {
        this._storeAndPrependBlock(outputEl, {
          type: 'error',
          sql: textarea.value.trim() || null,
          message: errorMessage(error),
        });
      });
    };

    textarea.onkeydown = e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); executeFromUI(); return; }
      if (e.key === 'ArrowUp' && e.ctrlKey) {
        e.preventDefault();
        if (this.historyIdx < this.sqlHistory.length - 1) { this.historyIdx++; textarea.value = this.sqlHistory[this.historyIdx]; }
        return;
      }
      if (e.key === 'ArrowDown' && e.ctrlKey) {
        e.preventDefault();
        if (this.historyIdx > 0) { this.historyIdx--; textarea.value = this.sqlHistory[this.historyIdx]; }
        else if (this.historyIdx === 0) { this.historyIdx = -1; textarea.value = ''; }
        return;
      }
    };

    runBtn.onclick = executeFromUI;
    clearBtn.onclick = clearTerminal;
    textarea.focus();
  }

  _storeAndPrependBlock(outputEl: HTMLElement, block: SqlOutputBlock): void {
    if (!this.sqlOutputBlocks) this.sqlOutputBlocks = [];
    this.sqlOutputBlocks.push(block);
    if (this.sqlOutputBlocks.length > 50) this.sqlOutputBlocks.shift();
    this._renderOutputBlock(outputEl, block, false);
  }

  _renderOutputBlock(container: HTMLElement, block: SqlOutputBlock, append = false): void {
    const wrap = container.createDiv({ cls: 'mdb-sql-result' });
    if (!append) container.insertBefore(wrap, container.firstChild);

    const result = block.type === 'result' ? block.result : null;
    const isError = block.type === 'error' || result?.type === 'error';

    // SQL echo header
    if (block.sql) {
      const echo = wrap.createDiv({ cls: 'mdb-sql-echo' });
      echo.createEl('code', {
        cls: 'mdb-sql-echo-text',
        text: block.sql.length > 140 ? block.sql.slice(0, 140) + '…' : block.sql,
      });
      echo.createSpan({
        cls: 'mdb-sql-echo-meta',
        text: [block.timestamp, block.elapsed != null ? `${block.elapsed}ms` : null].filter(Boolean).join(' · '),
      });
    }

    // Result body
    if (isError) {
      const errEl = wrap.createDiv({ cls: 'mdb-sql-error' });
      errEl.setAttribute('role', 'alert');
      const icon = errEl.createSpan({ cls: 'mdb-error-icon' }); setIcon(icon, 'alert-circle');
      const errorCopy = errEl.createDiv({ cls: 'mdb-feedback-copy' });
      errorCopy.createEl('strong', { cls: 'mdb-feedback-title', text: 'Query failed' });
      const errorMessage = block.type === 'error'
        ? block.message
        : result?.type === 'error' ? result.message : 'The query could not be completed.';
      errorCopy.createDiv({ cls: 'mdb-error-msg', text: errorMessage });

    } else if (result?.type === 'ok') {
      const okEl = wrap.createDiv({ cls: 'mdb-sql-ok' });
      okEl.setAttribute('role', 'status');
      const icon = okEl.createSpan({ cls: 'mdb-ok-icon' }); setIcon(icon, 'check');
      const successCopy = okEl.createDiv({ cls: 'mdb-feedback-copy' });
      successCopy.createEl('strong', { cls: 'mdb-feedback-title', text: 'Query complete' });
      successCopy.createDiv({ cls: 'mdb-ok-msg', text: result.message || 'The query completed successfully.' });
      okEl.createSpan({ cls: 'mdb-sql-elapsed', text: block.elapsed != null ? `${block.elapsed}ms` : '' });

    } else if (result?.type === 'rows') {
      const rowCount = result.rows.length;
      const meta = wrap.createDiv({ cls: 'mdb-result-meta' });
      meta.createSpan({
        cls: 'mdb-result-count',
        text: rowCount === 0 ? 'Empty set (0 rows)' : `${rowCount} row${rowCount !== 1 ? 's' : ''}`,
      });
      if (block.elapsed != null && block.sql) {
        meta.createSpan({ cls: 'mdb-sql-elapsed', text: `${block.elapsed}ms` });
      }

      if (rowCount > 0) {
        const tableWrap = wrap.createDiv({ cls: 'mdb-result-table-wrap' });
        const table = tableWrap.createEl('table', { cls: 'mdb-result-table' });
        const thead = table.createTHead().insertRow();
        result.columns.forEach(c => { thead.createEl('th', { text: String(c) }); });
        const tbody = table.createTBody();
        result.rows.forEach(row => {
          const tr = tbody.insertRow();
          row.forEach(val => {
            const td = tr.insertCell();
            if (val === null || val === undefined) {
              td.createSpan({ cls: 'mdb-null', text: 'NULL' });
            } else if (typeof val === 'boolean') {
              td.createSpan({ cls: val ? 'mdb-bool-true' : 'mdb-bool-false', text: val ? 'TRUE' : 'FALSE' });
            } else { td.textContent = String(val); }
          });
        });
      }
    }
  }

  appendOutput(container: HTMLElement, result: SqlRenderResult, elapsed: number): void {
    this._renderOutputBlock(container, { type: 'result', result, elapsed }, false);
  }

  appendError(container: HTMLElement, message: string): void {
    this._renderOutputBlock(container, { type: 'error', message }, false);
  }

  handleMetaCommand(raw: string): SqlRenderResult | { __switch__: string } | '__CLEAR__' | '__HISTORY__' | null {
    const s = raw.trim().replace(/;$/, '').trim();
    const lower = s.toLowerCase();
    if (lower === '\\q' || lower === 'clear') return '__CLEAR__';
    if (lower === '\\s') return '__HISTORY__';
    if (lower === '\\dt' || lower === 'show tables') return this.db.exec('SHOW TABLES')[0];
    if (lower.startsWith('\\d ')) {
      const tname = s.slice(3).trim();
      try { return this.db.exec(`DESCRIBE ${tname}`)[0]; } catch (e) { return { type: 'error', message: errorMessage(e) }; }
    }
    if (lower.startsWith('\\c ') || lower.startsWith('use ')) {
      const dbName = s.replace(/^(\\c|use)\s+/i, '').trim();
      return { __switch__: dbName };
    }
    return null;
  }

  async getDBFiles(): Promise<string[]> {
    let files: string[] = [];
    try {
      const d = await this.plugin.app.vault.adapter.list(DB_DIR);
      files = (d.files || []).filter(f => f.endsWith('.motiondb.json'));
    } catch (error) {
      console.error('[MotionDB] Could not list database files:', error);
    }
    return files;
  }

  // ── Table browse view ─────────────────────────────────────────────────────

  renderTableView(el: HTMLElement, tableName: string): void {
    const db = this.db;
    if (!db) return;
    const tbl = db.tableData(tableName);
    if (!tbl) { el.createDiv({ cls: 'mdb-empty', text: `Table "${tableName}" not found.` }); return; }

    // Header
    const hdr = el.createDiv({ cls: 'mdb-content-hdr' });
    const tableTitle = hdr.createDiv({ cls: 'mdb-title-with-icon' });
    const tableTitleIcon = tableTitle.createSpan({ cls: 'mdb-title-icon' });
    setIcon(tableTitleIcon, 'table-2');
    tableTitle.createEl('h2', { cls: 'mdb-content-title', text: tableName });
    const metaEl = hdr.createSpan({ cls: 'mdb-table-meta', text: `${tbl.columns.length} columns · ${tbl.rows.length} rows` });

    const actions = hdr.createDiv({ cls: 'mdb-hdr-actions' });
    const structBtn = actions.createEl('button', { cls: 'mdb-btn' });
    setButtonContent(structBtn, 'columns-3', 'Structure');
    structBtn.onclick = () => new StructureModal(this.app, this.db, tableName, () => this.persistAndRender()).open();
    const sqlBtn = actions.createEl('button', { cls: 'mdb-btn' });
    setButtonContent(sqlBtn, 'square-terminal', 'Query');
    sqlBtn.onclick = () => { this.activeTab = 'sql'; this.sqlInitial = `SELECT * FROM ${tableName} LIMIT 100;`; this.render(); };
    const exportBtn = actions.createEl('button', { cls: 'mdb-btn' });
    setButtonContent(exportBtn, 'download', 'Export');
    exportBtn.onclick = () => this.exportCSV(tableName);
    const importBtn = actions.createEl('button', { cls: 'mdb-btn' });
    setButtonContent(importBtn, 'upload', 'Import');
    importBtn.onclick = () => this.importCSV(tableName);
    const addRowBtn = actions.createEl('button', { cls: 'mdb-btn mdb-btn-primary' });
    setButtonContent(addRowBtn, 'plus', 'Add row');
    addRowBtn.type = 'button';
    addRowBtn.setAttribute('aria-label', 'Go to new row');

    // Column strip
    const colRow = el.createDiv({ cls: 'mdb-col-strip' });
    tbl.columns.forEach(c => {
      const badge = colRow.createSpan({ cls: 'mdb-col-badge' });
      badge.createSpan({ cls: 'mdb-col-badge-type', text: c.type });
      badge.createSpan({ cls: 'mdb-col-badge-name', text: c.name });
      const presentation = storedColumnPropertyFormat(c);
      if (presentation) badge.createSpan({ cls: 'mdb-col-key mdb-presentation-key', text: presentation.type === 'rating' ? presentation.style : presentation.type });
      if (c.pk) badge.createSpan({ cls: 'mdb-col-key mdb-pk', text: 'PK' });
      if (c.fk) badge.createSpan({ cls: 'mdb-col-key mdb-fk', text: `FK→${c.fk.table}` });
      if (c.ai) badge.createSpan({ cls: 'mdb-col-key mdb-ai', text: 'AI' });
      if (c.notNull && !c.pk) badge.createSpan({ cls: 'mdb-col-key mdb-nn', text: 'NN' });
    });

    const wrap = el.createDiv({ cls: 'mdb-table-wrap' });
    const table = wrap.createEl('table', { cls: 'mdb-table' });

    // ── Header row ──
    const thead = table.createEl('thead').createEl('tr');
    thead.createEl('th', { cls: 'mdb-th mdb-th-num', text: '#' });
    tbl.columns.forEach(c => {
      const th = thead.createEl('th', { cls: 'mdb-th' });
      const inner = th.createDiv({ cls: 'mdb-th-inner' });
      inner.createSpan({ cls: 'mdb-th-name', text: c.name });
      const presentation = storedColumnPropertyFormat(c);
      inner.createSpan({ cls: 'mdb-th-type', text: presentation ? `${c.type} · ${presentation.type === 'rating' ? presentation.style : presentation.type}` : c.type });
      if (c.pk) inner.createSpan({ cls: 'mdb-col-key mdb-pk', text: 'PK' });
    });
    thead.createEl('th', { cls: 'mdb-th mdb-th-act' });

    const tbody = table.createEl('tbody');

    // ── Helper: build a cell input for a given column ──
    const buildInput = (parent: HTMLElement, c: DbColumn, value: unknown, inputMap: Record<string, HTMLInputElement>): HTMLInputElement => {
      // FK column — show a datalist for autocomplete
      if (c.fk) {
        const refTbl = db.tableData(c.fk.table);
        const inp = parent.createEl('input');
        inp.className = 'mdb-cell-input';
        inp.value = value !== null && value !== undefined ? String(value) : '';
        inp.placeholder = 'NULL';
        if (refTbl) {
          const dlId = `mdb-dl-${tableName}-${c.name}`;
          let dl = document.getElementById(dlId);
          if (!dl) {
            const dataList = document.body.createEl('datalist');
            dataList.id = dlId;
            refTbl.rows.forEach(r => {
              const opt = dataList.createEl('option');
              opt.value = String(r[c.fk.col] ?? '');
              const label = Object.values(r).slice(0, 3).map(value => toDisplayString(value, true)).join(' · ');
              opt.label = label;
            });
            dl = dataList;
          }
          inp.setAttribute('list', dlId);
        }
        inputMap[c.name] = inp;
        return inp;
      }
      // Boolean / INTEGER 0-1 — checkbox
      const presentation = storedColumnPropertyFormat(c);
      if (presentation?.type === 'checkbox' || (!c.presentation && c.type === 'INTEGER' && (c.name.startsWith('is_') || c.name.startsWith('has_')))) {
        const inp = parent.createEl('input');
        inp.type = 'checkbox';
        inp.className = 'mdb-cell-check';
        inp.checked = value === true || value === 1 || value === '1' || value === 'true';
        inputMap[c.name] = inp;
        return inp;
      }
      // Default — text input
      const inp = parent.createEl('input');
      inp.className = 'mdb-cell-input';
      const initialValue = value !== null && value !== undefined ? String(value) : '';
      inp.placeholder = c.notNull ? (c.default !== undefined ? String(c.default) : '') : 'NULL';
      if (c.type === 'INTEGER' || c.type === 'REAL') inp.inputMode = 'decimal';
      if (presentation?.type === 'rating') {
        if (!initialValue || Number.isFinite(Number(initialValue))) {
          inp.type = 'number';
          inp.min = '0';
          inp.max = String(presentation.max || 5);
          inp.step = '1';
        }
      }
      if (c.type === 'DATE' && (!initialValue || /^\d{4}-\d{2}-\d{2}$/.test(initialValue))) inp.type = 'date';
      inp.value = initialValue;
      inputMap[c.name] = inp;
      return inp;
    };

    const renderStoredCell = (td: HTMLTableCellElement, column: DbColumn, value: unknown): void => {
      td.empty();
      if (value === null || value === undefined) {
        td.createSpan({ cls: 'mdb-null', text: 'NULL' });
        return;
      }
      const format = storedColumnPropertyFormat(column);
      if (format) renderEmbedPropertyValue(td, value, format, { app: this.app });
      else td.setText(String(value));
    };

    // ── Helper: read input value → SQL literal ──
    const readVal = (c: DbColumn, inputMap: Record<string, HTMLInputElement>): string => {
      const inp = inputMap[c.name];
      if (!inp) return 'NULL';
      if (inp.type === 'checkbox') return inp.checked ? '1' : '0';
      const v = inp.value;
      if (v === '' || v.trim().toUpperCase() === 'NULL') return 'NULL';
      if (c.type === 'INTEGER' || c.type === 'REAL') return isNaN(Number(v)) ? `'${v.replace(/'/g, "''")}'` : v;
      return `'${v.replace(/'/g, "''")}'`;
    };

    // ── Existing rows ──
    const renderDataRow = (row: DbRow, i: number, before: HTMLTableRowElement | null = null): HTMLTableRowElement => {
      const tr = tbody.createEl('tr', { cls: 'mdb-tr' });
      if (before) tbody.insertBefore(tr, before);
      let editMode = false;
      const inputMap: Record<string, HTMLInputElement> = {};

      const numTd = tr.createEl('td', { cls: 'mdb-td mdb-td-num' });
      numTd.createSpan({ cls: 'mdb-row-num', text: String(i + 1) });

      // Data cells — render as display or input depending on editMode
      const cellTds = tbl.columns.map(c => {
        const td = tr.createEl('td', { cls: 'mdb-td' });
        const val = row[c.name];
        renderStoredCell(td, c, val);
        // Click on non-PK cell to enter edit mode
        if (!c.pk && !c.ai) {
          td.classList.add('is-editable');
          td.onclick = () => { if (!editMode) enterEdit(c.name); };
          td.tabIndex = 0;
          td.setAttribute('aria-label', `Edit ${c.name}`);
          td.onkeydown = event => {
            if (event.target !== td) return;
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              if (!editMode) enterEdit(c.name);
            }
          };
        }
        return { td, col: c };
      });

      const actTd = tr.createEl('td', { cls: 'mdb-td mdb-td-act' });

      const enterEdit = (focusColumnName?: string) => {
        if (editMode) return;
        editMode = true;
        tr.addClass('mdb-tr-editing');

        cellTds.forEach(({ td, col }) => {
          td.empty();
          if (col.pk || col.ai) {
            // PK/AI — show value as locked badge
            td.createSpan({ cls: 'mdb-cell-locked', text: String(row[col.name] ?? '') });
          } else {
            buildInput(td, col, row[col.name], inputMap);
          }
        });

        // Replace action cell with save/cancel
        actTd.empty();
        const saveBtn = actTd.createEl('button', { cls: 'mdb-cell-save' });
        setIcon(saveBtn, 'check');
        saveBtn.title = 'Save changes';
        saveBtn.setAttribute('aria-label', 'Save row changes');
        const cancelBtn = actTd.createEl('button', { cls: 'mdb-cell-cancel' });
        setIcon(cancelBtn, 'x');
        cancelBtn.title = 'Cancel changes';
        cancelBtn.setAttribute('aria-label', 'Cancel row changes');

        // Tab navigation across editable inputs
        const inputs = cellTds
          .filter(({ col }) => !col.pk && !col.ai)
          .map(({ col }) => inputMap[col.name])
          .filter(Boolean);
        inputs.forEach((inp, idx) => {
          inp.onkeydown = e => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void saveEdit().catch(error => new Notice(`Could not save row: ${errorMessage(error)}`));
            }
            if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
            if (e.key === 'Tab' && !e.shiftKey && idx === inputs.length - 1) {
              e.preventDefault();
              void saveEdit().catch(error => new Notice(`Could not save row: ${errorMessage(error)}`));
            }
          };
        });
        const focusInput = (focusColumnName ? inputMap[focusColumnName] : null) || inputs[0];
        focusInput?.focus();

        saveBtn.onclick = saveEdit;
        cancelBtn.onclick = cancelEdit;
      };

      const saveEdit = async () => {
        const pkCol = tbl.columns.find(c => c.pk);
        const editableColumns = tbl.columns.filter(c => !c.pk && !c.ai);
        try {
          if (pkCol) {
            const sets = editableColumns.map(c => `${c.name} = ${readVal(c, inputMap)}`).join(', ');
            const pkVal = row[pkCol.name];
            const pkLit = typeof pkVal === 'number' ? String(pkVal) : `'${String(pkVal).replace(/'/g, "''")}'`;
            this.db.exec(`UPDATE ${tableName} SET ${sets} WHERE ${pkCol.name} = ${pkLit}`);
          } else {
            const values: Record<string, unknown> = {};
            editableColumns.forEach(column => {
              const input = inputMap[column.name];
              if (!input) return;
              values[column.name] = input.type === 'checkbox'
                ? (input.checked ? 1 : 0)
                : input.value === '' ? null : input.value;
            });
            this.db.engine.updateRowByReference(tableName, row, values);
          }
          exitEditDisplay();
          this._scheduleSave();
        } catch (e) {
          new Notice(`Could not save row: ${errorMessage(e)}`);
          this.render();
        }
      };

      const cancelEdit = () => { exitEditDisplay(); };

      const exitEditDisplay = () => {
        editMode = false;
        tr.removeClass('mdb-tr-editing');
        cellTds.forEach(({ td, col }) => {
          td.empty();
          const val = row[col.name];
          renderStoredCell(td, col, val);
        });
        actTd.empty();
        const del = actTd.createEl('button', { cls: 'mdb-del-btn' });
        setIcon(del, 'trash-2');
        del.setAttribute('aria-label', 'Delete row');
        del.onclick = doDelete;
      };

      const doDelete = async (e?: MouseEvent): Promise<void> => {
        if (e) e.stopPropagation();
        const pkCol = tbl.columns.find(c => c.pk);
        if (pkCol) {
          try {
            const pkVal = row[pkCol.name];
            const pkLit = typeof pkVal === 'number' ? String(pkVal) : `'${String(pkVal).replace(/'/g, "''")}'`;
            this.db.exec(`DELETE FROM ${tableName} WHERE ${pkCol.name} = ${pkLit}`);
          } catch (e) { new Notice(`Error: ${errorMessage(e)}`); return; }
        } else {
          const idx = tbl.rows.indexOf(row);
          if (idx !== -1) {
            tbl.rows.splice(idx, 1);
            this.db.engine._dirty = true;
          }
        }
        tr.remove();
        Array.from(tbody.querySelectorAll('.mdb-row-num')).forEach((number, index) => number.setText(String(index + 1)));
        metaEl.textContent = `${tbl.columns.length} columns · ${tbl.rows.length} rows`;
        this._scheduleSave();
      };

      // Initial delete button
      const del = actTd.createEl('button', { cls: 'mdb-del-btn' });
      setIcon(del, 'trash-2');
      del.setAttribute('aria-label', 'Delete row');
      del.onclick = doDelete;
      return tr;
    };
    tbl.rows.forEach((row, index) => renderDataRow(row, index));

    // ── Inline insert row ──
    const insertRow = tbody.createEl('tr', { cls: 'mdb-tr mdb-tr-insert' });
    const insertInputMap: Record<string, HTMLInputElement> = {};

    insertRow.createEl('td', { cls: 'mdb-td mdb-td-num' }).createSpan({ cls: 'mdb-insert-icon', text: '+' });

    tbl.columns.forEach(c => {
      const td = insertRow.createEl('td', { cls: 'mdb-td' });
      if (c.ai) {
        td.createSpan({ cls: 'mdb-cell-locked', text: 'auto' });
      } else {
        buildInput(td, c, null, insertInputMap);
      }
    });

    const insertActTd = insertRow.createEl('td', { cls: 'mdb-td mdb-td-act' });
    const doInsertBtn = insertActTd.createEl('button', { cls: 'mdb-cell-save' });
    setIcon(doInsertBtn, 'plus');
    doInsertBtn.title = 'Insert row';
    doInsertBtn.setAttribute('aria-label', 'Insert row');

    const doInsert = async (focusAfter = true) => {
      try {
        const cols = tbl.columns.filter(c => !c.ai).map(c => c.name);
        const values = tbl.columns.filter(c => !c.ai).map(c => readVal(c, insertInputMap));
        db.exec(`INSERT INTO ${tableName} (${cols.join(', ')}) VALUES (${values.join(', ')})`);
        metaEl.textContent = `${tbl.columns.length} columns · ${tbl.rows.length} rows`;
        this._scheduleSave();
        // Use the same controls/edit handlers as existing rows, without
        // rebuilding the table or using a second SQL deletion path.
        const newRow = tbl.rows[tbl.rows.length - 1];
        if (!newRow) throw new Error('The database did not return the inserted row.');
        const newTr = renderDataRow(newRow, tbl.rows.length - 1, insertRow);
        newTr.addClass('mdb-tr-flash');
        window.setTimeout(() => newTr.classList.remove('mdb-tr-flash'), 600);
        // Reset insert inputs
        tbl.columns.filter(c => !c.ai).forEach(c => {
          const inp = insertInputMap[c.name];
          if (!inp) return;
          if (inp.type === 'checkbox') inp.checked = false;
          else inp.value = '';
        });
        if (focusAfter) {
          const first = tbl.columns.find(c => !c.ai);
          if (first && insertInputMap[first.name]) insertInputMap[first.name].focus();
        }
      } catch (e) { new Notice(`Error: ${errorMessage(e)}`); }
    };

    doInsertBtn.onclick = () => doInsert(true);

    // Tab from last editable insert input → triggers insert and loops back
    const insertInputs = tbl.columns.filter(c => !c.ai).map(c => insertInputMap[c.name]).filter((input): input is HTMLInputElement => input.instanceOf(HTMLInputElement));
    insertInputs.forEach((inp, idx) => {
      inp.onkeydown = e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          void doInsert(true).catch(error => new Notice(`Could not insert row: ${errorMessage(error)}`));
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          tbl.columns.filter(c => !c.ai).forEach(c => { const i = insertInputMap[c.name]; if (i) { if (i.type === 'checkbox') i.checked = false; else i.value = ''; } });
        }
        if (e.key === 'Tab' && !e.shiftKey && idx === insertInputs.length - 1) {
          e.preventDefault();
          void doInsert(true).catch(error => new Notice(`Could not insert row: ${errorMessage(error)}`));
        }
      };
    });

    addRowBtn.onclick = () => {
      insertRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      const firstEditableColumn = tbl.columns.find(column => !column.ai);
      if (firstEditableColumn) insertInputMap[firstEditableColumn.name]?.focus();
    };
  }

  async onClose() {
    if (this._saveTimer) {
      window.clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (this.db && !this.db._deleted && !this.db.engine._inTx && this.db.engine._dirty) {
      try {
        await this.persist();
      } catch (error) {
        console.error('[MotionDB] Failed to save while closing the view:', error);
      }
    }
    this.containerEl.empty();
  }
}

// ── New Table Modal ────────────────────────────────────────────────────────────

function installModalFooter(contentEl: HTMLElement, setting: Setting): void {
  const footer = setting.settingEl;
  footer.addClass('mdb-modal-actions');
  const body = contentEl.createDiv({ cls: 'mdb-modal-body' });
  Array.from(contentEl.children).filter(child => child !== body && child !== footer).forEach(child => body.appendChild(child));
  contentEl.appendChild(footer);
}

class NewTableModal extends Modal {
  db: MotionDB;
  onSave: () => Promise<void>;

  constructor(app: App, db: MotionDB, onSave: () => Promise<void>) { super(app); this.db = db; this.onSave = onSave; }

  onOpen() {
    this.modalEl.addClass('mdb-modal', 'mdb-new-table-modal');
    this.setTitle('New Table');
    const { contentEl } = this;

    let updatePreview: () => void = () => { };
    let tableName = '';
    new Setting(contentEl).setName('Table name').addText(t => {
      t.setPlaceholder('users');
      t.onChange(v => {
        tableName = v.trim().toLowerCase();
        updatePreview();
      });
      t.inputEl.focus();
    });

    contentEl.createEl('h3', { cls: 'mdb-modal-section', text: 'Columns' });

    type ColumnFlag = 'pk' | 'ai' | 'notNull' | 'unique';
    interface ColumnDraft {
      name: string;
      type: string;
      pk: boolean;
      ai: boolean;
      notNull: boolean;
      unique: boolean;
      defaultVal: string;
      presentation: string;
      ratingMax: number;
    }
    const cols: ColumnDraft[] = [{ name: 'id', type: 'INTEGER', pk: true, ai: true, notNull: true, unique: false, defaultVal: '', presentation: 'default', ratingMax: 5 }];
    const colsEl = contentEl.createDiv({ cls: 'mdb-col-editor' });

    const renderCols = () => {
      colsEl.empty();
      // Header
      const hdr = colsEl.createDiv({ cls: 'mdb-col-row mdb-col-row-hdr' });
      ['Name', 'Type', 'Display', 'Max', 'PK', 'AI', 'NOT NULL', 'UNIQUE', 'Default', ''].forEach(h => hdr.createSpan({ text: h, cls: 'mdb-col-hdr-cell' }));

      cols.forEach((col, i) => {
        const row = colsEl.createDiv({ cls: 'mdb-col-row' });

        const nameInp = row.createEl('input', { cls: 'mdb-col-inp', value: col.name });
        nameInp.oninput = () => {
          cols[i].name = nameInp.value.trim().toLowerCase();
          updatePreview();
        };

        const typesel = row.createEl('select', { cls: 'mdb-col-sel' });
        ['INTEGER', 'BOOLEAN', 'TEXT', 'REAL', 'BLOB', 'DATE'].forEach(t => { const o = typesel.createEl('option', { value: t, text: t }); if (t === col.type) o.selected = true; });
        typesel.onchange = () => {
          cols[i].type = typesel.value;
          if (typesel.value === 'BOOLEAN') cols[i].presentation = 'checkbox';
          renderCols();
          updatePreview();
        };

        const presentation = row.createEl('select', { cls: 'mdb-col-sel' });
        [
          ['default', 'Default'], ['checkbox', 'Checkbox'], ['rating-stars', 'Stars'],
          ['rating-hearts', 'Hearts'], ['rating-number', 'Rating number'],
        ].forEach(([value, label]) => presentation.createEl('option', { value, text: label }));
        presentation.value = col.presentation || (col.type === 'BOOLEAN' ? 'checkbox' : 'default');
        presentation.onchange = () => { cols[i].presentation = presentation.value; renderCols(); updatePreview(); };

        if (String(col.presentation).startsWith('rating-')) {
          const max = row.createEl('input', { cls: 'mdb-col-inp mdb-col-inp-max', type: 'number', value: String(col.ratingMax || 5), attr: { min: '1', max: '100', 'aria-label': `Rating maximum for ${col.name}` } });
          max.oninput = () => { cols[i].ratingMax = Math.max(1, Math.min(100, Math.round(Number(max.value) || 5))); };
        } else row.createSpan({ cls: 'mdb-col-max-spacer' });

        const checkboxLabels: Record<ColumnFlag, string> = { pk: 'Primary key', ai: 'Auto increment', notNull: 'Not null', unique: 'Unique' };
        const mkCb = (key: ColumnFlag): HTMLInputElement => {
          const checkbox = row.createEl('input');
          checkbox.type = 'checkbox';
          checkbox.className = 'mdb-col-checkbox';
          checkbox.checked = Boolean(col[key]);
          checkbox.setAttribute('aria-label', `${checkboxLabels[key]} for ${col.name || `column ${i + 1}`}`);
          checkbox.addEventListener('change', () => {
            cols[i][key] = checkbox.checked;
            updatePreview();
          });
          row.appendChild(checkbox);
          return checkbox;
        };
        mkCb('pk'); mkCb('ai'); mkCb('notNull'); mkCb('unique');

        const defInp = row.createEl('input', { cls: 'mdb-col-inp mdb-col-inp-sm', value: col.defaultVal || '' });
        defInp.placeholder = 'NULL';
        defInp.oninput = () => {
          cols[i].defaultVal = defInp.value;
          updatePreview();
        };

        if (i > 0) {
          const del = row.createEl('button', { cls: 'mdb-opt-del' });
          setIcon(del, 'x');
          del.setAttribute('aria-label', 'Remove column');
          del.onclick = () => {
            cols.splice(i, 1);
            renderCols();
            updatePreview();
          };
        }
        else row.createSpan();
      });
    };
    renderCols();

    new Setting(contentEl).addButton(b => b.setButtonText('+ Add column').onClick(() => {
      cols.push({ name: 'col_' + cols.length, type: 'TEXT', pk: false, ai: false, notNull: false, unique: false, defaultVal: '', presentation: 'default', ratingMax: 5 });
      renderCols();
      updatePreview();
    }));

    // SQL preview
    const previewEl = contentEl.createEl('pre', { cls: 'mdb-sql-preview' });
    updatePreview = () => {
      if (!tableName) { previewEl.textContent = '-- Enter a table name'; return; }
      const colDefs = cols.map(c => {
        let def = `  ${c.name} ${c.type}`;
        if (c.pk) def += ' PRIMARY KEY';
        if (c.ai) def += ' AUTOINCREMENT';
        if (c.notNull && !c.pk) def += ' NOT NULL';
        if (c.unique) def += ' UNIQUE';
        if (c.defaultVal) def += ` DEFAULT '${c.defaultVal}'`;
        return def;
      });
      previewEl.textContent = `CREATE TABLE ${tableName} (\n${colDefs.join(',\n')}\n);`;
    };
    updatePreview();

    const actions = new Setting(contentEl)
      .addButton(b => b.setButtonText('Create Table').setCta().onClick(async () => {
        if (!tableName) { new Notice('Enter a table name.'); return; }
        try {
          const sql = previewEl.textContent;
          this.db.exec(sql);
          const created = this.db.tableData(tableName);
          created?.columns?.forEach((column, index) => {
            const draft = cols[index];
            if (draft) column.presentation = presentationFromChoice(draft.presentation, draft.ratingMax);
          });
          if (created) this.db.engine._dirty = true;
          await this.onSave();
          this.close();
        } catch (e) { new Notice(`Error: ${errorMessage(e)}`); }
      }))
      .addButton(b => b.setButtonText('Cancel').onClick(() => this.close()));
    installModalFooter(contentEl, actions);
  }
  onClose() { this.contentEl.empty(); }
}

// ── Structure Modal ────────────────────────────────────────────────────────────

class StructureModal extends Modal {
  db: MotionDB;
  tableName: string;
  onSave: () => Promise<void>;

  constructor(app: App, db: MotionDB, tableName: string, onSave: () => Promise<void>) { super(app); this.db = db; this.tableName = tableName; this.onSave = onSave; }

  onOpen() {
    this.modalEl.addClass('mdb-modal');
    this.setTitle(`Structure: ${this.tableName}`);
    const { contentEl } = this;
    const tbl = this.db.tableData(this.tableName);

    // Column list
    const result = this.db.exec(`DESCRIBE ${this.tableName}`)[0];
    if (result.type === 'rows') {
      const table = contentEl.createEl('table', { cls: 'mdb-result-table' });
      const thead = table.createEl('thead').createEl('tr');
      result.columns.forEach(c => thead.createEl('th', { text: c }));
      const tbody = table.createEl('tbody');
      result.rows.forEach(row => {
        const tr = tbody.createEl('tr');
        row.forEach(v => tr.createEl('td', { text: v === null ? 'NULL' : String(v) }));
      });
    }

    contentEl.createEl('h3', { cls: 'mdb-modal-section', text: 'Column presentation' });
    const presentationHost = contentEl.createDiv({ cls: 'mdb-presentation-settings' });
    const renderPresentations = () => {
      presentationHost.empty();
      tbl.columns.forEach(column => {
        const current = normalizeColumnPresentation(column.presentation);
        const setting = new Setting(presentationHost)
          .setName(column.name)
          .setDesc(`${column.type} value · presentation only; stored data is unchanged`)
          .addDropdown(dropdown => dropdown
            .addOption('default', 'Default value')
            .addOption('checkbox', 'Checkbox (Boolean)')
            .addOption('rating-stars', 'Rating · stars')
            .addOption('rating-hearts', 'Rating · hearts')
            .addOption('rating-number', 'Rating · number')
            .setValue(columnPresentationChoice(column))
            .onChange(async value => {
              column.presentation = presentationFromChoice(value, current.type === 'rating' ? current.max : 5);
              this.db.engine._dirty = true;
              await this.onSave();
              renderPresentations();
            }));
        if (current.type === 'rating') {
          setting.addText(text => {
            text.inputEl.type = 'number';
            text.inputEl.min = '1';
            text.inputEl.max = '100';
            text.setPlaceholder('Max').setValue(String(current.max)).onChange(async value => {
              const max = Math.max(1, Math.min(100, Math.round(Number(value) || 5)));
              column.presentation = { ...current, max };
              this.db.engine._dirty = true;
              await this.onSave();
            });
          });
        }
      });
    };
    renderPresentations();

    contentEl.createEl('h3', { cls: 'mdb-modal-section', text: 'Add Column' });
    let addName = '', addType = 'TEXT', addNotNull = false, addDefault = '', addPresentation = 'default', addRatingMax = 5;
    new Setting(contentEl).setName('Column name').addText(t => t.onChange(v => addName = v.trim().toLowerCase()));
    new Setting(contentEl).setName('Type').addDropdown(dd => {
      ['INTEGER', 'BOOLEAN', 'TEXT', 'REAL', 'DATE', 'BLOB'].forEach(t => { dd.addOption(t, t); });
      dd.onChange(v => { addType = v; if (v === 'BOOLEAN') addPresentation = 'checkbox'; });
    });
    new Setting(contentEl).setName('Presentation').setDesc('How the stored value is displayed and edited.').addDropdown(dd => dd
      .addOption('default', 'Default value')
      .addOption('checkbox', 'Checkbox (Boolean)')
      .addOption('rating-stars', 'Rating · stars')
      .addOption('rating-hearts', 'Rating · hearts')
      .addOption('rating-number', 'Rating · number')
      .onChange(value => { addPresentation = value; }));
    new Setting(contentEl).setName('Rating maximum').setDesc('Used only by rating presentations.').addText(text => {
      text.inputEl.type = 'number';
      text.inputEl.min = '1';
      text.inputEl.max = '100';
      text.setValue('5').onChange(value => { addRatingMax = Math.max(1, Math.min(100, Math.round(Number(value) || 5))); });
    });
    new Setting(contentEl).setName('NOT NULL').addToggle(tg => tg.onChange(v => addNotNull = v));
    new Setting(contentEl).setName('Default').addText(t => t.setPlaceholder('NULL').onChange(v => addDefault = v));

    const actions = new Setting(contentEl)
      .addButton(b => b.setButtonText('Add Column').setCta().onClick(async () => {
        if (!addName) { new Notice('Column name required.'); return; }
        try {
          let sql = `ALTER TABLE ${this.tableName} ADD COLUMN ${addName} ${addType}`;
          if (addNotNull) sql += ' NOT NULL';
          if (addDefault) sql += ` DEFAULT '${addDefault}'`;
          this.db.exec(sql);
          const added = tbl.columns.find(column => column.name === addName);
          if (added) {
            added.presentation = presentationFromChoice(addPresentation, addRatingMax);
            this.db.engine._dirty = true;
          }
          await this.onSave();
          this.close();
        } catch (e) { new Notice(`Error: ${errorMessage(e)}`); }
      }))
      .addButton(b => b.setButtonText('Close').onClick(() => this.close()));
    installModalFooter(contentEl, actions);
  }
  onClose() { this.contentEl.empty(); }
}

// ── Confirm Modal ──────────────────────────────────────────────────────────────

class ConfirmModal extends Modal {
  message: string;
  onConfirm: () => void | Promise<void>;
  onCancel: (() => void) | null;
  private confirming = false;

  constructor(app: App, message: string, onConfirm: () => void | Promise<void>, onCancel?: () => void) { super(app); this.message = message; this.onConfirm = onConfirm; this.onCancel = onCancel || null; }
  private async confirm(): Promise<void> {
    if (this.confirming) return;
    this.confirming = true;
    try {
      await this.onConfirm();
      this.close();
    } catch (error) {
      new Notice(`Action failed: ${errorMessage(error)}`);
    } finally {
      this.confirming = false;
    }
  }

  onOpen() {
    this.modalEl.addClass('mdb-modal', 'mdb-confirm-modal');
    this.setTitle('Confirm action');
    this.contentEl.createEl('p', { cls: 'mdb-confirm-message', text: this.message });
    const actions = new Setting(this.contentEl)
      .addButton(b => b.setButtonText('Confirm').setDestructive().onClick(() => { void this.confirm(); }))
      .addButton(b => b.setButtonText('Cancel').onClick(() => { this.onCancel?.(); this.close(); }));
    installModalFooter(this.contentEl, actions);
  }
  onClose() { this.contentEl.empty(); }
}

class NewDatabaseModal extends Modal {
  plugin: MotionDatabasePluginAPI;
  existingNames: string[];
  onCreated: () => Promise<void>;

  constructor(app: App, plugin: MotionDatabasePluginAPI, existingNames: string[], onCreated: () => Promise<void>) {
    super(app);
    this.plugin = plugin;
    this.existingNames = existingNames;
    this.onCreated = onCreated;
  }

  onOpen(): void {
    this.modalEl.addClass('mdb-modal', 'mdb-new-database-modal');
    this.setTitle('Create database');

    const { contentEl } = this;
    contentEl.createEl('p', {
      cls: 'mdb-modal-description',
      text: `Create a local database in this vault. Its file will be saved in ${DB_DIR}/.`,
    });

    let databaseName = '';
    let creating = false;
    let nameInput: HTMLInputElement | null = null;
    let createButton: HTMLButtonElement | null = null;

    const status = contentEl.createDiv({ cls: 'mdb-new-database-status', attr: { role: 'status', 'aria-live': 'polite' } });
    status.hidden = true;
    const showError = (message: string): void => {
      status.setText(message);
      status.addClass('is-error');
      status.hidden = false;
    };
    const setBusy = (busy: boolean): void => {
      creating = busy;
      if (!createButton) return;
      createButton.disabled = busy || !nameInput?.value.trim();
      setButtonContent(createButton, busy ? 'loader-circle' : 'plus', busy ? 'Creating…' : 'Create database');
      createButton.toggleClass('is-loading', busy);
    };

    const createDatabase = async (): Promise<void> => {
      if (creating) return;
      databaseName = nameInput?.value.trim() || '';
      if (!databaseName) {
        showError('Enter a database name.');
        nameInput?.focus();
        return;
      }
      if (this.existingNames.some(name => name.toLocaleLowerCase() === databaseName.toLocaleLowerCase())) {
        showError(`A database named “${databaseName}” already exists.`);
        nameInput?.focus();
        nameInput?.select();
        return;
      }

      const fileName = databaseName.replace(/[\\/:*?"<>|]/g, '_');
      const filePath = `${DB_DIR}/${fileName}.motiondb.json`;
      status.hidden = true;
      status.removeClass('is-error');
      setBusy(true);

      let created = false;
      try {
        if (await this.plugin.app.vault.adapter.exists(filePath)) {
          throw new Error(`A database file named “${fileName}” already exists.`);
        }
        const db = new MotionDB(this.plugin, filePath);
        db.name = databaseName;
        await db.save();
        this.plugin.registerDatabase(db);
        created = true;
      } catch (error) {
        showError(`Could not create database: ${errorMessage(error)}`);
      } finally {
        if (!created) setBusy(false);
      }
      if (!created) return;

      this.close();
      new Notice(`“${databaseName}” created`);
      try {
        await this.plugin.openInLeaf(filePath);
      } catch (error) {
        new Notice(`Database created, but could not be opened: ${errorMessage(error)}`);
      }
      try {
        await this.onCreated();
      } catch (error) {
        console.error('[MotionDB] Could not refresh the database list:', error);
      }
    };

    new Setting(contentEl)
      .setName('Database name')
      .setDesc('Choose a name you will recognize in this vault.')
      .addText(text => {
        nameInput = text.inputEl;
        text.setPlaceholder('e.g. Project tracker').onChange(value => {
          databaseName = value.trim();
          status.hidden = true;
          status.removeClass('is-error');
          if (createButton) createButton.disabled = creating || databaseName.length === 0;
        });
        text.inputEl.focus();
        text.inputEl.addEventListener('keydown', event => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void createDatabase();
          }
        });
      });

    const actions = new Setting(contentEl)
      .addButton(button => {
        button.setButtonText('Create database').setCta().onClick(() => { void createDatabase(); });
        createButton = button.buttonEl;
        createButton.disabled = true;
        createButton.setAttribute('type', 'button');
      })
      .addButton(button => button.setButtonText('Cancel').onClick(() => this.close()));
    installModalFooter(contentEl, actions);
  }

  onClose(): void { this.contentEl.empty(); }
}

// ── Home View ──────────────────────────────────────────────────────────────────

class MotionDatabaseHomeView extends ItemView {
  plugin: MotionDatabasePluginAPI;
  renaming: string | null;
  file: { name: string; path: string; extension: string };

  constructor(leaf: WorkspaceLeaf, plugin: MotionDatabasePluginAPI) {
    super(leaf);
    this.plugin = plugin;
    this.renaming = null;
    // Stub for third-party plugins that read activeLeaf.view.file.name
    this.file = { name: 'Motion Database', path: '', extension: '' };
  }

  getViewType() { return VIEW_TYPE_HOME; }
  getDisplayText() { return 'Motion Database'; }
  getIcon() { return 'database'; }

  // Home view SHOULD persist — it's the main entry point
  async onOpen() {
    this.containerEl.addClass('mdb-root');
    this.navigation = true;
    await this.render();
  }

  // Minimal state so Obsidian knows to restore this view type on startup
  getState() { return { view: 'home' }; }
  async setState() { /* nothing to restore — render() loads fresh data */ }

  async render(): Promise<void> {
    const root = this.containerEl;
    root.empty();

    // Load all database files
    let files: string[] = [];
    try {
      const d = await this.plugin.app.vault.adapter.list(DB_DIR);
      files = (d.files || []).filter(f => f.endsWith('.motiondb.json'));
    } catch (error) {
      console.error('[MotionDB] Could not load database list:', error);
      root.createDiv({ cls: 'mdb-query-error', text: 'Could not load databases. Check the console for details.' });
      return;
    }

    // Load metadata for each db
    const databases: DatabaseSummary[] = [];
    for (const fp of files) {
      try {
        const raw = await this.plugin.app.vault.adapter.read(fp);
        const data: unknown = JSON.parse(raw);
        if (!isRecord(data)) throw new Error('Database metadata must be a JSON object.');
        const schemaValue = data.schema ?? {};
        if (!isDbSchema(schemaValue)) throw new Error('Database metadata contains an invalid schema.');
        const schema = schemaValue;
        const tableNames = Object.keys(schema).filter(k => k !== '__views__');
        const totalRows = tableNames.reduce((sum, tableName) => {
          const table = schema[tableName];
          return sum + (isDbTable(table) ? table.rows.length : 0);
        }, 0);
        const viewCount = Object.keys(schema.__views__ || {}).length;
        const stat = await this.plugin.app.vault.adapter.stat(fp);
        databases.push({
          filePath: fp,
          name: typeof data.name === 'string' && data.name ? data.name : fp.split('/').pop()?.replace('.motiondb.json', '') || 'Untitled',
          tables: tableNames.length,
          rows: totalRows,
          views: viewCount,
          mtime: stat?.mtime || 0,
        });
      } catch (error) {
        console.warn('[MotionDB] Could not read database metadata:', fp, error);
      }
    }
    databases.sort((a, b) => b.mtime - a.mtime);

    const home = root.createDiv({ cls: 'mdb-home' });

    // ── Header ──
    const header = home.createDiv({ cls: 'mdb-home-header' });
    const homeIcon = header.createDiv({ cls: 'mdb-home-logo' });
    setIcon(homeIcon, 'database');
    const titleWrap = header.createDiv({ cls: 'mdb-home-title-wrap' });
    titleWrap.createEl('h1', { cls: 'mdb-home-title', text: 'Motion Database' });
    titleWrap.createDiv({ cls: 'mdb-home-subtitle', text: 'Databases stored in this vault' });
    // ── Body ──
    const body = home.createDiv({ cls: 'mdb-home-body' });

    const totalTables = databases.reduce((sum, database) => sum + database.tables, 0);
    const totalRows = databases.reduce((sum, database) => sum + database.rows, 0);

    const pageHeader = body.createDiv({ cls: 'mdb-home-page-header' });
    const pageIntro = pageHeader.createDiv({ cls: 'mdb-home-page-intro' });
    pageIntro.createEl('h2', { cls: 'mdb-home-library-title', text: 'Your databases' });
    if (databases.length > 0) {
      pageIntro.createDiv({
        cls: 'mdb-home-summary',
        text: `${databases.length} ${databases.length === 1 ? 'database' : 'databases'} · ${totalTables} ${totalTables === 1 ? 'table' : 'tables'} · ${totalRows} ${totalRows === 1 ? 'row' : 'rows'}`,
      });
    }

    const openCreateModal = () => new NewDatabaseModal(
      this.app,
      this.plugin,
      databases.map(database => database.name),
      async () => this.render(),
    ).open();
    const createDatabaseButton = pageHeader.createEl('button', { cls: 'mdb-home-create-button mod-cta' });
    createDatabaseButton.type = 'button';
    setButtonContent(createDatabaseButton, 'plus', 'Create database');
    createDatabaseButton.onclick = openCreateModal;

    // ── Database grid ──
    if (databases.length > 0) {
      const grid = body.createDiv({ cls: 'mdb-home-grid' });

      databases.forEach(dbInfo => {
        const modified = dbInfo.mtime ? new Date(dbInfo.mtime) : null;
        const description = [
          `${dbInfo.tables} ${dbInfo.tables === 1 ? 'table' : 'tables'}`,
          `${dbInfo.rows} ${dbInfo.rows === 1 ? 'row' : 'rows'}`,
          `${dbInfo.views} ${dbInfo.views === 1 ? 'view' : 'views'}`,
          dbInfo.filePath.split('/').pop(),
          modified ? `Updated ${modified.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` : null,
        ].filter(Boolean).join(' · ');
        const setting = new Setting(grid)
          .setClass('mdb-database-setting')
          .setName(dbInfo.name)
          .setDesc(description);

        if (this.renaming === dbInfo.filePath) {
          setting.nameEl.empty();
          const nameInput = setting.nameEl.createEl('input', { cls: 'mdb-db-rename-input' });
          nameInput.value = dbInfo.name;
          nameInput.setAttribute('aria-label', `Rename ${dbInfo.name}`);
          window.setTimeout(() => { nameInput.focus(); nameInput.select(); }, 30);

          let renameHandled = false;
          const doRename = async () => {
            if (renameHandled) return;
            renameHandled = true;
            const newName = nameInput.value.trim();
            if (!newName || newName === dbInfo.name) { this.renaming = null; await this.render(); return; }
            if (databases.some(other => other.filePath !== dbInfo.filePath && other.name.toLowerCase() === newName.toLowerCase())) {
              new Notice(`A database named “${newName}” already exists.`);
              renameHandled = false;
              nameInput.focus();
              nameInput.select();
              return;
            }
            try {
              const db = await this.plugin.getDatabase(dbInfo.filePath);
              const previousName = db.name;
              db.name = newName;
              try {
                await db.save();
              } catch (error) {
                db.name = previousName;
                throw error;
              }
              if (window._motionDBRegistry) {
                delete window._motionDBRegistry[previousName];
                window._motionDBRegistry[newName] = db;
              }
              new Notice(`Renamed to "${newName}"`);
            } catch (error) { new Notice(`Rename failed: ${errorMessage(error)}`); }
            this.renaming = null;
            await this.render();
          };

          nameInput.onblur = () => { void doRename(); };
          nameInput.onkeydown = event => {
            if (event.key === 'Enter') { event.preventDefault(); nameInput.blur(); }
            if (event.key === 'Escape') {
              this.renaming = null;
              void this.render().catch(error => console.error('[MotionDB] Could not refresh home view:', error));
            }
          };
        }

        setting
          .addButton(button => button
            .setButtonText('Open')
            .setIcon('folder-open')
            .setCta()
            .onClick(() => {
              void this.plugin.openInLeaf(dbInfo.filePath).catch(error => new Notice(`Could not open database: ${errorMessage(error)}`));
            }))
          .addExtraButton(button => button
            .setIcon('pencil')
            .setTooltip(`Rename ${dbInfo.name}`)
            .onClick(() => {
              this.renaming = dbInfo.filePath;
              void this.render();
            }))
          .addExtraButton(button => button
            .setIcon('trash-2')
            .setTooltip(`Delete ${dbInfo.name}`)
            .onClick(() => {
              new ConfirmModal(this.app, `Delete "${dbInfo.name}"? This permanently removes the database file and cannot be undone.`, async () => {
                try {
                  await this.plugin.deleteDatabase(dbInfo.filePath);
                  this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE).forEach(leaf => {
                    if (isMotionDatabaseView(leaf.view) && leaf.view.db?.filePath === dbInfo.filePath) leaf.detach();
                  });
                  new Notice(`"${dbInfo.name}" deleted`);
                  await this.render();
                } catch (error) { new Notice(`Delete failed: ${errorMessage(error)}`); }
              }).open();
            }));
      });
    } else {
      const empty = body.createDiv({ cls: 'mdb-home-empty' });
      empty.createEl('h3', { cls: 'mdb-home-empty-text', text: 'No databases yet' });
      empty.createDiv({ cls: 'mdb-home-empty-sub', text: 'Create a local database to start organizing tables and queries.' });
      const emptyCreateButton = empty.createEl('button', { cls: 'mod-cta' });
      emptyCreateButton.type = 'button';
      setButtonContent(emptyCreateButton, 'plus', 'Create database');
      emptyCreateButton.onclick = openCreateModal;
    }
  }

  async onClose(): Promise<void> { this.containerEl.empty(); }
}

function isMotionDatabaseView(view: unknown): view is MotionDatabaseView {
  return view instanceof MotionDatabaseView;
}

function isMotionDatabaseHomeView(view: unknown): view is MotionDatabaseHomeView {
  return view instanceof MotionDatabaseHomeView;
}

function getEmbedPropertyFormat(formats: PropertyFormats | undefined, column: string): PropertyFormat {
  if (!formats) return { type: 'text' };
  if (formats[column]) return formats[column];
  const key = Object.keys(formats).find(name => name.toLowerCase() === String(column).toLowerCase());
  return key ? formats[key] : { type: 'text' };
}

function normalizeColumnPresentation(presentation: unknown): ColumnPresentation {
  if (!isRecord(presentation) || presentation.type === 'default') return { type: 'default' };
  if (presentation.type === 'checkbox') return { type: 'checkbox' };
  if (presentation.type === 'rating') {
    const style = ['stars', 'hearts', 'number'].includes(String(presentation.style))
      ? presentation.style as 'stars' | 'hearts' | 'number'
      : 'stars';
    const max = Math.max(1, Math.min(100, Math.round(Number(presentation.max) || 5)));
    return { type: 'rating', style, max };
  }
  return { type: 'default' };
}

function columnPresentationChoice(column: Pick<DbColumn, 'presentation'>) {
  const presentation = normalizeColumnPresentation(column?.presentation);
  return presentation.type === 'rating' ? `rating-${presentation.style}` : presentation.type;
}

function presentationFromChoice(choice: unknown, max = 5): ColumnPresentation {
  if (choice === 'checkbox') return { type: 'checkbox' };
  if (String(choice).startsWith('rating-')) {
    return normalizeColumnPresentation({ type: 'rating', style: String(choice).slice(7), max });
  }
  return { type: 'default' };
}

function storedColumnPropertyFormat(column: Pick<DbColumn, 'presentation'>): Exclude<ColumnPresentation, { type: 'default' }> | null {
  const presentation = normalizeColumnPresentation(column?.presentation);
  return presentation.type === 'default' ? null : presentation;
}

function tableEmbedPropertyFormats(table: DbTable, configured: PropertyFormats = {}): PropertyFormats {
  const formats = { ...configured };
  table.columns.forEach(column => {
    const alreadyConfigured = Object.keys(formats).some(name => name.toLowerCase() === String(column.name).toLowerCase());
    if (alreadyConfigured) return;
    const stored = storedColumnPropertyFormat(column);
    if (stored) {
      formats[column.name] = stored;
      return;
    }
    const name = String(column.name).toLowerCase();
    const type = String(column.type).toUpperCase();
    if (type === 'BOOLEAN' || type === 'BOOL' || (type === 'INTEGER' && /^(is_|has_|done$|complete$|completed$|checked$)/.test(name))) {
      formats[column.name] = { type: 'checkbox' };
    }
  });
  return formats;
}

function embedPropertyIcon(format: PropertyFormat): string {
  if (format.type === 'image') return 'image';
  if (format.type === 'media') return 'paperclip';
  if (format.type === 'checkbox') return 'square-check';
  if (format.type === 'progress') return 'chart-no-axes-column-increasing';
  if (format.type === 'rating') return format.style === 'hearts' ? 'heart' : format.style === 'number' ? 'hash' : 'star';
  return 'type';
}

function unwrapMediaValue(value: unknown): string {
  let raw = String(value ?? '').trim();
  const markdown = raw.match(/^!?\[[^\]]*\]\(([^)]+)\)$/);
  if (markdown) raw = markdown[1].trim();
  const wiki = raw.match(/^!?\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/);
  if (wiki) raw = wiki[1].trim();
  return raw;
}

function resolveEmbedMedia(app: App | undefined, value: unknown, sourcePath = ''): EmbedMediaResource {
  const raw = unwrapMediaValue(value);
  if (!raw) return { raw, src: '', extension: '' };
  const clean = raw.split('?')[0].split('#')[0];
  const extension = clean.includes('.') ? clean.split('.').pop().toLowerCase() : '';
  if (/^(https?:|data:|blob:|app:)/i.test(raw)) return { raw, src: raw, extension };
  const file = app?.metadataCache?.getFirstLinkpathDest(raw, sourcePath || '');
  return { raw, src: file ? app.vault.getResourcePath(file) : raw, extension };
}

function renderEmbedPropertyValue(td: HTMLElement, value: unknown, format: PropertyFormat, options: EmbedPropertyRenderOptions = {}): void {
  td.empty();
  if (value === null || value === undefined || value === '') {
    td.createSpan({ cls: 'mdb-null', text: value === '' ? '' : 'Empty' });
    return;
  }
  if (format.type === 'checkbox') {
    const checkbox = td.createEl('input', { cls: 'mdb-property-checkbox', type: 'checkbox' });
    checkbox.checked = value === true || value === 1 || /^(1|true|yes|on)$/i.test(String(value));
    checkbox.disabled = !options.editable;
    checkbox.setAttribute('aria-label', options.editable ? 'Toggle checkbox' : 'Checkbox value');
    if (options.onChange) checkbox.onchange = () => options.onChange(checkbox.checked ? 1 : 0);
    return;
  }
  if (format.type === 'progress') {
    const max = Number(format.max) || 100;
    const numeric = Number(value);
    const safe = Number.isFinite(numeric) ? Math.max(0, Math.min(max, numeric)) : 0;
    const percent = Math.round((safe / max) * 100);
    const progress = td.createDiv({ cls: 'mdb-property-progress' });
    const track = progress.createDiv({ cls: 'mdb-property-progress-track' });
    track.createDiv({ cls: 'mdb-property-progress-fill', attr: { style: `width:${percent}%` } });
    progress.createSpan({ cls: 'mdb-property-progress-label', text: `${percent}%` });
    progress.setAttribute('aria-label', `${safe} out of ${max}`);
    return;
  }
  if (format.type === 'rating') {
    const max = Math.max(1, Math.round(Number(format.max) || 5));
    const numeric = Math.max(0, Math.min(max, Number(value) || 0));
    const rating = td.createDiv({ cls: `mdb-property-rating is-${format.style || 'stars'}` });
    if (format.style === 'number') {
      rating.createSpan({ cls: 'mdb-property-rating-number', text: String(numeric) });
      rating.createSpan({ cls: 'mdb-property-rating-max', text: `/${max}` });
    } else {
      const symbol = format.style === 'hearts' ? '♥' : '★';
      for (let index = 1; index <= max; index++) {
        const cls = index <= Math.round(numeric) ? 'is-filled' : 'is-empty';
        if (options.editable) {
          const button = rating.createEl('button', { text: symbol, cls: `mdb-property-rating-button ${cls}`, attr: { type: 'button' } });
          button.setAttribute('aria-label', `Set rating to ${index} out of ${max}`);
          button.onclick = event => { event.stopPropagation(); options.onChange?.(index); };
        } else {
          rating.createSpan({ text: symbol, cls });
        }
      }
    }
    rating.setAttribute('aria-label', `${numeric} out of ${max}`);
    return;
  }
  if (format.type === 'image' || format.type === 'media') {
    const media = resolveEmbedMedia(options.app, value, options.sourcePath);
    const images = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp'];
    const audio = ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'];
    const video = ['mp4', 'webm', 'ogv', 'mov', 'mkv'];
    if (format.type === 'image' || images.includes(media.extension)) {
      const image = td.createEl('img', { cls: 'mdb-property-image', attr: { src: media.src, alt: media.raw, loading: 'lazy' } });
      image.onerror = () => {
        const parent = image.parentElement;
        if (!parent) return;
        const missing = parent.createSpan({ cls: 'mdb-property-missing', text: media.raw });
        parent.insertBefore(missing, image);
        image.remove();
      };
    } else if (audio.includes(media.extension)) {
      td.createEl('audio', { cls: 'mdb-property-audio', attr: { src: media.src, controls: 'controls', preload: 'metadata' } });
    } else if (video.includes(media.extension)) {
      td.createEl('video', { cls: 'mdb-property-video', attr: { src: media.src, controls: 'controls', preload: 'metadata' } });
    } else {
      const link = td.createEl('a', { cls: 'mdb-property-file', text: media.raw, href: media.src });
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener');
    }
    return;
  }
  td.setText(typeof value === 'object' ? JSON.stringify(value) : String(value));
}

function renderQueryResults(containerEl: HTMLElement, results: SqlResult[], options: QueryResultsOptions = {}): void {
  containerEl.empty();
  const result = [...results].reverse().find(item => item?.type === 'rows');
  if (!result) {
    containerEl.createDiv({ cls: 'mdb-query-empty', text: 'The query returned no result set.' });
    return;
  }

  const meta = containerEl.createDiv({ cls: 'mdb-query-meta' });
  const rowCount = `${result.rows.length} row${result.rows.length === 1 ? '' : 's'}`;
  const identity = meta.createDiv({ cls: 'mdb-query-identity' });
  const databaseIcon = identity.createSpan({ cls: 'mdb-query-icon' });
  setIcon(databaseIcon, 'table-2');
  if (options.label) identity.createSpan({ cls: 'mdb-query-title', text: options.label });
  identity.createSpan({ cls: 'mdb-query-count', text: rowCount });
  if (options.interactive) {
    meta.createSpan({ cls: 'mdb-query-meta-hint', text: 'Click a property to edit' });
  }
  if (result.rows.length === 0 && !options.interactive) {
    containerEl.createDiv({ cls: 'mdb-query-empty', text: 'No rows match this query.' });
    return;
  }

  const wrap = containerEl.createDiv({ cls: 'mdb-query-table-wrap' });
  const table = wrap.createEl('table', {
    cls: `mdb-query-table mdb-query-table-natural-width${options.interactive ? ' is-interactive' : ''}`,
  });
  const head = table.createEl('thead').createEl('tr');
  result.columns.forEach(column => {
    const format = getEmbedPropertyFormat(options.formats, column);
    const th = head.createEl('th');
    const heading = th.createDiv({ cls: 'mdb-query-column-heading' });
    const icon = heading.createSpan({ cls: 'mdb-query-column-icon' });
    setIcon(icon, embedPropertyIcon(format));
    heading.createSpan({ text: String(column) });
  });
  if (options.interactive && (options.onDelete || options.onAdd)) {
    const actionHead = head.createEl('th', { cls: 'mdb-query-action-cell' });
    actionHead.setAttribute('aria-label', 'Row actions');
  }
  const body = table.createEl('tbody');
  result.rows.forEach((row, rowIndex) => {
    const tr = body.createEl('tr');
    row.forEach((value, columnIndex) => {
      const td = tr.createEl('td');
      const format = getEmbedPropertyFormat(options.formats, result.columns[columnIndex]);
      td.addClass(`is-property-${format.type}`);
      const renderValue = currentValue => {
        renderEmbedPropertyValue(td, currentValue, format, { app: options.app, sourcePath: options.sourcePath });
      };
      renderValue(value);

      if (options.interactive && options.canEdit?.(rowIndex, columnIndex)) {
        td.addClass('is-editable');
        td.setAttribute('tabindex', '0');
        td.setAttribute('aria-label', `Edit ${result.columns[columnIndex]}`);
        if (format.type === 'checkbox' || (format.type === 'rating' && format.style !== 'number')) {
          const applyEdit = async (nextValue: unknown): Promise<void> => {
            if (!options.onEdit) return;
            try {
              await options.onEdit(rowIndex, columnIndex, nextValue);
              value = nextValue;
              if (td.isConnected) renderInteractiveProperty();
            } catch (error) {
              if (td.isConnected) renderInteractiveProperty();
              new Notice(errorMessage(error));
            }
          };
          const renderInteractiveProperty = () => renderEmbedPropertyValue(td, value, format, {
            app: options.app,
            sourcePath: options.sourcePath,
            editable: true,
            onChange: nextValue => { void applyEdit(nextValue); },
          });
          renderInteractiveProperty();
          return;
        }
        const beginEdit = () => {
          if (td.hasClass('is-editing')) return;
          td.addClass('is-editing');
          td.empty();
          const input = td.createEl('input', { cls: 'mdb-query-cell-input' });
          if (format.type === 'progress' || format.type === 'rating') {
            input.type = 'number';
            input.min = '0';
            input.max = String(format.max || (format.type === 'progress' ? 100 : 5));
            input.step = format.type === 'rating' ? '1' : 'any';
          }
          input.value = value === null || value === undefined ? '' : String(value);
          input.setAttribute('aria-label', `Edit ${result.columns[columnIndex]}`);
          let settled = false;
          const finish = async save => {
            if (settled) return;
            settled = true;
            td.removeClass('is-editing');
            if (!save) {
              renderValue(value);
              return;
            }
            input.disabled = true;
            const nextValue = input.value === '' ? null : input.value;
            try {
              await options.onEdit(rowIndex, columnIndex, nextValue);
              value = nextValue;
              if (td.isConnected) renderValue(value);
            } catch (error) {
              if (td.isConnected) renderValue(value);
              new Notice(errorMessage(error));
            }
          };
          input.onkeydown = event => {
            if (event.key === 'Enter') { event.preventDefault(); void finish(true); }
            if (event.key === 'Escape') { event.preventDefault(); void finish(false); }
          };
          input.onblur = () => void finish(true);
          input.focus();
          input.select();
        };
        td.onclick = beginEdit;
        td.onkeydown = event => {
          if (event.target !== td) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            beginEdit();
          }
        };
      }
    });

    if (options.interactive && options.onDelete) {
      const actionCell = tr.createEl('td', { cls: 'mdb-query-action-cell' });
      const deleteButton = actionCell.createEl('button', { cls: 'mdb-query-delete-button' });
      deleteButton.type = 'button';
      deleteButton.setAttribute('aria-label', `Delete row ${rowIndex + 1}`);
      deleteButton.setAttribute('title', 'Delete row');
      setIcon(deleteButton, 'trash-2');
      deleteButton.onclick = () => {
        new ConfirmModal(
          options.app,
          `Delete this row from “${options.label || 'the table'}”? This cannot be undone.`,
          async () => {
            deleteButton.disabled = true;
            try {
              await options.onDelete(rowIndex);
            } catch (error) {
              if (deleteButton.isConnected) deleteButton.disabled = false;
              new Notice(errorMessage(error));
            }
          },
        ).open();
      };
    }
  });

  if (options.interactive && options.onAdd) {
    const draftRow = body.createEl('tr', { cls: 'mdb-query-add-row' });
    const fields: Array<{ columnIndex: number; input: HTMLInputElement; format: PropertyFormat }> = [];
    result.columns.forEach((column, columnIndex) => {
      const cell = draftRow.createEl('td');
      if (options.canAdd && !options.canAdd(columnIndex)) {
        cell.createSpan({ cls: 'mdb-query-add-auto', text: 'Auto' });
        return;
      }
      const format = getEmbedPropertyFormat(options.formats, column);
      const input = cell.createEl('input', { cls: 'mdb-query-add-input' });
      if (format.type === 'checkbox') input.type = 'checkbox';
      if (format.type === 'progress' || format.type === 'rating') {
        input.type = 'number';
        input.min = '0';
        input.max = String(format.max || (format.type === 'progress' ? 100 : 5));
      }
      input.placeholder = String(column);
      input.setAttribute('aria-label', `New ${column}`);
      fields.push({ columnIndex, input, format });
    });
    const actionCell = draftRow.createEl('td', { cls: 'mdb-query-action-cell' });
    const save = actionCell.createEl('button', { cls: 'mdb-query-add-button', attr: { type: 'button', 'aria-label': 'Add row', title: 'Add row' } });
    setIcon(save, 'check');
    save.onclick = async () => {
      save.disabled = true;
      try {
        const values = fields
          .filter(({ input, format }) => format.type === 'checkbox' || input.value !== '')
          .map(({ columnIndex, input, format }) => ({ columnIndex, value: format.type === 'checkbox' ? (input.checked ? 1 : 0) : input.value }));
        await options.onAdd(values);
      } catch (error) {
        save.disabled = false;
        new Notice(errorMessage(error));
      }
    };
  }
}

function renderDefaultQueryResults(containerEl: HTMLElement, results: SqlResult[]): void {
  containerEl.empty();
  const result = [...results].reverse().find(item => item?.type === 'rows');
  if (!result) {
    containerEl.createDiv({ text: 'The query returned no result set.' });
    return;
  }
  const meta = containerEl.createDiv({ text: `${result.rows.length} row${result.rows.length === 1 ? '' : 's'}` });
  meta.setAttribute('aria-live', 'polite');
  if (result.rows.length === 0) return;
  const table = containerEl.createEl('table');
  const head = table.createEl('thead').createEl('tr');
  result.columns.forEach(column => head.createEl('th', { text: String(column) }));
  const body = table.createEl('tbody');
  result.rows.forEach(row => {
    const tr = body.createEl('tr');
    row.forEach(value => {
      const td = tr.createEl('td');
      if (value === null || value === undefined) td.setText('NULL');
      else td.setText(typeof value === 'object' ? JSON.stringify(value) : String(value));
    });
  });
}

class MotionDatabaseEmbed extends MarkdownRenderChild {
  plugin: MotionDatabasePluginAPI;
  source: string;
  sourcePath: string;
  renderVersion: number;
  databaseName: string | null;

  constructor(containerEl: HTMLElement, plugin: MotionDatabasePluginAPI, source: string, sourcePath = '') {
    super(containerEl);
    this.plugin = plugin;
    this.source = source;
    this.sourcePath = sourcePath;
    this.renderVersion = 0;
    this.databaseName = null;
  }

  onload() {
    this.registerEvent(this.plugin.app.workspace.on('motion-database:changed', change => {
      if (!this.databaseName || change?.name === this.databaseName) void this.render();
    }));
    void this.render();
  }

  async render() {
    const version = ++this.renderVersion;
    this.containerEl.empty();
    this.containerEl.createDiv({ cls: 'mdb-query-empty', text: 'Loading embedded table…' });

    try {
      const config = parseMotionDBEmbedSource(this.source);
      this.databaseName = config.database;
      let results: SqlResult[];
      let label: string | null = null;

      if (config.table) {
        const database = await window.motiondb.open(config.database);
        const tableData: unknown = database.tableData(config.table);
        if (!isDbTable(tableData)) throw new Error(`Table “${config.table}” was not found in “${config.database}”.`);
        const table = tableData;
        const columns = table.columns.map(column => column.name);
        const sourceRows = config.limit === null ? table.rows : table.rows.slice(0, config.limit);
        results = [{
          type: 'rows',
          columns,
          rows: sourceRows.map(row => columns.map(column => row[column])),
        }];
        label = config.table;
        const primaryKey = table.columns.find(column => column.pk);
        const formats = tableEmbedPropertyFormats(table, config.properties);
        const interactive: QueryResultsOptions | null = config.interactive && primaryKey ? {
          app: this.plugin.app,
          canEdit: (_rowIndex: number, columnIndex: number) => {
            const column = table.columns[columnIndex];
            return !column.pk && !column.ai;
          },
          onEdit: async (rowIndex: number, columnIndex: number, value: unknown) => {
            const row = sourceRows[rowIndex];
            const column = table.columns[columnIndex];
            const quoteIdentifier = (name: string) => {
              if (String(name).includes('`')) throw new Error('Interactive embeds do not support backticks in names.');
              return `\`${name}\``;
            };
            const sql = `UPDATE ${quoteIdentifier(config.table)} SET ${quoteIdentifier(column.name)} = $1 WHERE ${quoteIdentifier(primaryKey.name)} = $2`;
            await database.query(sql, [value, row[primaryKey.name]]);
          },
          onDelete: async (rowIndex: number) => {
            const row = sourceRows[rowIndex];
            const quoteIdentifier = (name: string) => {
              if (String(name).includes('`')) throw new Error('Interactive embeds do not support backticks in names.');
              return `\`${name}\``;
            };
            const sql = `DELETE FROM ${quoteIdentifier(config.table)} WHERE ${quoteIdentifier(primaryKey.name)} = $1`;
            await database.query(sql, [row[primaryKey.name]]);
          },
          canAdd: (columnIndex: number) => !table.columns[columnIndex].ai,
          onAdd: async (values: Array<{ columnIndex: number; value: unknown }>) => {
            const quoteIdentifier = (name: string) => {
              if (String(name).includes('`')) throw new Error('Interactive embeds do not support backticks in names.');
              return `\`${name}\``;
            };
            let insertValues = values;
            if (insertValues.length === 0) {
              const automaticColumnIndex = table.columns.findIndex(column => column.ai);
              const defaultColumnIndex = table.columns.findIndex(column => column.default !== undefined);
              const fallbackIndex = automaticColumnIndex >= 0 ? automaticColumnIndex : defaultColumnIndex;
              if (fallbackIndex < 0) {
                throw new Error('Enter at least one value. Blank fields use their default value or NULL.');
              }
              const fallbackColumn = table.columns[fallbackIndex];
              insertValues = [{
                columnIndex: fallbackIndex,
                value: fallbackColumn.ai ? null : fallbackColumn.default,
              }];
            }
            const columns = insertValues.map(({ columnIndex }) => quoteIdentifier(table.columns[columnIndex].name));
            const placeholders = insertValues.map((_, index) => `$${index + 1}`);
            const parameters = insertValues.map(({ value }) => value);
            const sql = `INSERT INTO ${quoteIdentifier(config.table)} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`;
            await database.query(sql, parameters);
          },
        } : null;
        if (config.interactive && !primaryKey) {
          throw new Error(`Interactive table “${config.table}” needs a primary key so rows can be updated safely.`);
        }
        if (version !== this.renderVersion) return;
        renderQueryResults(this.containerEl, results, {
          label,
          formats,
          app: this.plugin.app,
          sourcePath: this.sourcePath,
          interactive: !!interactive,
          ...interactive,
        });
        return;
      } else {
        assertReadOnlyQuery(config.sql);
        results = await window.motiondb.query(config.database, config.sql);
      }

      if (version !== this.renderVersion) return;
      renderQueryResults(this.containerEl, results, {
        label,
        formats: config.properties,
        app: this.plugin.app,
        sourcePath: this.sourcePath,
      });
    } catch (error) {
      if (version !== this.renderVersion) return;
      this.containerEl.empty();
      this.containerEl.createDiv({ cls: 'mdb-query-error', text: errorMessage(error) });
    }
  }
}

function registerBasesIntegration(plugin: MotionDatabasePluginAPI): boolean {
  if (!BasesView || typeof plugin.registerBasesView !== 'function') return false;

  class MotionDatabaseBasesView extends BasesView {
    type = 'motion-database-query';
    containerEl: HTMLElement;
    renderVersion: number;

    constructor(controller: QueryController, containerEl: HTMLElement) {
      super(controller);
      this.containerEl = containerEl.createDiv({ cls: 'mdb-bases-view' });
      this.renderVersion = 0;
      this.registerEvent(plugin.app.workspace.on('motion-database:changed', () => this.onDataUpdated()));
    }

    onDataUpdated(): void {
      void this.renderDatabaseQuery();
    }

    async renderDatabaseQuery(): Promise<void> {
      const version = ++this.renderVersion;
    const databaseValue: unknown = this.config.get('database');
    const sqlValue: unknown = this.config.get('sql');
    const database = typeof databaseValue === 'string' ? databaseValue.trim() : '';
    const sql = typeof sqlValue === 'string' ? sqlValue.trim() : '';
      this.containerEl.empty();

      if (!database || !sql) {
        this.containerEl.createDiv({
          cls: 'mdb-query-empty',
          text: 'Choose a Motion Database and enter a read-only SQL query in this view’s settings.',
        });
        return;
      }

      const loading = this.containerEl.createDiv({ cls: 'mdb-query-empty', text: 'Loading database query…' });
      try {
        assertReadOnlyQuery(sql);
        const results = await window.motiondb.query(database, sql);
        if (version !== this.renderVersion) return;
        renderDefaultQueryResults(this.containerEl, results);
      } catch (error) {
        if (version !== this.renderVersion) return;
        loading.remove();
        this.containerEl.createDiv({
          cls: 'mdb-query-error',
          text: errorMessage(error),
        });
      }
    }
  }

  return plugin.registerBasesView('motion-database-query', {
    name: 'Motion Database query',
    icon: 'lucide-database',
    factory: (controller, containerEl) => new MotionDatabaseBasesView(controller, containerEl),
    options: () => [
      {
        type: 'text',
        key: 'database',
        displayName: 'Database',
        placeholder: 'My Database',
      },
      {
        type: 'text',
        key: 'sql',
        displayName: 'SQL query',
        placeholder: 'SELECT * FROM table_name LIMIT 100',
      },
    ],
  });
}



module.exports = class MotionDatabasePlugin extends Plugin {
  databases: Map<string, MotionDB>;

  onload() {
    this.databases = new Map();
    this.registerView(VIEW_TYPE, leaf => new MotionDatabaseView(leaf, this));
    this.registerView(VIEW_TYPE_HOME, leaf => new MotionDatabaseHomeView(leaf, this));
    registerGlobalAPI(this);
    registerBasesIntegration(this);
    this.registerMarkdownCodeBlockProcessor('motiondb', (source, el, context) => {
      context.addChild(new MotionDatabaseEmbed(el, this, source, context.sourcePath));
    });
    const openHomeFromCommand = () => {
      void this.openHome().catch(error => {
        console.error('[MotionDB] Could not open the home view:', error);
        new Notice('Could not open Motion Database.');
      });
    };
    this.addCommand({ id: 'mdb-home', name: 'Home', callback: openHomeFromCommand });
    this.addCommand({ id: 'mdb-open', name: 'Open or create', callback: openHomeFromCommand });
    this.addCommand({
      id: 'prefix-selected-lines-blockquote',
      name: 'Editor: Prefix selected lines with blockquote',
      editorCallback: editor => {
        const from = editor.getCursor('from');
        const to = editor.getCursor('to');
        const endLine = to.ch === 0 && to.line > from.line ? to.line - 1 : to.line;
        const start = { line: from.line, ch: 0 };
        const end = { line: endLine, ch: editor.getLine(endLine).length };
        const quoted = editor.getRange(start, end)
          .split('\n')
          .map(line => line.length ? `> ${line}` : '>')
          .join('\n');
        editor.replaceRange(quoted, start, end);
        editor.setSelection(
          { line: from.line, ch: 0 },
          { line: endLine, ch: editor.getLine(endLine).length },
        );
      },
    });
    this.addRibbonIcon('database', 'Motion Database', openHomeFromCommand);

    // After workspace finishes restoring, detach any db leaves with no db loaded.
    // These are zombies from a previous session's saved workspace state.
    // We use a short timeout because setState is async and may not have finished
    // by the time onLayoutReady fires.
    this.app.workspace.onLayoutReady(() => {
      window.setTimeout(() => {
        this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach(leaf => {
          if (!isMotionDatabaseView(leaf.view) || !leaf.view.db) leaf.detach();
        });
      }, 300);
    });
  }

  onunload() {
    const pendingSaves = [...this.databases.values()].map(db => db.flushSave().catch(error => {
      console.error('[MotionDB] Failed to flush database during unload:', db.filePath, error);
    }));
    delete window.motiondb;
    delete window._motionDBRegistry;
    this.databases.clear();
    void Promise.all(pendingSaves).catch(error => {
      console.error('[MotionDB] Unexpected error while flushing databases during unload:', error);
    });
  }

  async getDatabase(filePath: string): Promise<MotionDB> {
    const key = filePath.replace(/\\/g, '/');
    let db = this.databases.get(key);
    if (db) {
      if (db._loadPromise !== null) await db._loadPromise;
      return db;
    }

    db = new MotionDB(this, key);
    this.databases.set(key, db);
    db._loadPromise = db.load();
    try {
      await db._loadPromise;
      db._loadPromise = null;
      if (window._motionDBRegistry) window._motionDBRegistry[db.name] = db;
      return db;
    } catch (error) {
      this.databases.delete(key);
      throw error;
    }
  }

  registerDatabase(db: MotionDB): MotionDB {
    const key = db.filePath.replace(/\\/g, '/');
    this.databases.set(key, db);
    if (window._motionDBRegistry) window._motionDBRegistry[db.name] = db;
    return db;
  }

  async deleteDatabase(filePath: string): Promise<void> {
    const key = filePath.replace(/\\/g, '/');
    const db = this.databases.get(key);
    if (db) {
      db.cancelScheduledSave();
      await db._saveChain.catch(error => {
        console.warn('[MotionDB] Continuing database deletion after a failed save:', key, error);
      });
      db._deleted = true;
    }
    if (await this.app.vault.adapter.exists(key)) {
      await this.app.vault.adapter.remove(key);
    }
    this.databases.delete(key);
    if (window._motionDBRegistry) {
      Object.keys(window._motionDBRegistry).forEach(name => {
        if (window._motionDBRegistry[name] === db) delete window._motionDBRegistry[name];
      });
    }
  }

  // Open (or reveal) the Home view — always a single tab
  async openHome(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_HOME);
    if (existing.length > 0) {
      await this.app.workspace.revealLeaf(existing[0]);
      try {
        if (isMotionDatabaseHomeView(existing[0].view)) await existing[0].view.render();
      } catch (error) {
        console.error('[MotionDB] Could not refresh the home view:', error);
      }
      return;
    }
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: VIEW_TYPE_HOME, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  async openInLeaf(filePath: string): Promise<void> {
    // Check if this exact database is already open — reveal it if so
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    for (const leaf of existing) {
      if (isMotionDatabaseView(leaf.view) && leaf.view.db?.filePath === filePath) {
        await this.app.workspace.revealLeaf(leaf);
        return;
      }
    }
    // Reuse an already-open but unloaded DB leaf instead of spawning a new tab
    const emptyLeaf = existing.find(leaf => isMotionDatabaseView(leaf.view) && !leaf.view.db);
    const leaf = emptyLeaf || this.app.workspace.getLeaf('tab');
    if (!emptyLeaf) {
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
    if (isMotionDatabaseView(leaf.view)) await leaf.view.loadDB(filePath);
  }
};
