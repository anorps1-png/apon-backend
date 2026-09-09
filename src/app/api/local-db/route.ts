import { NextRequest, NextResponse } from 'next/server';
import {
  getAllRecordsFromTable,
  saveRecordsToTable,
  deleteRecordsFromTable,
  getQueue,
  addToQueue,
  removeFromQueue,
  getSyncMeta,
  setSyncMeta
} from '@/lib/db/sqlite';
import { callLocalAggregate } from '@/lib/db/localAggregates';

// Cette API sert de base de données locale SQL (SQLite) pour l'application desktop (Electron).
// Elle lit/écrit directement dans un fichier SQLite (.mboaschool/local_db.sqlite) sur la machine.
// Elle ne doit jamais être exposée sur un déploiement web.
const isDesktopRuntime = () => process.env.MBOASCHOOL_DESKTOP === '1';

const desktopOnlyResponse = () =>
  NextResponse.json(
    { data: null, error: { message: "Cette API n'est disponible que dans l'application desktop (Mode SQL SQLite)." } },
    { status: 403 }
  );

// Helper to resolve nested relationships in queries
async function resolveRelations(table: string, records: any[]) {
  if (table === 'eleves') {
    const paiements = await getAllRecordsFromTable('paiements');
    const notes = await getAllRecordsFromTable('notes');
    const discipline = await getAllRecordsFromTable('discipline');
    const classes = await getAllRecordsFromTable('classes');
    return records.map(record => ({
      ...record,
      classes: classes.find((c: any) => c.id === record.classe_id) || null,
      paiements: paiements.filter((p: any) => p.eleve_id === record.id),
      notes: notes.filter((n: any) => n.eleve_id === record.id),
      discipline: discipline.filter((d: any) => d.eleve_id === record.id)
    }));
  }
  
  if (table === 'ecritures_comptables') {
    const lignes = await getAllRecordsFromTable('lignes_ecritures');
    return records.map(record => ({
      ...record,
      lignes_ecritures: lignes.filter((l: any) => l.ecriture_id === record.id)
    }));
  }
  
  if (table === 'classes') {
    const eleves = await getAllRecordsFromTable('eleves');
    return records.map(record => ({
      ...record,
      eleves: eleves.filter((e: any) => e.classe_id === record.id)
    }));
  }

  if (table === 'membres_personnel') {
    const fb = await getAllRecordsFromTable('formations_beneficiaires');
    return records.map(record => ({
      ...record,
      formations_beneficiaires: fb.filter((x: any) => x.personnel_id === record.id)
    }));
  }

  if (table === 'sections') {
    const niveaux = await getAllRecordsFromTable('niveaux_classes');
    const classes = await getAllRecordsFromTable('classes');
    return records.map(record => ({
      ...record,
      niveaux_classes: niveaux
        .filter((n: any) => n.section_id === record.id)
        .map((n: any) => ({
          ...n,
          classes: classes.filter((c: any) => c.niveau_id === n.id)
        }))
    }));
  }
  
  return records;
}

// GET handler
export async function GET(req: NextRequest) {
  if (!isDesktopRuntime()) return desktopOnlyResponse();
  try {
    const { searchParams } = new URL(req.url);
    const action = searchParams.get('action');

    // 1. Get sync queue
    if (action === 'get-queue') {
      const queue = await getQueue();
      return NextResponse.json({ queue, error: null });
    }

    // 1b. Get a Pull incrémental cursor (voir src/lib/localDbSync.ts)
    if (action === 'get-sync-cursor') {
      const key = searchParams.get('key');
      if (!key) return NextResponse.json({ error: 'Missing key parameter' }, { status: 400 });
      const value = await getSyncMeta(key);
      return NextResponse.json({ value, error: null });
    }

    // 2. Select query
    const table = searchParams.get('table');
    if (!table) {
      return NextResponse.json({ error: "Missing table parameter" }, { status: 400 });
    }

    const filtersStr = searchParams.get('filters');
    const isSingle = searchParams.get('isSingle') === 'true';
    const orderBy = searchParams.get('orderBy');
    const orderDirection = (searchParams.get('orderDirection') as 'asc' | 'desc') || 'asc';
    const limitCountStr = searchParams.get('limitCount');
    const rangeStartStr = searchParams.get('rangeStart');
    const rangeEndStr = searchParams.get('rangeEnd');

    let records = await getAllRecordsFromTable(table);

    // Apply filters
    if (filtersStr) {
      const filters = JSON.parse(filtersStr) as { field: string; op: string; value: any }[];
      for (const filter of filters) {
        const fieldValue = (item: any) => item[filter.field];
        records = records.filter((item: any) => {
          const val = fieldValue(item);
          switch (filter.op) {
            case 'eq':
              return val === filter.value;
            case 'gte':
              return val >= filter.value;
            case 'lte':
              return val <= filter.value;
            case 'in':
              return Array.isArray(filter.value) && filter.value.includes(val);
            default:
              return true;
          }
        });
      }
    }

    // Apply ordering
    if (orderBy) {
      records.sort((a: any, b: any) => {
        const aVal = a[orderBy];
        const bVal = b[orderBy];
        if (aVal < bVal) return orderDirection === 'asc' ? -1 : 1;
        if (aVal > bVal) return orderDirection === 'asc' ? 1 : -1;
        return 0;
      });
    }

    // Apply range/limit
    if (rangeEndStr !== null) {
      const rangeStart = parseInt(rangeStartStr || '0');
      const rangeEnd = parseInt(rangeEndStr);
      records = records.slice(rangeStart, rangeEnd + 1);
    } else if (limitCountStr !== null) {
      const limitCount = parseInt(limitCountStr);
      records = records.slice(0, limitCount);
    }

    // Resolve nested relations
    records = await resolveRelations(table, records);

    if (isSingle) {
      return NextResponse.json({ data: records[0] || null, error: null });
    }

    return NextResponse.json({ data: records, error: null });
  } catch (e: any) {
    return NextResponse.json({ data: null, error: { message: e.message } }, { status: 500 });
  }
}

