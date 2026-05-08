import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SpanType,
  exportTrace,
  getTraceContext,
  ghost,
  type GhostTracePlugin,
  type Interceptor,
  type PluginHookContext,
  type Span
} from '../../src/index.js';

const PLUGIN_SPAN_TYPE = 'plugin:effect' as SpanType;

let runPluginEffect = (): string => 'live-effect';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isReplayStoreLike(value: unknown): value is {
  readonly consumeSpan: (type: SpanType, name: string, input: unknown) => { readonly span: Span } | undefined;
} {
  return isRecord(value) && typeof value.consumeSpan === 'function';
}

function pluginState(context: PluginHookContext): Record<string, unknown> {
  return context.pluginState;
}

describe('plugin system', () => {
  afterEach(() => {
    runPluginEffect = () => 'live-effect';
    vi.restoreAllMocks();
  });

  it('rejects plugins missing name or version with descriptive errors', () => {
    expect(() => ghost.registerPlugin({ version: '1.0.0' } as unknown as GhostTracePlugin)).toThrow(/plugin.*name/iu);

    expect(() =>
      ghost.createTracer({
        plugins: [{ version: '1.0.0' } as unknown as GhostTracePlugin]
      })
    ).toThrow(/plugin.*name/iu);

    expect(() =>
      ghost.createTracer({
        plugins: [{ name: 'missing-version' } as unknown as GhostTracePlugin]
      })
    ).toThrow(/plugin.*version/iu);

    expect(() =>
      ghost.createTracer({
        plugins: [{ name: 'valid', version: '1.0.0' }]
      })
    ).not.toThrow();

    const unregister = ghost.registerPlugin({ name: 'valid-global', version: '1.0.0' });
    unregister();
  });

  it('fires hooks in registration order at record, replay, and export lifecycle points', async () => {
    const events: string[] = [];
    const pluginA: GhostTracePlugin = {
      name: 'ordered-a',
      version: '1.0.0',
      hooks: {
        beforeRecord: () => {
          events.push('a:beforeRecord');
        },
        afterRecord: (trace) => {
          events.push(`a:afterRecord:${trace.spans.length > 0 ? 'has-spans' : 'no-spans'}`);
          return {
            ...trace,
            metadata: {
              ...trace.metadata,
              afterRecordA: true
            }
          };
        },
        beforeReplay: () => {
          events.push('a:beforeReplay');
        },
        afterReplay: () => {
          events.push('a:afterReplay');
        },
        beforeExport: (_trace, context) => {
          events.push(`a:beforeExport:${context.format}`);
        }
      }
    };
    const pluginB: GhostTracePlugin = {
      name: 'ordered-b',
      version: '1.0.0',
      hooks: {
        beforeRecord: () => {
          events.push('b:beforeRecord');
        },
        afterRecord: (trace) => {
          events.push(`b:afterRecord:${trace.metadata.afterRecordA === true ? 'saw-a' : 'missing-a'}`);
        },
        beforeReplay: () => {
          events.push('b:beforeReplay');
        },
        afterReplay: () => {
          events.push('b:afterReplay');
        },
        beforeExport: (_trace, context) => {
          events.push(`b:beforeExport:${context.format}`);
        }
      }
    };
    const tracer = ghost.createTracer({ plugins: [pluginA, pluginB] });
    const tempDir = await mkdtemp(join(tmpdir(), 'ghosttrace-plugin-order-'));

    try {
      const trace = await tracer.record('plugin-order', () => 'recorded-value');
      const savedPath = await trace.save(tempDir);
      const savedTrace = JSON.parse(await readFile(savedPath, 'utf8')) as { readonly metadata?: Record<string, unknown> };

      expect(savedTrace.metadata?.afterRecordA).toBe(true);

      await tracer.replay(trace, () => 'recorded-value');
      await tracer.exportTrace(trace, { format: 'json' });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }

    expect(events).toEqual([
      'a:beforeRecord',
      'b:beforeRecord',
      'a:afterRecord:has-spans',
      'b:afterRecord:saw-a',
      'a:beforeReplay',
      'b:beforeReplay',
      'a:afterReplay',
      'b:afterReplay',
      'a:beforeExport:json',
      'b:beforeExport:json'
    ]);
  });

  it('installs plugin interceptors for recording and replay', async () => {
    const pluginInterceptor: Interceptor = {
      name: 'plugin-effect',
      isAvailable: () => true,
      install: ({ addSpan }) => {
        const previous = runPluginEffect;

        runPluginEffect = () => {
          const context = getTraceContext();
          const input = { value: 'plugin-input' };

          if (context?.mode === 'replay' && isReplayStoreLike(context.replayStore)) {
            const consumed = context.replayStore.consumeSpan(PLUGIN_SPAN_TYPE, 'plugin-effect', input);
            return typeof consumed?.span.output === 'string' ? consumed.span.output : previous();
          }

          if (context?.mode === 'record') {
            const startTime = context.clock.now();
            const output = 'recorded-plugin-effect';
            const endTime = context.clock.now();

            addSpan({
              id: context.idGenerator.next(),
              parentId: context.currentSpan?.id ?? null,
              type: PLUGIN_SPAN_TYPE,
              name: 'plugin-effect',
              startTime,
              endTime,
              duration: endTime - startTime,
              input,
              output,
              children: [],
              error: null,
              metadata: {
                plugin: 'effect-plugin'
              }
            });

            return output;
          }

          return previous();
        };

        return () => {
          runPluginEffect = previous;
        };
      }
    };
    const tracer = ghost.createTracer({
      plugins: [
        {
          name: 'effect-plugin',
          version: '1.0.0',
          interceptors: [pluginInterceptor]
        }
      ]
    });

    const trace = await tracer.record('plugin-interceptor', () => runPluginEffect(), {
      interceptors: ['plugin-effect']
    });
    const pluginSpan = trace.spans.find((span) => span.type === PLUGIN_SPAN_TYPE);

    expect(pluginSpan).toMatchObject({
      name: 'plugin-effect',
      output: 'recorded-plugin-effect',
      metadata: {
        plugin: 'effect-plugin'
      }
    });

    runPluginEffect = () => 'changed-live-effect';

    const replayed = await tracer.replay(trace, () => runPluginEffect());

    expect(replayed.output).toBe('recorded-plugin-effect');
    expect(replayed.spansMatched.map((match) => match.span.id)).toContain(pluginSpan?.id);

    runPluginEffect = () => 'changed-live-effect-partial';

    const partialReplay = await tracer.replay(trace, () => runPluginEffect(), {
      mode: 'partial',
      replayTypes: [PLUGIN_SPAN_TYPE]
    });

    expect(partialReplay.output).toBe('recorded-plugin-effect');
    expect(partialReplay.spansMatched.map((match) => match.span.id)).toContain(pluginSpan?.id);
  });

  it('catches hook errors with warnings and keeps operations running', async () => {
    const warningSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const tracer = ghost.createTracer({
      plugins: [
        {
          name: 'throwing-plugin',
          version: '1.0.0',
          hooks: {
            afterRecord: () => {
              throw new Error('afterRecord boom');
            }
          }
        }
      ]
    });

    const trace = await tracer.record('warning-isolated', () => 42);

    expect(trace.name).toBe('warning-isolated');
    expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining('throwing-plugin'), expect.any(Error));
  });

  it('isolates plugin state and provides hook context with tracer, trace, and config', async () => {
    let pluginBStateWasIsolated = false;
    let configWasVisible = false;
    let tracerWasVisible = false;
    let traceWasVisible = false;
    const pluginA: GhostTracePlugin = {
      name: 'state-a',
      version: '1.0.0',
      hooks: {
        beforeRecord: (context) => {
          pluginState(context).shared = 'a-only';
          configWasVisible = isRecord(context.config.metadata) && context.config.metadata.suite === 'plugins';
          tracerWasVisible = isRecord(context.tracer);
        },
        afterRecord: (_trace, context) => {
          traceWasVisible = context.trace?.name === 'state-context';
          pluginState(context).afterRecordSeen = true;
        }
      }
    };
    const pluginB: GhostTracePlugin = {
      name: 'state-b',
      version: '1.0.0',
      hooks: {
        beforeRecord: (context) => {
          pluginBStateWasIsolated = pluginState(context).shared === undefined;
          pluginState(context).shared = 'b-only';
        }
      }
    };
    const tracer = ghost.createTracer({
      metadata: { suite: 'plugins' },
      plugins: [pluginA, pluginB]
    });

    await tracer.record('state-context', () => 'ok');

    expect(pluginBStateWasIsolated).toBe(true);
    expect(configWasVisible).toBe(true);
    expect(tracerWasVisible).toBe(true);
    expect(traceWasVisible).toBe(true);
  });

  it('applies returned trace copies but ignores mutation-only hook changes', async () => {
    const tracer = ghost.createTracer({
      plugins: [
        {
          name: 'mutation-only',
          version: '1.0.0',
          hooks: {
            afterRecord: (trace) => {
              (trace.metadata as Record<string, unknown>).mutationOnly = true;
            },
            beforeExport: (trace) => {
              (trace.metadata as Record<string, unknown>).exportMutationOnly = true;
            }
          }
        },
        {
          name: 'returning-plugin',
          version: '1.0.0',
          hooks: {
            afterRecord: (trace) => ({
              ...trace,
              metadata: {
                ...trace.metadata,
                returnedAfterRecord: true
              }
            }),
            beforeExport: (trace, context) => ({
              ...trace,
              metadata: {
                ...trace.metadata,
                returnedBeforeExport: context.format
              }
            })
          }
        }
      ]
    });

    const trace = await tracer.record('immutable-trace-hooks', () => 'ok');

    expect(trace.metadata.mutationOnly).toBeUndefined();
    expect(trace.metadata.returnedAfterRecord).toBe(true);

    const exported = await tracer.exportTrace(trace, { format: 'json' });
    const exportedTrace = JSON.parse(exported) as { readonly metadata?: Record<string, unknown> };

    expect(exportedTrace.metadata?.exportMutationOnly).toBeUndefined();
    expect(exportedTrace.metadata?.returnedBeforeExport).toBe('json');
  });

  it('allows beforeExport hooks supplied directly to exportTrace to transform formatter input', async () => {
    const trace = await ghost.record('direct-export-plugin', () => 'ok');
    const exported = await exportTrace(trace, {
      format: 'json',
      plugins: [
        {
          name: 'direct-export-transform',
          version: '1.0.0',
          hooks: {
            beforeExport: (incomingTrace, context) => ({
              ...incomingTrace,
              metadata: {
                ...incomingTrace.metadata,
                directFormat: context.format
              }
            })
          }
        }
      ]
    });
    const parsed = JSON.parse(exported) as { readonly metadata?: Record<string, unknown> };

    expect(parsed.metadata?.directFormat).toBe('json');
  });

  it('threads afterReplay returned trace transforms through the replay result', async () => {
    const trace = await ghost.record('after-replay-result-trace', () => 'ok');

    const replayed = await ghost.replay(trace, () => 'ok', {
      plugins: [
        {
          name: 'after-replay-result-transform',
          version: '1.0.0',
          hooks: {
            beforeReplay: (incomingTrace) => ({
              ...incomingTrace,
              metadata: {
                ...incomingTrace.metadata,
                beforeReplayVisible: true
              }
            }),
            afterReplay: (incomingTrace) => ({
              ...incomingTrace,
              metadata: {
                ...incomingTrace.metadata,
                afterReplayVisible: true
              }
            })
          }
        }
      ]
    });

    expect(replayed.trace.metadata.beforeReplayVisible).toBe(true);
    expect(replayed.trace.metadata.afterReplayVisible).toBe(true);
    expect(replayed.replayTrace.metadata.beforeReplayVisible).toBe(true);
    expect(replayed.replayTrace.metadata.afterReplayVisible).toBeUndefined();
  });
});
