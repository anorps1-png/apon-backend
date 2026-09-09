'use client';
import { captureError, captureMessage } from '@/lib/observability/logger';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import AiBrainChat from '@/components/ai/AiBrainChat';
import { useEtablissement } from '@/contexts/etablissement-context';
import {
  DashboardIcon,
  StudentsIcon,
  TeachersIcon,
  FeesIcon,
  TimetableIcon,
  NotificationIcon,
  ChevronDownIcon,
  AcademicIcon,
  UsersIcon,
  ChartIcon,
  SettingsIcon
} from './icons';

import { createClient } from '@/lib/supabase/client';

interface DashboardLayoutProps {
  children: React.ReactNode;
}

export default function DashboardLayout({ children }: DashboardLayoutProps) {
  const pathname = usePathname();
  const { etablissementId, setEtablissementId, academicYear, setAcademicYear, academicYearId, setAcademicYearId } = useEtablissement();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [selectedSchool, setSelectedSchool] = useState('');
  const [subscriptionPlan, setSubscriptionPlan] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState('admin@mboaschool.com');
  const [userRole, setUserRole] = useState('Administrateur');
  const [userPermissions, setUserPermissions] = useState<Record<string, boolean> | null>(null);
  const [showNotifications, setShowNotifications] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [isElectron, setIsElectron] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncStatusMsg, setSyncStatusMsg] = useState('');
  const [pendingSyncCount, setPendingSyncCount] = useState(0);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const isEl = window.navigator.userAgent.toLowerCase().includes('electron') ||
                   !!(window as any).process?.versions?.electron;
      setIsElectron(isEl);

      // Le mode Electron/hors-ligne ne pré-charge plus d'école de démonstration
      // fictive ("École Privée Bilingue Mboa", classes/profs/emploi du temps
      // inventés) dans la base locale au premier lancement : une base vide
      // reste vide, l'utilisateur crée ses propres données réelles.

      // mboaschool_force_offline ne pilote plus le routage des données
      // (toujours local en Electron désormais, cf. src/lib/supabase/client.ts)
      // — seul le choix de méthode de connexion sur l'écran de login le lit
      // encore. window.__forceOffline reste exposé pour les deux derniers
      // repolis de lecture qui le consultent encore (eleves/page.tsx).
      const storedForceOffline = localStorage.getItem('mboaschool_force_offline');
      if (storedForceOffline === null || !isEl) {
        localStorage.setItem('mboaschool_force_offline', 'false');
      }
      (window as any).__forceOffline = isEl && storedForceOffline === 'true';
    }
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const handleUpdate = () => setRefreshTrigger(prev => prev + 1);
      window.addEventListener('school_settings_updated', handleUpdate);
      return () => window.removeEventListener('school_settings_updated', handleUpdate);
    }
  }, []);

  // Push et Pull sont deux actions manuelles indépendantes (jamais enchaînées
  // automatiquement) : l'utilisateur choisit d'envoyer ses modifications
  // locales, ou de rapatrier l'état distant, sans que l'une déclenche l'autre.
  const handlePush = async () => {
    if (isSyncing) return;
    setIsSyncing(true);
    setSyncStatusMsg('Envoi des modifications...');

    try {
      const { pushLocalQueue } = await import('@/lib/localDbSync');
      const result = await pushLocalQueue();

      if (result.sessionExpired) {
        setSyncStatusMsg('Session expirée, reconnexion nécessaire...');
        setTimeout(() => handleLogout('session-expiree'), 1500);
        return;
      }

      if (result.errors.length > 0) {
        setSyncStatusMsg(`${result.pushed} envoyé(s), ${result.failed} erreur(s).`);
        captureError(new Error('Push partiel'), { context: 'Manual push completed with errors', pushErrors: result.errors });
      } else if (result.pushed === 0) {
        setSyncStatusMsg('Rien à envoyer.');
      } else {
        setSyncStatusMsg(`${result.pushed} envoyé(s) !`);
      }
      setTimeout(() => setSyncStatusMsg(''), 3500);
    } catch (e: any) {
      captureError(e, { context: "Push failed:" });
      setSyncStatusMsg("Erreur d'envoi.");
      setTimeout(() => setSyncStatusMsg(''), 3000);
    } finally {
      setIsSyncing(false);
      refreshPendingCount();
    }
  };

  const handlePull = async () => {
    if (isSyncing) return;
    setIsSyncing(true);
    setSyncStatusMsg('Réception des données...');

    try {
      const { pullFromRemote } = await import('@/lib/localDbSync');
      const result = await pullFromRemote();

      if (result.sessionExpired) {
        setSyncStatusMsg('Session expirée, reconnexion nécessaire...');
        setTimeout(() => handleLogout('session-expiree'), 1500);
        return;
      }

      const pulledTotal = Object.values(result.pulled).reduce((sum, n) => sum + n, 0);

      if (result.errors.length > 0) {
        setSyncStatusMsg(`${pulledTotal} reçu(s), ${result.errors.length} erreur(s).`);
        captureError(new Error('Pull partiel'), { context: 'Manual pull completed with errors', pullErrors: result.errors });
      } else if (pulledTotal === 0) {
        setSyncStatusMsg('Déjà à jour !');
      } else {
        setSyncStatusMsg(`${pulledTotal} reçu(s) !`);
      }
      setTimeout(() => setSyncStatusMsg(''), 3500);
    } catch (e: any) {
      captureError(e, { context: "Pull failed:" });
      setSyncStatusMsg('Erreur de réception.');
      setTimeout(() => setSyncStatusMsg(''), 3000);
    } finally {
      setIsSyncing(false);
      refreshPendingCount();
    }
  };

  const handleLogout = async (reason?: string) => {
    try {
      const { createClient } = await import('@/lib/supabase/client');
      const supabase = createClient();
      await supabase.auth.signOut();
    } catch (err) {
      captureError(err, { context: "Error signing out:" });
    }

    // Purge des caches du service worker : sans elle, les réponses mises en
    // cache (pages du dashboard, payloads RSC) survivaient à la déconnexion et
    // restaient servables hors réseau à l'utilisateur suivant du même poste.
    try {
      if (typeof caches !== 'undefined') {
        const cacheKeys = await caches.keys();
        await Promise.all(cacheKeys.map((k) => caches.delete(k)));
      }
    } catch (err) {
      captureError(err, { context: 'Error clearing service worker caches:' });
    }

    document.cookie = "mboaschool_offline_session=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT";
    // Toutes les clés locales de session et de données, pas seulement la
    // session hors-ligne. Exception desktop : mboaschool_profiles porte les
    // hashes PBKDF2 qui permettent la connexion hors-ligne sur le poste de
    // l'école — les purger rendrait l'app inutilisable sans réseau.
    try {
      const preserve = isElectron ? ['mboaschool_profiles'] : [];
      Object.keys(localStorage)
        .filter((k) =>
          (k.startsWith('mboaschool_') || k.startsWith('offline_cache_')) &&
          !preserve.includes(k)
        )
        .forEach((k) => localStorage.removeItem(k));
    } catch (err) {
      captureError(err, { context: 'Error clearing local storage:' });
    }

    setEtablissementId(null);
    window.location.href = reason ? `/login?raison=${encodeURIComponent(reason)}` : '/login';
  };

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const loadProfileAndSchool = async () => {
        try {
          const { createClient } = await import('@/lib/supabase/client');
          const supabase = createClient();
          const { data: { user } } = await supabase.auth.getUser();

          if (user) {
            setUserEmail(user.email || '');
            
            // Get profile details
            const { data: profile } = await supabase
              .from('profiles')
              .select('role, etablissement_id, permissions')
              .eq('id', user.id)
              .single();

            if (profile) {
              setUserRole(profile.role === 'admin' ? 'Administrateur' : profile.role);
              // Seule trace persistée du rôle courant (pas de mboaschool_profiles
              // unique quand la connexion s'est faite en ligne) : lue par
              // callLocalRpc (src/lib/supabase/client.ts) pour les RPC locales
              // desktop qui vérifient un rôle (ex. soft_delete_paiement).
              if (profile.role) localStorage.setItem('mboaschool_current_role', profile.role);
              if (profile.permissions) {
                setUserPermissions(profile.permissions);
              }
              
              // Synchronize database etablissement_id with context/localStorage
              if (profile.etablissement_id && profile.etablissement_id !== etablissementId) {
                setEtablissementId(profile.etablissement_id);
              }
              
              // Get establishment details
              if (profile.etablissement_id) {
                const { data: etab } = await supabase
                  .from('etablissements')
                  .select('nom, annee_scolaire_active_id')
                  .eq('id', profile.etablissement_id)
                  .single();

                if (etab) {
                  setSelectedSchool(etab.nom);
                  localStorage.setItem('mboaschool_current_school', etab.nom);
                  
                  let activeYearId = etab.annee_scolaire_active_id;
                  
                  // Fallback: If no active year is set in the establishment, query the first school year from the database
                  if (!activeYearId && profile.etablissement_id) {
                    const { data: years } = await supabase
                      .from('annees_scolaires')
                      .select('id')
                      .eq('etablissement_id', profile.etablissement_id)
                      .limit(1);
                    if (years && years.length > 0) {
                      activeYearId = years[0].id;
                    }
                  }

                  if (activeYearId) {
                    setAcademicYearId(activeYearId);
                    const { data: annee } = await supabase
                      .from('annees_scolaires')
                      .select('nom')
                      .eq('id', activeYearId)
                      .single();

                    if (annee) {
                      setAcademicYear(annee.nom);
                      localStorage.setItem('mboaschool_current_year', annee.nom);
                    }
                  }
                }
              }
            }
          }
        } catch (err) {
          captureMessage("Could not load dynamic user context from Supabase, loading fallbacks", { detail: err });
        }

        // Check local storage fallbacks only if we don't have DB values yet
        const localSchool = localStorage.getItem('mboaschool_current_school');
        const localYear = localStorage.getItem('mboaschool_current_year');
        const localSub = localStorage.getItem('mboaschool_subscription');
        const offlineSession = localStorage.getItem('mboaschool_offline_session');

        if (!selectedSchool && localSchool) setSelectedSchool(localSchool);
        if (!academicYear && localYear) setAcademicYear(localYear);
        if (localSub) setSubscriptionPlan(localSub);
        
        let localActiveYearId = localStorage.getItem('mboaschool_active_year_id');
        const activeYearVal = localYear || academicYear;
        if (!localActiveYearId && activeYearVal) {
          localActiveYearId = typeof crypto !== 'undefined' ? crypto.randomUUID() : `local_year_${Date.now()}`;
          setAcademicYearId(localActiveYearId);
          
          const storedYears = localStorage.getItem('offline_cache_annees_scolaires');
          if (!storedYears) {
            const mockYear = { 
              id: localActiveYearId, 
              nom: activeYearVal, 
              etablissement_id: localStorage.getItem('mboaschool_etablissement_id') || 'd3b07384-d113-4ee7-a496-c67b8a74e50d'
            };
            localStorage.setItem('offline_cache_annees_scolaires', JSON.stringify([mockYear]));
          }
        }
        
        if (offlineSession) {
          try {
            const parsed = JSON.parse(offlineSession);
            if (parsed.email) setUserEmail(parsed.email);
            if (parsed.role) setUserRole(parsed.role === 'admin' ? 'Administrateur' : parsed.role);
            if (parsed.permissions) setUserPermissions(parsed.permissions);
          } catch (e) {
            captureMessage("Failed parsing offline session", { detail: e });
          }
        }
      };

      loadProfileAndSchool();
    }
    // Ne se relance que sur refreshTrigger : lit etablissementId/selectedSchool/
    // academicYear en closure pour des comparaisons "déjà à jour ?", mais ne doit
    // pas se redéclencher quand ces valeurs changent (ce sont ses propres setters
    // qui les modifient plus bas — boucle sinon).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTrigger]);

  const [availableYears, setAvailableYears] = useState<any[]>([]);

  useEffect(() => {
    if (typeof window !== 'undefined' && etablissementId) {
      const fetchYears = async () => {
        try {
          const supabase = createClient();
          const { data, error } = await supabase
            .from('annees_scolaires')
            .select('*')
            .eq('etablissement_id', etablissementId)
            .order('nom', { ascending: false });

          if (!error && data && data.length > 0) {
            setAvailableYears(data);
            
            const currentYear = localStorage.getItem('mboaschool_current_year') || academicYear;
            const currentYearId = localStorage.getItem('mboaschool_active_year_id') || academicYearId;
            const match = data.find(y => y.nom === currentYear || y.id === currentYearId);
            if (match) {
              if (academicYear !== match.nom) setAcademicYear(match.nom);
              if (academicYearId !== match.id) setAcademicYearId(match.id);
            } else {
              setAcademicYear(data[0].nom);
              setAcademicYearId(data[0].id);
            }
          } else {
            const stored = localStorage.getItem('offline_cache_annees_scolaires');
            if (stored) {
              const parsed = JSON.parse(stored);
              if (Array.isArray(parsed) && parsed.length > 0) {
                setAvailableYears(parsed);
                const match = parsed.find(y => y.nom === academicYear || y.id === academicYearId);
                if (match) {
                  if (academicYear !== match.nom) setAcademicYear(match.nom);
                  if (academicYearId !== match.id) setAcademicYearId(match.id);
                } else {
                  setAcademicYear(parsed[0].nom);
                  setAcademicYearId(parsed[0].id);
                }
              }
            }
          }
        } catch (e) {
          captureMessage("Error fetching years in DashboardLayout:", { detail: e });
        }
      };

      fetchYears();

      window.addEventListener('school_settings_updated', fetchYears);
      window.addEventListener('academic_year_changed', fetchYears);
      return () => {
        window.removeEventListener('school_settings_updated', fetchYears);
        window.removeEventListener('academic_year_changed', fetchYears);
      };
    }
    // academicYear/academicYearId lus en closure pour comparaison ; ce sont ces
    // mêmes valeurs que l'effet met à jour plus bas (guard "si différent") —
    // les inclure ferait tourner fetchYears en boucle inutilement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [etablissementId, refreshTrigger]);


  // Compteur d'actions en attente : reflète désormais la file SQLite locale
  // (/api/local-db, action=get-queue), la même que Push consomme — plus de
  // file IndexedDB séparée (SyncManager, supprimé) à tenir synchronisée avec
  // elle. Pas de synchro automatique en arrière-plan (Mode 100% Manuel,
  // Push/Pull explicites uniquement) : on se contente d'afficher le compte.
  const refreshPendingCount = async () => {
    if (!isElectron) return;
    try {
      const res = await fetch('/api/local-db?action=get-queue');
      const body = await res.json();
      setPendingSyncCount((body.queue || []).length);
    } catch {
      // Pas grave si ça échoue une fois : Push/Pull redonnera l'occasion de rafraîchir.
    }
  };

  useEffect(() => {
    refreshPendingCount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isElectron]);


  // BYPASS POUR LA LANDING PAGE
  if (pathname === '/') {
    return <>{children}</>;
  }


  const menuItems = [
    { name: 'Tableau de bord', href: '/dashboard', icon: DashboardIcon, key: 'dashboard' },
    { name: 'Sections', href: '/sections', icon: DashboardIcon, key: 'sections' },
    { name: 'Classes', href: '/classes', icon: StudentsIcon, key: 'classes' },
    { name: 'Emploi du temps', href: '/emploi-du-temps', icon: TimetableIcon, key: 'emploi-du-temps' },
    { name: 'Élèves', href: '/eleves', icon: StudentsIcon, key: 'eleves' },
    { name: 'Communauté & QHSE', href: '/parents', icon: UsersIcon, key: 'parents' },
    { name: 'Enseignants', href: '/enseignants', icon: TeachersIcon, key: 'enseignants' },
    { name: 'Évaluations', href: '/evaluations', icon: AcademicIcon, key: 'evaluations' },
    { name: 'Finance', href: '/finance', icon: ChartIcon, key: 'finance' },
    { name: 'Ressources Humaines', href: '/rh', icon: UsersIcon, key: 'rh' },
    { name: 'Paramètres', href: '/settings', icon: SettingsIcon, key: 'settings' },
  ];

  const roleLower = userRole.toLowerCase();

  const filteredMenuItems = menuItems.filter(item => {
    if (roleLower === 'admin' || roleLower === 'administrateur') {
      return true;
    }

    // Check custom permissions first if available
    if (userPermissions && Object.keys(userPermissions).length > 0) {
      if (item.key === 'dashboard') return true;
      if (userPermissions[item.key] !== undefined) {
        return userPermissions[item.key];
      }
    }

    // Fallback role defaults
    if (roleLower === 'directeur') {
      return true;
    }
    if (roleLower === 'enseignant') {
      return ['/dashboard', '/classes', '/emploi-du-temps', '/eleves', '/evaluations'].includes(item.href);
    }
    if (roleLower === 'parent') {
      return ['/dashboard', '/emploi-du-temps', '/eleves', '/parents'].includes(item.href);
    }
    return item.href === '/dashboard';
  });

  const isAuthorized = (href: string) => {
    if (roleLower === 'admin' || roleLower === 'administrateur') {
      return true;
    }

    // Check custom permissions first if available
    if (userPermissions && Object.keys(userPermissions).length > 0) {
      if (href === '/dashboard') return true;
      const matched = menuItems.find(item => href === item.href || href.startsWith(item.href + '/'));
      if (matched && userPermissions[matched.key] !== undefined) {
        return userPermissions[matched.key];
      }
    }

    // Fallback role defaults
    if (roleLower === 'directeur') {
      return true;
    }
    if (roleLower === 'enseignant') {
      return ['/dashboard', '/classes', '/emploi-du-temps', '/eleves', '/evaluations'].some(path => href === path || href.startsWith(path + '/'));
    }
    if (roleLower === 'parent') {
      return ['/dashboard', '/emploi-du-temps', '/eleves', '/parents'].some(path => href === path || href.startsWith(path + '/'));
    }
    return href === '/dashboard';
  };

  // Aucune source réelle de notifications n'existe encore dans l'application
  // (pas de table `notifications` en base) — liste volontairement vide plutôt
  // que des événements fictifs ("Nouveau paiement reçu pour Jean-Pierre
  // Fouda"...) affichés comme s'ils étaient réels sur chaque page du tableau
  // de bord.
  const notifications: { id: number; text: string; time: string; unread: boolean }[] = [];

  return (
    <div className="min-h-screen bg-bg flex flex-col font-sans text-ink">
      {/* Bande kenté signature */}
      <div className="kente-band sticky top-0 z-40" />


      {/* Configuration Warning Banner */}
      {(typeof window !== 'undefined' &&
        (!process.env.NEXT_PUBLIC_SUPABASE_URL ||
         process.env.NEXT_PUBLIC_SUPABASE_URL.includes('placeholder'))) && (
        <div className="bg-accent text-cream text-xs font-bold text-center py-2.5 px-4 z-30 flex items-center justify-center gap-2">
          <span>⚠️</span>
          <span>
            <strong>Configuration incomplète :</strong> les variables d&apos;environnement Supabase (URL / Clé) ne sont pas configurées. Ajoutez <code>NEXT_PUBLIC_SUPABASE_URL</code> et <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code>, puis redéployez.
          </span>
        </div>
      )}

      {/* Header sticky : logo, contrôles, nav en pills */}
      <header className="sticky top-[6px] z-30 bg-surface border-b border-border">
        {/* Rangée 1 : logo + contrôles */}
        <div className="flex items-center justify-between gap-4 px-4 lg:px-8 h-16">
          <Link href="/dashboard" className="flex items-center gap-2.5 shrink-0">
            <div className="w-9 h-9 rounded-[12px] bg-ink text-cream flex items-center justify-center font-extrabold text-lg">M</div>
            <span className="font-extrabold text-xl text-ink tracking-tight hidden sm:inline">MboaSchool</span>
          </Link>

          <div className="flex items-center gap-2.5">
            {/* Établissement */}
            {selectedSchool && (
              <div className="hidden md:flex items-center gap-2 bg-bg border border-border px-3 py-1.5 rounded-pill text-sm font-semibold text-ink-soft">
                <span className="w-2 h-2 rounded-full bg-accent"></span>
                <span className="max-w-[180px] truncate">{selectedSchool}</span>
              </div>
            )}

            {/* Sélecteur d'année */}
            <div className="relative">
              <select
                value={academicYear}
                onChange={(e) => {
                  const selectedYearNom = e.target.value;
                  const matched = availableYears.find(y => y.nom === selectedYearNom);
                  if (matched) {
                    setAcademicYear(matched.nom);
                    setAcademicYearId(matched.id);
                  } else {
                    setAcademicYear(selectedYearNom);
                  }
                }}
                className="appearance-none bg-bg border border-outline pl-3 pr-8 py-1.5 rounded-pill text-sm font-semibold text-ink-soft focus:outline-none focus:border-accent cursor-pointer"
              >
                {availableYears.length === 0 ? (
                  <option value={academicYear}>Année {academicYear || 'Non spécifiée'}</option>
                ) : (
                  availableYears.map(y => (
                    <option key={y.id} value={y.nom}>Année {y.nom}</option>
                  ))
                )}
              </select>
              <ChevronDownIcon size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none text-ink-faint" />
            </div>

            {/* Pastille de statut : le desktop Electron fonctionne toujours en
                local (src/lib/supabase/client.ts) — pas de notion "en ligne/
                hors-ligne" à afficher, juste ce qui reste à envoyer via Push. */}
            {isElectron && (
              <div
                className="hidden lg:flex items-center gap-2 text-xs font-bold text-ink-faint px-2"
                title={pendingSyncCount > 0 ? `${pendingSyncCount} action(s) en attente d'envoi (bouton Push)` : "Aucune action en attente d'envoi"}
              >
                <span className={`w-2 h-2 rounded-full ${pendingSyncCount > 0 ? 'bg-accent animate-pulse-dot' : 'bg-green'}`}></span>
                <span>{pendingSyncCount > 0 ? `${pendingSyncCount} en attente` : 'Local'}</span>
              </div>
            )}

            {/* Push / Pull (desktop Electron) : deux actions manuelles
                indépendantes, jamais enchaînées automatiquement. */}
            {isElectron && (
              <div className="flex items-center gap-1.5">
                <button
                  onClick={handlePull}
                  disabled={isSyncing}
                  title="Rapatrier les données distantes vers ce poste"
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-chip hover:bg-chip-hover disabled:opacity-60 text-ink rounded-pill text-xs font-bold transition-colors cursor-pointer"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M6 13l6 6 6-6"/></svg>
                  <span>Pull</span>
                </button>
                <button
                  onClick={handlePush}
                  disabled={isSyncing}
                  title="Envoyer les modifications locales vers le serveur"
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-accent hover:bg-accent-hover disabled:opacity-60 text-cream rounded-pill text-xs font-bold transition-colors cursor-pointer"
                  style={{ boxShadow: 'var(--shadow-cta)' }}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg>
                  <span>Push</span>
                </button>
                {syncStatusMsg && (
                  <span className="text-[11px] font-bold text-ink-faint px-1 whitespace-nowrap">{syncStatusMsg}</span>
                )}
              </div>
            )}

            {/* Notifications */}
            <div className="relative">
              <button
                onClick={() => setShowNotifications(!showNotifications)}
                className="p-2 text-ink-soft hover:text-ink hover:bg-chip rounded-full transition-colors relative"
              >
                <NotificationIcon size={20} />
                {notifications.some(n => n.unread) && (
                  <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-accent rounded-full"></span>
                )}
              </button>
              {showNotifications && (
                <>
                  <div className="fixed inset-0 z-30" onClick={() => setShowNotifications(false)}></div>
                  <div className="absolute right-0 mt-2 w-80 bg-surface border border-border rounded-card shadow-lg py-2 z-40 animate-fade-up">
                    <div className="px-4 py-2 border-b border-border flex items-center justify-between">
                      <span className="text-xs font-bold text-ink">Notifications</span>
                      {notifications.some(n => n.unread) && (
                        <span className="text-[10px] text-green bg-green-bg px-2 py-0.5 rounded-pill font-bold">
                          {notifications.filter(n => n.unread).length} Nouvelle(s)
                        </span>
                      )}
                    </div>
                    <div className="max-h-64 overflow-y-auto">
                      {notifications.map((n) => (
                        <div key={n.id} className={`px-4 py-3 hover:bg-row-hover border-b border-border-row last:border-b-0 cursor-pointer transition-colors`}>
                          <p className="text-xs text-ink-soft leading-relaxed">{n.text}</p>
                          <span className="text-[10px] text-ink-faint mt-1 block">{n.time}</span>
                        </div>
                      ))}
                      {notifications.length === 0 && (
                        <p className="px-4 py-6 text-xs text-ink-faint text-center italic">Aucune notification pour le moment.</p>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Avatar */}
            <div className="w-9 h-9 rounded-full bg-chip text-ink flex items-center justify-center font-extrabold text-sm uppercase shrink-0" title={`${userEmail} · ${userRole}`}>
              {userEmail ? userEmail.substring(0, 2) : 'AD'}
            </div>

            {/* Déconnexion */}
            <button
              onClick={() => handleLogout()}
              title="Se déconnecter"
              className="p-2 text-ink-soft hover:text-accent hover:bg-chip rounded-full transition-colors"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
            </button>
          </div>
        </div>

        {/* Rangée 2 : navigation en pills (défilement horizontal si nécessaire) */}
        <nav className="flex items-center gap-1.5 px-4 lg:px-8 pb-3 pt-1 overflow-x-auto">
          {filteredMenuItems.map((item) => {
            const isActive = pathname === item.href || (item.href !== '/dashboard' && pathname.startsWith(item.href));
            return (
              <Link
                key={item.name}
                href={item.href}
                className={`
                  whitespace-nowrap px-4 py-2 rounded-pill text-sm font-bold transition-colors shrink-0
                  ${isActive
                    ? 'bg-ink text-cream'
                    : 'text-ink-soft hover:bg-chip'
                  }
                `}
              >
                {item.name}
              </Link>
            );
          })}
        </nav>
      </header>

      {/* Contenu */}
      <main className="flex-1 p-4 lg:p-8 overflow-y-auto">
        {isAuthorized(pathname) ? (
          children
        ) : (
          <div className="bg-surface p-8 rounded-card border border-border text-center max-w-md mx-auto mt-20 animate-fade-up">
            <span className="text-5xl">🔒</span>
            <h2 className="text-xl font-extrabold text-ink mt-4">Accès Restreint</h2>
            <p className="text-sm text-ink-soft mt-2">
              Vous n&apos;avez pas les habilitations nécessaires pour accéder à la rubrique <strong>{pathname}</strong>.
            </p>
            <Link href="/dashboard" className="mt-6 inline-block px-5 py-2.5 bg-accent hover:bg-accent-hover text-cream rounded-control text-sm font-extrabold transition-colors">
              Retour au Tableau de bord
            </Link>
          </div>
        )}
      </main>

      {(roleLower === 'admin' || roleLower === 'administrateur' || roleLower === 'directeur') && <AiBrainChat />}
    </div>
  );
}
