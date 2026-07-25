import { Bot, Download, Link2, Repeat2, Settings2, SunMoon, UserRound, Users } from 'lucide-react';
import type { Dispatch, FormEvent, SetStateAction } from 'react';
import type { SettingsSection } from '../../api/types';
import { Badge } from '../../components/ui/badge';
import { Card, CardContent } from '../../components/ui/card';
import { NavList } from '../../components/ui/nav-list';
import { IngestionDigestsPage } from '../ingestion/ingestion-digests-page';
import type { DigestAdminView, IngestionCredentialView, IngestionSourceView } from '../ingestion/types';
import type { SchedulerSettings } from '../status/types';
import {
  AccessScopeSection,
  AccountSecuritySection,
  AiSettingsSection,
  DataManagementSection,
  NotificationsSection,
  SchedulerSection,
  SystemSection,
  TwitterSettingsSection,
  UsersSection,
} from './settings-sections';
import type {
  AccountSecurityEmailState,
  AccountSecurityPasswordState,
  AIConfig,
  AuthUser,
  ManagedUser,
  NotificationSettings,
  RuntimeVersionInfo,
  TwitterConfig,
  UpdateStatusInfo,
  UserFormState,
  UserPermissions,
} from './types';

interface SettingsPageProps {
  section: SettingsSection;
  onSectionChange(section: SettingsSection): void;
  user: AuthUser;
  permissions: UserPermissions;
  email: AccountSecurityEmailState;
  setEmail: Dispatch<SetStateAction<AccountSecurityEmailState>>;
  password: AccountSecurityPasswordState;
  setPassword: Dispatch<SetStateAction<AccountSecurityPasswordState>>;
  scheduler: SchedulerSettings | null;
  setScheduler: Dispatch<SetStateAction<SchedulerSettings | null>>;
  twitter: TwitterConfig;
  setTwitter: Dispatch<SetStateAction<TwitterConfig>>;
  ai: AIConfig;
  setAi: Dispatch<SetStateAction<AIConfig>>;
  notifications: NotificationSettings;
  setNotifications: Dispatch<SetStateAction<NotificationSettings>>;
  users: ManagedUser[];
  newUser: UserFormState;
  setNewUser: Dispatch<SetStateAction<UserFormState>>;
  runtime: RuntimeVersionInfo | null;
  update: UpdateStatusInfo | null;
  busy: boolean;
  schedulerSaving: boolean;
  updateBusy: boolean;
  editingUserId: string | null;
  canCreateMappings: boolean;
  ingestion: {
    sources: IngestionSourceView[];
    credentials: IngestionCredentialView[];
    digests: DigestAdminView;
    oneTimeSecret: string | null;
    loading: boolean;
    error: string | null;
    createSource: Parameters<typeof IngestionDigestsPage>[0]['onCreateSource'];
    setRouteDelivery: Parameters<typeof IngestionDigestsPage>[0]['onSetRouteDelivery'];
    createCredential: Parameters<typeof IngestionDigestsPage>[0]['onCreateCredential'];
    revokeCredential: Parameters<typeof IngestionDigestsPage>[0]['onRevokeCredential'];
    previewDigest: Parameters<typeof IngestionDigestsPage>[0]['onPreviewDigest'];
    publishDigest: Parameters<typeof IngestionDigestsPage>[0]['onPublishDigest'];
    retryDigest: Parameters<typeof IngestionDigestsPage>[0]['onRetryDigest'];
    cancelDigest: Parameters<typeof IngestionDigestsPage>[0]['onCancelDigest'];
  };
  onSaveEmail(event: FormEvent<HTMLFormElement>): void;
  onSavePassword(event: FormEvent<HTMLFormElement>): void;
  onSaveScheduler(event: FormEvent<HTMLFormElement>): void;
  onSaveTwitter(event: FormEvent<HTMLFormElement>): void;
  onSaveAi(event: FormEvent<HTMLFormElement>): void;
  onSaveNotifications(event: FormEvent<HTMLFormElement>): void;
  onCreateUser(event: FormEvent<HTMLFormElement>): void;
  onEditUser(user: ManagedUser): void;
  onDeleteUser(user: ManagedUser): void;
  onRunUpdate(): void;
  onAddDestination(): void;
  onExport(): void;
  onImport(): void;
  onBackup(mode: 'redacted' | 'full'): void;
  onRestore(): void;
}

