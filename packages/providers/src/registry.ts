import type { Provider } from '../../core/src/index.ts';

import { ClaudeCliProvider, type ClaudeCliProviderOptions } from './claude-cli-provider.ts';
import { CodexCliProvider, type CodexCliProviderOptions } from './codex-cli-provider.ts';
import { GeminiCliProvider, type GeminiCliProviderOptions } from './gemini-cli-provider.ts';
import {
  parseProviderIdFromRoutingYaml,
  resolveProviderForRoleFromRoutingYaml
} from './routing.ts';

export type ProviderFactory = () => Provider;

export interface CreateProviderRegistryOptions {
  codexCli?: CodexCliProviderOptions;
  geminiCli?: GeminiCliProviderOptions;
  claudeCli?: ClaudeCliProviderOptions;
}

export interface ProviderSelectionOptions {
  providerId?: string;
  routingYaml?: string;
  fallbackProviderId?: string;
  role?: string;
}

export class ProviderRegistry {
  private readonly factories = new Map<string, ProviderFactory>();

  register(providerId: string, factory: ProviderFactory): void {
    this.factories.set(providerId, factory);
  }

  has(providerId: string): boolean {
    return this.factories.has(providerId);
  }

  create(providerId: string): Provider {
    const normalizedProviderId = providerId.trim().toLowerCase();
    const factory = this.factories.get(normalizedProviderId);

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
  registry.register('claude', () => new ClaudeCliProvider(options.claudeCli));
  registry.register('claude-cli', () => new ClaudeCliProvider(options.claudeCli));
  registry.register('gemini', () => new GeminiCliProvider(options.geminiCli));
  registry.register('gemini-cli', () => new GeminiCliProvider(options.geminiCli));

  return registry;
}

export function resolveProviderId(options: ProviderSelectionOptions = {}): string {
  const explicitProviderId = options.providerId?.trim();

  if (explicitProviderId) {
    return explicitProviderId;
  }

  if (options.role && options.routingYaml) {
    const roleProviderId = resolveProviderForRoleFromRoutingYaml(
      options.routingYaml,
      options.role,
      options.fallbackProviderId
    );

    if (roleProviderId) {
      return roleProviderId.trim().toLowerCase();
    }
  }

  if (options.routingYaml) {
    const providerId = parseProviderIdFromRoutingYaml(options.routingYaml);

    if (providerId) {
      return providerId.trim().toLowerCase();
    }
  }

  return options.fallbackProviderId?.trim().toLowerCase() ?? 'codex-cli';
}

export function createProviderFromSelection(
  registry: ProviderRegistry,
  options: ProviderSelectionOptions = {}
): Provider {
  const providerId = resolveProviderId(options);
  return registry.create(providerId);
}
