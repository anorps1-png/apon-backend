import { createBrowserClient } from '@supabase/ssr';
import { captureError } from '@/lib/observability/logger';

// Tables tenant-scopées synchronisées entre la base SQLite locale (desktop
// Electron, cf. src/lib/db/sqlite.ts) et Supabase. Le PULL ne filtre pas
// explicitement par etablissement_id : la RLS de chaque table le fait déjà
// (vérifié dans les audits de cette session), donc `select('*')` ne renvoie
// que les lignes de l'école de l'utilisateur connecté. `profiles`,
// `etablissements` et `invitations` sont volontairement exclues : identité/
// compte, déjà gérées par le flux de connexion, pas des données de travail
// hors-ligne.
const SYNCABLE_TABLES = [
  'annees_scolaires',
  'sections',
  'niveaux_classes',
  'classes',
  'matieres',
  'eleves',
  'enseignants',
  'membres_personnel',
  'notes',
  'bulletins',
  'paiements',
  'tranches_scolarite',
  'fiches_de_paie',
  'ecritures_comptables',
  'lignes_ecritures',
  'comptes_ohada',
  'emploi_du_temps',
  'discipline',
  'absences_personnel',
  'mouvements_personnel',
  'evaluations_rh',
  'formations_rh',
  'formations_beneficiaires',
  'qhse_incidents',
  'qhse_reunions',
  'qhse_depenses',
  'qhse_evaluations',
  'enquetes',
  'enquetes_historique',
  'parent_eleves',
] as const;

// Tables (parmi SYNCABLE_TABLES) qui ont une colonne updated_at maintenue par
// trigger ET une table de tombstones (deleted_records, migration
// 20260909100000) pour détecter leurs suppressions : seules celles-ci peuvent
// faire un Pull incrémental (updated_at > curseur). Les 16 autres tables
// (RH/QHSE, tranches_scolarite, comptes_ohada, emploi_du_temps,
// lignes_ecritures, parent_eleves...) n'ont pas cette colonne : elles restent
// en Pull complet, sans risque puisque leur volume est faible.
const INCREMENTAL_TABLES = new Set([
  'annees_scolaires', 'bulletins', 'classes', 'discipline', 'ecritures_comptables',
  'eleves', 'enseignants', 'fiches_de_paie', 'matieres', 'membres_personnel',
  'niveaux_classes', 'notes', 'paiements', 'sections',
]);

// Client Supabase "réel", en dehors du proxy offline-aware de
// @/lib/supabase/client (qui redirige .from() vers la base SQLite locale
// quand forceOffline est actif) : le PULL a justement besoin de toujours
// atteindre le vrai Supabase, quel que soit ce réglage.
function getOnlineClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co';
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder';
  return createBrowserClient(supabaseUrl, supabaseKey);
}

// Une coupure réseau pile pendant le renouvellement automatique du jeton de
// session peut le laisser mort côté client alors qu'il a déjà été invalidé
// côté serveur (rotation du refresh token) : toute requête suivante échoue
// silencieusement, table après table, jusqu'à ce que l'utilisateur ferme/
// rouvre l'app ou se reconnecte manuellement. On détecte ce cas précis pour
// arrêter tout de suite plutôt que d'accumuler des dizaines d'erreurs
// identiques, et pour dire clairement à l'appelant qu'il faut se reconnecter.
function isDeadSessionError(err: any): boolean {
  const msg = String(err?.message || err?.error_description || '').toLowerCase();
  const code = String(err?.code || '').toLowerCase();
  return (
    err?.name === 'AuthApiError' ||
    code === 'refresh_token_not_found' ||
    code === 'refresh_token_already_used' ||
    msg.includes('refresh token') ||
    msg.includes('jwt expired') ||
    msg.includes('invalid jwt') ||
    msg.includes('invalid claim') ||
    msg.includes('session missing')
  );
}

// Vérifie, avant de lancer un Push/Pull potentiellement long, qu'une session
// en ligne valide existe réellement — plutôt que de le découvrir après avoir
// déjà échoué sur plusieurs tables/éléments.
async function hasValidOnlineSession(client: ReturnType<typeof getOnlineClient>): Promise<boolean> {
  try {
    const { data, error } = await client.auth.getSession();
    if (error || !data?.session) return false;
    return true;
  } catch {
    return false;
  }
}