export function SettingsPage(props: SettingsPageProps) {
  const isAdmin = props.user.isAdmin;
  const nav = [
    { id: 'account' as const, label: 'Account', icon: UserRound },
    ...(isAdmin
      ? [
          { id: 'system' as const, label: 'System', icon: Settings2 },
          { id: 'scheduler' as const, label: 'Scheduler', icon: Settings2 },
          { id: 'users' as const, label: 'Users', icon: Users },
          { id: 'twitter' as const, label: 'Twitter', icon: Bot, badge: <Badge variant={props.twitter.hasAuthToken ? 'success' : 'outline'}>{props.twitter.hasAuthToken ? 'On' : 'Off'}</Badge> },
          { id: 'ai' as const, label: 'Image Alt Text', icon: SunMoon, badge: <Badge variant={props.ai.enabled ? 'success' : 'outline'}>{props.ai.enabled ? 'On' : 'Off'}</Badge> },
          { id: 'notifications' as const, label: 'Notifications', icon: Link2 },
          { id: 'ingestion' as const, label: 'Ingestion & digests', icon: Repeat2 },
          { id: 'data' as const, label: 'Data', icon: Download },
        ]
      : []),
  ];

  return (
    <section className="grid gap-6 lg:grid-cols-[240px_1fr] animate-fade-in" aria-labelledby="settings-title">
      <h2 id="settings-title" className="sr-only">Settings</h2>
      <Card className="h-fit"><CardContent className="p-2"><NavList items={nav} activeId={props.section} onSelect={(id) => props.onSectionChange(id as SettingsSection)} ariaLabel="Settings sections" /></CardContent></Card>
      <div className="min-w-0 space-y-4">
        {props.section === 'account' ? (
          <>
            <AccountSecuritySection user={props.user} email={props.email} setEmail={props.setEmail} password={props.password} setPassword={props.setPassword} busy={props.busy} onSaveEmail={props.onSaveEmail} onSavePassword={props.onSavePassword} />
            {!isAdmin ? <AccessScopeSection permissions={props.permissions} /> : null}
          </>
        ) : null}
        {props.section === 'system' && isAdmin ? <SystemSection runtime={props.runtime} update={props.update} updating={props.updateBusy} canCreate={props.canCreateMappings} onUpdate={props.onRunUpdate} onAdd={props.onAddDestination} /> : null}
        {props.section === 'scheduler' && isAdmin && props.scheduler ? <SchedulerSection value={props.scheduler} setValue={props.setScheduler} saving={props.schedulerSaving} onSubmit={props.onSaveScheduler} /> : null}
        {props.section === 'users' && isAdmin ? <UsersSection users={props.users} form={props.newUser} setForm={props.setNewUser} editingId={props.editingUserId} busy={props.busy} onCreate={props.onCreateUser} onEdit={props.onEditUser} onDelete={props.onDeleteUser} /> : null}
        {props.section === 'twitter' && isAdmin ? <TwitterSettingsSection value={props.twitter} setValue={props.setTwitter} busy={props.busy} onSubmit={props.onSaveTwitter} /> : null}
        {props.section === 'ai' && isAdmin ? <AiSettingsSection value={props.ai} setValue={props.setAi} busy={props.busy} onSubmit={props.onSaveAi} /> : null}
        {props.section === 'notifications' && isAdmin ? <NotificationsSection value={props.notifications} setValue={props.setNotifications} busy={props.busy} onSubmit={props.onSaveNotifications} /> : null}
        {props.section === 'ingestion' && isAdmin ? <IngestionDigestsPage sources={props.ingestion.sources} credentials={props.ingestion.credentials} digests={props.ingestion.digests} oneTimeSecret={props.ingestion.oneTimeSecret} loading={props.ingestion.loading} error={props.ingestion.error} onCreateSource={props.ingestion.createSource} onSetRouteDelivery={props.ingestion.setRouteDelivery} onCreateCredential={props.ingestion.createCredential} onRevokeCredential={props.ingestion.revokeCredential} onPreviewDigest={props.ingestion.previewDigest} onPublishDigest={props.ingestion.publishDigest} onRetryDigest={props.ingestion.retryDigest} onCancelDigest={props.ingestion.cancelDigest} /> : null}
        {props.section === 'data' && isAdmin ? <DataManagementSection busy={props.busy} onExport={props.onExport} onImport={props.onImport} onBackup={props.onBackup} onRestore={props.onRestore} /> : null}
      </div>
    </section>
  );
}
