import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { Command } from 'commander';
import inquirer from 'inquirer';
import {
  addDestinationSources,
  applyValidatedDestinationIdentity,
  findDuplicateActiveDestination,
  getSourceDependencies,
  removeDestinationSource,
  setDestinationSourcePaused,
} from './aggregate-destination.js';
import {
  applyRestoreBundle,
  createBackupBundle,
  getBackupStorageStatus,
  validateBackupBundle,
} from './backup-service.js';
import { clearCachedAgent, deleteAllPosts } from './bsky.js';
import { previewTextCapability, testAIProvider } from './ai-manager.js';
import { evaluateContentPolicy } from './content-policy.js';
import { defaultPostingPolicy } from './config/defaults.js';
import type { AttributionMode } from './config/schemas.js';
import {
  type AccountMapping,
  type AppConfig,
  type ConfigExportMode,
  addMapping,
  createConfigExport,
  getConfig,
  getConfigMigrationReport,
  mergeImportedConfig,
  normalizeSourceFilters,
  normalizeSourceSchedule,
  removeMapping,
  saveConfig,
  saveCanonicalConfig,
  updateTwitterConfig,
} from './config-manager.js';
import {
  dbService,
  digestEntryService,
  digestJobService,
  ingestionAuditService,
  ingestionCredentialService,
  postQueueService,
  runtimeStateService,
} from './db.js';
import { getDestinationStorageKey, parseTwitterUsernameInput } from './mapping-helpers.js';
import {
  applyProfileMirrorSyncState,
  fetchTwitterMirrorProfile,
  syncBlueskyProfileFromTwitter,
  validateBlueskyCredentials,
} from './profile-mirror.js';
import { applyPostingPolicy, validateAttributionTemplate } from './post-transform.js';
import { assertProfileMutationAllowed, evaluateProfileMutation } from './profile-policy.js';
import { getSchedulerIntervalMinutes, parseSchedulerIntervalMinutes } from './scheduler-timing.js';
import { evaluateSourceFilter } from './source-filter.js';
import { validateWebhookTarget } from './webhook.js';
import { getEncryptionStatus } from './secret-storage.js';
import { rotateEncryptionKey } from './encryption-rotation.js';
import { ACTIVE_CONFIG_FILE } from './storage-paths.js';
import { parseIngestionScopes } from './ingestion-security.js';
import { buildDigestPreview } from './digest.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.join(__dirname, '..');
const getCliVersion = (): string => {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof value.version === 'string' && value.version.trim() ? value.version.trim() : 'unknown';
  } catch {
    return 'unknown';
  }
};

const normalizeHandle = (value: string) => value.trim().replace(/^@/, '').toLowerCase();

const requireCliAdminReauthentication = async (): Promise<void> => {
  const config = getConfig();
  const admins = config.users.filter((user) => user.role === 'admin');
  if (admins.length === 0) throw new Error('Restore apply requires an existing administrator.');
  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'identifier',
      message: 'Current admin username or email:',
    },
    {
      type: 'password',
      name: 'password',
      message: 'Current admin password:',
      mask: '*',
    },
  ]);
  const identifier = String(answers.identifier || '').trim().toLowerCase();
  const admin = admins.find(
    (user) => user.username?.toLowerCase() === identifier || user.email?.toLowerCase() === identifier,
  );
  if (!admin || !(await bcrypt.compare(String(answers.password || ''), admin.passwordHash))) {
    throw new Error('Current administrator reauthentication failed.');
  }
};

/**
 * The CLI writes config.json from a separate process, so it cannot signal a running
 * daemon the way the web PATCH does. The daemon re-reads config at each sweep boundary.
 */
const describeSchedulerApplication = (enabled: boolean): string =>
  enabled
    ? 'A running daemon picks this up at its next scheduled cycle; restart it to apply immediately.'
    : 'Automatic checks are disabled, so this only takes effect once the scheduler is enabled.';

const describeAttributionState = (mode: AttributionMode, sourceCount: number): string => {
  if (mode === 'always') return 'Attribution: every mirrored post is prefixed with its X source.';
  if (mode === 'never') return 'Attribution: mirrored posts are never prefixed with an X source.';
  return sourceCount > 1
    ? `Attribution: active because this destination has ${sourceCount} X sources.`
    : 'Attribution: inactive while this destination has a single X source; it turns on when a second source is added.';
};

const parsePositiveInt = (value: string, defaultValue: number): number => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }
  return parsed;
};

const findMappingByRef = (config: AppConfig, ref: string): AccountMapping | undefined => {
  const needle = normalizeHandle(ref);
  return config.mappings.find(
    (mapping) =>
      mapping.id === ref ||
      normalizeHandle(mapping.bskyIdentifier) === needle ||
      mapping.twitterUsernames.some((username) => normalizeHandle(username) === needle),
  );
};

const selectMapping = async (message: string): Promise<AccountMapping | null> => {
  const config = getConfig();
  if (config.mappings.length === 0) {
    console.log('No mappings found.');
    return null;
  }

  const { id } = await inquirer.prompt([
    {
      type: 'list',
      name: 'id',
      message,
      choices: config.mappings.map((mapping) => ({
        name: `${mapping.owner || 'System'}: ${mapping.twitterUsernames.join(', ')} -> ${mapping.bskyIdentifier}`,
        value: mapping.id,
      })),
    },
  ]);

  return config.mappings.find((mapping) => mapping.id === id) ?? null;
};

