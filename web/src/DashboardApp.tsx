import api, { getApiErrorMessage, withConfigVersion } from './api/client';
import type { DashboardTab, Notice, SettingsSection, ThemeMode } from './api/types';
import { ActivityQueuePage } from './components/features/activity-queue-page';
import { OperationsStatus } from './components/features/operations-status';
import { Button } from './components/ui/button';
import { Card, CardContent } from './components/ui/card';
import { ConfirmDialog } from './components/ui/confirm-dialog';
import { NavList } from './components/ui/nav-list';
import {
  History,
  LayoutDashboard,
  LogOut,
  Moon,
  Newspaper,
  Plus,
  Settings2,
  Sun,
  SunMoon,
  Users,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useActivityPolling } from './features/activity/use-activity-polling';
import type { ActivityLog, EnrichedPost, LocalPostSearchResult, QueueItemView } from './features/activity/types';
import { AddDestinationWizard } from './features/destinations/add-destination-wizard';
import { DestinationsPage } from './features/destinations/destinations-page';
import { EditDestinationDialog } from './features/destinations/edit-destination-dialog';
import type { AccountMapping, MappingFormState, SourceParseSummary } from './features/destinations/types';
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
import { defaultUserForm, normalizePermissions } from './features/settings/utils';
import { useSettingsSecurity } from './features/settings/use-settings-security';
import {
  ACCOUNT_SEARCH_MIN_SCORE,
  DEFAULT_GROUP_EMOJI,
  DEFAULT_GROUP_KEY,
  TAB_PATHS,
  defaultMappingForm,
  getBskyPostUrl,
  getGroupMeta,
  getMappingGroupMeta,
  getTabFromPath,
  getTwitterPostUrl,
  nextAttributionModeForSourceChange,
  normalizePath,
  normalizeSearchValue,
  normalizeTwitterUsername,
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
  const [activeTab, setActiveTab] = useState<DashboardTab>(() => getTabFromPath(window.location.pathname) || 'overview');
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('account');
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
  const noticeTimer = useRef<number | null>(null);

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

  useEffect(() => {
    console.log(
      '%cTweets-2-Bsky %cReady to syndicate! 🚀\n%cView source & contribute: https://github.com/j4ckxyz/tweets-2-bsky',
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

  useEffect(() => {
    const expected = TAB_PATHS[activeTab];
    if (normalizePath(window.location.pathname) !== expected) window.history.pushState({ tab: activeTab }, '', expected);
    localStorage.setItem('dashboard-tab', activeTab);
  }, [activeTab]);

  useEffect(() => {
    const onPopState = () => setActiveTab(getTabFromPath(window.location.pathname) || 'overview');
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (session.token) {
      void session.refreshUser();
    } else {
      void session.fetchBootstrapStatus();
    }
  }, [session.fetchBootstrapStatus, session.refreshUser, session.token]);

  useEffect(() => {
    if (!session.token || !session.user) return;
    void Promise.all([destinations.fetchDestinations(), activity.refresh()]);
  }, [activity.refresh, destinations.fetchDestinations, session.token, session.user]);

  useEffect(() => {
    if (isAdmin) void settings.refresh();
  }, [isAdmin, settings.refresh]);

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

  const resetAdd = useCallback(() => {
    setNewMapping({ ...defaultMappingForm(), owner: session.user?.username || session.user?.email || '' });
    setNewSources([]);
    setNewSourceInput('');
    setNewSourceSummary({ duplicates: [], invalid: [] });
    setAddStep(1);
    setValidatingCredentials(false);
  }, [session.user?.email, session.user?.username]);

  const openAdd = () => {
    if (!canCreateMappings) return showNotice('error', 'You do not have permission to add mappings.');
    resetAdd();
    setAddOpen(true);
  };
  const closeAdd = () => {
    setAddOpen(false);
    resetAdd();
  };
  // Attribution defaults follow the source count (off for one-to-one, on for
  // aggregates) until the operator picks a mode explicitly in the wizard.
  const syncAttributionDefault = useCallback((previousCount: number, nextCount: number) => {
    setNewMapping((current) => {
      const mode = nextAttributionModeForSourceChange(
        current.postingPolicy.attribution.mode,
        previousCount,
        nextCount,
      );
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
    const next = newSources.filter(
      (source) => normalizeTwitterUsername(source) !== normalizeTwitterUsername(username),
    );
    setNewSources(next);
    syncAttributionDefault(newSources.length, next.length);
  };

  const advanceAdd = async () => {
    if (addStep === 1 && newSources.length === 0) return showNotice('error', 'Add at least one Twitter username.');
    if (addStep < 3) return setAddStep((current) => current + 1);
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
    void run(async () => {
      await destinations.createDestination({
        owner: newMapping.owner.trim(),
        twitterUsernames: newSources,
        bskyIdentifier: newMapping.bskyIdentifier.trim(),
        bskyPassword: newMapping.bskyPassword,
        bskyServiceUrl: newMapping.bskyServiceUrl.trim(),
        groupName: newMapping.groupName.trim(),
        groupEmoji: newMapping.groupEmoji.trim(),
        postingPolicy: newMapping.postingPolicy,
        profileManagement: newMapping.profileManagement,
      });
      closeAdd();
      await destinations.fetchDestinations();
    }, allowProfileMutation
      ? 'Destination added. Profile mutation is allowed, but profile and pin sync modes are still off.'
      : 'Destination added with profile and pin mutations disabled.');
  };

  const [editingMapping, setEditingMapping] = useState<AccountMapping | null>(null);
  const [editForm, setEditForm] = useState<MappingFormState>(defaultMappingForm);
  const [editSources, setEditSources] = useState<string[]>([]);
  const [editSourceInput, setEditSourceInput] = useState('');
  const [editSourceSummary, setEditSourceSummary] = useState<SourceParseSummary>({ duplicates: [], invalid: [] });

  const startEdit = (mapping: AccountMapping) => {
    setEditingMapping(mapping);
    setEditSources(mapping.twitterUsernames);
    setEditSourceInput('');
    setEditSourceSummary({ duplicates: [], invalid: [] });
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
  };

  // Credential saves keep the dialog open, so the pinned mapping snapshot must
  // pick up the new config revision or the next save fails the version check.
  useEffect(() => {
    setEditingMapping((current) => {
      if (!current) return current;
      const latest = destinations.mappings.find((entry) => entry.id === current.id);
      if (!latest) return current;
      return latest.revision === current.revision && latest.updatedAt === current.updatedAt ? current : latest;
    });
  }, [destinations.mappings]);

  const submitEdit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingMapping) return;
    void run(async () => {
      const updated = await destinations.updateDestination(editingMapping, {
        owner: editForm.owner.trim(),
        groupName: editForm.groupName.trim(),
        groupEmoji: editForm.groupEmoji.trim(),
        postingPolicy: editForm.postingPolicy,
        profileManagement: editForm.profileManagement,
        aiOverrides: editForm.aiOverrides,
      });
      // syncSources refreshes the destination list itself.
      await destinations.syncSources(updated, editSources);
      setEditingMapping(null);
    }, 'Destination updated.');
  };

  const addEditSources = () => {
    const parsed = parseTwitterUsernameInput(editSources, editSourceInput);
    setEditSources(parsed.usernames);
    setEditSourceSummary(parsed.summary);
    setEditSourceInput('');
  };

  const [folderFilter, setFolderFilter] = useState('__all__');
  const [accountSearch, setAccountSearch] = useState('');
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
      const meta = folderFilter === '__all__' ? { key: '__all__', name: 'All Accounts', emoji: '🌐' } : getMappingGroupMeta(mapping);
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
    for (const mapping of destinations.mappings) {
      result.set(normalizeTwitterUsername(mapping.bskyIdentifier), mapping);
      for (const source of mapping.twitterUsernames) result.set(normalizeTwitterUsername(source), mapping);
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
        const response = await api.get<LocalPostSearchResult[]>('/api/posts/search', { params: { q: query, limit: 120 } });
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
    (mapping: AccountMapping | undefined, group: string) => group === 'all' || getMappingGroupMeta(mapping).key === group,
    [],
  );
  const visiblePosts = activity.enrichedPosts.slice(0, 12).filter((post) => filterByGroup(resolvePost(post), postsGroup));
  const visibleLocalPosts = localPosts.filter((post) => filterByGroup(resolveLocalPost(post), postsGroup));
  const visibleActivity = activity.recentActivity.filter((entry) => filterByGroup(resolveActivity(entry), activityGroup));

  const engagement = useMemo(() => {
    const scores = new Map<string, { identifier: string; score: number; posts: number }>();
    for (const post of activity.enrichedPosts) {
      const key = normalizeTwitterUsername(post.bskyIdentifier);
      const current = scores.get(key) || { identifier: post.bskyIdentifier, score: 0, posts: 0 };
      current.score += post.stats.engagement;
      current.posts += 1;
      scores.set(key, current);
    }
    return [...scores.values()].sort((a, b) => b.score - a.score)[0];
  }, [activity.enrichedPosts]);

  const [emailForm, setEmailForm] = useState<AccountSecurityEmailState>({ currentEmail: '', newEmail: '', password: '' });
  const [passwordForm, setPasswordForm] = useState<AccountSecurityPasswordState>({ currentPassword: '', newPassword: '', confirmPassword: '' });
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
      <AuthScreen
        view={session.authView}
        bootstrapOpen={session.bootstrapOpen}
        loading={session.loading}
        error={session.error}
        onViewChange={session.setAuthView}
        onLogin={session.login}
        onRegister={session.register}
      />
    );
  }

  if (!session.user) {
    return <main className="flex min-h-screen items-center justify-center"><output>Loading dashboard…</output></main>;
  }

  const currentStatus = activity.status?.currentStatus;
  const queue = activity.status?.queue;
  const pendingBackfills = activity.status?.pendingBackfills || [];
  const queuedCount = (queue?.pending || 0) + (queue?.processing || 0);
  const progress = currentStatus?.totalCount
    ? Math.round(((currentStatus.processedCount || 0) / currentStatus.totalCount) * 100)
    : 0;

  const cycleTheme = () => setTheme((current) => (current === 'system' ? 'light' : current === 'light' ? 'dark' : 'system'));
  const themeIcon = theme === 'system' ? <SunMoon className="h-4 w-4" /> : theme === 'light' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />;

  return (
    <div className="min-h-screen bg-muted/20 text-foreground">
      <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div><p className="font-semibold">Tweets-2-Bsky</p><p className="text-xs text-muted-foreground">Crosspost control center</p></div>
          <div className="flex items-center gap-2">
            {canCreateMappings ? <Button size="sm" onClick={openAdd}><Plus className="mr-2 h-4 w-4" />Add Bluesky destination</Button> : null}
            <Button size="sm" variant="outline" onClick={() => void run(activity.runNow, 'Check triggered.')} disabled={!permissions.runNow}><LayoutDashboard className="mr-2 h-4 w-4" />Run now</Button>
            <Button size="icon" variant="ghost" aria-label={`Theme: ${theme} (${resolvedTheme})`} onClick={cycleTheme}>{themeIcon}</Button>
            <Button size="icon" variant="ghost" aria-label="Log out" onClick={() => void session.logout()}><LogOut className="h-4 w-4" /></Button>
          </div>
        </div>
      </header>
      <div className="mx-auto grid max-w-[1600px] gap-6 px-4 py-6 lg:grid-cols-[220px_1fr]">
        <Card className="h-fit lg:sticky lg:top-24"><CardContent className="p-2"><NavList items={dashboardTabs} activeId={activeTab} onSelect={setActiveTab} ariaLabel="Dashboard navigation" /></CardContent></Card>
        <main className="min-w-0">
          <div className="mb-5"><h1 id="page-title" className="text-2xl font-semibold">{dashboardTabs.find((tab) => tab.id === activeTab)?.label}</h1></div>
          {notice ? <div role={notice.tone === 'error' ? 'alert' : 'status'} className={`mb-4 rounded-md border p-3 text-sm ${notice.tone === 'error' ? 'border-red-300 text-red-700 dark:text-red-300' : ''}`}>{notice.message}</div> : null}
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
              isBackfillActive={(id) => currentStatus?.state === 'backfilling' && currentStatus.backfillMappingId === id}
              onEdit={startEdit}
              onDelete={(mapping) => void run(() => destinations.deleteDestination(mapping), 'Destination deleted.')}
              onBackfill={(mapping) => void run(() => activity.requestBackfill(mapping.id), 'Backfill queued.')}
              onCancelBackfill={(mapping) => void run(() => activity.cancelBackfill(mapping.id), 'Backfill cancelled.')}
              onApplyProfileSync={(mapping) =>
                void run(
                  () =>
                    destinations.applyProfileSync(
                      mapping,
                      mapping.profileManagement.profileSync.sourceUsername,
                    ),
                  'Profile sync applied.',
                )
              }
              onQueuePinSync={(mapping) =>
                void run(
                  () => destinations.queuePinSync(mapping, mapping.profileManagement.pinSync.sourceUsername),
                  'Pin sync queued.',
                )
              }
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
                const diagnostic = JSON.stringify({
                  queue: { status: item.status, attempts: item.attempts, enqueuedAt: item.enqueued_at, category: item.error_category },
                  identities: { destinationId: queueItem.destination_id, routeId: queueItem.route_id, sourceId: queueItem.source_id, requestId: queueItem.request_id, externalPostId: item.twitter_id },
                  policy: { version: item.policy_version, behavior: item.policy_snapshot ? 'snapshotted' : 'current' },
                  error: item.error_message,
                  deliveryFallbacks: queueItem.delivery_diagnostics ?? item.delivery_diagnostics ?? null,
                }, null, 2);
                try {
                  await navigator.clipboard.writeText(diagnostic);
                  showNotice('success', 'Redacted queue diagnostic copied.');
                } catch {
                  showNotice('error', 'The browser blocked clipboard access; copy the diagnostic from the item instead.');
                }
              }}
              reevaluatePolicy={async (item) => {
                const ok = await askConfirmation({ title: 'Use current queue policy?', description: 'Replace this queued item policy snapshot with current policy.', confirmLabel: 'Use current policy' });
                if (ok) await run(() => activity.reevaluateQueueItem(item as QueueItemView), 'Queue policy updated.');
              }}
              operateItem={async (item, action) => {
                if (action === 'cancel') {
                  const ok = await askConfirmation({ title: 'Cancel queue item?', description: 'The pending delivery will be removed.', confirmLabel: 'Cancel item', destructive: true });
                  if (!ok) return;
                }
                await run(() => activity.operateQueueItem(item as QueueItemView, action), action === 'retry' ? 'Queue item requeued.' : 'Queue item cancelled.');
              }}
              overrideSkipped={async (entry) => {
                const ok = await askConfirmation({ title: 'Override skipped item?', description: 'Re-evaluate and explicitly override current policy for this retained item.', confirmLabel: 'Override and requeue' });
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
              updateBusy={updateBusy}
              editingUserId={editingUserId}
              canCreateMappings={canCreateMappings}
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
              onSaveEmail={(event) => saveWithNotice(event, async () => {
                await settings.changeEmail(emailForm);
                session.setUser((current) => current ? { ...current, email: emailForm.newEmail } : current);
                setEmailForm({ currentEmail: emailForm.newEmail, newEmail: '', password: '' });
              }, 'Email updated.')}
              onSavePassword={(event) => saveWithNotice(event, async () => {
                await settings.changePassword(passwordForm);
                setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
              }, 'Password updated.')}
              onSaveScheduler={(event) => {
                event.preventDefault();
                setSchedulerSaving(true);
                void settings.saveScheduler().then(() => showNotice('success', 'Scheduler saved.')).catch((error) => handleError(error, 'Failed to save scheduler.')).finally(() => setSchedulerSaving(false));
              }}
              onSaveTwitter={(event) => saveWithNotice(event, settings.saveTwitter, 'Twitter credentials saved.')}
              onSaveAi={(event) => saveWithNotice(event, settings.saveAi, 'AI settings saved.')}
              onPreviewAiText={(capability, text) => settings.previewAiText(capability, text)}
              onSaveNotifications={(event) => saveWithNotice(event, settings.saveNotifications, 'Notification settings saved.')}
              onTestNotifications={() => {
                void run(() => settings.testNotifications(), 'Test notification queued.');
              }}
              onCreateUser={(event) => saveWithNotice(event, async () => {
                await settings.createUser({
                  username: newUser.username || undefined,
                  email: newUser.email || undefined,
                  password: newUser.password,
                  isAdmin: newUser.isAdmin,
                  permissions: newUser.permissions,
                });
                setNewUser(defaultUserForm());
              }, 'User created.')}
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
                setUpdateBusy(true);
                void api.post('/api/update').then(() => settings.refresh()).then(() => showNotice('success', 'Update started.')).catch((error) => handleError(error, 'Failed to start update.')).finally(() => setUpdateBusy(false));
              }}
              onAddDestination={openAdd}
              onExport={() => void run(async () => {
                const response = await api.get('/api/config/export');
                downloadJson('tweets-2-bsky-config.json', response.data);
              })}
              onImport={() => importInput.current?.click()}
              onBackup={(mode) => void run(async () => {
                const response = await api.post('/api/backup/create', { mode });
                downloadJson(`tweets-2-bsky-${mode}-backup.json`, response.data);
              })}
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
        parseSummary={newSourceSummary}
        form={newMapping}
        busy={busy}
        validating={validatingCredentials}
        onClose={closeAdd}
        onSourceInputChange={setNewSourceInput}
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
        onClose={() => setEditingMapping(null)}
        onSubmit={submitEdit}
        onFormChange={setEditForm}
        onSourceInputChange={setEditSourceInput}
        onAddSources={addEditSources}
        onRemoveSource={(username) =>
          setEditSources((current) =>
            current.filter((source) => normalizeTwitterUsername(source) !== normalizeTwitterUsername(username)),
          )
        }
        onTestCredentials={() => {
          if (!editingMapping) return;
          void run(async () => {
            await destinations.testCredentials(editingMapping, editForm.bskyPassword);
          }, 'Credentials are valid.');
        }}
        onSaveCredentials={() => {
          if (!editingMapping) return;
          void run(async () => {
            await destinations.saveCredentials(editingMapping, editForm.bskyPassword);
            setEditForm((current) => ({ ...current, bskyPassword: '' }));
          }, 'Credentials saved.');
        }}
        onSaveSourceFilters={async (username, filters) => {
          if (!editingMapping) return;
          await run(async () => {
            await destinations.patchSource(editingMapping, username, { filters });
          }, `Filters saved for @${username}.`);
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
            await destinations.applyProfileSync(
              editingMapping,
              editForm.profileManagement.profileSync.sourceUsername,
            );
          }, 'Profile sync applied.');
        }}
        onQueuePinSync={() => {
          if (!editingMapping) return;
          void run(async () => {
            await destinations.queuePinSync(
              editingMapping,
              editForm.profileManagement.pinSync.sourceUsername,
            );
          }, 'Pin sync queued.');
        }}
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
          void run(async () => {
            const version = settings.scheduler;
            if (!version) throw new Error('Settings are still loading; retry the import in a moment.');
            await api.post('/api/config/import', withConfigVersion(JSON.parse(await file.text()), version));
            await Promise.all([destinations.fetchDestinations(), settings.refresh()]);
          }, 'Configuration imported.');
          event.target.value = '';
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
          void askConfirmation({ title: 'Restore backup?', description: 'Current configuration and runtime data may be replaced.', confirmLabel: 'Restore backup', destructive: true }).then((ok) => {
            if (!ok) return;
            void run(async () => {
              const version = settings.scheduler;
              if (!version) throw new Error('Settings are still loading; retry the restore in a moment.');
              const bundle = JSON.parse(await file.text());
              await api.post('/api/backup/restore/apply', withConfigVersion({ bundle }, version));
              await Promise.all([destinations.fetchDestinations(), settings.refresh(), activity.refresh()]);
            }, 'Backup restored.');
          });
          event.target.value = '';
        }}
      />
    </div>
  );
}
