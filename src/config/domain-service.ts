import { normalizeTwitterUsername } from '../mapping-helpers.js';
import {
  applyMappingProjection,
  findDestinationByLegacyId,
  findRouteForMappingSource,
  projectAccountMappings,
} from './projection.js';
import type { AccountMapping, AppConfig, Destination, Route, Source } from './schemas.js';

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export interface RouteContext {
  source: Source;
  destination: Destination;
  route: Route;
  mapping: AccountMapping;
  destinationStorageKey: string;
}

export class ConfigDomainService {
  constructor(
    private config: AppConfig,
    private readonly clock: Clock = systemClock,
  ) {}

  getConfig(): AppConfig {
    return this.config;
  }

  listMappings(): AccountMapping[] {
    return projectAccountMappings(this.config);
  }

  findDestination(id: string): Destination | undefined {
    return findDestinationByLegacyId(this.config, id);
  }

  findMapping(id: string): AccountMapping | undefined {
    const destination = this.findDestination(id);
    return destination ? this.listMappings().find((mapping) => mapping.id === destination.id) : undefined;
  }

  resolveRoute(mappingOrDestinationId: string, username: string): RouteContext | undefined {
    const destination = this.findDestination(mappingOrDestinationId);
    const normalized = normalizeTwitterUsername(username);
    if (!destination || !normalized) {
      return undefined;
    }
    const route = findRouteForMappingSource(this.config, destination.id, normalized);
    const source = route ? this.config.sources.find((candidate) => candidate.id === route.sourceId) : undefined;
    const mapping = this.listMappings().find((candidate) => candidate.id === destination.id);
    return route && source && mapping
      ? {
          source,
          destination,
          route,
          mapping,
          destinationStorageKey: destination.storageKey,
        }
      : undefined;
  }

  replaceMapping(mapping: AccountMapping): AppConfig {
    const mappings = this.listMappings();
    const index = mappings.findIndex((candidate) => candidate.id === mapping.id);
    if (index === -1) {
      mappings.push(mapping);
    } else {
      mappings[index] = mapping;
    }
    this.config = applyMappingProjection(this.config, mappings);
    return this.config;
  }

  removeDestination(id: string): AppConfig {
    const destination = this.findDestination(id);
    if (!destination) {
      return this.config;
    }
    this.config = applyMappingProjection(
      this.config,
      this.listMappings().filter((mapping) => mapping.id !== destination.id),
    );
    return this.config;
  }

  recordSourceFetch(sourceId: string, result: { success: boolean; errorCategory?: string }): AppConfig {
    const now = this.clock.now().toISOString();
    this.config.sources = this.config.sources.map((source) =>
      source.id === sourceId
        ? {
            ...source,
            state: {
              ...source.state,
              lastFetchedAt: now,
              ...(result.success
                ? { lastSuccessfulFetchAt: now, lastErrorCategory: undefined }
                : { lastErrorAt: now, lastErrorCategory: result.errorCategory }),
            },
            updatedAt: now,
          }
        : source,
    );
    return this.config;
  }
}
