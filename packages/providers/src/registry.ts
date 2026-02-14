import type { Provider } from '../../core/src/index.ts';

import { CodexCliProvider, type CodexCliProviderOptions } from './codex-cli-provider.ts';
import { parseProviderIdFromRoutingYaml } from './routing.ts';

export type ProviderFactory = () => Provider;

export interface CreateProviderRegistryOptions {
  codexCli?: CodexCliProviderOptions;
}

export interface ProviderSelectionOptions {
  providerId?: string;
  routingYaml?: string;
  fallbackProviderId?: string;
}

export class ProviderRegistry {
  private readonly factories = new Map<string, ProviderFactory>();

  register(providerId: string, factory: ProviderFactory): void {
    this.factories.set(providerId, factory);
  }

  create(providerId: string): Provider {
    const factory = this.factories.get(providerId);

    if (!factory) {
      throw new Error(`등록되지 않은 provider입니다: ${providerId}`);
    }

    return factory();
  }

  list(): string[] {
    return [...this.factories.keys()].sort();
  }
}

export function createProviderRegistry(
  options: CreateProviderRegistryOptions = {}
): ProviderRegistry {
  const registry = new ProviderRegistry();

  registry.register('codex-cli', () => new CodexCliProvider(options.codexCli));

  return registry;
}

export function resolveProviderId(options: ProviderSelectionOptions = {}): string {
  const explicitProviderId = options.providerId?.trim();

  if (explicitProviderId) {
    return explicitProviderId;
  }

  if (options.routingYaml) {
    const providerId = parseProviderIdFromRoutingYaml(options.routingYaml);

    if (providerId) {
      return providerId;
    }
  }

  return options.fallbackProviderId ?? 'codex-cli';
}

export function createProviderFromSelection(
  registry: ProviderRegistry,
  options: ProviderSelectionOptions = {}
): Provider {
  const providerId = resolveProviderId(options);
  return registry.create(providerId);
}
