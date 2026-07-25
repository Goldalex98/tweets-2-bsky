import type { AuthUser, UserFormState, UserPermissions } from './types';

export const DEFAULT_USER_PERMISSIONS: UserPermissions = {
  viewAllMappings: false,
  manageOwnMappings: true,
  manageAllMappings: false,
  manageGroups: false,
  queueBackfills: true,
  runNow: true,
  reevaluateQueuePolicies: false,
};

export const PERMISSION_OPTIONS: Array<{
  key: keyof UserPermissions;
  label: string;
  help: string;
}> = [
  { key: 'viewAllMappings', label: 'View all destinations', help: 'See every destination, post, and activity row.' },
  {
    key: 'manageOwnMappings',
    label: 'Manage own destinations',
    help: 'Create, edit, and delete destinations this user owns.',
  },
  {
    key: 'manageAllMappings',
    label: 'Manage all destinations',
    help: 'Edit/delete destinations created by any user.',
  },
  { key: 'manageGroups', label: 'Manage groups', help: 'Create, rename, and delete account groups.' },
  { key: 'queueBackfills', label: 'Queue backfills', help: 'Queue backfills for destinations they can manage.' },
  { key: 'runNow', label: 'Run checks now', help: 'Trigger an immediate scheduler run.' },
  {
    key: 'reevaluateQueuePolicies',
    label: 'Re-evaluate queued policies',
    help: 'Rewrite non-processing queue snapshots under current policy with confirmation.',
  },
];

export function defaultUserForm(): UserFormState {
  return {
    username: '',
    email: '',
    password: '',
    isAdmin: false,
    permissions: { ...DEFAULT_USER_PERMISSIONS },
  };
}

export function normalizePermissions(permissions?: Partial<UserPermissions>): UserPermissions {
  return { ...DEFAULT_USER_PERMISSIONS, ...(permissions || {}) };
}

export function getUserLabel(user?: Pick<AuthUser, 'username' | 'email'> | null): string {
  return user?.username || user?.email || 'user';
}