// Repris du même principe que l'app comptable Agent OHADA (Le-DAF) : une
// coupure réseau passagère en plein milieu d'un PUSH/PULL déclenché
// manuellement ne doit pas obliger l'utilisateur à tout relancer dès que la
// connexion revient.
async function withNetworkRetry<T>(fn: () => PromiseLike<T>, retries = 3, baseDelayMs = 1500): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
      const delay = Math.min(10000, baseDelayMs * 2 ** attempt);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

export interface PushResult {
  pushed: number;
  failed: number;
  errors: string[];
  sessionExpired?: boolean;
}

export interface PullResult {
  pulled: Record<string, number>;
  errors: string[];
  sessionExpired?: boolean;
}

// PUSH : rejoue la file locale (sync_queue en SQLite, alimentée à chaque
// insert/update/delete offline via /api/local-db) vers Supabase.
export async function pushLocalQueue(): Promise<PushResult> {
  const res = await fetch('/api/local-db?action=get-queue');
  const data = await res.json();
  const queue = data.queue || [];
  if (queue.length === 0) return { pushed: 0, failed: 0, errors: [] };

  const client = getOnlineClient();
  if (!(await hasValidOnlineSession(client))) {
    return { pushed: 0, failed: queue.length, errors: ['Session en ligne expirée ou absente.'], sessionExpired: true };
  }

  let pushed = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const task of queue) {
    const { id, table, action, payload, filters } = task;
    try {
      let result: any;
      if (action === 'insert') {
        result = await withNetworkRetry(() => client.from(table).insert(payload));
      } else if (action === 'update') {
        result = await withNetworkRetry(() => {
          let builder: any = client.from(table).update(payload);
          (filters || []).forEach((f: any) => { builder = builder.eq(f.field, f.value); });
          return builder;
        });
      } else if (action === 'delete') {
        result = await withNetworkRetry(() => {
          let builder: any = client.from(table).delete();
          (filters || []).forEach((f: any) => { builder = builder.eq(f.field, f.value); });
          return builder;
        });
      }

      if (result?.error) {
        if (isDeadSessionError(result.error)) {
          errors.push('Session en ligne expirée en cours de synchronisation.');
          return { pushed, failed: failed + (queue.length - pushed - failed), errors, sessionExpired: true };
        }
        failed++;
        errors.push(`${table} (${action}): ${result.error.message}`);
        captureError(result.error, { context: 'Push sync error on table', table });
      } else {
        pushed++;
        await fetch('/api/local-db', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskId: id }),
        });
      }
    } catch (err: any) {
      if (isDeadSessionError(err)) {
        errors.push('Session en ligne expirée en cours de synchronisation.');
        return { pushed, failed: failed + (queue.length - pushed - failed), errors, sessionExpired: true };
      }
      failed++;
      errors.push(`${table} (${action}): ${err.message}`);
      captureError(err, { context: 'Push sync network error on table', table });
    }
  }

  return { pushed, failed, errors };
}

// Pagine un select() jusqu'à épuisement : PostgREST peut tronquer une grande
// table (paiements, notes...) sur une requête non paginée, et un appelant qui
// traiterait l'absence de lignes comme "supprimé à distance" effacerait alors
// localement tout ce qui dépasse la première page à tort.
async function fetchAllPages<T>(
  pageFn: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>
): Promise<{ records: T[]; error: any }> {
  const records: T[] = [];
  const pageSize = 1000;
  let from = 0;
  let hasMore = true;
  while (hasMore) {
    const { data, error } = await withNetworkRetry(() => pageFn(from, from + pageSize - 1));
    if (error) return { records, error };
    const page = data || [];
    records.push(...page);
    if (page.length < pageSize) hasMore = false;
    else from += pageSize;
  }
  return { records, error: null };
}

const CURSOR_KEY = (table: string) => `pull_cursor_${table}`;

// Léger recul (2s) sur le curseur persisté : couvre le cas limite où deux
// écritures très rapprochées auraient un updated_at côté serveur légèrement
// désynchronisé de l'ordre de visibilité des transactions. Re-télécharger
// quelques lignes déjà vues est inoffensif (upsert idempotent) ; rater une
// ligne modifiée ne l'est pas.
const CURSOR_SAFETY_MARGIN_MS = 2000;

function maxISODate(dates: (string | null | undefined)[], fallback: string | null): string | null {
  let max = fallback ? new Date(fallback).getTime() : -Infinity;
  for (const d of dates) {
    if (!d) continue;
    const t = new Date(d).getTime();
    if (!Number.isNaN(t) && t > max) max = t;
  }
  return Number.isFinite(max) ? new Date(max).toISOString() : null;
}

