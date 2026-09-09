'use client';
import { captureError, captureMessage } from '@/lib/observability/logger';

import React, { useState, useEffect, useMemo, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient, isRunningInElectron } from '@/lib/supabase/client';
import { hashPassword, verifyPassword } from '@/lib/utils/offlineAuth';
import { validatePasswordStrength } from '@/lib/validation/password';

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  
  // Navigation State
  const [isSignUp, setIsSignUp] = useState(false);
  const [signUpSuccess, setSignUpSuccess] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [resetSent, setResetSent] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);

  // Step 1 & Login States
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isOffline, setIsOffline] = useState(false);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const checkStatus = () => {
        const forceOffline = localStorage.getItem('mboaschool_force_offline') === 'true';
        setIsOffline(!navigator.onLine || forceOffline);
      };
      checkStatus();
      window.addEventListener('online', checkStatus);
      window.addEventListener('offline', checkStatus);
      return () => {
        window.removeEventListener('online', checkStatus);
        window.removeEventListener('offline', checkStatus);
      };
    }
  }, []);

  // Abonnement souscrit à la création du compte — pas de sélection de plan
  // ni de paiement dans ce MVP (facturation non branchée) : 'Standard' par
  // défaut, persisté pour l'affichage (DashboardLayout).
  const [selectedPlan] = useState<'Basic' | 'Standard' | 'Premium'>('Standard');

  // School Information
  const [schoolName, setSchoolName] = useState('');
  const [schoolSystem, setSchoolSystem] = useState('Francophone');
  const [schoolYear, setSchoolYear] = useState('2025/2026');

  const supabase = useMemo(() => createClient(), []);

  useEffect(() => {
    const isSignupUrl = searchParams.get('signup') === 'true';
    if (isSignupUrl) {
      setIsSignUp(true);
    }
    if (searchParams.get('raison') === 'session-expiree') {
      setErrorMsg("Votre session en ligne a expiré, probablement suite à une coupure réseau. Reconnectez-vous pour continuer.");
    }
  }, [searchParams]);

  const handleOfflineLogin = async () => {
    // Check in mboaschool_profiles for accounts cached during a previous online login.
    // Le mot de passe est TOUJOURS vérifié (hash PBKDF2) : un profil sans empreinte
    // de mot de passe ne permet pas de se connecter hors-ligne.
    const storedProfiles = localStorage.getItem('mboaschool_profiles');
    if (storedProfiles) {
      try {
        const profilesList = JSON.parse(storedProfiles);
        const matchedProfile = profilesList.find((p: any) => p.email === email);
        if (matchedProfile) {
          let passwordOk = false;
          if (matchedProfile.passwordHash && matchedProfile.passwordSalt) {
            passwordOk = await verifyPassword(password, matchedProfile.passwordSalt, matchedProfile.passwordHash);
          } else if (matchedProfile.password) {
            // Ancienne entrée stockée en clair : on vérifie puis on migre vers le hash.
            passwordOk = matchedProfile.password === password;
            if (passwordOk) {
              const { hash, salt } = await hashPassword(password);
              delete matchedProfile.password;
              matchedProfile.passwordHash = hash;
              matchedProfile.passwordSalt = salt;
              localStorage.setItem('mboaschool_profiles', JSON.stringify(profilesList));
            }
          }
          if (!passwordOk) {
            setErrorMsg("Mot de passe incorrect.");
            setIsLoading(false);
            return;
          }
          localStorage.setItem('mboaschool_offline_session', JSON.stringify({
            email: matchedProfile.email,
            role: matchedProfile.role,
            school: matchedProfile.school || localStorage.getItem('mboaschool_current_school') || 'Mon Établissement'
          }));
          if (matchedProfile.school) {
            localStorage.setItem('mboaschool_current_school', matchedProfile.school);
          }
          if (matchedProfile.role) {
            localStorage.setItem('mboaschool_current_role', matchedProfile.role);
          }
          if (matchedProfile.etablissement_id) {
            localStorage.setItem('mboaschool_etablissement_id', matchedProfile.etablissement_id);
          }
          document.cookie = "mboaschool_offline_session=true; path=/; max-age=86400";
          router.push('/dashboard');
          return;
        }
      } catch (e) {
        captureMessage("Failed checking mboaschool_profiles", { detail: e });
      }
    }

    // Comptes de démonstration : uniquement dans les builds de développement.
    // En production, aucun compte codé en dur ne doit donner accès à l'application.
    if (process.env.NODE_ENV === 'development' &&
        (email === 'admin@mboaschool.com' || email === 'directeur@mboaschool.com')) {
      const demoEtabId = 'd3b07384-d113-4ee7-a496-c67b8a74e50d';
      const demoYearId = 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d';
      document.cookie = "mboaschool_offline_session=true; path=/; max-age=86400";
      localStorage.setItem('mboaschool_offline_session', JSON.stringify({
        email,
        role: 'admin',
        school: 'Collège Vogt - Yaoundé'
      }));
      localStorage.setItem('mboaschool_current_school', 'Collège Vogt - Yaoundé');
      localStorage.setItem('mboaschool_current_year', '2025/2026');
      localStorage.setItem('mboaschool_active_year_id', demoYearId);
      localStorage.setItem('mboaschool_etablissement_id', demoEtabId);

      // Pre-populate offline cache for annees_scolaires
      const mockYear = { id: demoYearId, nom: '2025/2026', etablissement_id: demoEtabId };
      localStorage.setItem('offline_cache_annees_scolaires', JSON.stringify([mockYear]));

      router.push('/dashboard');
      return;
    }

    setErrorMsg("Aucun compte local correspondant trouvé sur cet appareil. Veuillez vous connecter une fois en ligne.");
    setIsLoading(false);
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setErrorMsg(null);

    const isElectron = isRunningInElectron();
    const forceOffline = isElectron && typeof window !== 'undefined' && localStorage.getItem('mboaschool_force_offline') === 'true';
    const isOfflineMode = isElectron && typeof navigator !== 'undefined' && (!navigator.onLine || forceOffline);

    if (isOfflineMode) {
      await handleOfflineLogin();
      return;
    }

    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password
      });

      if (error) throw error;
      if (data?.user) {
        // Clear offline session cookie if successful Supabase authentication
        document.cookie = "mboaschool_offline_session=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT";
        localStorage.removeItem('mboaschool_offline_session');
        
        // Fetch profile and cache robustly in Electron only
        try {
          const { data: profile } = await supabase
            .from('profiles')
            .select('etablissement_id, role, permissions, nom_complet')
            .eq('id', data.user.id)
            .single();
            
          let schoolName = 'Mon Établissement';
          const etabId = profile?.etablissement_id || null;
          
          if (etabId) {
            localStorage.setItem('mboaschool_etablissement_id', etabId);
            const { data: etab } = await supabase
              .from('etablissements')
              .select('nom')
              .eq('id', etabId)
              .single();
            if (etab) {
              schoolName = etab.nom;
              localStorage.setItem('mboaschool_current_school', etab.nom);
            }
          }
          
          if (isElectron) {
            const storedProfiles = localStorage.getItem('mboaschool_profiles');
            let profilesList = [];
            if (storedProfiles) {
              try { profilesList = JSON.parse(storedProfiles); } catch (e) {}
            }
            profilesList = profilesList.filter((p: any) => p.email !== email);
            const { hash: passwordHash, salt: passwordSalt } = await hashPassword(password);
            profilesList.push({
              id: data.user.id,
              email: email,
              passwordHash, // Empreinte PBKDF2 pour le login hors-ligne — jamais le mot de passe en clair
              passwordSalt,
              role: profile?.role || 'admin',
              school: schoolName,
              etablissement_id: etabId,
              permissions: profile?.permissions || null,
              nom_complet: profile?.nom_complet || '',
              created_at: new Date().toISOString()
            });
            localStorage.setItem('mboaschool_profiles', JSON.stringify(profilesList));
          }
        } catch (profileErr) {
          captureMessage('Could not fetch/cache profile on login:', { detail: profileErr });
          
          if (isElectron) {
            // Fallback to caching basic details
            const storedProfiles = localStorage.getItem('mboaschool_profiles');
            let profilesList = [];
            if (storedProfiles) {
              try { profilesList = JSON.parse(storedProfiles); } catch (e) {}
            }
            if (!profilesList.find((p: any) => p.email === email)) {
              const { hash: passwordHash, salt: passwordSalt } = await hashPassword(password);
              profilesList.push({
                id: data.user.id,
                email: email,
                passwordHash,
                passwordSalt,
                role: 'admin',
                school: localStorage.getItem('mboaschool_current_school') || 'Mon Établissement',
                etablissement_id: localStorage.getItem('mboaschool_etablissement_id'),
                created_at: new Date().toISOString()
              });
              localStorage.setItem('mboaschool_profiles', JSON.stringify(profilesList));
            }
          }
        }
        router.push('/dashboard');
      }
    } catch (err: any) {
      captureError(err, { context: "Login error, checking error type:" });

      // 1. Check if the error is due to unconfirmed email
      if (err.message && (err.message.includes('Email not confirmed') || err.message.toLowerCase().includes('confirm'))) {
        setErrorMsg("Veuillez valider votre adresse email avant de vous connecter. Un email de confirmation vous a été envoyé lors de votre inscription.");
        setIsLoading(false);
        return;
      }

      // 2. Check if it's a real credential failure from Supabase
      const isRealAuthError = err.message && (
        err.message.includes('Invalid login credentials') ||
        err.message.toLowerCase().includes('invalid_credentials') ||
        err.message.toLowerCase().includes('invalid credentials')
      );

      if (isRealAuthError) {
        setErrorMsg("Identifiants de connexion invalides. Veuillez vérifier votre adresse email et votre mot de passe.");
        setIsLoading(false);
        return;
      }

      // Connection error, fallback to offline login only in Electron
      if (isElectron) {
        await handleOfflineLogin();
      } else {
        setErrorMsg(`Erreur de connexion : impossible de joindre le serveur. Veuillez vérifier votre connexion internet. (Détail: ${err.message || 'Erreur inconnue'})`);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleForgotPassword = async () => {
    setErrorMsg(null);
    if (!email) {
      setErrorMsg("Saisissez votre adresse email ci-dessus, puis cliquez à nouveau sur « Mot de passe oublié ? ».");
      return;
    }
    setResetLoading(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: typeof window !== 'undefined' ? `${window.location.origin}/login` : undefined,
      });
      if (error) throw error;
      setResetSent(true);
    } catch (err: any) {
      setErrorMsg(err.message || "Impossible d'envoyer l'email de réinitialisation.");
    } finally {
      setResetLoading(false);
    }
  };

  const handleFinalSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!schoolName) {
      setErrorMsg("Veuillez renseigner le nom de votre établissement.");
      return;
    }
    if (!email || !password) {
      setErrorMsg("Veuillez renseigner votre email et un mot de passe.");
      return;
    }
    const pwdError = validatePasswordStrength(password);
    if (pwdError) {
      setErrorMsg(pwdError);
      return;
    }
    setIsLoading(true);
    setErrorMsg(null);

    try {
      // 1. Create client auth user in Supabase with metadata
      const { data: signUpData, error: authError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            school_name: schoolName,
            school_year: schoolYear
          }
        }
      });

      if (authError) throw authError;

      if (signUpData?.user) {
        // Since database trigger handles creating the establishment, year, and profile,
        // we can fetch the profile to get the created etablissement_id
        let etabId = null;
        try {
          const { data: profile } = await supabase
            .from('profiles')
            .select('etablissement_id')
            .eq('id', signUpData.user.id)
            .single();
          if (profile) etabId = profile.etablissement_id;
        } catch (e) {
          captureMessage("Could not fetch newly created profile immediately:", { detail: e });
        }

        // Always save plan & info to local storage as fallback and for Layout displaying
        localStorage.setItem('mboaschool_current_school', schoolName);
        localStorage.setItem('mboaschool_current_year', schoolYear);
        localStorage.setItem('mboaschool_subscription', selectedPlan);
        // Persist the etablissement_id for multi-tenant filtering
        if (etabId) {
          localStorage.setItem('mboaschool_etablissement_id', etabId);
        }

        // Cache local du profil pour le login hors-ligne : desktop uniquement,
        // avec empreinte de mot de passe (jamais en clair).
        if (isRunningInElectron()) {
          const storedProfiles = localStorage.getItem('mboaschool_profiles');
          let profilesList = [];
          if (storedProfiles) {
            try {
              profilesList = JSON.parse(storedProfiles);
            } catch (e) {
              profilesList = [];
            }
          }
          if (!profilesList.find((p: any) => p.email === email)) {
            const { hash: passwordHash, salt: passwordSalt } = await hashPassword(password);
            profilesList.push({
              id: signUpData?.user?.id || `offline-${Date.now()}`,
              email: email,
              passwordHash,
              passwordSalt,
              role: 'admin',
              school: schoolName,
              etablissement_id: etabId,
              created_at: new Date().toISOString()
            });
            localStorage.setItem('mboaschool_profiles', JSON.stringify(profilesList));
          }
        }

        // If the email is auto-confirmed, we can log the user in immediately
        if (!signUpData.session) {
          try {
            await supabase.auth.signInWithPassword({
              email,
              password
            });
          } catch (loginErr) {
            captureMessage("Auto login failed after signup:", { detail: loginErr });
          }
        }
        router.push('/dashboard');
      }
    } catch (err: any) {
      captureMessage("Supabase onboarding failed, checking error type:", { detail: err });
      
      // If it's a real API auth error from Supabase (rate limit, weak password, duplicate email, invalid domain),
      // we must show the error instead of falling back to simulated offline mode.
      if (err.status || err.code || (err.message && !err.message.includes('fetch') && !err.message.includes('network') && !err.message.includes('Failed to fetch'))) {
        let displayMsg = err.message;
        if (err.code === 'over_email_send_rate_limit' || (err.message && err.message.toLowerCase().includes('rate limit'))) {
          displayMsg = "Limite d'envoi d'emails de confirmation dépassée par Supabase. Veuillez désactiver l'option 'Confirm email' dans la console Supabase (Auth > Providers > Email) ou configurer un service SMTP.";
        } else if (err.code === 'user_already_exists' || (err.message && err.message.toLowerCase().includes('already registered'))) {
          displayMsg = "Cette adresse email est déjà enregistrée. Veuillez utiliser une autre adresse ou vous connecter.";
        } else if (err.code === 'weak_password') {
          displayMsg = "Le mot de passe choisi est trop faible. Veuillez choisir un mot de passe plus complexe.";
        } else if (err.code === 'email_address_invalid') {
          displayMsg = "L'adresse email saisie est invalide ou non autorisée.";
        }
        setErrorMsg(displayMsg);
        setIsLoading(false);
        return;
      }
      
      // Local Fallback Mode : uniquement dans l'application desktop. Sur le web,
      // on ne crée jamais de session simulée (le middleware la refuserait de
      // toute façon) — on affiche une erreur de connexion.
      if (!isRunningInElectron()) {
        setErrorMsg("Impossible de joindre le serveur pour créer votre compte. Veuillez vérifier votre connexion internet et réessayer.");
        setIsLoading(false);
        return;
      }
      const offlineEtabId = crypto.randomUUID();
      const offlineYearId = crypto.randomUUID();
      localStorage.setItem('mboaschool_current_school', schoolName);
      localStorage.setItem('mboaschool_current_year', schoolYear);
      localStorage.setItem('mboaschool_active_year_id', offlineYearId);
      localStorage.setItem('mboaschool_subscription', selectedPlan);
      localStorage.setItem('mboaschool_etablissement_id', offlineEtabId);

      // Pre-populate offline cache for annees_scolaires so that academic years list and student dropdowns are happy
      const mockYear = { id: offlineYearId, nom: schoolYear, etablissement_id: offlineEtabId };
      localStorage.setItem('offline_cache_annees_scolaires', JSON.stringify([mockYear]));

      // Update local profiles list so they can log back in
      const storedProfiles = localStorage.getItem('mboaschool_profiles');
      let profilesList = [];
      if (storedProfiles) {
        try {
          profilesList = JSON.parse(storedProfiles);
        } catch (e) {
          profilesList = [];
        }
      }
      if (!profilesList.find((p: any) => p.email === email)) {
        const { hash: passwordHash, salt: passwordSalt } = await hashPassword(password);
        profilesList.push({
          id: `offline-${Date.now()}`,
          email: email,
          passwordHash,
          passwordSalt,
          role: 'admin',
          school: schoolName,
          etablissement_id: offlineEtabId,
          created_at: new Date().toISOString()
        });
        localStorage.setItem('mboaschool_profiles', JSON.stringify(profilesList));
      }
      
      // Simulate active offline profile session
      localStorage.setItem('mboaschool_offline_session', JSON.stringify({
        email,
        role: 'admin',
        school: schoolName
      }));

      // Set cookie so middleware lets us access /dashboard
      document.cookie = "mboaschool_offline_session=true; path=/; max-age=86400";

      router.push('/dashboard');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-bg text-ink flex flex-col items-center justify-center py-12 px-4 relative">
      {/* Bande kenté signature */}
      <div className="absolute top-0 left-0 right-0 kente-band" />

      <div className="w-full max-w-md bg-surface border border-border rounded-card-lg p-8 sm:p-11 shadow-login animate-fade-up">
        {/* En-tête logo */}
        <div className="flex items-center gap-3 mb-2">
          <div className="w-11 h-11 rounded-[14px] bg-ink text-cream flex items-center justify-center font-extrabold text-xl">M</div>
          <div>
            <div className="font-extrabold text-[22px] text-ink tracking-[-0.5px] leading-none">MboaSchool</div>
            <div className="text-xs text-ink-faint font-semibold mt-1">Gestion scolaire · Cameroun</div>
          </div>
        </div>

          {errorMsg && (
            <div className="mt-6 bg-red-bg border border-border text-accent px-4 py-3.5 rounded-control text-xs font-semibold flex items-center gap-3">
              <span className="w-5 h-5 rounded-full bg-accent/15 flex items-center justify-center font-bold shrink-0">!</span>
              <span>{errorMsg}</span>
            </div>
          )}

          {isOffline ? (
            <div className="mt-6 bg-chip border border-outline text-ink-soft px-4 py-3.5 rounded-control text-xs font-semibold">
              <div className="flex justify-between items-center">
                <span className="flex items-center gap-1.5">💻 Mode Hors-ligne / Local actif</span>
                <button
                  type="button"
                  onClick={() => {
                    localStorage.setItem('mboaschool_force_offline', 'false');
                    setIsOffline(!navigator.onLine);
                  }}
                  className="text-[10px] bg-surface hover:bg-bg text-ink-soft px-2 py-0.5 rounded-control border border-outline font-bold transition-colors cursor-pointer"
                >
                  Passer en ligne
                </button>
              </div>
              <p className="text-[11px] text-ink-faint font-normal mt-2 leading-relaxed">
                Connexion avec vos identifiants habituels (déjà connectés sur cet appareil) ou le compte démo :
                <strong className="text-accent ml-1">admin@mboaschool.com</strong>.
              </p>
            </div>
          ) : (
            <div className="flex justify-end mt-4">
              <button
                type="button"
                onClick={() => {
                  localStorage.setItem('mboaschool_force_offline', 'true');
                  setIsOffline(true);
                }}
                className="text-[11px] text-ink-faint hover:text-ink-soft flex items-center gap-1 transition-colors cursor-pointer"
              >
                <span>🌐 Travailler hors-ligne (mode local)</span>
              </button>
            </div>
          )}

          {/* LOGIN VIEW */}
          {!isSignUp && (
            <form className="mt-6 space-y-5" onSubmit={handleLogin}>
              <div>
                <h1 className="text-[30px] font-extrabold text-ink tracking-[-1px]">Bon retour.</h1>
                <p className="text-sm text-ink-soft mt-1">Connectez-vous pour gérer votre établissement.</p>
              </div>

              <div>
                <label className="block text-xs font-bold text-ink-soft mb-1.5">Adresse email</label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="directeur@mboaschool.com"
                  className="w-full box-border px-3.5 py-3 bg-bg border border-border rounded-control text-sm text-ink placeholder:text-ink-faint outline-none focus:border-accent focus:bg-surface transition-colors"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-ink-soft mb-1.5">Mot de passe</label>
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full box-border px-3.5 py-3 bg-bg border border-border rounded-control text-sm text-ink placeholder:text-ink-faint outline-none focus:border-accent focus:bg-surface transition-colors"
                />
              </div>

              <button
                type="submit"
                disabled={isLoading}
                className="w-full py-3.5 bg-accent hover:bg-accent-hover text-cream rounded-control text-[15px] font-extrabold shadow-cta transition-colors active:scale-[0.99] flex items-center justify-center disabled:opacity-60"
              >
                {isLoading ? "Vérification..." : "Se connecter"}
              </button>

              {resetSent && (
                <p className="text-[12px] font-semibold text-green">
                  Email de réinitialisation envoyé (si ce compte existe).
                </p>
              )}

              <div className="flex justify-between items-center text-[13px] font-semibold pt-1">
                <button
                  type="button"
                  onClick={handleForgotPassword}
                  disabled={resetLoading}
                  className="text-accent hover:text-accent-hover bg-transparent border-none p-0 cursor-pointer font-semibold disabled:opacity-60"
                >
                  {resetLoading ? "Envoi..." : "Mot de passe oublié ?"}
                </button>
                <button
                  type="button"
                  onClick={() => setIsSignUp(true)}
                  className="text-accent hover:text-accent-hover bg-transparent border-none cursor-pointer font-semibold"
                >
                  Créer un compte →
                </button>
              </div>
            </form>
          )}

          {/* SIGNUP VIEW */}
          {isSignUp && (
            <div className="mt-6">
              <div className="flex items-center justify-between border-b border-border-row pb-4 mb-5">
                <div>
                  <h1 className="text-[26px] font-extrabold text-ink tracking-[-0.5px]">Créer mon espace</h1>
                  <p className="text-xs text-ink-faint mt-1">Création de votre compte établissement</p>
                </div>
                <button
                  type="button"
                  onClick={() => setIsSignUp(false)}
                  className="text-xs font-bold text-ink-soft hover:text-ink shrink-0"
                >
                  Se connecter
                </button>
              </div>

              <form onSubmit={handleFinalSubmit} className="space-y-5">
                <div>
                  <label className="block text-xs font-bold text-ink-soft mb-1.5">Nom de l&apos;établissement *</label>
                  <input
                    type="text"
                    required
                    value={schoolName}
                    onChange={(e) => setSchoolName(e.target.value)}
                    placeholder="Ex: Collège Vogt, Lycée de Douala"
                    className="w-full box-border px-3.5 py-3 bg-bg border border-border rounded-control text-sm text-ink placeholder:text-ink-faint outline-none focus:border-accent focus:bg-surface transition-colors"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-ink-soft mb-1.5">Année scolaire de départ *</label>
                  <select
                    value={schoolYear}
                    onChange={(e) => setSchoolYear(e.target.value)}
                    className="w-full box-border px-3.5 py-3 bg-bg border border-border rounded-control text-sm font-semibold text-ink outline-none focus:border-accent focus:bg-surface transition-colors cursor-pointer"
                  >
                    <option value="2024/2025">2024/2025</option>
                    <option value="2025/2026">2025/2026</option>
                    <option value="2026/2027">2026/2027</option>
                    <option value="2027/2028">2027/2028</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold text-ink-soft mb-1.5">Adresse email *</label>
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="admin@mboaschool.com"
                    className="w-full box-border px-3.5 py-3 bg-bg border border-border rounded-control text-sm text-ink placeholder:text-ink-faint outline-none focus:border-accent focus:bg-surface transition-colors"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-ink-soft mb-1.5">Créer un mot de passe *</label>
                  <input
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Minimum 8 caractères, majuscule + chiffre"
                    className="w-full box-border px-3.5 py-3 bg-bg border border-border rounded-control text-sm text-ink placeholder:text-ink-faint outline-none focus:border-accent focus:bg-surface transition-colors"
                  />
                </div>

                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full py-3.5 bg-accent hover:bg-accent-hover text-cream rounded-control text-[15px] font-extrabold shadow-cta transition-colors active:scale-[0.99] flex items-center justify-center disabled:opacity-60"
                >
                  {isLoading ? "Création de l'espace..." : "Finaliser et ouvrir mon Dashboard →"}
                </button>
              </form>
            </div>
          )}

      </div>

      {/* Sous la carte */}
      <div className="mt-6 text-xs text-ink-faint font-semibold flex items-center gap-2 text-center px-4">
        <span className="w-[7px] h-[7px] rounded-full bg-green animate-pulse-dot shrink-0"></span>
        Fonctionne aussi hors-ligne — vos données restent sur cette machine
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-bg text-ink flex items-center justify-center">Chargement...</div>}>
      <LoginContent />
    </Suspense>
  );
}
