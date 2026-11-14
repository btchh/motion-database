export {};

declare module 'obsidian' {
  interface Workspace {
    on(
      name: 'motion-database:changed',
      callback: (change: { name: string; filePath: string }) => unknown,
      ctx?: unknown,
    ): EventRef;
  }
}

declare global {
  interface MotionDatabaseRowsResult {
    type: 'rows';
    columns: string[];
    rows: unknown[][];
  }

  interface MotionDatabaseOkResult {
    type: 'ok';
    message: string;
    count?: number;
  }

  type MotionDatabaseResult = MotionDatabaseRowsResult | MotionDatabaseOkResult;

  interface MotionDatabaseInstance {
    readonly name: string;
    query(sql: string, parameters?: unknown[]): Promise<MotionDatabaseResult[]>;
    exec(sql: string): MotionDatabaseResult[];
    tables(): string[];
    tableData(name: string): unknown;
    nameFromPath(): string;
    flushSave(): Promise<void>;
  }

  interface Window {
    motiondb?: MotionDatabasePublicApi;
    _motionDBRegistry?: Record<string, MotionDatabaseInstance>;
  }

  interface MotionDatabasePublicApi {
    readonly version: number;
    create(name: string): Promise<MotionDatabaseInstance>;
    open(name: string): Promise<MotionDatabaseInstance>;
    query(database: string, sql: string, parameters?: unknown[]): Promise<MotionDatabaseResult[]>;
    select(database: string, sql: string, parameters?: unknown[]): Promise<Record<string, unknown>[]>;
    list(): Promise<Array<{ name: string; tables: string[] }>>;
    exec(database: MotionDatabaseInstance, sql: string, parameters?: unknown[]): Promise<MotionDatabaseResult[]>;
    seed(database: string): Promise<{ ok: number; errors: Array<{ type: string; message: string }> }>;
    subscribe(callback: (change: { name: string; filePath: string }) => void): () => void;
  }
}
