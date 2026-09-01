/**
 * Shim de tipos MÍNIMO para `better-sqlite3` en apps/desktop.
 *
 * Los tipos completos (@types/better-sqlite3) son devDependency de
 * packages/db y no se resuelven desde acá; este shim declara solo la
 * superficie que usan DemoManager/seedDemoData (conexiones auxiliares de
 * lectura/UPDATE). El acceso de negocio va SIEMPRE por @stockflow/db.
 */
declare module 'better-sqlite3' {
  interface Statement {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  }
  class Database {
    constructor(path: string, options?: { readonly?: boolean; fileMustExist?: boolean });
    prepare(sql: string): Statement;
    pragma(directive: string): unknown;
    close(): void;
  }
  export = Database;
}
