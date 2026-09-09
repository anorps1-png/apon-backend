import fs from 'fs';
import path from 'path';
import os from 'os';
import initSqlJs, { Database, SqlJsStatic } from 'sql.js';

let SQLInstance: SqlJsStatic | null = null;
let dbInstance: Database | null = null;
let isInitializing = false;

export const getDbDir = () => {
  const dir = path.join(os.homedir(), '.mboaschool');
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const testPath = path.join(dir, '.write_test');
    fs.writeFileSync(testPath, 'test', 'utf8');
    fs.unlinkSync(testPath);
    return dir;
  } catch (e) {
    const tmpDir = path.join(os.tmpdir(), '.mboaschool');
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    return tmpDir;
  }
};

export const getSqlitePath = () => path.join(getDbDir(), 'local_db.sqlite');

export async function getSqliteDb(): Promise<Database> {
  if (dbInstance) {
    return dbInstance;
  }

  if (!SQLInstance) {
    SQLInstance = await initSqlJs();
  }

  const dbPath = getSqlitePath();
  if (fs.existsSync(dbPath)) {
    try {
      const fileBuffer = fs.readFileSync(dbPath);
      dbInstance = new SQLInstance.Database(fileBuffer);
    } catch {
      dbInstance = new SQLInstance.Database();
    }
  } else {
    dbInstance = new SQLInstance.Database();
  }

  // Initialize internal sync_queue table
  dbInstance.run(`
    CREATE TABLE IF NOT EXISTS sync_queue (
      id TEXT PRIMARY KEY,
      table_name TEXT NOT NULL,
      action TEXT NOT NULL,
      payload TEXT NOT NULL,
      filters TEXT,
      timestamp INTEGER NOT NULL
    );
  `);

  // Curseur de Pull incrémental : un cursor (ISO datetime) par table, servant
  // de filtre "updated_at > cursor" pour ne retélécharger que ce qui a changé
  // depuis le dernier Pull (voir src/lib/localDbSync.ts).
  dbInstance.run(`
    CREATE TABLE IF NOT EXISTS sync_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  migrateLegacyJson(dbInstance);
  saveToDisk(dbInstance);

  return dbInstance;
}

export function saveToDisk(db: Database) {
  try {
    const dbPath = getSqlitePath();
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer);
  } catch (e) {
    // Disk write fallback
  }
}

const safeTableName = (name: string) => name.replace(/[^a-zA-Z0-9_]/g, '_');

export function ensureTable(db: Database, tableName: string) {
  const safeName = safeTableName(tableName);
  db.run(`
    CREATE TABLE IF NOT EXISTS "${safeName}" (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      created_at TEXT,
      updated_at TEXT
    );
  `);
}

// Migration ponctuelle depuis l'ancien format JSON (avant l'introduction de
// SQLite). BUG CORRIGÉ : cette fonction tournait à CHAQUE démarrage à froid
// (chaque fois que dbInstance repart de zéro, donc à chaque relance de l'app,
// puisque dbInstance est un singleton en mémoire du process serveur) et
// utilisait INSERT OR IGNORE — inoffensif tant que les lignes migrées
// restaient en base, mais dès qu'on en supprimait une manuellement (ex.
// nettoyage d'entrées de test dans sync_queue), le prochain démarrage la
// réinsérait aussitôt depuis le fichier JSON jamais purgé, la ressuscitant
// indéfiniment. On renomme maintenant les fichiers sources juste après une
// migration réussie : la présence du fichier `.json` est le signal "encore à
// migrer", son absence (ou son renommage en `.migrated`) signale "déjà fait,
// ne plus jamais rejouer".
function migrateLegacyJson(db: Database) {
  try {
    const jsonDbPath = path.join(getDbDir(), 'local_db.json');
    if (fs.existsSync(jsonDbPath)) {
      const data = fs.readFileSync(jsonDbPath, 'utf8');
      const legacyDb = JSON.parse(data);

      for (const [table, records] of Object.entries(legacyDb)) {
        if (Array.isArray(records) && records.length > 0) {
          ensureTable(db, table);
          for (const r of records) {
            if (r && r.id) {
              db.run(
                `INSERT OR IGNORE INTO "${safeTableName(table)}" (id, data, created_at, updated_at) VALUES (?, ?, ?, ?)`,
                [
                  r.id,
                  JSON.stringify(r),
                  r.created_at || new Date().toISOString(),
                  r.updated_at || new Date().toISOString()
                ]
              );
            }
          }
        }
      }
      fs.renameSync(jsonDbPath, jsonDbPath + '.migrated');
    }

    const jsonQueuePath = path.join(getDbDir(), 'sync_queue.json');
    if (fs.existsSync(jsonQueuePath)) {
      const data = fs.readFileSync(jsonQueuePath, 'utf8');
      const legacyQueue = JSON.parse(data);
      if (Array.isArray(legacyQueue) && legacyQueue.length > 0) {
        for (const item of legacyQueue) {
          if (item && item.id) {
            db.run(
              `INSERT OR IGNORE INTO sync_queue (id, table_name, action, payload, filters, timestamp) VALUES (?, ?, ?, ?, ?, ?)`,
              [
                item.id,
                item.table || item.table_name || '',
                item.action || 'insert',
                JSON.stringify(item.payload || {}),
                item.filters ? JSON.stringify(item.filters) : null,
                item.timestamp || Date.now()
              ]
            );
          }
        }
      }
      fs.renameSync(jsonQueuePath, jsonQueuePath + '.migrated');
    }
  } catch {
    // Migration fallback
  }
}

export async function getAllRecordsFromTable(tableName: string): Promise<any[]> {
  const db = await getSqliteDb();
  ensureTable(db, tableName);
  const safeName = safeTableName(tableName);
  
  const stmt = db.prepare(`SELECT data FROM "${safeName}"`);
  const records: any[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject() as { data: string };
    if (row && row.data) {
      try {
        records.push(JSON.parse(row.data));
      } catch {}
    }
  }
  stmt.free();
  return records;
}

export async function saveRecordsToTable(tableName: string, records: any[]) {
  const db = await getSqliteDb();
  ensureTable(db, tableName);
  const safeName = safeTableName(tableName);

  for (const r of records) {
    if (!r.id) {
      r.id = crypto.randomUUID();
    }
    db.run(
      `INSERT OR REPLACE INTO "${safeName}" (id, data, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      [
        r.id,
        JSON.stringify(r),
        r.created_at || new Date().toISOString(),
        new Date().toISOString()
      ]
    );
  }
  saveToDisk(db);
}

