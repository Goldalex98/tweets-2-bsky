import { History, LayoutDashboard, LogOut, Moon, Newspaper, Plus, Settings2, Sun, SunMoon, Users } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api, { getApiErrorMessage, withConfigVersion } from './api/client';
import type { DashboardTab, Notice, SettingsSection, ThemeMode } from './api/types';
import { ActivityQueuePage } from './components/features/activity-queue-page';
import { OperationsStatus } from './components/features/operations-status';
import { RecoveryBanners, type RecoveryNotice } from './components/recovery-banners';
import { Button } from './components/ui/button';
import { Card, CardContent } from './components/ui/card';
import { ConfirmDialog } from './components/ui/confirm-dialog';
import { NavList } from './components/ui/nav-list';
import type { ActivityLog, EnrichedPost, LocalPostSearchResult, QueueItemView } from './features/activity/types';
import { useActivityPolling } from './features/activity/use-activity-polling';
import { useBlueskyAccounts } from './features/bluesky-accounts/use-bluesky-accounts';
import { AddDestinationWizard, type NewDestinationAccountMode } from './features/destinations/add-destination-wizard';
import { summarizeDestinationHealth } from './features/destinations/destination-health';
import { DestinationsPage } from './features/destinations/destinations-page';
import { EditDestinationDialog } from './features/destinations/edit-destination-dialog';
import type {
  AccountMapping,
  DestinationAIOverrides,
  DuplicateSuppressionPolicy,
  InitialImportMode,
  MappingFormState,
  ModerationPolicy,
  RouteDeliveryPolicy,
  RoutingPolicy,
  SourceParseSummary,
} from './features/destinations/types';
import { useDestinations } from './features/destinations/use-destinations';
import { useIngestionDigests } from './features/ingestion/use-ingestion-digests';
import { OverviewPage } from './features/overview/overview-page';
import { PostsPage } from './features/posts/posts-page';
import { AuthScreen } from './features/session/auth-screen';
import { useSessionBootstrap } from './features/session/use-session-bootstrap';
import { SettingsPage } from './features/settings/settings-page';
import type {
  AccountSecurityEmailState,
  AccountSecurityPasswordState,
  ManagedUser,
  UserFormState,
} from './features/settings/types';
import { useSettingsSecurity } from './features/settings/use-settings-security';
import { useSourceDefaults } from './features/settings/use-source-defaults';
import { defaultUserForm, normalizePermissions } from './features/settings/utils';
import {
  ACCOUNT_SEARCH_MIN_SCORE,
  DEFAULT_GROUP_EMOJI,
  DEFAULT_GROUP_KEY,
  buildDashboardUrl,
  defaultMappingForm,
  getBskyPostUrl,
  getGroupMeta,
  getMappingGroupMeta,
  getTwitterPostUrl,
  nextAttributionModeForSourceChange,
  normalizePath,
  normalizeSearchValue,
  normalizeTwitterUsername,
  parseDashboardLocation,
  parseTwitterUsernameInput,
  scoreAccountMapping,
  tokenizeSearchValue,
} from './lib/dashboard-utils';

const dashboardTabs = [
  { id: 'overview' as const, label: 'Overview', icon: LayoutDashboard },
  { id: 'accounts' as const, label: 'Accounts', icon: Users },
  { id: 'posts' as const, label: 'Posts', icon: Newspaper },
  { id: 'activity' as const, label: 'Activity', icon: History },
  { id: 'settings' as const, label: 'Settings', icon: Settings2 },
];

interface ConfirmationState {
  title: string;
  description: string;
  confirmLabel?: string;
  destructive?: boolean;
  resolve(value: boolean): void;
}