const spawnAndWait = async (command: string, args: string[], cwd: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      env: process.env,
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Process exited with code ${code}`));
    });
  });

const runCoreCommand = async (args: string[]): Promise<void> => {
  const distEntry = path.join(ROOT_DIR, 'dist', 'index.js');
  if (fs.existsSync(distEntry)) {
    await spawnAndWait(process.execPath, [distEntry, ...args], ROOT_DIR);
    return;
  }

  const sourceEntry = path.join(ROOT_DIR, 'src', 'index.ts');
  if (fs.existsSync(sourceEntry)) {
    await spawnAndWait(process.execPath, [sourceEntry, ...args], ROOT_DIR);
    return;
  }

  throw new Error('Could not find dist/index.js or source runtime entry. Run bun run build first.');
};

const ensureMapping = async (mappingRef?: string): Promise<AccountMapping | null> => {
  const config = getConfig();
  if (config.mappings.length === 0) {
    console.log('No mappings found.');
    return null;
  }

  if (mappingRef) {
    const mapping = findMappingByRef(config, mappingRef);
    if (!mapping) {
      console.log(`No mapping found for '${mappingRef}'.`);
      return null;
    }
    return mapping;
  }

  return selectMapping('Select a mapping:');
};

const exportConfig = (outputFile: string, mode: ConfigExportMode, fullExportConfirmed: boolean) => {
  if (mode === 'full' && !fullExportConfirmed) {
    throw new Error('Full export contains credentials. Re-run with --mode full --confirm-full-export.');
  }
  const config = getConfig();
  const outputPath = path.resolve(outputFile);
  fs.writeFileSync(outputPath, `${JSON.stringify(createConfigExport(config, mode), null, 2)}\n`);
  console.log(
    mode === 'full'
      ? `Exported full credential-containing config to ${outputPath}. Protect this file.`
      : `Exported redacted config to ${outputPath}. Use --mode full --confirm-full-export only for a credential backup.`,
  );
};

const importConfig = (inputFile: string) => {
  const inputPath = path.resolve(inputFile);
  if (!fs.existsSync(inputPath)) {
    throw new Error(`File not found: ${inputPath}`);
  }

  const parsed: unknown = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const currentConfig = getConfig();
  const nextConfig = mergeImportedConfig(currentConfig, parsed);
  saveConfig(nextConfig);
  console.log('Config imported successfully. Existing users and redacted credentials were preserved.');
};

const program = new Command();

program.name('tweets-2-bsky-cli').description('CLI for full Tweets -> Bluesky dashboard workflows').version(getCliVersion());

program
  .command('setup-ai')
  .description('Configure AI settings for alt text generation')
  .action(async () => {
    const config = getConfig();
    const currentAi = config.ai;

    const answers = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'enabled',
        message: 'Enable Image Alt Text generation?',
        default: currentAi.enabled,
      },
      {
        type: 'list',
        name: 'provider',
        message: 'Select AI Provider:',
        choices: [
          { name: 'Google Gemini (Default)', value: 'gemini' },
          { name: 'OpenAI / OpenRouter', value: 'openai' },
          { name: 'Anthropic (Claude)', value: 'anthropic' },
          { name: 'Custom (OpenAI Compatible)', value: 'custom' },
        ],
        default: currentAi.provider,
      },
      {
        type: 'number',
        name: 'maxAltTextChars',
        message: 'Maximum Image Alt Text characters:',
        default: currentAi.maxAltTextChars,
      },
      {
        type: 'input',
        name: 'apiKey',
        message: 'Enter API Key (optional for some custom providers):',
        default: currentAi.apiKey,
      },
      {
        type: 'input',
        name: 'model',
        message: 'Enter Model ID (optional, leave empty for default):',
        default: currentAi.model,
      },
      {
        type: 'input',
        name: 'baseUrl',
        message: 'Enter Base URL (optional):',
        default: currentAi.baseUrl,
        when: (answers) => ['openai', 'anthropic', 'custom'].includes(answers.provider),
      },
    ]);

    config.ai = {
      ...currentAi,
      enabled: answers.enabled,
      purpose: 'image-alt-text',
      provider: answers.provider,
      apiKey: answers.apiKey,
      model: answers.model || undefined,
      baseUrl: answers.baseUrl || undefined,
      maxAltTextChars: answers.maxAltTextChars,
    };

    config.geminiApiKey = undefined; // legacy field; dropped from config.json on save
    saveConfig(config);
    console.log('Image Alt Text configuration updated. Text capabilities remain independently disabled.');
  });

program
  .command('ai-provider-test')
  .description('Test the configured AI provider with a disclosed generated image')
  .action(async () => {
    console.log(JSON.stringify(await testAIProvider(), null, 2));
  });

program
  .command('ai-text-preview <capability> <text>')
  .description('Preview an explicitly enabled AI text capability without saving')
  .action(async (capability: string, text: string) => {
    if (!['translation', 'summarization', 'cleanup', 'hashtags'].includes(capability)) {
      throw new Error('Capability must be translation, summarization, cleanup, or hashtags.');
    }
    console.log(
      JSON.stringify(
        await previewTextCapability({
          capability: capability as 'translation' | 'summarization' | 'cleanup' | 'hashtags',
          text,
        }),
        null,
        2,
      ),
    );
  });

program
  .command('policy-preview <destinationId> <routeId>')
  .description('Dry-run routing and moderation with trace output')
  .requiredOption('--metadata-json <json>', 'Normalized post metadata JSON')
  .action((destinationId: string, routeId: string, options: { metadataJson: string }) => {
    const config = getConfig();
    const destination = config.destinations.find((entry) => entry.id === destinationId);
    const route = config.routes.find((entry) => entry.id === routeId && entry.destinationId === destinationId);
    if (!destination || !route) throw new Error('Destination route not found.');
    console.log(
      JSON.stringify(
        { dryRun: true, decision: evaluateContentPolicy(destination, route, JSON.parse(options.metadataJson)) },
        null,
        2,
      ),
    );
  });

program
  .command('setup-twitter')
  .description('Setup Twitter auth cookies (primary + backup)')
  .action(async () => {
    const config = getConfig();
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'authToken',
        message: 'Primary Twitter auth_token:',
        default: config.twitter.authToken,
      },
      {
        type: 'input',
        name: 'ct0',
        message: 'Primary Twitter ct0:',
        default: config.twitter.ct0,
      },
      {
        type: 'input',
        name: 'backupAuthToken',
        message: 'Backup Twitter auth_token (optional):',
        default: config.twitter.backupAuthToken,
      },
      {
        type: 'input',
        name: 'backupCt0',
        message: 'Backup Twitter ct0 (optional):',
        default: config.twitter.backupCt0,
      },
    ]);

    updateTwitterConfig(answers);
    console.log('Twitter credentials updated.');
  });

program
  .command('add-mapping')
  .description('Add a new Twitter -> Bluesky mapping with guided onboarding')
  .action(async () => {
    const config = getConfig();
    const ownerDefault =
      config.users.find((user) => user.role === 'admin')?.username || config.users[0]?.username || '';

    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'twitterUsernames',
        message: 'Twitter username(s) to watch (comma separated, without @):',
      },
    ]);

    const sourceParsing = parseTwitterUsernameInput(answers.twitterUsernames);
    const usernames = sourceParsing.added;

    if (usernames.length === 0 || sourceParsing.invalid.length > 0) {
      console.log(JSON.stringify(sourceParsing, null, 2));
      console.log('Please provide at least one valid X username and fix invalid entries.');
      return;
    }

    const accountFlow = await inquirer.prompt([
      {
        type: 'list',
        name: 'accountState',
        message: 'Bluesky account setup:',
        choices: [
          { name: 'Open bsky.app and create a new account', value: 'create' },
          { name: 'I already have a Bluesky account', value: 'existing' },
        ],
      },
    ]);

    if (accountFlow.accountState === 'create') {
      console.log('Open https://bsky.app to create the account, then generate an app password.');
      const continueAnswer = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'continueAfterCreate',
          message: 'Continue once your Bluesky account exists?',
          default: true,
        },
      ]);

      if (!continueAnswer.continueAfterCreate) {
        console.log('Cancelled.');
        return;
      }
    }

    const bskyAnswers = await inquirer.prompt([
      {
        type: 'input',
        name: 'bskyIdentifier',
        message: 'Bluesky identifier (handle or email):',
      },
      {
        type: 'password',
        name: 'bskyPassword',
        message: 'Bluesky app password:',
      },
      {
        type: 'input',
        name: 'bskyServiceUrl',
        message: 'Bluesky service URL:',
        default: 'https://bsky.social',
      },
    ]);

    let validation: Awaited<ReturnType<typeof validateBlueskyCredentials>>;
    try {
      validation = await validateBlueskyCredentials({
        bskyIdentifier: bskyAnswers.bskyIdentifier,
        bskyPassword: bskyAnswers.bskyPassword,
        bskyServiceUrl: bskyAnswers.bskyServiceUrl,
      });
      console.log(`Authenticated as @${validation.handle} on ${validation.serviceUrl}.`);
      if (validation.emailConfirmed) {
        console.log('Email status: confirmed ✅');
      } else {
        console.log('Email status: not confirmed yet ⚠️ (media upload features may be limited until verified).');
      }
      console.log(`Verify email from: ${validation.settingsUrl}`);
    } catch (error) {
      console.log(`Bluesky credential validation failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    const duplicate = findDuplicateActiveDestination(config.mappings, {
      bskyIdentifier: validation.handle,
      bskyCanonicalHandle: validation.handle,
      bskyDid: validation.did,
      bskyServiceUrl: validation.serviceUrl,
    });
    if (duplicate) {
      console.log(
        `Destination @${validation.handle} is already active as mapping ${duplicate.id}. Add sources there; legacy duplicates are not merged automatically.`,
      );
      return;
    }

    const continueAfterVerify = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'continueAfterVerify',
        message: 'Continue with mapping creation?',
        default: validation.emailConfirmed,
      },
    ]);

    if (!continueAfterVerify.continueAfterVerify) {
      console.log('Cancelled.');
      return;
    }

    if (usernames.length === 1) {
      try {
        const preview = await fetchTwitterMirrorProfile(usernames[0] || '');
        console.log(`Read-only Twitter profile preview from @${preview.username}:`);
        console.log(`  Display name -> ${preview.mirroredDisplayName}`);
        console.log(`  Bio preview  -> ${JSON.stringify(preview.mirroredDescription)}`);
      } catch (error) {
        console.log(`Twitter metadata preview failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const metadataAnswers = await inquirer.prompt([
      {
        type: 'input',
        name: 'owner',
        message: 'Owner name (optional):',
        default: ownerDefault,
      },
      {
        type: 'input',
        name: 'groupName',
        message: 'Group/folder name (optional):',
      },
      {
        type: 'input',
        name: 'groupEmoji',
        message: 'Group emoji icon (optional):',
      },
      {
        type: 'list',
        name: 'mirrorSourceUsername',
        message: 'Use which Twitter source for profile mirror metadata?',
        choices: [
          { name: 'None (keep profile and pin policies off)', value: '' },
          ...usernames.map((username) => ({
            name: `@${username}`,
            value: username,
          })),
        ],
        default: usernames.length === 1 ? usernames[0] : '',
      },
      {
        type: 'list',
        name: 'attributionMode',
        message: 'Prepend the X username to each mirrored post?',
        choices: [
          { name: 'Never (one-to-one mirror)', value: 'never' },
          { name: 'Only while this destination has multiple X sources (aggregate)', value: 'multiple-sources' },
          { name: 'Always', value: 'always' },
        ],
        default: usernames.length > 1 ? 'multiple-sources' : 'never',
      },
    ]);

    const postingPolicy = defaultPostingPolicy(usernames.length);
    postingPolicy.attribution.mode = metadataAnswers.attributionMode as AttributionMode;

    addMapping({
      owner: metadataAnswers.owner,
      twitterUsernames: usernames,
      pausedTwitterUsernames: [],
      bskyIdentifier: validation.handle,
      bskyPassword: bskyAnswers.bskyPassword,
      bskyServiceUrl: validation.serviceUrl,
      bskyDid: validation.did,
      bskyCanonicalHandle: validation.handle,
      groupName: metadataAnswers.groupName?.trim() || undefined,
      groupEmoji: metadataAnswers.groupEmoji?.trim() || undefined,
      postingPolicy,
      profileSyncSourceUsername: normalizeHandle(
        metadataAnswers.mirrorSourceUsername || (usernames.length === 1 ? usernames[0] || '' : ''),
      ),
    });

    console.log('Mapping added with profile and pin mutations disabled. Configure policy before applying changes.');
    console.log(describeAttributionState(postingPolicy.attribution.mode, usernames.length));
  });

program
  .command('sync-profile [mapping]')
  .description('Sync Bluesky profile from a mapped Twitter source')
  .option('-s, --source <username>', 'Twitter source username to mirror from')
  .action(async (mappingRef?: string, options?: { source?: string }) => {
    const mapping = await ensureMapping(mappingRef);
    if (!mapping) return;

    const availableSources = mapping.twitterUsernames.map(normalizeHandle).filter((username) => username.length > 0);
    const requestedSource = options?.source ? normalizeHandle(options.source) : '';
    if (requestedSource && !availableSources.includes(requestedSource)) {
      console.log(`@${requestedSource} is not part of the selected mapping.`);
      return;
    }

    let authorization: ReturnType<typeof assertProfileMutationAllowed>;
    try {
      authorization = assertProfileMutationAllowed(mapping, 'profile-apply', {
        requestedSource: requestedSource || undefined,
        requestedFields: mapping.profileManagement.profileSync.fields,
      });
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
      return;
    }
    const sourceTwitterUsername = authorization.sourceUsername;
    if (!sourceTwitterUsername) return;

    try {
      const result = await syncBlueskyProfileFromTwitter({
        twitterUsername: sourceTwitterUsername,
        bskyIdentifier: mapping.bskyIdentifier,
        bskyPassword: mapping.bskyPassword,
        bskyServiceUrl: mapping.bskyServiceUrl,
        authorization,
        syncDisplayName: authorization.fields?.displayName,
        syncDescription: authorization.fields?.description,
        syncAvatar: authorization.fields?.avatar,
        syncBanner: authorization.fields?.banner,
        previousSync: {
          sourceUsername: mapping.profileManagement.profileSync.sourceUsername,
          mirroredDisplayName: mapping.lastMirroredDisplayName,
          mirroredDescription: mapping.lastMirroredDescription,
          avatarUrl: mapping.lastMirroredAvatarUrl,
          bannerUrl: mapping.lastMirroredBannerUrl,
        },
      });

      const config = getConfig();
      const index = config.mappings.findIndex((entry) => entry.id === mapping.id);
      if (index !== -1) {
        const current = config.mappings[index];
        if (current) {
          config.mappings[index] = applyProfileMirrorSyncState(current, sourceTwitterUsername, result);
          saveConfig(config);
        }
      }

      console.log(`Profile sync completed for ${mapping.bskyIdentifier} from @${result.twitterProfile.username}.`);
      if (result.skipped) {
        console.log('No profile updates needed (Twitter profile is unchanged).');
      }
      if (result.warnings.length > 0) {
        console.log('Warnings:');
        for (const warning of result.warnings) {
          console.log(`  - ${warning}`);
        }
      }
    } catch (error) {
      console.log(`Profile sync failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

program
  .command('edit-mapping [mapping]')
  .description('Edit a mapping by id/handle/twitter username')
  .action(async (mappingRef?: string) => {
    const mapping = await ensureMapping(mappingRef);
    if (!mapping) return;

    const config = getConfig();
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'owner',
        message: 'Owner:',
        default: mapping.owner || '',
      },
      {
        type: 'input',
        name: 'twitterUsernames',
        message: 'X sources (read-only here; use sources-add/remove/pause/resume):',
        default: mapping.twitterUsernames.join(', '),
      },
      {
        type: 'input',
        name: 'bskyIdentifier',
        message: 'Bluesky destination identifier (read-only here):',
        default: mapping.bskyIdentifier,
      },
      {
        type: 'password',
        name: 'bskyPassword',
        message: 'Leave empty (use destination-credentials-update separately):',
      },
      {
        type: 'input',
        name: 'bskyServiceUrl',
        message: 'Bluesky service URL:',
        default: mapping.bskyServiceUrl || 'https://bsky.social',
      },
      {
        type: 'input',
        name: 'groupName',
        message: 'Group/folder name (optional):',
        default: mapping.groupName || '',
      },
      {
        type: 'input',
        name: 'groupEmoji',
        message: 'Group emoji icon (optional):',
        default: mapping.groupEmoji || '',
      },
    ]);

    const sourceParsing = parseTwitterUsernameInput(answers.twitterUsernames);
    const usernames = sourceParsing.added;

    if (usernames.length === 0 || sourceParsing.invalid.length > 0) {
      console.log(JSON.stringify(sourceParsing, null, 2));
      console.log('Please provide at least one valid X username.');
      return;
    }
    if (JSON.stringify(usernames) !== JSON.stringify(mapping.twitterUsernames)) {
      console.log('Use sources-add, sources-remove, sources-pause, or sources-resume for X source changes.');
      return;
    }
    if (
      normalizeHandle(answers.bskyIdentifier) !== normalizeHandle(mapping.bskyIdentifier) ||
      answers.bskyServiceUrl.trim().replace(/\/$/, '').toLowerCase() !==
        (mapping.bskyServiceUrl || 'https://bsky.social').replace(/\/$/, '').toLowerCase() ||
      answers.bskyPassword
    ) {
      console.log('Use destination-credentials-update so identity changes are validated and canonicalized.');
      return;
    }

    // Always ask, including for single-source mappings: silently re-populating a
    // profile source the operator cleared is how profile mutation creeps back in.
    const storedSource = normalizeHandle(mapping.profileManagement.profileSync.sourceUsername || '');
    const sourceAnswer = await inquirer.prompt([
      {
        type: 'list',
        name: 'profileSyncSourceUsername',
        message: 'Use which Twitter source for profile syncing?',
        choices: [
          { name: 'None (profile and pin syncing stay inert)', value: '' },
          ...usernames.map((username: string) => ({
            name: `@${username}`,
            value: username,
          })),
        ],
        default: usernames.includes(storedSource) ? storedSource : '',
      },
    ]);
    const profileSyncSourceUsername = normalizeHandle(String(sourceAnswer.profileSyncSourceUsername || ''));
    if (!profileSyncSourceUsername && mapping.profileManagement.profileSync.mode !== 'off') {
      console.log('Profile sync mode is not off, but no source is selected; no profile changes will be applied.');
    }

    const index = config.mappings.findIndex((entry) => entry.id === mapping.id);
    if (index === -1) return;

    const existingMapping = config.mappings[index];
    if (!existingMapping) return;

    const updatedMapping = {
      ...existingMapping,
      owner: answers.owner,
      twitterUsernames: existingMapping.twitterUsernames,
      bskyIdentifier: existingMapping.bskyIdentifier,
      bskyServiceUrl: existingMapping.bskyServiceUrl,
      groupName: answers.groupName?.trim() || undefined,
      groupEmoji: answers.groupEmoji?.trim() || undefined,
      profileSyncSourceUsername: profileSyncSourceUsername || undefined,
      profileManagement: {
        ...existingMapping.profileManagement,
        profileSync: {
          ...existingMapping.profileManagement.profileSync,
          sourceUsername: profileSyncSourceUsername || undefined,
        },
      },
    };

    config.mappings[index] = updatedMapping;
    saveConfig(config);
    console.log('Mapping updated successfully.');
  });