export async function deleteRecordsFromTable(tableName: string, ids: string[]) {
  if (ids.length === 0) return;
  const db = await getSqliteDb();
  ensureTable(db, tableName);
  const safeName = safeTableName(tableName);
  const placeholders = ids.map(() => '?').join(',');
  db.run(`DELETE FROM "${safeName}" WHERE id IN (${placeholders})`, ids);
  saveToDisk(db);
}

export async function getQueue(): Promise<any[]> {
  const db = await getSqliteDb();
  const stmt = db.prepare(`SELECT * FROM sync_queue ORDER BY timestamp ASC`);
  const queue: any[] = [];
  while (stmt.step()) {
    const r = stmt.getAsObject() as any;
    if (r && r.id) {
      queue.push({
        id: r.id,
        table: r.table_name,
        action: r.action,
        payload: JSON.parse(r.payload || '{}'),
        filters: r.filters ? JSON.parse(r.filters) : undefined,
        timestamp: r.timestamp
      });
    }
  }
  stmt.free();
  return queue;
}

export async function addToQueue(item: { id: string; table: string; action: string; payload: any; filters?: any; timestamp: number }) {
  const db = await getSqliteDb();
  db.run(
    `INSERT INTO sync_queue (id, table_name, action, payload, filters, timestamp) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      item.id,
      item.table,
      item.action,
      JSON.stringify(item.payload || {}),
      item.filters ? JSON.stringify(item.filters) : null,
      item.timestamp
    ]
  );
  saveToDisk(db);
}

export async function removeFromQueue(taskId: string) {
  const db = await getSqliteDb();
  db.run(`DELETE FROM sync_queue WHERE id = ?`, [taskId]);
  saveToDisk(db);
}

export async function getSyncMeta(key: string): Promise<string | null> {
  const db = await getSqliteDb();
  const stmt = db.prepare(`SELECT value FROM sync_meta WHERE key = ?`);
  stmt.bind([key]);
  let value: string | null = null;
  if (stmt.step()) {
    value = (stmt.getAsObject() as { value: string | null }).value;
  }
  stmt.free();
  return value;
}

export async function setSyncMeta(key: string, value: string) {
  const db = await getSqliteDb();
  db.run(`INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)`, [key, value]);
  saveToDisk(db);
}
