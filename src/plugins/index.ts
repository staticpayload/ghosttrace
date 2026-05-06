import { RecordingError } from '../core/errors.js';
import {
  type GhostTraceConfig,
  type GhostTracePlugin,
  type PluginHookContext,
  type PluginHooks,
  type PluginRuntimeContext,
  type PluginState,
  type Trace
} from '../core/types.js';
import { canonicalJsonStringify, toSerializableTrace } from '../validation/canonical.js';
import type { Interceptor, Teardown } from '../interceptors/types.js';

type TraceTransformHookName = 'afterRecord' | 'beforeReplay' | 'afterReplay' | 'beforeExport';

interface PluginRegistration {
  readonly plugin: GhostTracePlugin;
  readonly pluginState: PluginState;
}

/** Runtime plugin registrations and their isolated state bags. */
export interface PluginRuntime {
  /** Effective plugin config visible to hooks. */
  readonly config: GhostTraceConfig;
  /** Tracer or tracer-like object visible to hooks. */
  readonly tracer: unknown;
  /** Ordered plugin registrations. */
  readonly registrations: readonly PluginRegistration[];
}

/** Options used when creating a plugin runtime for one operation. */
export interface CreatePluginRuntimeOptions {
  /** Operation-scoped plugins. */
  readonly plugins?: readonly GhostTracePlugin[];
  /** Effective config visible to hooks. */
  readonly config?: GhostTraceConfig;
  /** Internal tracer/config context supplied by createTracer(). */
  readonly pluginContext?: PluginRuntimeContext;
  /** Fallback tracer-like object visible to hooks. */
  readonly tracer?: unknown;
}

/** Options supplied to trace-transforming plugin hooks. */
export interface RunTracePluginHooksOptions {
  /** Lifecycle operation invoking the hook. */
  readonly operation: PluginHookContext['operation'];
  /** Export format for beforeExport hooks. */
  readonly format?: string;
}

const globalPlugins: GhostTracePlugin[] = [];

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pluginLocation(index: number | undefined): string {
  return index === undefined ? 'plugin' : `plugin at index ${index}`;
}

function pluginValidationError(message: string, context: Readonly<Record<string, unknown>> = {}): RecordingError {
  return new RecordingError(message, {
    code: 'GHOSTTRACE_PLUGIN_INVALID',
    context
  });
}

function assertNonEmptyString(value: unknown, field: 'name' | 'version', index: number | undefined): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw pluginValidationError(`GhostTrace ${pluginLocation(index)} is missing required ${field}`, {
      field,
      index
    });
  }

  return value;
}

function assertInterceptorShape(value: unknown, pluginName: string, index: number): void {
  if (!isRecord(value)) {
    throw pluginValidationError(`GhostTrace plugin "${pluginName}" interceptor at index ${index} must be an object`, {
      plugin: pluginName,
      interceptorIndex: index
    });
  }

  if (typeof value.name !== 'string' || value.name.length === 0) {
    throw pluginValidationError(`GhostTrace plugin "${pluginName}" interceptor at index ${index} is missing name`, {
      plugin: pluginName,
      interceptorIndex: index,
      field: 'name'
    });
  }

  if (typeof value.install !== 'function' || typeof value.isAvailable !== 'function') {
    throw pluginValidationError(
      `GhostTrace plugin "${pluginName}" interceptor "${value.name}" must define install() and isAvailable()`,
      {
        plugin: pluginName,
        interceptor: value.name
      }
    );
  }
}

/** Validates a plugin object and returns it with the public plugin type. */
export function validatePlugin(plugin: unknown, index?: number): GhostTracePlugin {
  if (!isRecord(plugin)) {
    throw pluginValidationError(`GhostTrace ${pluginLocation(index)} must be an object with name and version`, {
      index
    });
  }

  const name = assertNonEmptyString(plugin.name, 'name', index);
  assertNonEmptyString(plugin.version, 'version', index);

  if (plugin.interceptors !== undefined) {
    if (!Array.isArray(plugin.interceptors)) {
      throw pluginValidationError(`GhostTrace plugin "${name}" interceptors must be an array`, {
        plugin: name
      });
    }

    for (const [interceptorIndex, interceptor] of plugin.interceptors.entries()) {
      assertInterceptorShape(interceptor, name, interceptorIndex);
    }
  }

  if (plugin.hooks !== undefined && !isRecord(plugin.hooks)) {
    throw pluginValidationError(`GhostTrace plugin "${name}" hooks must be an object`, {
      plugin: name
    });
  }

  return plugin as unknown as GhostTracePlugin;
}