program
  .command('list')
  .description('List all Bluesky destinations')
  .action(() => {
    const config = getConfig();
    if (config.mappings.length === 0) {
      console.log('No mappings found.');
      return;
    }

    console.table(
      config.mappings.map((mapping) => ({
        id: mapping.id,
        owner: mapping.owner || 'System',
        twitter: mapping.twitterUsernames.join(', '),
        profileSyncSource: mapping.profileSyncSourceUsername || '--',
        bsky: mapping.bskyIdentifier,
        group: `${mapping.groupEmoji || '📁'} ${mapping.groupName || 'Ungrouped'}`,
        enabled: mapping.enabled,
      })),
    );
  });

program
  .command('sources-add <mapping> <sources...>')
  .description('Add one or more X sources without backfilling')
  .action(async (mappingRef: string, sources: string[]) => {
    const selected = await ensureMapping(mappingRef);
    if (!selected) return;
    const config = getConfig();
    const mapping = config.mappings.find((entry) => entry.id === selected.id);
    if (!mapping) return;
    const result = addDestinationSources(mapping, sources);
    if (result.added.length > 0) {
      saveConfig(config);
    }
    console.log(JSON.stringify({ ...result, automaticBackfill: false }, null, 2));
  });

program
  .command('sources-remove <mapping> <sources...>')
  .description('Remove one or more X sources with safe queue/history defaults')
  .option('--cancel-pending-queue', 'Delete pending queue items for these sources', false)
  .option('--delete-history', 'Delete processed history for these sources and destination', false)
  .action(
    async (
      mappingRef: string,
      sources: string[],
      options: { cancelPendingQueue: boolean; deleteHistory: boolean },
    ) => {
      const selected = await ensureMapping(mappingRef);
      if (!selected) return;
      const config = getConfig();
      const mapping = config.mappings.find((entry) => entry.id === selected.id);
      if (!mapping) return;
      const parsed = parseTwitterUsernameInput(sources);
      if (parsed.invalid.length > 0) {
        throw new Error(parsed.invalid.map((entry) => `${entry.input}: ${entry.reason}`).join('; '));
      }
      const updatedMapping: AccountMapping = {
        ...mapping,
        twitterUsernames: [...mapping.twitterUsernames],
        pausedTwitterUsernames: [...(mapping.pausedTwitterUsernames ?? [])],
      };
      const impact = parsed.added.map((username) => ({
        username,
        dependencies: getSourceDependencies(mapping, username),
        queue: postQueueService.getSourceCounts(mapping.id, username),
        historyCount: dbService.countTweetsBySourceForDestination(username, getDestinationStorageKey(mapping)),
      }));
      for (const username of parsed.added) {
        removeDestinationSource(updatedMapping, username);
      }
      let cancelledQueueItems = 0;
      let deletedHistoryItems = 0;
      for (const username of parsed.added) {
        if (options.cancelPendingQueue) {
          cancelledQueueItems += postQueueService.cancelPendingByMappingAndSource(mapping.id, username);
        }
        if (options.deleteHistory) {
          deletedHistoryItems += dbService.deleteTweetsBySourceForDestination(
            username,
            getDestinationStorageKey(mapping),
          );
        }
      }
      const index = config.mappings.findIndex((entry) => entry.id === mapping.id);
      config.mappings[index] = updatedMapping;
      saveConfig(config);
      console.log(
        JSON.stringify(
          {
            removed: parsed.added,
            impact,
            cancelledQueueItems,
            deletedHistoryItems,
            queuePreserved: !options.cancelPendingQueue,
            historyPreserved: !options.deleteHistory,
          },
          null,
          2,
        ),
      );
    },
  );