// POST handler (Insert / Update / Delete / Init)
export async function POST(req: NextRequest) {
  if (!isDesktopRuntime()) return desktopOnlyResponse();
  try {
    const body = await req.json();
    const { action, table, payload, filters } = body;

    // 1. Init Database with seed data if empty
    if (action === 'init') {
      let initializedCount = 0;
      for (const key of Object.keys(payload)) {
        const existing = await getAllRecordsFromTable(key);
        if (existing.length === 0 && Array.isArray(payload[key])) {
          await saveRecordsToTable(key, payload[key]);
          initializedCount++;
        }
      }
      return NextResponse.json({ success: true, initializedCount });
    }

    // 2. Sync Pull from Remote Supabase to Local SQLite DB
    if (action === 'sync-pull-table') {
      const { table: pullTable, records, mode, deletedIds } = body;
      if (!pullTable || !Array.isArray(records)) {
        return NextResponse.json({ error: "Missing table or records array" }, { status: 400 });
      }

      const queue = await getQueue();
      const pendingIds = new Set(
        queue
          .filter((t: any) => t.table === pullTable && t.payload?.id)
          .map((t: any) => t.payload.id)
      );

      const recordsToUpsert = records.filter(remoteItem => remoteItem?.id && !pendingIds.has(remoteItem.id));
      if (recordsToUpsert.length > 0) {
        await saveRecordsToTable(pullTable, recordsToUpsert);
      }

      let idsToRemoveLocally: string[] = [];

      if (mode === 'incremental') {
        // Pull incrémental (voir src/lib/localDbSync.ts) : `records` ne
        // contient QUE les lignes modifiées depuis le dernier curseur, donc
        // l'absence d'une ligne ici ne veut RIEN dire (elle n'a peut-être
        // juste pas changé) — la reconciliation par absence ci-dessous serait
        // catastrophique (elle effacerait tout le miroir local). Seules les
        // suppressions explicitement remontées via la table deleted_records
        // (deletedIds, fourni par l'appelant) doivent être retirées ici.
        idsToRemoveLocally = Array.isArray(deletedIds)
          ? deletedIds.filter((id: string) => id && !pendingIds.has(id))
          : [];
      } else {
        // Pull complet : ramène systématiquement TOUTES les lignes visibles à
        // distance (select('*') filtré par RLS, qui exclut déjà les
        // soft-deletes) : toute ligne locale absente de ce jeu complet a donc
        // été supprimée (ou soft-supprimée) à distance depuis le dernier
        // Pull, et doit disparaître du miroir local. On ne touche jamais aux
        // lignes encore en attente dans la file (pas encore poussées, donc
        // normalement absentes du jeu distant).
        const remoteIds = new Set(records.filter(r => r?.id).map(r => r.id));
        const localRecords = await getAllRecordsFromTable(pullTable);
        idsToRemoveLocally = localRecords
          .map((r: any) => r.id)
          .filter((id: string) => id && !remoteIds.has(id) && !pendingIds.has(id));
      }

      if (idsToRemoveLocally.length > 0) {
        await deleteRecordsFromTable(pullTable, idsToRemoveLocally);
      }

      return NextResponse.json({
        success: true,
        count: recordsToUpsert.length,
        skipped: records.length - recordsToUpsert.length,
        removedLocally: idsToRemoveLocally.length
      });
    }

    // 2b. Set a Pull incrémental cursor (voir src/lib/localDbSync.ts)
    if (action === 'set-sync-cursor') {
      const { key, value } = body;
      if (!key || typeof value !== 'string') {
        return NextResponse.json({ error: 'Missing key or value' }, { status: 400 });
      }
      await setSyncMeta(key, value);
      return NextResponse.json({ success: true });
    }

    // 3. RPC : équivalent local d'une fonction Postgres (finance, dashboard,
    // classements, etc.) — voir src/lib/db/localAggregates.ts. Renvoie la même
    // forme { data, error } que le vrai supabase.rpc(...).
    if (action === 'rpc') {
      const { fn, params, callerEtablissementId, callerRole } = body;
      if (!fn) {
        return NextResponse.json({ data: null, error: { message: "Missing fn parameter" } }, { status: 400 });
      }
      try {
        const data = await callLocalAggregate(fn, params || {}, { callerEtablissementId, callerRole });
        return NextResponse.json({ data, error: null });
      } catch (e: any) {
        return NextResponse.json({ data: null, error: { message: e.message } }, { status: 200 });
      }
    }

    if (!table || !action) {
      return NextResponse.json({ error: "Missing table or action parameter" }, { status: 400 });
    }

    let resultData: any = null;

    // A. INSERT
    if (action === 'insert') {
      const payloadArray = Array.isArray(payload) ? payload : [payload];
      for (const item of payloadArray) {
        if (!item.id) {
          item.id = crypto.randomUUID();
        }
        
        await addToQueue({
          id: `task_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
          table,
          action: 'insert',
          payload: item,
          timestamp: Date.now()
        });
      }
      await saveRecordsToTable(table, payloadArray);
      resultData = Array.isArray(payload) ? payloadArray : payloadArray[0];
    }

    // B. UPDATE
    else if (action === 'update') {
      if (!filters || !Array.isArray(filters)) {
        return NextResponse.json({ error: "Missing filters for update" }, { status: 400 });
      }

      const existingRecords = await getAllRecordsFromTable(table);
      const updatedItems: any[] = [];

      for (const item of existingRecords) {
        let match = true;
        for (const filter of filters) {
          if (item[filter.field] !== filter.value) {
            match = false;
            break;
          }
        }
        if (match) {
          const updated = { ...item, ...payload };
          updatedItems.push(updated);
        }
      }

      if (updatedItems.length > 0) {
        await saveRecordsToTable(table, updatedItems);
        for (const item of updatedItems) {
          await addToQueue({
            id: `task_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
            table,
            action: 'update',
            payload: item,
            filters,
            timestamp: Date.now()
          });
        }
      }
      resultData = updatedItems;
    }

    // C. UPSERT
    else if (action === 'upsert') {
      const payloadArray = Array.isArray(payload) ? payload : [payload];
      const { upsertOptions } = body;
      const onConflictOpt = upsertOptions?.onConflict;
      const conflictKeys: string[] = typeof onConflictOpt === 'string'
        ? onConflictOpt.split(',').map((k: string) => k.trim())
        : ['id'];

      const existingRecords = await getAllRecordsFromTable(table);
      const insertedItems: any[] = [];
      const updatedItems: any[] = [];

      for (const item of payloadArray) {
        const conflictIndex = existingRecords.findIndex((existingItem: any) => {
          return conflictKeys.every((key: string) => existingItem[key] !== undefined && existingItem[key] === item[key]);
        });

        if (conflictIndex !== -1) {
          const updated = { ...existingRecords[conflictIndex], ...item };
          updatedItems.push(updated);
        } else {
          if (!item.id) {
            item.id = crypto.randomUUID();
          }
          insertedItems.push(item);
        }
      }

      const allToSave = [...updatedItems, ...insertedItems];
      if (allToSave.length > 0) {
        await saveRecordsToTable(table, allToSave);
      }

      for (const item of updatedItems) {
        await addToQueue({
          id: `task_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
          table,
          action: 'update',
          payload: item,
          filters: conflictKeys.map((k: string) => ({ field: k, value: item[k] })),
          timestamp: Date.now()
        });
      }
      for (const item of insertedItems) {
        await addToQueue({
          id: `task_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
          table,
          action: 'insert',
          payload: item,
          timestamp: Date.now()
        });
      }

      resultData = Array.isArray(payload) ? [...updatedItems, ...insertedItems] : (updatedItems[0] || insertedItems[0]);
    }

    // D. DELETE
    else if (action === 'delete') {
      if (!filters || !Array.isArray(filters)) {
        return NextResponse.json({ error: "Missing filters for delete" }, { status: 400 });
      }

      const existingRecords = await getAllRecordsFromTable(table);
      const deletedItems: any[] = [];

      for (const item of existingRecords) {
        let match = true;
        for (const filter of filters) {
          if (item[filter.field] !== filter.value) {
            match = false;
            break;
          }
        }
        if (match) {
          deletedItems.push(item);
        }
      }

      if (deletedItems.length > 0) {
        const idsToDelete = deletedItems.map(d => d.id).filter(Boolean);
        await deleteRecordsFromTable(table, idsToDelete);

        for (const item of deletedItems) {
          await addToQueue({
            id: `task_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
            table,
            action: 'delete',
            payload: item,
            filters,
            timestamp: Date.now()
          });
        }
      }
      resultData = deletedItems;
    }

    return NextResponse.json({ data: resultData, error: null });
  } catch (e: any) {
    return NextResponse.json({ data: null, error: { message: e.message } }, { status: 500 });
  }
}

// DELETE handler (Acknowledge task from queue)
export async function DELETE(req: NextRequest) {
  if (!isDesktopRuntime()) return desktopOnlyResponse();
  try {
    const { taskId } = await req.json();
    if (!taskId) {
      return NextResponse.json({ error: "Missing taskId" }, { status: 400 });
    }

    await removeFromQueue(taskId);
    const queue = await getQueue();

    return NextResponse.json({ success: true, remaining: queue.length });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 });
  }
}