/** Validates an ordered plugin list and preserves registration order. */
export function normalizePlugins(plugins: readonly GhostTracePlugin[] | undefined): readonly GhostTracePlugin[] {
  return (plugins ?? []).map((plugin, index) => validatePlugin(plugin, index));
}

/** Registers a global plugin and returns an unregister callback. */
export function registerPlugin(plugin: GhostTracePlugin): Teardown {
  const validatedPlugin = validatePlugin(plugin);
  globalPlugins.push(validatedPlugin);
  let registered = true;

  return () => {
    if (!registered) {
      return;
    }

    registered = false;
    const pluginIndex = globalPlugins.indexOf(validatedPlugin);
    if (pluginIndex >= 0) {
      globalPlugins.splice(pluginIndex, 1);
    }
  };
}

function cloneTraceForPlugin(trace: Trace): Trace {
  return JSON.parse(canonicalJsonStringify(toSerializableTrace(trace))) as Trace;
}

function runtimeConfig(options: CreatePluginRuntimeOptions, plugins: readonly GhostTracePlugin[]): GhostTraceConfig {
  if (options.pluginContext?.config !== undefined) {
    return options.pluginContext.config;
  }
  if (options.config !== undefined) {
    return options.config;
  }

  return plugins.length === 0 ? {} : { plugins };
}

function runtimeTracer(options: CreatePluginRuntimeOptions, config: GhostTraceConfig): unknown {
  if (options.pluginContext?.tracer !== undefined) {
    return options.pluginContext.tracer;
  }
  if (options.tracer !== undefined) {
    return options.tracer;
  }

  return { config };
}

/** Creates an isolated runtime for one operation, preserving plugin registration order. */
export function createPluginRuntime(options: CreatePluginRuntimeOptions = {}): PluginRuntime {
  const scopedPlugins = normalizePlugins(options.plugins);
  const plugins = [...globalPlugins, ...scopedPlugins];
  const config = runtimeConfig(options, plugins);

  return {
    config,
    tracer: runtimeTracer(options, config),
    registrations: plugins.map((plugin) => ({
      plugin,
      pluginState: {}
    }))
  };
}

function hookContext(
  runtime: PluginRuntime,
  registration: PluginRegistration,
  operation: PluginHookContext['operation'],
  trace: Trace | undefined,
  format: string | undefined
): PluginHookContext {
  const context: {
    plugin: GhostTracePlugin;
    pluginState: PluginState;
    tracer: unknown;
    config: GhostTraceConfig;
    operation: PluginHookContext['operation'];
    trace?: Trace;
    format?: string;
  } = {
    plugin: registration.plugin,
    pluginState: registration.pluginState,
    tracer: runtime.tracer,
    config: runtime.config,
    operation
  };

  if (trace !== undefined) {
    context.trace = trace;
  }
  if (format !== undefined) {
    context.format = format;
  }

  return context;
}

function warnHookError(plugin: GhostTracePlugin, hookName: string, error: unknown): void {
  console.warn(`GhostTrace plugin "${plugin.name}" ${hookName} hook failed`, error);
}

/** Invokes beforeRecord hooks in registration order, isolating hook failures. */
export async function runBeforeRecordHooks(runtime: PluginRuntime): Promise<void> {
  for (const registration of runtime.registrations) {
    const hook = registration.plugin.hooks?.beforeRecord;
    if (hook === undefined) {
      continue;
    }

    try {
      await hook(hookContext(runtime, registration, 'record', undefined, undefined));
    } catch (error) {
      warnHookError(registration.plugin, 'beforeRecord', error);
    }
  }
}

/** Invokes trace-transforming hooks in registration order with immutable trace-copy semantics. */
export async function runTracePluginHooks(
  runtime: PluginRuntime,
  hookName: TraceTransformHookName,
  trace: Trace,
  options: RunTracePluginHooksOptions
): Promise<Trace> {
  let currentTrace = trace;

  for (const registration of runtime.registrations) {
    const hooks: PluginHooks | undefined = registration.plugin.hooks;
    const hook = hooks?.[hookName];

    if (hook === undefined) {
      continue;
    }

    const hookTrace = cloneTraceForPlugin(currentTrace);
    const context = hookContext(runtime, registration, options.operation, hookTrace, options.format);

    try {
      const nextTrace = await hook(hookTrace, context);
      if (nextTrace !== undefined) {
        currentTrace = cloneTraceForPlugin(nextTrace);
      }
    } catch (error) {
      warnHookError(registration.plugin, hookName, error);
    }
  }

  return currentTrace;
}

/** Returns plugin-provided interceptors in plugin registration order. */
export function pluginInterceptors(runtime: PluginRuntime): readonly Interceptor[] {
  return runtime.registrations.flatMap((registration) => registration.plugin.interceptors ?? []);
}