for (const [commandName, paused] of [
  ['sources-pause', true],
  ['sources-resume', false],
] as const) {
  program
    .command(`${commandName} <mapping> <sources...>`)
    .description(`${paused ? 'Pause' : 'Resume'} one or more X sources`)
    .option('--cancel-pending-queue', 'Cancel pending items while pausing (default preserves)', false)
    .action(async (mappingRef: string, sources: string[], options: { cancelPendingQueue: boolean }) => {
      const selected = await ensureMapping(mappingRef);
      if (!selected) return;
      const parsed = parseTwitterUsernameInput(sources);
      if (parsed.invalid.length > 0) {
        throw new Error(parsed.invalid.map((entry) => `${entry.input}: ${entry.reason}`).join('; '));
      }
      const config = getConfig();
      const mapping = config.mappings.find((entry) => entry.id === selected.id);
      if (!mapping) return;
      for (const source of parsed.added) {
        setDestinationSourcePaused(mapping, source, paused);
        if (paused && options.cancelPendingQueue) {
          const routeId = mapping.routeIdsByUsername?.[source];
          if (routeId) postQueueService.cancelPendingByRouteId(routeId);
          else postQueueService.cancelPendingByMappingAndSource(mapping.id, source);
        }
      }
      saveConfig(config);
      console.log(
        JSON.stringify(
          {
            updated: parsed.added,
            state: paused ? 'paused' : 'enabled',
            queuedItemsPreserved: !(paused && options.cancelPendingQueue),
          },
          null,
          2,
        ),
      );
    });
}

program
  .command('source-policy <mapping> <source>')
  .description('View or edit source filters, schedule, pause state, and runtime')
  .option('--filters-json <json>', 'Partial source filter policy as JSON')
  .option('--schedule-json <json>', 'Partial source schedule policy as JSON')
  .option('--state <state>', 'enabled or paused')
  .option('--cancel-pending-queue', 'Cancel pending items when pausing', false)
  .option('--preview-json <json>', 'Preview a decision using sample metadata JSON')
  .action(async (mappingRef: string, sourceRef: string, options) => {
    const selected = await ensureMapping(mappingRef);
    if (!selected) return;
    const config = getConfig();
    const mapping = config.mappings.find((entry) => entry.id === selected.id);
    const username = normalizeHandle(sourceRef);
    const source = config.sources.find((entry) => entry.username === username);
    const route = source
      ? config.routes.find((entry) => entry.sourceId === source.id && entry.destinationId === mapping?.id)
      : undefined;
    if (!mapping || !source || !route || !mapping.twitterUsernames.includes(username)) {
      throw new Error(`@${username} is not a source for this destination.`);
    }
    if (options.state !== undefined && options.state !== 'enabled' && options.state !== 'paused') {
      throw new Error('--state must be enabled or paused.');
    }
    if (options.filtersJson) {
      route.filters = normalizeSourceFilters({ ...route.filters, ...JSON.parse(options.filtersJson) });
    }
    if (options.scheduleJson) {
      source.schedule = normalizeSourceSchedule({ ...source.schedule, ...JSON.parse(options.scheduleJson) });
    }
    if (options.state) {
      setDestinationSourcePaused(mapping, username, options.state === 'paused');
      if (options.state === 'paused' && options.cancelPendingQueue) {
        const routeId = mapping.routeIdsByUsername?.[username];
        if (routeId) postQueueService.cancelPendingByRouteId(routeId);
        else postQueueService.cancelPendingByMappingAndSource(mapping.id, username);
      }
    }
    if (options.filtersJson || options.scheduleJson || options.state) {
      source.updatedAt = new Date().toISOString();
      saveConfig(config);
    }
    const preview = options.previewJson
      ? evaluateSourceFilter(route.filters, JSON.parse(options.previewJson), { sourceEnabled: source.enabled })
      : undefined;
    console.log(
      JSON.stringify(
        {
          username,
          state: mapping.pausedTwitterUsernames?.includes(username) ? 'paused' : 'enabled',
          filters: route.filters,
          schedule: source.schedule,
          runtime: runtimeStateService.getSource(source.id),
          queuedItemsPreserved: !(options.state === 'paused' && options.cancelPendingQueue),
          preview,
        },
        null,
        2,
      ),
    );
  });

for (const [commandName, enabled] of [
  ['destination-resume', true],
  ['destination-pause', false],
] as const) {
  program
    .command(`${commandName} <mapping>`)
    .description(`${enabled ? 'Resume' : 'Pause'} a Bluesky destination`)
    .action(async (mappingRef: string) => {
      const selected = await ensureMapping(mappingRef);
      if (!selected) return;
      const config = getConfig();
      const mapping = config.mappings.find((entry) => entry.id === selected.id);
      if (!mapping) return;
      if (enabled) {
        const duplicate = findDuplicateActiveDestination(config.mappings, mapping, mapping.id);
        if (duplicate) {
          throw new Error(`Cannot resume: destination conflicts with active mapping ${duplicate.id}.`);
        }
      }
      mapping.enabled = enabled;
      saveConfig(config);
      console.log(`Destination ${enabled ? 'enabled' : 'paused'}; queued items were preserved.`);
    });
}

