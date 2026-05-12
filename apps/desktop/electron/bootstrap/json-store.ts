/**
 * Almacén de configuración mínimo sobre `fs`: un único JSON en
 * `{userData}/<name>.json`. Reemplaza a electron-store (que es CJS y rompe el
 * bundle ESM del proceso main por sus `require` dinámicos).
 *
 * Suficiente para lo que necesitamos: secreto de sesión + machineId.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { app } from 'electron';

export class JsonStore<T extends Record<string, unknown>> {
  private readonly file: string;
  private data: T;

  constructor(name: string) {
    this.file = path.join(app.getPath('userData'), `${name}.json`);
    this.data = this.read();
  }

  private read(): T {
    try {
      if (existsSync(this.file)) {
        return JSON.parse(readFileSync(this.file, 'utf8')) as T;
      }
    } catch {
      // archivo inexistente o corrupto: se empieza de cero.
    }
    return {} as T;
  }

  private flush(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
  }

  get<K extends keyof T>(key: K): T[K] {
    return this.data[key];
  }

  set<K extends keyof T>(key: K, value: T[K]): void {
    this.data[key] = value;
    this.flush();
  }

  delete<K extends keyof T>(key: K): void {
    delete this.data[key];
    this.flush();
  }
}
