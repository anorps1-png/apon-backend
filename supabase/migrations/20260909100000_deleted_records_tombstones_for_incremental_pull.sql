-- ============================================================================
-- Pull incrémental (desktop Electron) : jusqu'ici, chaque Pull retéléchargeait
-- l'intégralité de chaque table syncable. Pour ne récupérer que les lignes
-- modifiées depuis le dernier Pull (via classes.updated_at, déjà présent et
-- maintenu par trigger sur 14 des 30 tables — vérifié en direct), il faut
-- pouvoir aussi détecter les SUPPRESSIONS : une ligne supprimée (dur ou soft
-- via deleted_at) n'apparaît plus dans un SELECT filtré par updated_at, donc
-- resterait indéfiniment dans le miroir local sans mécanisme dédié.
--
-- Cette migration ajoute une table de "tombstones" (deleted_records) et des
-- triggers sur les 14 tables concernées : AFTER DELETE pour les 8 tables à
-- suppression définitive, AFTER UPDATE (transition deleted_at NULL -> NOT
-- NULL) pour les 6 tables à soft-delete. Le Pull incrémental interroge cette
-- table en plus des lignes modifiées pour savoir quoi retirer localement.
--
-- record_id est TEXT (pas UUID) car fiches_de_paie.id est de type text.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.deleted_records (
  id BIGSERIAL PRIMARY KEY,
  table_name TEXT NOT NULL,
  record_id TEXT NOT NULL,
  etablissement_id UUID,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deleted_records_table_deleted_at_idx
  ON public.deleted_records (table_name, deleted_at);

CREATE INDEX IF NOT EXISTS deleted_records_etablissement_idx
  ON public.deleted_records (etablissement_id);

ALTER TABLE public.deleted_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS deleted_records_tenant_select ON public.deleted_records;
CREATE POLICY deleted_records_tenant_select ON public.deleted_records
  FOR SELECT
  USING (etablissement_id = current_user_etablissement_id());

GRANT SELECT ON public.deleted_records TO authenticated;

-- Tables à suppression définitive (DELETE) : tombstone posé après coup, en
-- lisant OLD (la ligne n'existe déjà plus au moment du trigger).
CREATE OR REPLACE FUNCTION public.record_hard_deletion() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.deleted_records (table_name, record_id, etablissement_id, deleted_at)
  VALUES (TG_TABLE_NAME, OLD.id::text, OLD.etablissement_id, now());
  RETURN OLD;
END;
$$;

-- Tables à soft-delete (deleted_at) : tombstone posé quand deleted_at passe
-- de NULL à une valeur — pas à chaque UPDATE quelconque (WHEN plus bas).
CREATE OR REPLACE FUNCTION public.record_soft_deletion() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.deleted_records (table_name, record_id, etablissement_id, deleted_at)
  VALUES (TG_TABLE_NAME, NEW.id::text, NEW.etablissement_id, NEW.deleted_at);
  RETURN NEW;
END;
$$;

-- 8 tables hard-delete
DROP TRIGGER IF EXISTS trg_record_deletion ON public.annees_scolaires;
CREATE TRIGGER trg_record_deletion AFTER DELETE ON public.annees_scolaires
  FOR EACH ROW EXECUTE FUNCTION public.record_hard_deletion();

DROP TRIGGER IF EXISTS trg_record_deletion ON public.classes;
CREATE TRIGGER trg_record_deletion AFTER DELETE ON public.classes
  FOR EACH ROW EXECUTE FUNCTION public.record_hard_deletion();

DROP TRIGGER IF EXISTS trg_record_deletion ON public.discipline;
CREATE TRIGGER trg_record_deletion AFTER DELETE ON public.discipline
  FOR EACH ROW EXECUTE FUNCTION public.record_hard_deletion();

DROP TRIGGER IF EXISTS trg_record_deletion ON public.fiches_de_paie;
CREATE TRIGGER trg_record_deletion AFTER DELETE ON public.fiches_de_paie
  FOR EACH ROW EXECUTE FUNCTION public.record_hard_deletion();

DROP TRIGGER IF EXISTS trg_record_deletion ON public.matieres;
CREATE TRIGGER trg_record_deletion AFTER DELETE ON public.matieres
  FOR EACH ROW EXECUTE FUNCTION public.record_hard_deletion();

DROP TRIGGER IF EXISTS trg_record_deletion ON public.membres_personnel;
CREATE TRIGGER trg_record_deletion AFTER DELETE ON public.membres_personnel
  FOR EACH ROW EXECUTE FUNCTION public.record_hard_deletion();

DROP TRIGGER IF EXISTS trg_record_deletion ON public.niveaux_classes;
CREATE TRIGGER trg_record_deletion AFTER DELETE ON public.niveaux_classes
  FOR EACH ROW EXECUTE FUNCTION public.record_hard_deletion();

DROP TRIGGER IF EXISTS trg_record_deletion ON public.sections;
CREATE TRIGGER trg_record_deletion AFTER DELETE ON public.sections
  FOR EACH ROW EXECUTE FUNCTION public.record_hard_deletion();

-- 6 tables soft-delete
DROP TRIGGER IF EXISTS trg_record_soft_deletion ON public.bulletins;
CREATE TRIGGER trg_record_soft_deletion AFTER UPDATE ON public.bulletins
  FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION public.record_soft_deletion();

DROP TRIGGER IF EXISTS trg_record_soft_deletion ON public.ecritures_comptables;
CREATE TRIGGER trg_record_soft_deletion AFTER UPDATE ON public.ecritures_comptables
  FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION public.record_soft_deletion();

DROP TRIGGER IF EXISTS trg_record_soft_deletion ON public.eleves;
CREATE TRIGGER trg_record_soft_deletion AFTER UPDATE ON public.eleves
  FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION public.record_soft_deletion();

DROP TRIGGER IF EXISTS trg_record_soft_deletion ON public.enseignants;
CREATE TRIGGER trg_record_soft_deletion AFTER UPDATE ON public.enseignants
  FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION public.record_soft_deletion();

DROP TRIGGER IF EXISTS trg_record_soft_deletion ON public.notes;
CREATE TRIGGER trg_record_soft_deletion AFTER UPDATE ON public.notes
  FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION public.record_soft_deletion();

DROP TRIGGER IF EXISTS trg_record_soft_deletion ON public.paiements;
CREATE TRIGGER trg_record_soft_deletion AFTER UPDATE ON public.paiements
  FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION public.record_soft_deletion();

COMMIT;