program
  .command('destination-credentials-test <mapping>')
  .description('Read-only test of Bluesky destination credentials')
  .option('--identifier <identifier>', 'Candidate handle or email')
  .option('--password <password>', 'Candidate app password')
  .option('--service <url>', 'Candidate Bluesky service URL')
  .action(
    async (
      mappingRef: string,
      options: { identifier?: string; password?: string; service?: string },
    ) => {
      const mapping = await ensureMapping(mappingRef);
      if (!mapping) return;
      const validation = await validateBlueskyCredentials({
        bskyIdentifier: options.identifier || mapping.bskyIdentifier,
        bskyPassword: options.password || mapping.bskyPassword,
        bskyServiceUrl: options.service || mapping.bskyServiceUrl,
      });
      console.log(JSON.stringify({ ...validation, readOnly: true }, null, 2));
    },
  );

program
  .command('destination-credentials-update <mapping>')
  .description('Validate and update only Bluesky destination credentials')
  .option('--identifier <identifier>', 'Candidate handle or email')
  .option('--password <password>', 'Candidate app password')
  .option('--service <url>', 'Candidate Bluesky service URL')
  .action(
    async (
      mappingRef: string,
      options: { identifier?: string; password?: string; service?: string },
    ) => {
      const selected = await ensureMapping(mappingRef);
      if (!selected) return;
      const config = getConfig();
      const mapping = config.mappings.find((entry) => entry.id === selected.id);
      if (!mapping) return;
      const password = options.password || mapping.bskyPassword;
      const validation = await validateBlueskyCredentials({
        bskyIdentifier: options.identifier || mapping.bskyIdentifier,
        bskyPassword: password,
        bskyServiceUrl: options.service || mapping.bskyServiceUrl,
      });
      const candidate = applyValidatedDestinationIdentity({ ...mapping, bskyPassword: password }, validation);
      const duplicate = findDuplicateActiveDestination(config.mappings, candidate, mapping.id);
      if (duplicate) {
        throw new Error(
          `Destination conflicts with active mapping ${duplicate.id}. Add sources there or resolve ownership and credentials explicitly.`,
        );
      }
      const index = config.mappings.findIndex((entry) => entry.id === mapping.id);
      const previousStorageKey = getDestinationStorageKey(mapping);
      const nextStorageKey = getDestinationStorageKey(candidate);
      clearCachedAgent(mapping);
      clearCachedAgent(candidate);
      config.mappings[index] = candidate;
      saveConfig(config);
      const rekeyed = dbService.rekeyDestinationIdentity(previousStorageKey, nextStorageKey);
      console.log(
        JSON.stringify(
          {
            updated: true,
            did: validation.did,
            handle: validation.handle,
            serviceUrl: validation.serviceUrl,
            profileChanged: false,
            policiesChanged: false,
            sourcesChanged: false,
            rekeyed,
          },
          null,
          2,
        ),
      );
    },
  );

program
  .command('remove [mapping]')
  .description('Remove a mapping by id/handle/twitter username')
  .action(async (mappingRef?: string) => {
    const mapping = await ensureMapping(mappingRef);
    if (!mapping) return;

    const { confirmed } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirmed',
        message: `Remove mapping ${mapping.twitterUsernames.join(', ')} -> ${mapping.bskyIdentifier}?`,
        default: false,
      },
    ]);

    if (!confirmed) {
      console.log('Cancelled.');
      return;
    }

    removeMapping(mapping.id);
    console.log('Mapping removed.');
  });

program
  .command('import-history [mapping]')
  .description('Import history immediately for one mapping')
  .option('-l, --limit <number>', 'Tweet limit', '15')
  .option('--dry-run', 'Do not post to Bluesky', false)
  .option('--web', 'Keep web server enabled during import', false)
  .action(async (mappingRef: string | undefined, options) => {
    const mapping = await ensureMapping(mappingRef);
    if (!mapping) return;

    let username = mapping.twitterUsernames[0] ?? '';
    if (!username) {
      console.log('Mapping has no Twitter usernames.');
      return;
    }

    if (mapping.twitterUsernames.length > 1) {
      const answer = await inquirer.prompt([
        {
          type: 'list',
          name: 'username',
          message: 'Select Twitter username to import:',
          choices: mapping.twitterUsernames,
          default: username,
        },
      ]);
      username = String(answer.username || '').trim();
    }

    const args: string[] = [
      '--import-history',
      '--username',
      username,
      '--limit',
      String(parsePositiveInt(options.limit, 15)),
    ];
    if (options.dryRun) args.push('--dry-run');
    if (!options.web) args.push('--no-web');

    await runCoreCommand(args);
  });

program
  .command('set-interval <minutes>')
  .description('Set scheduler interval in minutes')
  .action((minutes) => {
    const parsed = parseSchedulerIntervalMinutes(Number(minutes));
    const config = getConfig();
    config.scheduler.intervalMinutes = parsed;
    saveConfig(config);
    console.log(`Interval set to ${parsed} minutes.`);
    console.log(describeSchedulerApplication(config.scheduler.enabled));
  });

program
  .command('scheduler-get')
  .description('Show scheduler configuration')
  .action(() => {
    const { enabled, intervalMinutes, runOnStartup } = getConfig().scheduler;
    console.log(JSON.stringify({ enabled, intervalMinutes, runOnStartup }, null, 2));
  });

program
  .command('scheduler-set')
  .description('Update scheduler configuration')
  .option('--interval <minutes>', 'Whole minutes from 1 to 1440')
  .option('--run-on-startup <value>', 'true or false')
  .option('--enabled <value>', 'true or false')
  .action((options: { interval?: string; runOnStartup?: string; enabled?: string }) => {
    const parseBoolean = (value: string | undefined, current: boolean): boolean => {
      if (value === undefined) return current;
      if (value === 'true') return true;
      if (value === 'false') return false;
      throw new Error('Boolean options must be true or false.');
    };
    const config = getConfig();
    config.scheduler = {
      enabled: parseBoolean(options.enabled, config.scheduler.enabled),
      intervalMinutes:
        options.interval === undefined
          ? config.scheduler.intervalMinutes
          : parseSchedulerIntervalMinutes(Number(options.interval)),
      runOnStartup: parseBoolean(options.runOnStartup, config.scheduler.runOnStartup),
    };
    saveConfig(config);
    console.log(JSON.stringify(config.scheduler, null, 2));
    console.log(describeSchedulerApplication(config.scheduler.enabled));
  });

for (const [commandName, enabled] of [
  ['scheduler-enable', true],
  ['scheduler-disable', false],
] as const) {
  program
    .command(commandName)
    .description(`${enabled ? 'Enable' : 'Disable'} automatic scheduler checks`)
    .action(() => {
      const config = getConfig();
      config.scheduler.enabled = enabled;
      saveConfig(config);
      console.log(`Automatic scheduler checks ${enabled ? 'enabled' : 'disabled'}.`);
      console.log(describeSchedulerApplication(enabled));
    });
}

program
  .command('attribution-policy [mapping]')
  .description('Show or update destination attribution policy')
  .option('--mode <mode>', 'never, multiple-sources, or always')
  .option('--template <template>', 'Attribution template')
  .option('--root-posts-only <value>', 'true or false')
  .option('--link-source <value>', 'true or false')
  .option('--append-original-link <value>', 'true or false')
  .option('--preview <text>', 'Preview transformed text')
  .action(async (mappingRef: string | undefined, options) => {
    const mapping = await ensureMapping(mappingRef);
    if (!mapping) return;
    const parseBoolean = (value: string | undefined, current: boolean): boolean => {
      if (value === undefined) return current;
      if (value === 'true') return true;
      if (value === 'false') return false;
      throw new Error('Boolean options must be true or false.');
    };
    const mode = options.mode ?? mapping.postingPolicy.attribution.mode;
    if (mode !== 'never' && mode !== 'multiple-sources' && mode !== 'always') {
      throw new Error('Attribution mode must be never, multiple-sources, or always.');
    }
    if (options.template !== undefined) validateAttributionTemplate(options.template);
    mapping.postingPolicy = {
      attribution: {
        mode,
        template: options.template ?? mapping.postingPolicy.attribution.template,
        rootPostsOnly: parseBoolean(options.rootPostsOnly, mapping.postingPolicy.attribution.rootPostsOnly),
        linkSource: parseBoolean(options.linkSource, mapping.postingPolicy.attribution.linkSource),
      },
      appendOriginalPostLink: parseBoolean(
        options.appendOriginalLink,
        mapping.postingPolicy.appendOriginalPostLink,
      ),
    };
    if (
      options.mode !== undefined ||
      options.template !== undefined ||
      options.rootPostsOnly !== undefined ||
      options.linkSource !== undefined ||
      options.appendOriginalLink !== undefined
    ) {
      const config = getConfig();
      const index = config.mappings.findIndex((entry) => entry.id === mapping.id);
      if (index !== -1) config.mappings[index] = mapping;
      saveConfig(config);
    }
    if (options.preview) {
      const username = mapping.twitterUsernames[0] || 'source';
      const preview = applyPostingPolicy(options.preview, mapping.postingPolicy, {
        twitterUsername: username,
        tweetId: '123',
        originalPostUrl: `https://x.com/${username}/status/123`,
        destinationIdentifier: mapping.bskyIdentifier,
        sourceCount: mapping.twitterUsernames.length,
        isReply: false,
        isThreadRoot: true,
      });
      console.log(preview.text);
    } else {
      console.log(JSON.stringify(mapping.postingPolicy, null, 2));
      console.log(
        describeAttributionState(mapping.postingPolicy.attribution.mode, mapping.twitterUsernames.length),
      );
    }
  });

