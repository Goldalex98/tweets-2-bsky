import { describe, expect, test } from 'bun:test';
import { canMutateBlueskyAccount } from '../../src/config/bluesky-accounts.js';
import type { AppConfig } from '../../src/config/schemas.js';

describe('canMutateBlueskyAccount', () => {
  const config = {
    blueskyAccounts: [
      {
        id: 'acct-owned',
        serviceUrl: 'https://bsky.social',
        loginIdentifier: 'owned.example',
        appPassword: 'secret',
        createdByUserId: 'user-a',
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
      {
        id: 'acct-orphan',
        serviceUrl: 'https://bsky.social',
        loginIdentifier: 'orphan.example',
        appPassword: 'secret',
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
      {
        id: 'acct-linked',
        serviceUrl: 'https://bsky.social',
        loginIdentifier: 'linked.example',
        appPassword: 'secret',
        createdByUserId: 'user-b',
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
    ],
    destinations: [
      {
        id: 'dest-1',
        enabled: true,
        bskyAccountId: 'acct-linked',
        bskyIdentifier: 'linked.example',
        bskyServiceUrl: 'https://bsky.social',
        storageKey: 'linked.example',
        metadata: { legacyMappingIds: ['dest-1'] },
      },
    ],
  } as unknown as AppConfig;

  test('creator may mutate their still-unlinked account', () => {
    expect(
      canMutateBlueskyAccount(config, { id: 'user-a' }, 'acct-owned', {
        canManageAllMappings: false,
        canManageDestination: () => false,
      }),
    ).toBe(true);
  });

  test('peer cannot mutate another user unlinked account', () => {
    expect(
      canMutateBlueskyAccount(config, { id: 'user-b' }, 'acct-owned', {
        canManageAllMappings: false,
        canManageDestination: () => false,
      }),
    ).toBe(false);
  });

  test('orphans without createdByUserId require manageAllMappings', () => {
    expect(
      canMutateBlueskyAccount(config, { id: 'user-a' }, 'acct-orphan', {
        canManageAllMappings: false,
        canManageDestination: () => false,
      }),
    ).toBe(false);
    expect(
      canMutateBlueskyAccount(config, { id: 'user-a' }, 'acct-orphan', {
        canManageAllMappings: true,
        canManageDestination: () => false,
      }),
    ).toBe(true);
  });

  test('linked accounts follow destination manageability', () => {
    expect(
      canMutateBlueskyAccount(config, { id: 'user-a' }, 'acct-linked', {
        canManageAllMappings: false,
        canManageDestination: (id) => id === 'dest-1',
      }),
    ).toBe(true);
    expect(
      canMutateBlueskyAccount(config, { id: 'user-a' }, 'acct-linked', {
        canManageAllMappings: false,
        canManageDestination: () => false,
      }),
    ).toBe(false);
  });

  test('unknown account ids are denied for non-admins', () => {
    expect(
      canMutateBlueskyAccount(config, { id: 'user-a' }, 'acct-missing', {
        canManageAllMappings: false,
        canManageDestination: () => true,
      }),
    ).toBe(false);
  });

  test('admins may still mutate unknown account ids (handler returns not-found)', () => {
    expect(
      canMutateBlueskyAccount(config, { id: 'admin' }, 'acct-missing', {
        canManageAllMappings: true,
        canManageDestination: () => false,
      }),
    ).toBe(true);
  });
});
