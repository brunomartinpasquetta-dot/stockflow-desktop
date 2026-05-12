// Punto de entrada de @stockflow/db.
// Las conexiones (better-sqlite3 local / postgres cloud) y los helpers Drizzle
// se implementan en P02. Por ahora solo re-exporta los placeholders de schema.
export * as localSchema from './schema/local';
export * as cloudSchema from './schema/cloud';