program
  .command('profile-policy [mapping]')
  .description('Show or update profile policy and read-only source preview')
  .option('--preview', 'Fetch a read-only Twitter profile preview')
  .option('--source <username>', 'Explicit mapped source')
  .option('--allow-mutation <value>', 'true or false')
  .option('--profile-mode <mode>', 'off, manual, or scheduled')
  .option('--profile-source <username>', 'Mapped profile source, or none')
  .option('--profile-fields <fields>', 'Comma-separated displayName,description,avatar,banner')
  .option('--profile-interval <hours>', 'Whole hours from 1 to 8760')
  .option('--pin-mode <mode>', 'off, manual, or scheduled')
  .option('--pin-source <username>', 'Mapped pin source, or none')
  .option('--pin-interval <hours>', 'Whole hours from 1 to 8760')
  .option('--bot-label <value>', 'true or false')
  .option('--display-suffix <value>', 'true or false')
  .action(async (mappingRef: string | undefined, options) => {
    const mapping = await ensureMapping(mappingRef);
    if (!mapping) return;
    const parseBoolean = (value: string | undefined, current: boolean): boolean => {
      if (value === undefined) return current;
      if (value === 'true') return true;
      if (value === 'false') return false;
      throw new Error('Boolean options must be true or false.');
    };
    const parseMode = (value: string | undefined, current: 'off' | 'manual' | 'scheduled') => {
      if (value === undefined) return current;
      if (value === 'off' || value === 'manual' || value === 'scheduled') return value;
      throw new Error('Sync modes must be off, manual, or scheduled.');
    };
    const parseHours = (value: string | undefined, current: number) => {
      if (value === undefined) return current;
      const hours = Number(value);
      if (!Number.isInteger(hours) || hours < 1 || hours > 8760) {
        throw new Error('Intervals must be whole hours between 1 and 8760.');
      }
      return hours;
    };
    const parseSource = (value: string | undefined, current?: string) => {
      if (value === undefined) return current;
      if (value === 'none' || value === '') return undefined;
      const source = normalizeHandle(value);
      if (!mapping.twitterUsernames.includes(source)) {
        throw new Error(`@${source} is not part of this mapping.`);
      }
      return source;
    };
    const profileFields = { ...mapping.profileManagement.profileSync.fields };
    if (options.profileFields !== undefined) {
      const selected = new Set(String(options.profileFields).split(',').map((field) => field.trim()));
      const unknown = [...selected].filter(
        (field) => !['displayName', 'description', 'avatar', 'banner'].includes(field),
      );
      if (unknown.length > 0) throw new Error(`Unknown profile field(s): ${unknown.join(', ')}`);
      profileFields.displayName = selected.has('displayName');
      profileFields.description = selected.has('description');
      profileFields.avatar = selected.has('avatar');
      profileFields.banner = selected.has('banner');
    }
    const updatedPolicy = {
      allowProfileMutation: parseBoolean(
        options.allowMutation,
        mapping.profileManagement.allowProfileMutation,
      ),
      ensureBotLabel: parseBoolean(options.botLabel, mapping.profileManagement.ensureBotLabel),
      ensureDisplayNameBotSuffix: parseBoolean(
        options.displaySuffix,
        mapping.profileManagement.ensureDisplayNameBotSuffix,
      ),
      profileSync: {
        mode: parseMode(options.profileMode, mapping.profileManagement.profileSync.mode),
        sourceUsername: parseSource(
          options.profileSource,
          mapping.profileManagement.profileSync.sourceUsername,
        ),
        intervalHours: parseHours(
          options.profileInterval,
          mapping.profileManagement.profileSync.intervalHours,
        ),
        fields: profileFields,
      },
      pinSync: {
        mode: parseMode(options.pinMode, mapping.profileManagement.pinSync.mode),
        sourceUsername: parseSource(options.pinSource, mapping.profileManagement.pinSync.sourceUsername),
        intervalHours: parseHours(options.pinInterval, mapping.profileManagement.pinSync.intervalHours),
      },
    };
    const changed = [
      options.allowMutation,
      options.profileMode,
      options.profileSource,
      options.profileFields,
      options.profileInterval,
      options.pinMode,
      options.pinSource,
      options.pinInterval,
      options.botLabel,
      options.displaySuffix,
    ].some((value) => value !== undefined);
    if (changed) {
      const config = getConfig();
      const index = config.mappings.findIndex((entry) => entry.id === mapping.id);
      const current = config.mappings[index];
      if (current) {
        current.profileManagement = updatedPolicy;
        current.profileSyncSourceUsername = updatedPolicy.profileSync.sourceUsername;
        saveConfig(config);
        mapping.profileManagement = updatedPolicy;
      }
    }
    console.log(JSON.stringify(mapping.profileManagement, null, 2));
    if (!options.preview) return;
    const decision = evaluateProfileMutation(mapping, 'profile-preview', { requestedSource: options.source });
    if (!decision.allowed || !decision.sourceUsername) {
      throw new Error(decision.reason || 'A valid profile source is required.');
    }
    const profile = await fetchTwitterMirrorProfile(decision.sourceUsername);
    console.log(
      JSON.stringify(
        {
          readOnly: true,
          sourceUsername: decision.sourceUsername,
          proposed: {
            displayName: profile.mirroredDisplayName,
            description: profile.mirroredDescription,
            avatarUrl: profile.avatarUrl,
            bannerUrl: profile.bannerUrl,
          },
        },
        null,
        2,
      ),
    );
  });

program
  .command('run-now')
  .description('Run one sync cycle now (ideal for cronjobs)')
  .option('--dry-run', 'Fetch but do not post', false)
  .option('--web', 'Keep web server enabled during this run', false)
  .action(async (options) => {
    const args = ['--run-once'];
    if (options.dryRun) args.push('--dry-run');
    if (!options.web) args.push('--no-web');
    await runCoreCommand(args);
  });

program
  .command('backfill [mapping]')
  .description('Run backfill now for one mapping (id/handle/twitter username)')
  .option('-l, --limit <number>', 'Tweet limit', '15')
  .option('--dry-run', 'Fetch but do not post', false)
  .option('--web', 'Keep web server enabled during this run', false)
  .action(async (mappingRef: string | undefined, options) => {
    const mapping = await ensureMapping(mappingRef);
    if (!mapping) return;

    const args = [
      '--run-once',
      '--backfill-mapping',
      mapping.id,
      '--backfill-limit',
      String(parsePositiveInt(options.limit, 15)),
    ];
    if (options.dryRun) args.push('--dry-run');
    if (!options.web) args.push('--no-web');

    await runCoreCommand(args);
  });

program
  .command('clear-cache [mapping]')
  .description('Clear cached tweet history for a mapping')
  .action(async (mappingRef?: string) => {
    const mapping = await ensureMapping(mappingRef);
    if (!mapping) return;

    for (const username of mapping.twitterUsernames) {
      dbService.deleteTweetsByUsername(username);
    }

    console.log(`Cache cleared for ${mapping.twitterUsernames.join(', ')}.`);
  });

program
  .command('delete-all-posts [mapping]')
  .description('Delete all posts on mapped Bluesky account and clear local cache')
  .action(async (mappingRef?: string) => {
    const mapping = await ensureMapping(mappingRef);
    if (!mapping) return;

    const { confirmed } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirmed',
        message: `Delete ALL posts for ${mapping.bskyIdentifier}? This cannot be undone.`,
        default: false,
      },
    ]);

    if (!confirmed) {
      console.log('Cancelled.');
      return;
    }

    const { typed } = await inquirer.prompt([
      {
        type: 'input',
        name: 'typed',
        message: 'Type DELETE to confirm:',
      },
    ]);

    if (typed !== 'DELETE') {
      console.log('Confirmation failed. Aborting.');
      return;
    }

    const deleted = await deleteAllPosts(mapping.id);
    dbService.deleteTweetsByBskyIdentifier(getDestinationStorageKey(mapping));
    console.log(`Deleted ${deleted} posts for ${mapping.bskyIdentifier} and cleared local cache.`);
  });

