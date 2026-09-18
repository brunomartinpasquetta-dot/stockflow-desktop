/**
 * Shim de tipos MÍNIMO para `better-sqlite3` en apps/desktop.
 *
 * Los tipos completos (@types/better-sqlite3) son devDependency de
 * packages/db y no se resuelven desde acá; este shim declara solo la
 * superficie que usan DemoManager/seedDemoData (conexiones auxiliares de
 * lectura/UPDATE) y BackupService (API de backup online, que copia la base
 * con el WAL incluido). El acceso de negocio va SIEMPRE por @stockflow/db.
 */
declare module 'better-sqlite3' {
  interface Statement {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  }
  interface BackupProgress {
    totalPages: number;
    remainingPages: number;
  }
  class Database {
    constructor(path: string, options?: { readonly?: boolean; fileMustExist?: boolean });
    readonly open: boolean;
    prepare(sql: string): Statement;
    exec(sql: string): void;
    pragma(directive: string): unknown;
    backup(destination: string, options?: { progress?: (info: BackupProgress) => number | void }): Promise<BackupProgress>;
    close(): void;
  }
  export = Database;
}