export default function DashboardApp() {
  const session = useSessionBootstrap();
  const [activeTab, setActiveTab] = useState<DashboardTab>(
    () => parseDashboardLocation(window.location.pathname, window.location.search).tab,
  );
  const [settingsSection, setSettingsSection] = useState<SettingsSection>(
    () => parseDashboardLocation(window.location.pathname, window.location.search).settingsSection ?? 'account',
  );
  const [pendingDestinationId, setPendingDestinationId] = useState<string | undefined>(
    () => parseDashboardLocation(window.location.pathname, window.location.search).destinationId,
  );
  const [pendingEditSection, setPendingEditSection] = useState<string | undefined>(
    () => parseDashboardLocation(window.location.pathname, window.location.search).editSection,
  );
  const [theme, setTheme] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem('theme-mode');
    return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system';
  });
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>('light');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [schedulerSaving, setSchedulerSaving] = useState(false);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<ConfirmationState | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);
  const noticeTimer = useRef<number | null>(null);

  useEffect(() => {
    void fetch('/readyz')
      .then(async (response) => {
        const payload = (await response.json()) as { restartRequired?: boolean };
        if (payload.restartRequired) setRestartRequired(true);
      })
      .catch(() => undefined);
  }, []);

  const showNotice = useCallback((tone: Notice['tone'], message: string) => {
    setNotice({ tone, message });
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 4200);
  }, []);

  const handleError = useCallback(
    (error: unknown, fallback: string) => {
      if (api.isAxiosError(error) && (error.response?.status === 401 || error.response?.status === 403)) {
        session.setToken(null);
        session.setUser(null);
        session.setError('Your session has expired.');
        return;
      }
      showNotice('error', getApiErrorMessage(error, fallback));
    },
    [session.setError, session.setToken, session.setUser, showNotice],
  );

  const destinations = useDestinations({ authenticated: Boolean(session.token), onError: handleError });
  const activity = useActivityPolling({
    authenticated: Boolean(session.token),
    activeTab,
    onError: handleError,
  });
  const isAdmin = session.user?.isAdmin === true;
  const settings = useSettingsSecurity({
    enabled: Boolean(session.token) && isAdmin,
    onError: handleError,
  });
  const sourceDefaults = useSourceDefaults({
    authenticated: Boolean(session.token),
    onError: handleError,
  });
  const ingestion = useIngestionDigests({
    enabled: Boolean(session.token) && isAdmin,
    onError: handleError,
  });

  const permissions = useMemo(() => normalizePermissions(session.user?.permissions), [session.user?.permissions]);
  const canManageAll = isAdmin || permissions.manageAllMappings;
  const canManageOwn = isAdmin || permissions.manageOwnMappings;
  const canCreateMappings = canManageAll || canManageOwn;
  const canManageMapping = useCallback(
    (mapping: AccountMapping) =>
      canManageAll || (canManageOwn && (!mapping.createdByUserId || mapping.createdByUserId === session.user?.id)),
    [canManageAll, canManageOwn, session.user?.id],
  );

  const blueskyAccounts = useBlueskyAccounts({
    authenticated: Boolean(session.token) && (isAdmin || canManageOwn || canManageAll),
    onError: handleError,
  });

  useEffect(() => {
    if (activeTab === 'settings' && settingsSection === 'bluesky') void blueskyAccounts.refresh();
  }, [activeTab, settingsSection, blueskyAccounts.refresh]);

  useEffect(() => {
    console.log(
      '%cTweets-2-Bsky %cReady to syndicate! 🚀\n%cView source & contribute: https://github.com/Goldalex98/tweets-2-bsky',
      'color: #0284c7; font-weight: bold;',
      'color: #64748b;',
      'color: #94a3b8;',
    );
    return () => {
      if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    };
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const next = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
      setResolvedTheme(next);
      document.documentElement.classList.remove('light', 'dark');
      document.documentElement.classList.add(next);
      localStorage.setItem('theme-mode', theme);
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);

  const sessionBootstrapStarted = useRef(false);
  useEffect(() => {
    if (sessionBootstrapStarted.current) return;
    sessionBootstrapStarted.current = true;
    let cancelled = false;
    void (async () => {
      const user = await session.refreshUser({ silentAnonymous: true });
      if (cancelled) return;
      if (!user) {
        await session.fetchBootstrapStatus();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session.fetchBootstrapStatus, session.refreshUser]);

  useEffect(() => {
    if (!session.token || !session.user) return;
    void Promise.all([destinations.fetchDestinations(), activity.refresh()]);
  }, [activity.refresh, destinations.fetchDestinations, session.token, session.user]);

  useEffect(() => {
    if (isAdmin) void settings.refresh();
  }, [isAdmin, settings.refresh]);

  useEffect(() => {
    if (activeTab === 'settings' && settingsSection === 'scheduler') void sourceDefaults.refresh();
  }, [activeTab, settingsSection, sourceDefaults.refresh]);

  useEffect(() => {
    if (activeTab === 'settings' && settingsSection === 'ingestion' && isAdmin) void ingestion.refresh();
  }, [activeTab, ingestion.refresh, isAdmin, settingsSection]);

  const askConfirmation = useCallback(
    (options: Omit<ConfirmationState, 'resolve'>) =>
      new Promise<boolean>((resolve) => setConfirmation({ ...options, resolve })),
    [],
  );

  const run = useCallback(
    async (action: () => Promise<void>, success?: string) => {
      setBusy(true);
      try {
        await action();
        if (success) showNotice('success', success);
      } catch (error) {
        handleError(error, 'The requested action failed.');
      } finally {
        setBusy(false);
      }
    },
    [handleError, showNotice],
  );

  const [addOpen, setAddOpen] = useState(false);
  const [addStep, setAddStep] = useState(1);
  const [newMapping, setNewMapping] = useState<MappingFormState>(defaultMappingForm);
  const [newSources, setNewSources] = useState<string[]>([]);
  const [newSourceInput, setNewSourceInput] = useState('');
  const [newSourceSummary, setNewSourceSummary] = useState<SourceParseSummary>({ duplicates: [], invalid: [] });
  const [validatingCredentials, setValidatingCredentials] = useState(false);
  const [newAccountMode, setNewAccountMode] = useState<NewDestinationAccountMode>('existing');
  const [newAccountId, setNewAccountId] = useState('');
  const [newInitialImportMode, setNewInitialImportMode] = useState<InitialImportMode>('inherit');

  /** Managed accounts that no destination claims yet. */
  const unlinkedBlueskyAccounts = useMemo(
    () => blueskyAccounts.accounts.filter((account) => account.linkedDestinationId === null),
    [blueskyAccounts.accounts],
  );

  const resetAdd = useCallback(() => {
    setNewMapping({ ...defaultMappingForm(), owner: session.user?.username || session.user?.email || '' });
    setNewSources([]);
    setNewSourceInput('');
    setNewSourceSummary({ duplicates: [], invalid: [] });
    setAddStep(1);
    setValidatingCredentials(false);
    setNewAccountMode(unlinkedBlueskyAccounts.length > 0 ? 'existing' : 'new');
    setNewAccountId('');
    setNewInitialImportMode('inherit');
  }, [session.user?.email, session.user?.username, unlinkedBlueskyAccounts.length]);

  const openAdd = () => {
    if (!canCreateMappings) return showNotice('error', 'You do not have permission to add mappings.');
    resetAdd();
    setAddOpen(true);
    // The picker must reflect accounts added since the last dashboard load.
    void blueskyAccounts.refresh();
  };
  const closeAdd = () => {
    setAddOpen(false);
    resetAdd();
  };
  // Attribution defaults follow the source count (off for one-to-one, on for
  // aggregates) until the operator picks a mode explicitly in the wizard.
  const syncAttributionDefault = useCallback((previousCount: number, nextCount: number) => {
    setNewMapping((current) => {
      const mode = nextAttributionModeForSourceChange(current.postingPolicy.attribution.mode, previousCount, nextCount);
      if (mode === current.postingPolicy.attribution.mode) return current;
      return {
        ...current,
        postingPolicy: {
          ...current.postingPolicy,
          attribution: { ...current.postingPolicy.attribution, mode },
        },
      };
    });
  }, []);

  const addSources = () => {
    const parsed = parseTwitterUsernameInput(newSources, newSourceInput);
    setNewSources(parsed.usernames);
    setNewSourceSummary(parsed.summary);
    setNewSourceInput('');
    syncAttributionDefault(newSources.length, parsed.usernames.length);
  };
  const removeSource = (username: string) => {
    const next = newSources.filter((source) => normalizeTwitterUsername(source) !== normalizeTwitterUsername(username));
    setNewSources(next);
    syncAttributionDefault(newSources.length, next.length);
  };

  const advanceAdd = async () => {
    if (addStep === 1 && newSources.length === 0) return showNotice('error', 'Add at least one Twitter username.');
    if (addStep < 3) return setAddStep((current) => current + 1);
    if (newAccountMode === 'existing') {
      // The account was validated when it was added in Settings.
      if (!newAccountId) return showNotice('error', 'Select a Bluesky account for this destination.');
      return setAddStep(4);
    }
    if (!newMapping.bskyIdentifier.trim() || !newMapping.bskyPassword.trim()) {
      return showNotice('error', 'Bluesky identifier and app password are required.');
    }
    setValidatingCredentials(true);
    try {
      await api.post('/api/onboarding/bsky-credentials', {
        bskyIdentifier: newMapping.bskyIdentifier.trim(),
        bskyPassword: newMapping.bskyPassword,
        bskyServiceUrl: newMapping.bskyServiceUrl.trim(),
      });
      setAddStep(4);
    } catch (error) {
      handleError(error, 'Failed to validate Bluesky credentials.');
    } finally {
      setValidatingCredentials(false);
    }
  };

  const createDestination = () => {
    const allowProfileMutation = newMapping.profileManagement.allowProfileMutation;
    const useExistingAccount = newAccountMode === 'existing';
    void run(
      async () => {
        const latestSourceDefaults = await sourceDefaults.refresh();
        if (!latestSourceDefaults) throw new Error('Could not refresh configuration before creating the destination.');
        const payload = {
          owner: newMapping.owner.trim(),
          twitterUsernames: newSources,
          initialImportMode: newInitialImportMode,
          // Either link an existing managed account or hand over credentials for
          // the server to save as a new managed account.
          ...(useExistingAccount
            ? { bskyAccountId: newAccountId }
            : {
                bskyIdentifier: newMapping.bskyIdentifier.trim(),
                bskyPassword: newMapping.bskyPassword,
                bskyServiceUrl: newMapping.bskyServiceUrl.trim(),
              }),
          groupName: newMapping.groupName.trim(),
          groupEmoji: newMapping.groupEmoji.trim(),
          postingPolicy: newMapping.postingPolicy,
          profileManagement: newMapping.profileManagement,
        };
        await destinations.createDestination(payload, latestSourceDefaults);
        closeAdd();
        await Promise.all([destinations.fetchDestinations(), blueskyAccounts.refresh()]);
      },
      allowProfileMutation
        ? 'Destination added. Profile mutation is allowed, but profile and pin sync modes are still off.'
        : 'Destination added with profile and pin mutations disabled.',
    );
  };

  const [editingMapping, setEditingMapping] = useState<AccountMapping | null>(null);
  const [editForm, setEditForm] = useState<MappingFormState>(defaultMappingForm);
  const [editSources, setEditSources] = useState<string[]>([]);
  const [editSourceInput, setEditSourceInput] = useState('');
  const [editSourceSummary, setEditSourceSummary] = useState<SourceParseSummary>({ duplicates: [], invalid: [] });
  const [editAddSourcesInitialImportMode, setEditAddSourcesInitialImportMode] = useState<InitialImportMode>('inherit');

  const startEdit = useCallback((mapping: AccountMapping, section?: string) => {
    setEditingMapping(mapping);
    setPendingEditSection(section);
    setEditSources(mapping.twitterUsernames);
    setEditSourceInput('');
    setEditSourceSummary({ duplicates: [], invalid: [] });
    setEditAddSourcesInitialImportMode('inherit');
    setEditForm({
      ...defaultMappingForm(),
      owner: mapping.owner || '',
      bskyIdentifier: mapping.bskyIdentifier,
      bskyServiceUrl: mapping.bskyServiceUrl || 'https://bsky.social',
      groupName: mapping.groupName || '',
      groupEmoji: mapping.groupEmoji || DEFAULT_GROUP_EMOJI,
      postingPolicy: {
        ...mapping.postingPolicy,
        attribution: { ...mapping.postingPolicy.attribution },
      },
      profileManagement: {
        ...mapping.profileManagement,
        profileSync: {
          ...mapping.profileManagement.profileSync,
          fields: { ...mapping.profileManagement.profileSync.fields },
        },
        pinSync: { ...mapping.profileManagement.pinSync },
      },
      aiOverrides: {
        imageAltText: mapping.aiOverrides?.imageAltText ?? 'inherit',
        textCapabilities: {
          translation: mapping.aiOverrides?.textCapabilities?.translation ?? 'inherit',
          summarization: mapping.aiOverrides?.textCapabilities?.summarization ?? 'inherit',
          cleanup: mapping.aiOverrides?.textCapabilities?.cleanup ?? 'inherit',
          hashtags: mapping.aiOverrides?.textCapabilities?.hashtags ?? 'inherit',
        },
      },
    });
  }, []);

  // Section-scoped saves keep the sheet open, so the pinned mapping snapshot
  // must pick up the new config revision or the next save fails the version check.
  useEffect(() => {
    setEditingMapping((current) => {
      if (!current) return current;
      const latest = destinations.mappings.find((entry) => entry.id === current.id);
      if (!latest) return current;
      return latest.revision === current.revision && latest.updatedAt === current.updatedAt ? current : latest;
    });
  }, [destinations.mappings]);

  // Source membership is applied immediately; keep chips aligned with the server list.
  useEffect(() => {
    if (!editingMapping) return;
    const latest = destinations.mappings.find((entry) => entry.id === editingMapping.id);
    if (!latest) return;
    setEditSources(latest.twitterUsernames);
  }, [destinations.mappings, editingMapping]);

  useEffect(() => {
    const url = buildDashboardUrl({
      tab: activeTab,
      settingsSection,
      destinationId: editingMapping?.id,
      editSection: editingMapping?.id ? pendingEditSection : undefined,
    });
    const [urlPath, urlQuery = ''] = url.split('?');
    const currentSearch = window.location.search.replace(/^\?/, '');
    if (normalizePath(window.location.pathname) !== urlPath || currentSearch !== urlQuery) {
      window.history.pushState({ tab: activeTab }, '', url);
    }
    localStorage.setItem('dashboard-tab', activeTab);
  }, [activeTab, settingsSection, editingMapping?.id, pendingEditSection]);

  useEffect(() => {
    const onPopState = () => {
      const location = parseDashboardLocation(window.location.pathname, window.location.search);
      setActiveTab(location.tab);
      setSettingsSection(location.settingsSection ?? 'account');
      if (location.destinationId) {
        setPendingDestinationId(location.destinationId);
        setPendingEditSection(location.editSection);
      } else {
        setEditingMapping(null);
        setPendingEditSection(undefined);
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Resolves a destination deep link (from initial load or a popstate
  // navigation) into the edit dialog once the destinations list has loaded.
  useEffect(() => {
    if (activeTab !== 'accounts' || !pendingDestinationId) return;
    const mapping = destinations.mappings.find((entry) => entry.id === pendingDestinationId);
    if (!mapping) return;
    startEdit(mapping, pendingEditSection);
    setPendingDestinationId(undefined);
    // pendingEditSection stays set so EditDestinationDialog can open on that
    // section via initialSection; it is cleared when the dialog closes or when
    // startEdit is called without a section (list Edit / Save Destination).
  }, [activeTab, destinations.mappings, pendingDestinationId, pendingEditSection, startEdit]);

  const openDestinationFromBlueskyAccount = useCallback(
    (destinationId: string) => {
      const mapping = destinations.mappings.find((entry) => entry.id === destinationId);
      if (!mapping) {
        showNotice('error', 'That destination could not be found. It may have been removed.');
        return;
      }
      setActiveTab('accounts');
      startEdit(mapping);
    },
    [destinations.mappings, showNotice, startEdit],
  );

  const saveContentPolicy = useCallback(
    (payload: {
      moderationPolicy: ModerationPolicy;
      duplicateSuppression: DuplicateSuppressionPolicy;
      aiOverrides: DestinationAIOverrides;
      routeId?: string;
      routingPolicy?: RoutingPolicy;
      routeModerationPolicy?: ModerationPolicy;
      routeDuplicateSuppression?: DuplicateSuppressionPolicy;
    }) => {
      if (!editingMapping) return Promise.resolve();
      return run(async () => {
        await api.patch(
          `/api/destinations/${editingMapping.id}/content-policies`,
          withConfigVersion(payload, editingMapping),
        );
        await destinations.fetchDestinations();
      }, 'Content policies saved.');
    },
    [destinations.fetchDestinations, editingMapping, run],
  );

  const previewContentPolicy = useCallback(
    async (payload: {
      text: string;
      language?: string;
      sensitive?: boolean;
      routeId?: string;
      routingPolicy?: RoutingPolicy;
      moderationPolicy?: ModerationPolicy;
      routeModerationPolicy?: ModerationPolicy;
    }): Promise<{ allowed: boolean; reason: string; trace: unknown[] }> => {
      if (!editingMapping) throw new Error('No destination selected.');
      try {
        const response = await api.post('/api/policies/preview', {
          destinationId: editingMapping.id,
          routeId: payload.routeId,
          moderationPolicy: payload.moderationPolicy,
          routingPolicy: payload.routingPolicy,
          routeModerationPolicy: payload.routeModerationPolicy,
          metadata: {
            text: payload.text,
            language: payload.language,
            sensitive: payload.sensitive,
          },
        });
        return response.data.decision as { allowed: boolean; reason: string; trace: unknown[] };
      } catch (error) {
        handleError(error, 'Failed to preview content policy.');
        throw error;
      }
    },
    [editingMapping, handleError],
  );

  const saveRouteDelivery = useCallback(
    (routeId: string, delivery: RouteDeliveryPolicy) => {
      if (!editingMapping) return Promise.resolve();
      return run(async () => {
        await api.patch(`/api/routes/${routeId}/delivery`, withConfigVersion(delivery, editingMapping));
        await destinations.fetchDestinations();
      }, 'Route delivery settings saved.');
    },
    [destinations.fetchDestinations, editingMapping, run],
  );

  /** Accounts the editor may link: unlinked ones plus the current link. */
  const editableBlueskyAccounts = useMemo(() => {
    if (!editingMapping) return [];
    return blueskyAccounts.accounts.filter(
      (account) => account.linkedDestinationId === null || account.linkedDestinationId === editingMapping.id,
    );
  }, [blueskyAccounts.accounts, editingMapping]);

  const changeBlueskyAccount = useCallback(
    (accountId: string) => {
      if (!editingMapping) return;
      const target = blueskyAccounts.accounts.find((account) => account.id === accountId);
      const handle = target?.canonicalHandle || target?.loginIdentifier || 'the selected account';
      void askConfirmation({
        title: editingMapping.bskyAccountId ? 'Switch Bluesky account?' : 'Link Bluesky account?',
        description: `Future posts for this destination go to @${handle}. Already mirrored tweets stay recorded, so they are not posted again.`,
        confirmLabel: editingMapping.bskyAccountId ? 'Switch account' : 'Link account',
      }).then((ok) => {
        if (!ok) return;
        return run(async () => {
          const updated = await destinations.linkBlueskyAccount(editingMapping, accountId);
          setEditingMapping(updated);
          await Promise.all([destinations.fetchDestinations(), blueskyAccounts.refresh()]);
        }, `Destination now posts to @${handle}.`);
      });
    },
    [
      askConfirmation,
      blueskyAccounts.accounts,
      blueskyAccounts.refresh,
      destinations.fetchDestinations,
      destinations.linkBlueskyAccount,
      editingMapping,
      run,
    ],
  );

  const openBlueskyAccountSettings = useCallback(() => {
    setEditingMapping(null);
    setPendingEditSection(undefined);
    setActiveTab('settings');
    setSettingsSection('bluesky');
  }, []);

  const submitEdit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingMapping) return;
    void run(async () => {
      // Source membership is applied immediately via Add/Remove; Save Destination
      // must not re-sync twitterUsernames or a stale chip list can delete sources.
      await destinations.updateDestination(editingMapping, {
        owner: editForm.owner.trim(),
        groupName: editForm.groupName.trim(),
        groupEmoji: editForm.groupEmoji.trim(),
        postingPolicy: editForm.postingPolicy,
        profileManagement: editForm.profileManagement,
        aiOverrides: editForm.aiOverrides,
      });
      setEditingMapping(null);
      setPendingEditSection(undefined);
    }, 'Destination updated.');
  };

  const addEditSources = async (): Promise<string | undefined> => {
    if (!editingMapping) return undefined;
    const inputSnapshot = editSourceInput;
    const parsed = parseTwitterUsernameInput(editSources, inputSnapshot);
    setEditSourceSummary(parsed.summary);
    const previous = new Set(editSources.map((username) => normalizeTwitterUsername(username)));
    const added = parsed.usernames.filter((username) => !previous.has(normalizeTwitterUsername(username)));
    if (added.length === 0) {
      // Nothing new to persist; clear the input after surfacing parse feedback.
      setEditSourceInput('');
      return undefined;
    }

    // Do not use run(): it swallows errors, which would clear focus/input incorrectly.
    setBusy(true);
    try {
      const updated = await destinations.syncSources(editingMapping, parsed.usernames, editAddSourcesInitialImportMode);
      setEditingMapping(updated);
      setEditSources(updated.twitterUsernames);
      setEditSourceInput('');
      showNotice('success', added.length === 1 ? `Added @${added[0]}.` : `Added ${added.length} sources.`);
      return added[0];
    } catch (error) {
      handleError(error, 'Failed to add sources.');
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  const removeEditSource = (username: string) => {
    if (!editingMapping) return;
    const normalized = normalizeTwitterUsername(username);
    if (!editSources.some((source) => normalizeTwitterUsername(source) === normalized)) return;
    // Capture identity at prompt time; recompute the target list at confirm so a
    // concurrent add is not wiped by a stale chip snapshot.
    const mappingAtPrompt = editingMapping;
    void askConfirmation({
      title: `Remove @${normalized}?`,
      description: 'This removes the source route from this destination immediately. Pending queue items are kept.',
      confirmLabel: 'Remove source',
      destructive: true,
    }).then((ok) => {
      if (!ok) return;
      return run(async () => {
        const latest = destinations.mappings.find((entry) => entry.id === mappingAtPrompt.id) ?? mappingAtPrompt;
        const nextSources = latest.twitterUsernames.filter((source) => normalizeTwitterUsername(source) !== normalized);
        if (nextSources.length === latest.twitterUsernames.length) return;
        const updated = await destinations.syncSources(latest, nextSources);
        setEditingMapping(updated);
        setEditSources(updated.twitterUsernames);
      }, `Removed @${normalized}.`);
    });
  };

  const [folderFilter, setFolderFilter] = useState('__all__');
  const [accountSearch, setAccountSearch] = useState('');

  const [selectedDestinationIds, setSelectedDestinationIds] = useState<Set<string>>(new Set());
  const [bulkFolderName, setBulkFolderName] = useState('');
  const [bulkBackfillConfirmation, setBulkBackfillConfirmation] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);

  const toggleDestinationSelected = useCallback((id: string) => {
    setSelectedDestinationIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAllDestinationsSelected = useCallback((ids: string[]) => {
    setSelectedDestinationIds((current) => {
      const allSelected = ids.length > 0 && ids.every((id) => current.has(id));
      return allSelected ? new Set() : new Set(ids);
    });
  }, []);

  const clearDestinationSelection = useCallback(() => {
    setSelectedDestinationIds(new Set());
    setBulkFolderName('');
    setBulkBackfillConfirmation('');
  }, []);

  const runBulkAction = useCallback(
    async (action: () => Promise<void>, success: string) => {
      setBulkBusy(true);
      try {
        await action();
        showNotice('success', success);
        clearDestinationSelection();
      } catch (error) {
        handleError(error, 'The bulk action failed.');
      } finally {
        setBulkBusy(false);
      }
    },
    [clearDestinationSelection, handleError, showNotice],
  );

  const bulkSetState = useCallback(
    (state: 'enabled' | 'paused') => {
      const ids = [...selectedDestinationIds];
      const version = destinations.mappings.find((mapping) => ids.includes(mapping.id));
      if (ids.length === 0 || !version) return;
      void runBulkAction(
        async () => {
          await api.post('/api/destinations/bulk/state', withConfigVersion({ destinationIds: ids, state }, version));
          await destinations.fetchDestinations();
        },
        state === 'paused' ? `Paused ${ids.length} destination(s).` : `Resumed ${ids.length} destination(s).`,
      );
    },
    [destinations, runBulkAction, selectedDestinationIds],
  );

  const bulkMoveFolder = useCallback(() => {
    const ids = [...selectedDestinationIds];
    const groupName = bulkFolderName.trim();
    const version = destinations.mappings.find((mapping) => ids.includes(mapping.id));
    if (ids.length === 0 || !groupName || !version) return;
    void runBulkAction(async () => {
      await api.post('/api/destinations/bulk/folder', withConfigVersion({ destinationIds: ids, groupName }, version));
      await destinations.fetchDestinations();
    }, `Moved ${ids.length} destination(s) to ${groupName}.`);
  }, [bulkFolderName, destinations, runBulkAction, selectedDestinationIds]);

  const bulkBackfill = useCallback(() => {
    const ids = [...selectedDestinationIds];
    const confirmation = `BACKFILL ${ids.length}`;
    if (ids.length === 0 || bulkBackfillConfirmation !== confirmation) return;
    void runBulkAction(async () => {
      await api.post('/api/destinations/bulk/backfill', { destinationIds: ids, confirmation });
      await destinations.fetchDestinations();
    }, `Backfill queued for ${ids.length} destination(s).`);
  }, [bulkBackfillConfirmation, destinations, runBulkAction, selectedDestinationIds]);
  const groupOptions = useMemo(() => {
    const values = new Map<string, { key: string; name: string; emoji: string }>();
    for (const group of destinations.groups) {
      const meta = getGroupMeta(group.name, group.emoji);
      if (meta.key !== DEFAULT_GROUP_KEY) values.set(meta.key, meta);
    }
    for (const mapping of destinations.mappings) {
      const meta = getMappingGroupMeta(mapping);
      values.set(meta.key, values.get(meta.key) || meta);
    }
    return [...values.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [destinations.groups, destinations.mappings]);

  const filteredMappings = useMemo(() => {
    const query = normalizeSearchValue(accountSearch);
    const tokens = tokenizeSearchValue(query);
    return destinations.mappings
      .filter((mapping) => folderFilter === '__all__' || getMappingGroupMeta(mapping).key === folderFilter)
      .filter((mapping) => !query || scoreAccountMapping(mapping, query, tokens) >= ACCOUNT_SEARCH_MIN_SCORE);
  }, [accountSearch, destinations.mappings, folderFilter]);
  const groupedMappings = useMemo(() => {
    const groups = new Map<string, { key: string; name: string; emoji: string; mappings: AccountMapping[] }>();
    for (const mapping of filteredMappings) {
      const meta =
        folderFilter === '__all__'
          ? { key: '__all__', name: 'All Accounts', emoji: '🌐' }
          : getMappingGroupMeta(mapping);
      const group = groups.get(meta.key) || { ...meta, mappings: [] };
      group.mappings.push(mapping);
      groups.set(meta.key, group);
    }
    return [...groups.values()];
  }, [filteredMappings, folderFilter]);

  const getProfile = useCallback(
    (actor: string) => destinations.profiles[actor] || destinations.profiles[normalizeTwitterUsername(actor)],
    [destinations.profiles],
  );

  const mappingsByIdentity = useMemo(() => {
    const result = new Map<string, AccountMapping>();
    const index = (value: string | undefined | null, mapping: AccountMapping) => {
      if (!value) return;
      const normalized = normalizeTwitterUsername(value);
      if (normalized) result.set(normalized, mapping);
      const lowered = value.trim().toLowerCase();
      if (lowered) result.set(lowered, mapping);
    };
    for (const mapping of destinations.mappings) {
      index(mapping.storageKey, mapping);
      index(mapping.bskyDid, mapping);
      index(mapping.bskyCanonicalHandle, mapping);
      index(mapping.bskyIdentifier, mapping);
      for (const source of mapping.twitterUsernames) index(source, mapping);
    }
    return result;
  }, [destinations.mappings]);
  const resolvePost = useCallback(
    (post: EnrichedPost) =>
      mappingsByIdentity.get(normalizeTwitterUsername(post.bskyIdentifier)) ||
      mappingsByIdentity.get(normalizeTwitterUsername(post.twitterUsername)),
    [mappingsByIdentity],
  );
  const resolveLocalPost = useCallback(
    (post: LocalPostSearchResult) =>
      mappingsByIdentity.get(normalizeTwitterUsername(post.bskyIdentifier)) ||
      mappingsByIdentity.get(normalizeTwitterUsername(post.twitterUsername)),
    [mappingsByIdentity],
  );
  const resolveActivity = useCallback(
    (entry: ActivityLog) =>
      mappingsByIdentity.get(normalizeTwitterUsername(entry.bsky_identifier)) ||
      mappingsByIdentity.get(normalizeTwitterUsername(entry.twitter_username)),
    [mappingsByIdentity],
  );

  const [postsGroup, setPostsGroup] = useState('all');
  const [postsSearch, setPostsSearch] = useState('');
  const [localPosts, setLocalPosts] = useState<LocalPostSearchResult[]>([]);
  const [searchingPosts, setSearchingPosts] = useState(false);
  const [activityGroup, setActivityGroup] = useState('all');
  useEffect(() => {
    const query = postsSearch.trim();
    if (!query) {
      setLocalPosts([]);
      setSearchingPosts(false);
      return;
    }
    let cancelled = false;
    setSearchingPosts(true);
    const timer = window.setTimeout(async () => {
      try {
        const response = await api.get<LocalPostSearchResult[]>('/api/posts/search', {
          params: { q: query, limit: 120 },
        });
        if (!cancelled) setLocalPosts(Array.isArray(response.data) ? response.data : []);
      } catch (error) {
        if (!cancelled) handleError(error, 'Failed to search local post history.');
      } finally {
        if (!cancelled) setSearchingPosts(false);
      }
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [handleError, postsSearch]);

  const filterByGroup = useCallback(
    (mapping: AccountMapping | undefined, group: string) =>
      group === 'all' || getMappingGroupMeta(mapping).key === group,
    [],
  );
  const visiblePosts = activity.enrichedPosts
    .slice(0, 12)
    .filter((post) => filterByGroup(resolvePost(post), postsGroup));
  const visibleLocalPosts = localPosts.filter((post) => filterByGroup(resolveLocalPost(post), postsGroup));
  const visibleActivity = activity.recentActivity.filter((entry) =>
    filterByGroup(resolveActivity(entry), activityGroup),
  );

  const engagement = useMemo(() => {
    const scores = new Map<string, { identifier: string; score: number; posts: number }>();
    for (const post of activity.enrichedPosts) {
      const mapping = resolvePost(post);
      const displayHandle =
        post.author?.handle ||
        mapping?.bskyCanonicalHandle ||
        (mapping?.bskyIdentifier && !mapping.bskyIdentifier.startsWith('did:') ? mapping.bskyIdentifier : undefined) ||
        post.bskyIdentifier;
      const key = normalizeTwitterUsername(displayHandle);
      const current = scores.get(key) || { identifier: displayHandle, score: 0, posts: 0 };
      current.score += post.stats.engagement;
      current.posts += 1;
      scores.set(key, current);
    }
    return [...scores.values()].sort((a, b) => b.score - a.score)[0];
  }, [activity.enrichedPosts, resolvePost]);

  const [emailForm, setEmailForm] = useState<AccountSecurityEmailState>({
    currentEmail: '',
    newEmail: '',
    password: '',
  });
  const [passwordForm, setPasswordForm] = useState<AccountSecurityPasswordState>({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  });
  const [newUser, setNewUser] = useState<UserFormState>(defaultUserForm);
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const restoreInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setEmailForm((current) => ({ ...current, currentEmail: session.user?.email || '' }));
  }, [session.user?.email]);

  const saveWithNotice = (event: FormEvent<HTMLFormElement>, action: () => Promise<unknown>, message: string) => {
    event.preventDefault();
    void run(async () => {
      await action();
    }, message);
  };

  const downloadJson = (name: string, value: unknown) => {
    const href = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = href;
    link.download = name;
    link.click();
    URL.revokeObjectURL(href);
  };

  if (!session.token) {
    return (
      <div className="min-h-screen bg-muted/20 text-foreground">
        {restartRequired ? (
          <div className="mx-auto max-w-lg px-4 pt-6">
            <RecoveryBanners
              notices={[
                {
                  id: 'restart-required',
                  severity: 'danger',
                  title: 'Restart required',
                  detail:
                    'A backup restore staged a new database. Restart the service to finish applying it before making changes.',
                  actionLabel: 'Dismiss',
                  onAction: () => undefined,
                },
              ]}
            />
          </div>
        ) : null}
        <AuthScreen
          view={session.authView}
          bootstrapOpen={session.bootstrapOpen}
          loading={session.loading}
          error={session.error}
          onViewChange={session.setAuthView}
          onLogin={session.login}
          onRegister={session.register}
        />
      </div>
    );
  }

  if (!session.user) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <output>Loading dashboard…</output>
      </main>
    );
  }

  const currentStatus = activity.status?.currentStatus;
  const queue = activity.status?.queue;
  const pendingBackfills = activity.status?.pendingBackfills || [];
  const queuedCount = (queue?.pending || 0) + (queue?.processing || 0);
  const progress = currentStatus?.totalCount
    ? Math.round(((currentStatus.processedCount || 0) / currentStatus.totalCount) * 100)
    : 0;

  const cycleTheme = () =>
    setTheme((current) => (current === 'system' ? 'light' : current === 'light' ? 'dark' : 'system'));
  const themeIcon =
    theme === 'system' ? (
      <SunMoon className="h-4 w-4" />
    ) : theme === 'light' ? (
      <Sun className="h-4 w-4" />
    ) : (
      <Moon className="h-4 w-4" />
    );

  const recoveryNotices: RecoveryNotice[] = destinations.mappings.reduce<RecoveryNotice[]>((notices, mapping) => {
    const { severity, label, detail } = summarizeDestinationHealth(mapping);
    if (severity !== 'danger' && severity !== 'warning') return notices;
    const handle = mapping.bskyCanonicalHandle || mapping.bskyIdentifier;
    const isFailure = label.toLowerCase().includes('failed');
    const isAuthIssue = label === 'Auth issue';
    notices.push({
      id: mapping.id,
      severity,
      title: `@${handle}: ${label}`,
      detail: detail || 'Review this destination for delivery issues.',
      actionLabel: isFailure ? 'Open activity' : isAuthIssue ? 'Open Bluesky accounts' : 'Open destination',
      onAction: () => {
        if (isFailure) {
          setActiveTab('activity');
        } else if (isAuthIssue) {
          setActiveTab('settings');
          setSettingsSection('bluesky');
        } else {
          setActiveTab('accounts');
          startEdit(mapping);
        }
      },
    });
    return notices;
  }, []);

  if (restartRequired || settings.scheduler?.restartRequired) {
    recoveryNotices.unshift({
      id: 'restart-required',
      severity: 'danger',
      title: 'Restart required',
      detail:
        'A backup restore staged a new database. Restart the service to finish applying it. Configuration changes stay blocked until then.',
      actionLabel: 'Open data settings',
      onAction: () => {
        setActiveTab('settings');
        setSettingsSection('data');
      },
    });
  }
  // Wrapped through `run` so a rejected mutation never escapes as an unhandled
  // promise from BlueskyAccountsSection's fire-and-forget call sites.
  const blueskyAccountActions = {
    onCreate: (form: Parameters<typeof blueskyAccounts.createAccount>[0]) =>
      run(async () => {
        await blueskyAccounts.createAccount(form);
      }, 'Bluesky account added.'),
    onValidate: (account: Parameters<typeof blueskyAccounts.validateAccount>[0]) =>
      run(async () => {
        await blueskyAccounts.validateAccount(account);
      }, 'Bluesky account validated.'),
    onRotate: (account: Parameters<typeof blueskyAccounts.rotateCredentials>[0], password: string) =>
      run(async () => {
        await blueskyAccounts.rotateCredentials(account, password);
      }, 'Bluesky app password rotated.'),
    onDelete: (account: Parameters<typeof blueskyAccounts.deleteAccount>[0]) =>
      run(async () => {
        await blueskyAccounts.deleteAccount(account);
      }, 'Bluesky account removed.'),
    onManageDestination: openDestinationFromBlueskyAccount,
  };

  return (
    <div className="min-h-screen bg-muted/20 text-foreground">
      <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div>
            <p className="font-semibold">Tweets-2-Bsky</p>
            <p className="text-xs text-muted-foreground">Crosspost control center</p>
          </div>
          <div className="flex items-center gap-2">
            {canCreateMappings ? (
              <Button size="sm" onClick={openAdd}>
                <Plus className="mr-2 h-4 w-4" />
                Add Bluesky destination
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              onClick={() => void run(activity.runNow, 'Check triggered.')}
              disabled={!permissions.runNow}
            >
              <LayoutDashboard className="mr-2 h-4 w-4" />
              Run now
            </Button>
            <Button size="icon" variant="ghost" aria-label={`Theme: ${theme} (${resolvedTheme})`} onClick={cycleTheme}>
              {themeIcon}
            </Button>
            <Button size="icon" variant="ghost" aria-label="Log out" onClick={() => void session.logout()}>
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>
      {recoveryNotices.length > 0 ? (
        <div className="mx-auto max-w-[1600px] px-4 pt-4">
          <RecoveryBanners notices={recoveryNotices} />
        </div>
      ) : null}
      <div className="mx-auto grid max-w-[1600px] gap-6 px-4 py-6 lg:grid-cols-[220px_1fr]">
        <Card className="h-fit lg:sticky lg:top-24">
          <CardContent className="p-2">
            <NavList
              items={dashboardTabs}
              activeId={activeTab}
              onSelect={setActiveTab}
              ariaLabel="Dashboard navigation"
            />
          </CardContent>
        </Card>
        <main className="min-w-0">
          <div className="mb-5">
            <h1 id="page-title" className="text-2xl font-semibold">
              {dashboardTabs.find((tab) => tab.id === activeTab)?.label}
            </h1>
          </div>
          {notice ? (
            <div
              role={notice.tone === 'error' ? 'alert' : 'status'}
              className={`mb-4 rounded-md border p-3 text-sm ${notice.tone === 'error' ? 'border-red-300 text-red-700 dark:text-red-300' : ''}`}
            >
              {notice.message}
            </div>
          ) : null}
          <OperationsStatus
            jobs={activity.status?.activeJobs || []}
            queue={queue}
            queuedCount={queuedCount}
            pendingBackfillCount={pendingBackfills.length}
            status={currentStatus}
            progressPercent={progress}
            canManageAll={isAdmin}
            onRetryFailed={() => void run(activity.retryFailed, 'Failed queue items requeued.')}
            onClearFailed={() =>
              void askConfirmation({
                title: 'Clear failed queue items?',
                description: 'Failed items will be removed and will not be retried.',
                confirmLabel: 'Clear failed',
                destructive: true,
              }).then((ok) => {
                if (ok) return run(activity.clearFailed, 'Failed queue items cleared.');
              })
            }
          />
          {activeTab === 'overview' ? (
            <OverviewPage
              mappings={destinations.mappings}
              queuedPostCount={queuedCount}
              pendingBackfillCount={pendingBackfills.length}
              currentStatus={currentStatus}
              latestActivity={activity.recentActivity[0]}
              topAccount={engagement}
              topAccountProfile={engagement ? getProfile(engagement.identifier) : undefined}
              dashboardTabs={dashboardTabs}
              loading={activity.isLoading || destinations.loading}
              error={activity.error || destinations.error}
              onRetry={() => void Promise.all([activity.refresh(), destinations.fetchDestinations()])}
              onNavigate={setActiveTab}
            />
          ) : null}
          {activeTab === 'accounts' ? (
            <DestinationsPage
              groups={groupOptions}
              selectedFolderKey={folderFilter}
              onSelectFolder={setFolderFilter}
              searchQuery={accountSearch}
              onSearchQueryChange={setAccountSearch}
              groupedMappings={groupedMappings}
              matchCount={filteredMappings.length}
              loading={destinations.loading}
              error={destinations.error}
              canCreate={canCreateMappings}
              onAdd={openAdd}
              getProfile={getProfile}
              canManage={canManageMapping}
              isBackfillQueued={(id) => pendingBackfills.some((entry) => entry.id === id)}
              isBackfillActive={(id) =>
                currentStatus?.state === 'backfilling' && currentStatus.backfillMappingId === id
              }
              onEdit={startEdit}
              onDelete={(mapping) => void run(() => destinations.deleteDestination(mapping), 'Destination deleted.')}
              onBackfill={(mapping) => void run(() => activity.requestBackfill(mapping.id), 'Backfill queued.')}
              onCancelBackfill={(mapping) => void run(() => activity.cancelBackfill(mapping.id), 'Backfill cancelled.')}
              onApplyProfileSync={(mapping) =>
                void run(
                  () => destinations.applyProfileSync(mapping, mapping.profileManagement.profileSync.sourceUsername),
                  'Profile sync applied.',
                )
              }
              onQueuePinSync={(mapping) =>
                void run(
                  () => destinations.queuePinSync(mapping, mapping.profileManagement.pinSync.sourceUsername),
                  'Pin sync queued.',
                )
              }
              selectedIds={selectedDestinationIds}
              onToggleSelected={toggleDestinationSelected}
              onToggleSelectAll={toggleAllDestinationsSelected}
              bulkBusy={bulkBusy}
              bulkFolderName={bulkFolderName}
              onBulkFolderNameChange={setBulkFolderName}
              bulkBackfillConfirmation={bulkBackfillConfirmation}
              onBulkBackfillConfirmationChange={setBulkBackfillConfirmation}
              onBulkPause={() => bulkSetState('paused')}
              onBulkResume={() => bulkSetState('enabled')}
              onBulkMoveFolder={bulkMoveFolder}
              onBulkBackfill={bulkBackfill}
              onBulkClearSelection={clearDestinationSelection}
            />
          ) : null}
          {activeTab === 'posts' ? (
            <PostsPage
              searchQuery={postsSearch}
              onSearchQueryChange={setPostsSearch}
              searching={searchingPosts}
              groupFilter={postsGroup}
              onGroupFilterChange={setPostsGroup}
              groupOptions={groupOptions}
              localResults={visibleLocalPosts}
              posts={visiblePosts}
              resolveLocalMapping={resolveLocalPost}
              resolvePostMapping={resolvePost}
              getProfile={getProfile}
              error={activity.error}
            />
          ) : null}
          {activeTab === 'activity' ? (
            <ActivityQueuePage
              queueItems={activity.queueItems}
              recentActivity={visibleActivity}
              groupOptions={groupOptions}
              groupFilter={activityGroup}
              setGroupFilter={setActivityGroup}
              canReevaluateQueue={isAdmin || permissions.reevaluateQueuePolicies}
              canOverrideSkipped={isAdmin || permissions.reevaluateQueuePolicies}
              getSourceUrl={getTwitterPostUrl}
              getDestinationUrl={(entry) => getBskyPostUrl(entry as ActivityLog)}
              getActivityGroup={(entry) => getMappingGroupMeta(resolveActivity(entry as ActivityLog))}
              copyDiagnostic={async (item) => {
                const queueItem = item as QueueItemView;
                const diagnostic = JSON.stringify(
                  {
                    queue: {
                      status: item.status,
                      attempts: item.attempts,
                      enqueuedAt: item.enqueued_at,
                      category: item.error_category,
                    },
                    identities: {
                      destinationId: queueItem.destination_id,
                      routeId: queueItem.route_id,
                      sourceId: queueItem.source_id,
                      requestId: queueItem.request_id,
                      externalPostId: item.twitter_id,
                    },
                    policy: {
                      version: item.policy_version,
                      behavior: item.policy_snapshot ? 'snapshotted' : 'current',
                    },
                    error: item.error_message,
                    deliveryFallbacks: queueItem.delivery_diagnostics ?? item.delivery_diagnostics ?? null,
                  },
                  null,
                  2,
                );
                try {
                  await navigator.clipboard.writeText(diagnostic);
                  showNotice('success', 'Redacted queue diagnostic copied.');
                } catch {
                  showNotice(
                    'error',
                    'The browser blocked clipboard access; copy the diagnostic from the item instead.',
                  );
                }
              }}
              reevaluatePolicy={async (item) => {
                const ok = await askConfirmation({
                  title: 'Use current queue policy?',
                  description: 'Replace this queued item policy snapshot with current policy.',
                  confirmLabel: 'Use current policy',
                });
                if (ok) await run(() => activity.reevaluateQueueItem(item as QueueItemView), 'Queue policy updated.');
              }}
              operateItem={async (item, action) => {
                if (action === 'cancel') {
                  const ok = await askConfirmation({
                    title: 'Cancel queue item?',
                    description: 'The pending delivery will be removed.',
                    confirmLabel: 'Cancel item',
                    destructive: true,
                  });
                  if (!ok) return;
                }
                await run(
                  () => activity.operateQueueItem(item as QueueItemView, action),
                  action === 'retry' ? 'Queue item requeued.' : 'Queue item cancelled.',
                );
              }}
              overrideSkipped={async (entry) => {
                const ok = await askConfirmation({
                  title: 'Override skipped item?',
                  description: 'Re-evaluate and explicitly override current policy for this retained item.',
                  confirmLabel: 'Override and requeue',
                });
                if (ok) await run(() => activity.overrideSkipped(entry as ActivityLog), 'Skipped item requeued.');
              }}
            />
          ) : null}
          {activeTab === 'settings' ? (
            <SettingsPage
              section={settingsSection}
              onSectionChange={setSettingsSection}
              user={session.user}
              permissions={permissions}
              email={emailForm}
              setEmail={setEmailForm}
              password={passwordForm}
              setPassword={setPasswordForm}
              scheduler={settings.scheduler}
              setScheduler={settings.setScheduler}
              twitter={settings.twitterConfig}
              setTwitter={settings.setTwitterConfig}
              cookieHealth={settings.cookieHealth}
              ai={settings.aiConfig}
              setAi={settings.setAiConfig}
              notifications={settings.notifications}
              setNotifications={settings.setNotifications}
              users={settings.users}
              newUser={newUser}
              setNewUser={setNewUser}
              runtime={settings.runtimeVersion}
              update={settings.updateStatus}
              busy={busy}
              schedulerSaving={schedulerSaving}
              sourceDefaults={sourceDefaults.value}
              setSourceDefaults={sourceDefaults.setValue}
              sourceDefaultsSaving={sourceDefaults.saving}
              mappings={destinations.mappings}
              updateBusy={updateBusy}
              editingUserId={editingUserId}
              canCreateMappings={canCreateMappings}
              canManageMappings={canManageAll || canManageOwn}
              blueskyAccounts={{
                accounts: blueskyAccounts.accounts,
                loading: blueskyAccounts.loading,
                error: blueskyAccounts.error,
                busy: blueskyAccounts.busy,
                ...blueskyAccountActions,
              }}
              ingestion={{
                sources: ingestion.sources,
                credentials: ingestion.credentials,
                digests: ingestion.digests,
                oneTimeSecret: ingestion.oneTimeSecret,
                loading: ingestion.loading,
                error: ingestion.error,
                createSource: ingestion.createSource,
                setRouteDelivery: ingestion.setRouteDelivery,
                createCredential: ingestion.createCredential,
                revokeCredential: ingestion.revokeCredential,
                previewDigest: ingestion.previewDigest,
                publishDigest: ingestion.publishDigest,
                retryDigest: ingestion.retryDigest,
                cancelDigest: ingestion.cancelDigest,
              }}
              onSaveEmail={(event) =>
                saveWithNotice(
                  event,
                  async () => {
                    await settings.changeEmail(emailForm);
                    session.setUser((current) => (current ? { ...current, email: emailForm.newEmail } : current));
                    setEmailForm({ currentEmail: emailForm.newEmail, newEmail: '', password: '' });
                  },
                  'Email updated.',
                )
              }
              onSavePassword={(event) =>
                saveWithNotice(
                  event,
                  async () => {
                    await settings.changePassword(passwordForm);
                    setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
                  },
                  'Password updated.',
                )
              }
              onSaveScheduler={(event) => {
                event.preventDefault();
                setSchedulerSaving(true);
                void settings
                  .saveScheduler()
                  .then(() => showNotice('success', 'Scheduler saved.'))
                  .catch((error) => handleError(error, 'Failed to save scheduler.'))
                  .finally(() => setSchedulerSaving(false));
              }}
              onSaveSourceSchedule={async (mapping, username, schedule) => {
                await run(async () => {
                  await destinations.patchSource(mapping, username, { schedule });
                }, `Polling policy saved for @${username}.`);
              }}
              onSaveSourceInitialImportMode={async (mapping, username, initialImportMode) => {
                await run(async () => {
                  await destinations.patchSource(mapping, username, { initialImportMode });
                }, `Initial import setting saved for @${username}.`);
              }}
              onSaveSourceDefaults={() => {
                void sourceDefaults
                  .save()
                  .then(() => showNotice('success', 'X source default saved.'))
                  .catch((error) => handleError(error, 'Failed to save X source default.'));
              }}
              onSaveTwitter={(event) => saveWithNotice(event, settings.saveTwitter, 'Twitter credentials saved.')}
              onSaveAi={(event) => saveWithNotice(event, settings.saveAi, 'AI settings saved.')}
              onPreviewAiText={(capability, text) => settings.previewAiText(capability, text)}
              onSaveNotifications={(event) =>
                saveWithNotice(event, settings.saveNotifications, 'Notification settings saved.')
              }
              onTestNotifications={() => {
                void run(() => settings.testNotifications(), 'Test notification queued.');
              }}
              onCreateUser={(event) =>
                saveWithNotice(
                  event,
                  async () => {
                    await settings.createUser({
                      username: newUser.username || undefined,
                      email: newUser.email || undefined,
                      password: newUser.password,
                      isAdmin: newUser.isAdmin,
                      permissions: newUser.permissions,
                    });
                    setNewUser(defaultUserForm());
                  },
                  'User created.',
                )
              }
              onEditUser={(user) => setEditingUserId(user.id)}
              onDeleteUser={(user: ManagedUser) =>
                void askConfirmation({
                  title: 'Delete user?',
                  description: `Delete ${user.username || user.email}?`,
                  confirmLabel: 'Delete user',
                  destructive: true,
                }).then((ok) => {
                  if (ok) return run(() => settings.deleteUser(user.id), 'User deleted.');
                })
              }
              onRunUpdate={() => {
                const confirmation = window.prompt('Type RUN_UPDATE to start a service update.');
                if (confirmation !== 'RUN_UPDATE') return;
                const password = window.prompt('Enter your admin password to confirm.');
                if (!password) return;
                setUpdateBusy(true);
                void api
                  .post(
                    '/api/update',
                    { confirmation: 'RUN_UPDATE', password },
                    { headers: { 'x-destructive-confirmation': 'RUN_UPDATE', 'x-reauth-password': password } },
                  )
                  .then(() => settings.refresh())
                  .then(() => showNotice('success', 'Update started.'))
                  .catch((error) => handleError(error, 'Failed to start update.'))
                  .finally(() => setUpdateBusy(false));
              }}
              onAddDestination={openAdd}
              onExport={() =>
                void run(async () => {
                  const response = await api.get('/api/config/export');
                  downloadJson('tweets-2-bsky-config.json', response.data);
                })
              }
              onImport={() => importInput.current?.click()}
              onBackup={(mode) =>
                void run(async () => {
                  const response = await api.post('/api/backup/create', { mode });
                  downloadJson(`tweets-2-bsky-${mode}-backup.json`, response.data);
                })
              }
              onRestore={() => restoreInput.current?.click()}
            />
          ) : null}
        </main>
      </div>
      <AddDestinationWizard
        open={addOpen}
        step={addStep}
        sourceInput={newSourceInput}
        sources={newSources}
        initialImportMode={newInitialImportMode}
        globalInitialImportDefault={sourceDefaults.effectiveDefault}
        parseSummary={newSourceSummary}
        form={newMapping}
        busy={busy}
        validating={validatingCredentials}
        blueskyAccounts={unlinkedBlueskyAccounts}
        accountsLoading={blueskyAccounts.loading}
        accountMode={newAccountMode}
        accountId={newAccountId}
        onAccountModeChange={setNewAccountMode}
        onAccountIdChange={setNewAccountId}
        onManageAccounts={() => {
          closeAdd();
          setActiveTab('settings');
          setSettingsSection('bluesky');
        }}
        onClose={closeAdd}
        onSourceInputChange={setNewSourceInput}
        onInitialImportModeChange={setNewInitialImportMode}
        onAddSources={addSources}
        onRemoveSource={removeSource}
        onFormChange={setNewMapping}
        onNext={() => void advanceAdd()}
        onBack={() => setAddStep((current) => Math.max(1, current - 1))}
        onCreate={createDestination}
      />
      <EditDestinationDialog
        mapping={editingMapping}
        form={editForm}
        sources={editSources}
        sourceInput={editSourceInput}
        parseSummary={editSourceSummary}
        busy={busy}
        schedulerIntervalMinutes={settings.scheduler?.intervalMinutes ?? 5}
        globalInitialImportDefault={sourceDefaults.effectiveDefault}
        addSourcesInitialImportMode={editAddSourcesInitialImportMode}
        blueskyAccounts={editableBlueskyAccounts}
        canChangeAccount={editingMapping ? canManageMapping(editingMapping) : false}
        onChangeAccount={changeBlueskyAccount}
        onClose={() => {
          setEditingMapping(null);
          setPendingEditSection(undefined);
        }}
        onSubmit={submitEdit}
        onFormChange={setEditForm}
        onSourceInputChange={setEditSourceInput}
        onAddSourcesInitialImportModeChange={setEditAddSourcesInitialImportMode}
        onAddSources={addEditSources}
        onRemoveSource={removeEditSource}
        onManageAccount={openBlueskyAccountSettings}
        onSectionChange={setPendingEditSection}
        onSaveSourceFilters={async (username, filters) => {
          if (!editingMapping) return;
          await run(async () => {
            setEditingMapping(await destinations.patchSource(editingMapping, username, { filters }));
          }, `Filters saved for @${username}.`);
        }}
        onSaveSourceSchedule={async (username, schedule) => {
          if (!editingMapping) return;
          await run(async () => {
            setEditingMapping(await destinations.patchSource(editingMapping, username, { schedule }));
          }, `Polling policy saved for @${username}.`);
        }}
        onSaveSourceInitialImportMode={async (username, initialImportMode) => {
          if (!editingMapping) return;
          await run(async () => {
            setEditingMapping(await destinations.patchSource(editingMapping, username, { initialImportMode }));
          }, `Initial import setting saved for @${username}.`);
        }}
        onPreviewSourceFilter={async (username, filters, metadata) => {
          if (!editingMapping) throw new Error('No destination selected.');
          return destinations.previewSourceFilter(editingMapping, username, filters, metadata);
        }}
        onPreviewPosting={async (input) => {
          if (!editingMapping) throw new Error('No destination selected.');
          return destinations.previewPostingPolicy(editingMapping, input);
        }}
        onPreviewProfileSync={() => {
          if (!editingMapping) return;
          void run(async () => {
            await destinations.previewProfileSync(
              editingMapping,
              editForm.profileManagement.profileSync.sourceUsername,
            );
          }, 'Profile sync preview ready.');
        }}
        onApplyProfileSync={() => {
          if (!editingMapping) return;
          void run(async () => {
            await destinations.applyProfileSync(editingMapping, editForm.profileManagement.profileSync.sourceUsername);
          }, 'Profile sync applied.');
        }}
        onQueuePinSync={() => {
          if (!editingMapping) return;
          void run(async () => {
            await destinations.queuePinSync(editingMapping, editForm.profileManagement.pinSync.sourceUsername);
          }, 'Pin sync queued.');
        }}
        onSaveContentPolicy={saveContentPolicy}
        onPreviewContentPolicy={previewContentPolicy}
        onSaveRouteDelivery={saveRouteDelivery}
        initialSection={pendingEditSection}
      />
      <ConfirmDialog
        open={confirmation !== null}
        title={confirmation?.title || ''}
        description={confirmation?.description || ''}
        confirmLabel={confirmation?.confirmLabel}
        destructive={confirmation?.destructive}
        onCancel={() => {
          confirmation?.resolve(false);
          setConfirmation(null);
        }}
        onConfirm={() => {
          confirmation?.resolve(true);
          setConfirmation(null);
        }}
      />
      <input
        ref={importInput}
        className="hidden"
        type="file"
        accept="application/json"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          void (async () => {
            const confirmation = window.prompt('Type IMPORT_CONFIG to import this configuration.');
            if (confirmation !== 'IMPORT_CONFIG') {
              event.target.value = '';
              return;
            }
            const password = window.prompt('Enter your admin password to confirm the import.');
            if (!password) {
              event.target.value = '';
              return;
            }
            await run(async () => {
              const version = settings.scheduler;
              if (!version) throw new Error('Settings are still loading; retry the import in a moment.');
              const payload = withConfigVersion(
                { ...JSON.parse(await file.text()), confirmation: 'IMPORT_CONFIG', password },
                version,
              );
              await api.post('/api/config/import', payload, {
                headers: {
                  'x-destructive-confirmation': 'IMPORT_CONFIG',
                  'x-reauth-password': password,
                },
              });
              await Promise.all([destinations.fetchDestinations(), settings.refresh()]);
            }, 'Configuration imported.');
            event.target.value = '';
          })();
        }}
      />
      <input
        ref={restoreInput}
        className="hidden"
        type="file"
        accept="application/json"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          void askConfirmation({
            title: 'Restore backup?',
            description:
              'Current configuration and runtime data may be replaced. You will need to restart the service afterward.',
            confirmLabel: 'Restore backup',
            destructive: true,
          }).then((ok) => {
            if (!ok) return;
            void run(async () => {
              const version = settings.scheduler;
              if (!version) throw new Error('Settings are still loading; retry the restore in a moment.');
              const bundle = JSON.parse(await file.text());
              const response = await api.post<{ restartRequired?: boolean }>(
                '/api/backup/restore/apply',
                withConfigVersion({ bundle }, version),
              );
              if (response.data?.restartRequired !== false) setRestartRequired(true);
              showNotice('success', 'Backup restored. Restart the service now to finish applying the database.');
            });
          });
          event.target.value = '';
        }}
      />
    </div>
  );
}