program
  .command('recent-activity')
  .description('Show recent processed tweets')
  .option('-l, --limit <number>', 'Number of rows', '20')
  .action((options) => {
    const limit = parsePositiveInt(options.limit, 20);
    const rows = dbService.getRecentProcessedTweets(limit);

    if (rows.length === 0) {
      console.log('No recent activity found.');
      return;
    }

    console.table(
      rows.map((row) => ({
        time: row.created_at,
        twitter: row.twitter_username,
        bsky: row.bsky_identifier,
        status: row.status,
        text: row.tweet_text ? row.tweet_text.slice(0, 80) : row.twitter_id,
      })),
    );
  });

program
  .command('config-migration-report [file]')
  .description('Dry-run a config v3 migration without writing files or exposing secrets')
  .action((file?: string) => {
    const raw = file
      ? JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'))
      : undefined;
    console.log(JSON.stringify(getConfigMigrationReport(raw), null, 2));
  });

program
  .command('encryption-status')
  .description('Show configuration encryption status without printing secrets')
  .action(() => {
    console.log(JSON.stringify({ ...getEncryptionStatus(), configFile: ACTIVE_CONFIG_FILE }, null, 2));
  });

program
  .command('encryption-migrate')
  .description('Encrypt plaintext configuration secrets and verify before replacement')
  .option('--new-key-env <name>', 'Environment variable containing the new key', 'CONFIG_ENCRYPTION_KEY')
  .option('--old-key-env <name>', 'Environment variable containing the current key')
  .option('--confirm <text>', 'Must be ENCRYPT_CONFIG')
  .action((options: { newKeyEnv: string; oldKeyEnv?: string; confirm?: string }) => {
    if (options.confirm !== 'ENCRYPT_CONFIG') {
      throw new Error('Use --confirm ENCRYPT_CONFIG after backing up the encryption key.');
    }
    const newKey = process.env[options.newKeyEnv];
    const oldKey = options.oldKeyEnv ? process.env[options.oldKeyEnv] : undefined;
    if (!newKey) throw new Error(`Environment variable ${options.newKeyEnv} is not set.`);
    const result = rotateEncryptionKey({ newRawKey: newKey, oldRawKey: oldKey });
    console.log(JSON.stringify({ migrated: true, ...result }, null, 2));
  });

program
  .command('encryption-rotate')
  .description('Rotate the config encryption key with backup and verification')
  .requiredOption('--old-key-env <name>', 'Environment variable containing the old key')
  .requiredOption('--new-key-env <name>', 'Environment variable containing the new key')
  .option('--confirm <text>', 'Must be ROTATE_CONFIG_KEY')
  .action((options: { oldKeyEnv: string; newKeyEnv: string; confirm?: string }) => {
    if (options.confirm !== 'ROTATE_CONFIG_KEY') {
      throw new Error('Use --confirm ROTATE_CONFIG_KEY after securely recording the new key.');
    }
    const oldKey = process.env[options.oldKeyEnv];
    const newKey = process.env[options.newKeyEnv];
    if (!oldKey || !newKey) throw new Error('Both old and new key environment variables must be set.');
    const result = rotateEncryptionKey({ newRawKey: newKey, oldRawKey: oldKey });
    console.log(JSON.stringify({ rotated: true, ...result }, null, 2));
  });

program
  .command('backup [file]')
  .description('Create a WAL-consistent config and SQLite backup bundle')
  .option('--mode <mode>', 'redacted or full', 'redacted')
  .option('--confirm-full-backup', 'Acknowledge that a full backup contains credentials', false)
  .action((file: string | undefined, command: Command) => {
    const options = command.opts<{ mode: string; confirmFullBackup: boolean }>();
    if (options.mode !== 'redacted' && options.mode !== 'full') {
      throw new Error('Backup mode must be redacted or full.');
    }
    if (options.mode === 'full' && !options.confirmFullBackup) {
      throw new Error('Full backups contain credentials. Re-run with --confirm-full-backup.');
    }
    const output = path.resolve(file ?? `tweets-2-bsky-${options.mode}-${Date.now()}.t2b-backup`);
    fs.writeFileSync(output, createBackupBundle(options.mode), { mode: 0o600 });
    console.log(
      JSON.stringify(
        {
          created: output,
          mode: options.mode,
          warning: options.mode === 'full' ? 'Contains credentials; protect the file and encryption key.' : undefined,
          storage: getBackupStorageStatus(),
        },
        null,
        2,
      ),
    );
  });

program
  .command('restore <file>')
  .description('Validate a backup; apply only with typed confirmation')
  .option('--apply', 'Stage the validated restore', false)
  .option('--confirm <text>', 'Must be RESTORE when applying')
  .action(async (file: string, command: Command) => {
    const options = command.opts<{ apply: boolean; confirm?: string }>();
    const input = fs.readFileSync(path.resolve(file));
    if (!options.apply) {
      console.log(JSON.stringify({ dryRun: true, ...validateBackupBundle(input).report }, null, 2));
      return;
    }
    if (options.confirm !== 'RESTORE') throw new Error('Restore apply requires --confirm RESTORE.');
    await requireCliAdminReauthentication();
    console.log(
      JSON.stringify(
        {
          applied: true,
          ...applyRestoreBundle(input, { confirmation: options.confirm }),
          restartRequired: true,
        },
        null,
        2,
      ),
    );
  });

program
  .command('config-export [file]')
  .description('Export dashboard config (redacted by default)')
  .option('--mode <mode>', 'Export mode: redacted or full', 'redacted')
  .option('--confirm-full-export', 'Confirm that a full export will contain credentials', false)
  .action((file: string | undefined, command: Command) => {
    const options = command.opts<{ mode: string; confirmFullExport: boolean }>();
    if (options.mode !== 'redacted' && options.mode !== 'full') {
      throw new Error('Export mode must be redacted or full.');
    }
    exportConfig(file ?? 'tweets-2-bsky-config.json', options.mode, options.confirmFullExport);
  });

program
  .command('config-import <file>')
  .description('Import dashboard config (preserves existing users)')
  .action((file) => {
    importConfig(file);
  });

const queueScopeFromOptions = (options: {
  destination?: string;
  route?: string;
  source?: string;
  request?: string;
}) => {
  const supplied = [
    options.destination ? { destinationId: options.destination } : null,
    options.route ? { routeId: options.route } : null,
    options.source ? { sourceId: options.source } : null,
    options.request ? { requestId: options.request } : null,
  ].filter(Boolean);
  if (supplied.length !== 1) {
    throw new Error('Specify exactly one of --destination, --route, --source, or --request.');
  }
  return supplied[0] ?? {};
};

program
  .command('queue-list')
  .description('Inspect the durable queue with redacted diagnostics')
  .option('--destination <id>')
  .option('--route <id>')
  .option('--source <id>')
  .option('--request <id>')
  .action((options) => {
    const hasScope = options.destination || options.route || options.source || options.request;
    console.log(JSON.stringify(postQueueService.inspect(hasScope ? queueScopeFromOptions(options) : {}), null, 2));
  });

program
  .command('queue-item <destination-key> <tweet-id>')
  .description('Inspect, retry, or cancel one queue item')
  .option('--action <action>', 'inspect, retry, or cancel', 'inspect')
  .action((destinationKey: string, tweetId: string, options: { action: string }) => {
    const scope = { bskyIdentifier: destinationKey, twitterId: tweetId };
    const item = postQueueService.inspect(scope)[0];
    if (!item) throw new Error('Queue item not found.');
    if (options.action === 'inspect') {
      console.log(JSON.stringify(item, null, 2));
      return;
    }
    if (options.action === 'retry') {
      if (item.status !== 'failed') throw new Error('Only failed items can be retried.');
      console.log(JSON.stringify({ affected: postQueueService.retryFailed(scope) }, null, 2));
      return;
    }
    if (options.action === 'cancel') {
      if (item.status === 'processing') {
        throw new Error('Active items cannot be deleted without coordinated worker cancellation.');
      }
      if (item.status !== 'pending') throw new Error('Only pending items can be cancelled.');
      console.log(JSON.stringify({ affected: postQueueService.cancelPending(scope) }, null, 2));
      return;
    }
    throw new Error('--action must be inspect, retry, or cancel.');
  });