// PULL : télécharge chaque table syncable depuis Supabase (RLS = tenant
// courant déjà appliqué) et remplace le miroir SQLite local. Le serveur
// (`sync-pull-table`) ignore les lignes qui ont une tâche encore en attente
// dans la file locale, pour ne pas écraser une modif pas encore poussée par
// une version distante plus ancienne.
//
// Les tables de INCREMENTAL_TABLES (updated_at maintenu par trigger + table
// de tombstones deleted_records, migration 20260909100000) ne retéléchargent
// que ce qui a changé depuis le curseur local ; les autres restent en Pull
// complet (volume faible, pas de gain à en tirer).
export async function pullFromRemote(): Promise<PullResult> {
  const client = getOnlineClient();
  if (!(await hasValidOnlineSession(client))) {
    return { pulled: {}, errors: ['Session en ligne expirée ou absente.'], sessionExpired: true };
  }

  const pulled: Record<string, number> = {};
  const errors: string[] = [];

  for (const table of SYNCABLE_TABLES) {
    try {
      const isIncremental = INCREMENTAL_TABLES.has(table);
      let cursor: string | null = null;
      if (isIncremental) {
        const curRes = await fetch(`/api/local-db?action=get-sync-cursor&key=${encodeURIComponent(CURSOR_KEY(table))}`);
        const curBody = await curRes.json();
        cursor = curBody.value || null;
      }

      let records: any[] = [];
      let tombstoneRecords: { record_id: string; deleted_at: string }[] = [];
      let pageError: any = null;

      if (isIncremental && cursor) {
        // Curseur déjà initialisé : ne récupère que les lignes modifiées et
        // les tombstones posés depuis le dernier Pull réussi.
        const changed = await fetchAllPages<any>((from, to) =>
          client.from(table).select('*').gt('updated_at', cursor as string).order('updated_at', { ascending: true }).range(from, to)
        );
        if (changed.error) { pageError = changed.error; }
        else {
          records = changed.records;
          const tombstones = await fetchAllPages<{ record_id: string; deleted_at: string }>((from, to) =>
            client.from('deleted_records').select('record_id, deleted_at').eq('table_name', table).gt('deleted_at', cursor as string).order('deleted_at', { ascending: true }).range(from, to)
          );
          if (tombstones.error) { pageError = tombstones.error; }
          else tombstoneRecords = tombstones.records;
        }
      } else {
        // Premier Pull de cette table (ou table non incrémentale) : jeu complet.
        const full = await fetchAllPages<any>((from, to) => client.from(table).select('*').range(from, to));
        pageError = full.error;
        records = full.records;
      }

      if (pageError) {
        if (isDeadSessionError(pageError)) {
          return { pulled, errors: [...errors, 'Session en ligne expirée en cours de synchronisation.'], sessionExpired: true };
        }
        errors.push(`${table}: ${pageError.message}`);
        captureError(pageError, { context: 'Pull sync error on table', table });
        continue;
      }

      const res = await fetch('/api/local-db', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'sync-pull-table',
          table,
          records,
          mode: isIncremental && cursor ? 'incremental' : 'full',
          deletedIds: tombstoneRecords.map((t) => t.record_id),
        }),
      });
      const body = await res.json();
      pulled[table] = body.count ?? records.length;

      if (isIncremental) {
        const newCursor = maxISODate(
          [...records.map((r) => r.updated_at), ...tombstoneRecords.map((t) => t.deleted_at)],
          cursor || '1970-01-01T00:00:00.000Z'
        );
        if (newCursor) {
          const adjusted = new Date(new Date(newCursor).getTime() - CURSOR_SAFETY_MARGIN_MS).toISOString();
          // Ne recule jamais avant le curseur déjà persisté (une marge de
          // sécurité ne doit pas faire boucler indéfiniment sur les mêmes
          // lignes si rien de nouveau n'a jamais été vu).
          const finalCursor = cursor && new Date(adjusted).getTime() < new Date(cursor).getTime() ? cursor : adjusted;
          await fetch('/api/local-db', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'set-sync-cursor', key: CURSOR_KEY(table), value: finalCursor }),
          });
        }
      }
    } catch (err: any) {
      if (isDeadSessionError(err)) {
        return { pulled, errors: [...errors, 'Session en ligne expirée en cours de synchronisation.'], sessionExpired: true };
      }
      errors.push(`${table}: ${err.message}`);
      captureError(err, { context: 'Pull sync network error on table', table });
    }
  }

  return { pulled, errors };
}