program
  .command('queue-scope <action>')
  .description('Operate on a destination, route, source, or request queue scope')
  .option('--destination <id>')
  .option('--route <id>')
  .option('--source <id>')
  .option('--request <id>')
  .option('--confirm-clear-pending', 'Required for bulk pending cancellation', false)
  .action((action: string, options) => {
    const scope = queueScopeFromOptions(options);
    if (action === 'retry-failed') {
      console.log(JSON.stringify({ affected: postQueueService.retryFailed(scope) }, null, 2));
      return;
    }
    if (action === 'clear-failed') {
      console.log(JSON.stringify({ affected: postQueueService.clearFailed(scope) }, null, 2));
      return;
    }
    if (action === 'cancel-pending') {
      if (!options.confirmClearPending) throw new Error('Use --confirm-clear-pending for bulk cancellation.');
      console.log(JSON.stringify({ affected: postQueueService.cancelPending(scope) }, null, 2));
      return;
    }
    throw new Error('Action must be retry-failed, clear-failed, or cancel-pending.');
  });

program
  .command('notifications')
  .description('Show or configure generic webhook notifications')
  .option('--url <https-url>', 'Set a new webhook URL')
  .option('--secret <secret>', 'Set a new HMAC secret')
  .option('--enabled <value>', 'true or false')
  .option('--allow-private', 'Allow private-network targets (admin-only equivalent)', false)
  .option('--events <events>', 'Comma-separated event names')
  .action(async (options) => {
    const config = getConfig();
    const current = config.notifications;
    const changed =
      options.url !== undefined ||
      options.secret !== undefined ||
      options.enabled !== undefined ||
      options.allowPrivate ||
      options.events !== undefined;
    if (changed) {
      const enabled =
        options.enabled === undefined
          ? current.enabled
          : options.enabled === 'true'
            ? true
            : options.enabled === 'false'
              ? false
              : (() => {
                  throw new Error('--enabled must be true or false.');
                })();
      const webhookUrl = options.url ?? current.webhookUrl;
      if (webhookUrl) await validateWebhookTarget(webhookUrl, Boolean(options.allowPrivate));
      const selected = options.events
        ? new Set(String(options.events).split(',').map((event) => event.trim()))
        : new Set(Object.entries(current.events).filter(([, value]) => value).map(([event]) => event));
      config.notifications = {
        ...current,
        enabled,
        ...(webhookUrl ? { webhookUrl } : {}),
        ...(options.secret ? { webhookSecret: options.secret } : {}),
        allowPrivate: Boolean(options.allowPrivate),
        events: {
          'twitter-auth-failure': selected.has('twitter-auth-failure'),
          'bsky-auth-failure': selected.has('bsky-auth-failure'),
          'queue-parked': selected.has('queue-parked'),
          'queue-age': selected.has('queue-age'),
          'update-failure': selected.has('update-failure'),
        },
      };
      saveConfig(config);
    }
    console.log(
      JSON.stringify(
        {
          enabled: config.notifications.enabled,
          webhookConfigured: Boolean(config.notifications.webhookUrl),
          secretConfigured: Boolean(config.notifications.webhookSecret),
          allowPrivate: config.notifications.allowPrivate,
          events: config.notifications.events,
        },
        null,
        2,
      ),
    );
  });

program
  .command('ingestion-credentials-list')
  .description('List redacted inbound ingestion credentials')
  .action(() => console.table(ingestionCredentialService.list()));

program
  .command('ingestion-credential-create <sourceId> <name>')
  .description('Create a scoped inbound credential and show its secret once')
  .option('--scopes <scopes>', 'Comma-separated posts:write/posts:preview scopes', 'posts:write')
  .option('--hmac', 'Also create an encrypted HMAC signing secret', false)
  .action(async (sourceId: string, name: string, options: { scopes: string; hmac: boolean }) => {
    await requireCliAdminReauthentication();
    const config = getConfig();
    const source = config.sources.find((candidate) => candidate.id === sourceId && candidate.type !== 'x');
    if (!source) throw new Error('Webhook/API source not found.');
    const actor = config.users.find((user) => user.role === 'admin');
    if (!actor) throw new Error('Administrator not found.');
    const created = ingestionCredentialService.create({
      name,
      sourceId,
      scopes: parseIngestionScopes(options.scopes.split(',').map((scope) => scope.trim())),
      createdBy: actor.id,
      includeHmac: options.hmac,
    });
    console.log(JSON.stringify({ ...created, warning: 'Copy these secrets now; they cannot be retrieved.' }, null, 2));
  });

program
  .command('ingestion-credential-revoke <id>')
  .description('Revoke an inbound ingestion credential with typed confirmation')
  .action(async (id: string) => {
    await requireCliAdminReauthentication();
    const answer = await inquirer.prompt([
      { type: 'input', name: 'confirmation', message: `Type REVOKE ${id} to continue:` },
    ]);
    if (answer.confirmation !== `REVOKE ${id}`) throw new Error('Confirmation did not match.');
    console.log(JSON.stringify({ revoked: ingestionCredentialService.revoke(id) }, null, 2));
  });

program
  .command('ingestion-audit')
  .description('List sanitized inbound ingestion audit records')
  .option('--limit <count>', 'Maximum records', '100')
  .action((options: { limit: string }) =>
    console.table(ingestionAuditService.list(parsePositiveInt(options.limit, 100))),
  );

program
  .command('digest-list')
  .description('List digest jobs and pending entries')
  .action(() =>
    console.log(
      JSON.stringify(
        { jobs: digestJobService.list(), entries: digestEntryService.list({ limit: 500 }) },
        null,
        2,
      ),
    ),
  );

program
  .command('digest-preview <routeId>')
  .description('Preview a digest without publishing')
  .action((routeId: string) => {
    const route = getConfig().routes.find((candidate) => candidate.id === routeId);
    if (!route?.delivery || route.delivery.mode !== 'digest') throw new Error('Digest route not found.');
    console.log(
      JSON.stringify(
        buildDigestPreview(
          digestEntryService.list({ routeId, status: 'pending', limit: route.delivery.digest.maxEntries }),
          route.delivery.digest,
        ),
        null,
        2,
      ),
    );
  });

program
  .command('digest-publish <routeId>')
  .description('Make a digest job immediately eligible for the destination worker')
  .action(async (routeId: string) => {
    await requireCliAdminReauthentication();
    const config = getConfig();
    const route = config.routes.find((candidate) => candidate.id === routeId);
    if (!route?.delivery || route.delivery.mode !== 'digest') throw new Error('Digest route not found.');
    console.log(JSON.stringify(digestJobService.arm(route.destinationId, route.id, Date.now()), null, 2));
  });

program
  .command('source-create <type> <name>')
  .description('Create a canonical x, webhook, or api source without credentials')
  .action((type: string, name: string) => {
    if (!['x', 'webhook', 'api'].includes(type)) throw new Error('Type must be x, webhook, or api.');
    const config = getConfig();
    const username = normalizeHandle(name).replace(/[^a-z0-9._-]+/g, '-');
    config.sources.push({
      id: `source_${randomUUID()}`,
      type: type as 'x' | 'webhook' | 'api',
      username,
      name,
      enabled: true,
      filters: normalizeSourceFilters({}),
      schedule: normalizeSourceSchedule({}),
      state: { consecutiveFailures: 0 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    saveCanonicalConfig(config);
    console.log(`Created ${type} source ${username}. Add routes in the dashboard or API.`);
  });

program
  .command('status')
  .description('Show local CLI status summary')
  .action(() => {
    const config = getConfig();
    const recent = dbService.getRecentProcessedTweets(5);

    console.log('Tweets-2-Bsky status');
    console.log('--------------------');
    console.log(`Mappings: ${config.mappings.length}`);
    console.log(`Enabled mappings: ${config.mappings.filter((mapping) => mapping.enabled).length}`);
    console.log(`Check interval: ${getSchedulerIntervalMinutes(config)} minute(s)`);
    console.log(`Twitter configured: ${Boolean(config.twitter.authToken && config.twitter.ct0)}`);
    console.log(`AI provider: ${config.ai?.provider || 'gemini (default)'}`);
    console.log(`Recent processed tweets: ${recent.length > 0 ? recent.length : 0}`);

    const queue = postQueueService.getCounts();
    console.log(`Post queue: ${queue.pending} pending, ${queue.processing} posting, ${queue.failed} failed`);

    if (recent.length > 0) {
      const last = recent[0];
      console.log(`Latest activity: ${last?.created_at || 'unknown'} (${last?.status || 'unknown'})`);
    }
  });

program.parseAsync().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
