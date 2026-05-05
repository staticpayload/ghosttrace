/** Trace file format version emitted by this release. */
export const TRACE_FORMAT_VERSION = '1.0.0' as const;

/** Supported side-effect span categories recorded by GhostTrace. */
export enum SpanType {
  Function = 'function',
  Http = 'http',
  Timer = 'timer',
  Random = 'random',
  Env = 'env',
  Fs = 'fs',
  Db = 'db',
  Queue = 'queue',
  Error = 'error',
  Performance = 'performance'
}

/** Arbitrary metadata stored on traces and spans. */
export type TraceMetadata = Readonly<Record<string, unknown>>;

/** Arbitrary metadata stored on individual spans. */
export type SpanMetadata = Readonly<Record<string, unknown>>;

/** Serializable error details captured on a span. */
export interface SpanError {
  /** Error class or constructor name. */
  readonly name: string;
  /** Human-readable error message. */
  readonly message: string;
  /** Optional stack trace captured when available. */
  readonly stack?: string;
  /** Optional machine-readable error code. */
  readonly code?: string;
  /** Optional nested error cause when the runtime provided one. */
  readonly cause?: SpanError;
}

/** A recorded unit of work or side-effectful operation. */
export interface Span<TInput = unknown, TOutput = unknown> {
  /** Deterministic span identifier unique within a trace. */
  readonly id: string;
  /** Parent span identifier, or null for root spans. */
  readonly parentId: string | null;
  /** Category of operation represented by this span. */
  readonly type: SpanType;
  /** Human-readable operation name. */
  readonly name: string;
  /** Relative start time in milliseconds from the trace start. */
  readonly startTime: number;
  /** Relative end time in milliseconds from the trace start. */
  readonly endTime: number;
  /** Duration in milliseconds, equal to endTime - startTime. */
  readonly duration: number;
  /** Serialized input payload for the operation. */
  readonly input: TInput;
  /** Serialized output payload for the operation. */
  readonly output: TOutput;
  /** Nested child spans, preserving the call tree. */
  readonly children: readonly Span[];
  /** Captured error details, or null when the operation succeeded. */
  readonly error: SpanError | null;
  /** Operation-specific metadata. */
  readonly metadata: SpanMetadata;
}

/** A complete deterministic execution trace. */
export interface Trace<TSpan extends Span = Span> {
  /** Unique trace identifier. */
  readonly id: string;
  /** Human-readable trace name. */
  readonly name: string;
  /** GhostTrace format version. */
  readonly version: typeof TRACE_FORMAT_VERSION | string;
  /** Relative trace start time; foundation traces start at 0. */
  readonly startTime: number;
  /** Relative trace end time. */
  readonly endTime: number;
  /** Trace duration in milliseconds. */
  readonly duration: number;
  /** Chronologically ordered spans captured by the trace. */
  readonly spans: readonly TSpan[];
  /** User and runtime metadata associated with the trace. */
  readonly metadata: TraceMetadata;
}

/** Options controlling where a recorded trace is saved. */
export interface TraceSaveOptions {
  /** Directory where the default sanitized trace filename should be written. */
  readonly directory?: string;
  /** Exact output file path. Takes precedence over directory when provided. */
  readonly filePath?: string;
}

/** Destination accepted by a recorded trace's save method. */
export type TraceSaveTarget = string | TraceSaveOptions;

/** Saves a recorded trace and returns the file path written. */
export type TraceSaveFunction = (target?: TraceSaveTarget) => Promise<string>;

/** Trace returned by the recorder, augmented with persistence helpers. */
export interface RecordedTrace<TSpan extends Span = Span> extends Trace<TSpan> {
  /** Writes this trace to deterministic JSON, creating parent directories. */
  readonly save: TraceSaveFunction;
}

/** Options used to create a Trace object in foundation builds. */
export interface CreateTraceOptions<TSpan extends Span = Span> {
  /** Unique trace identifier. */
  readonly id: string;
  /** Human-readable trace name. */
  readonly name: string;
  /** Optional trace format version. */
  readonly version?: string;
  /** Optional relative start time. */
  readonly startTime?: number;
  /** Optional relative end time. */
  readonly endTime?: number;
  /** Optional spans to attach to the trace. */
  readonly spans?: readonly TSpan[];
  /** Optional trace metadata. */
  readonly metadata?: TraceMetadata;
}

/** Top-level recorder configuration shared by the API, CLI, and integrations. */
export interface GhostTraceConfig {
  /** Directory where traces should be read or written by higher-level features. */
  readonly traceDir?: string;
  /** Names of interceptors to activate. */
  readonly interceptors?: readonly string[];
  /** Additional configuration reserved for plugins and future feature areas. */
  readonly metadata?: TraceMetadata;
}

/** Options accepted by the recording API. */
export interface RecordOptions {
  /** Additional trace metadata supplied by the caller. */
  readonly metadata?: TraceMetadata;
  /** Optional interceptor selection. */
  readonly interceptors?: readonly string[];
}

/** Options accepted by the foundation replay API placeholder. */
export interface ReplayOptions {
  /** Replay mode selected by future replay-engine features. */
  readonly mode?: ReplayMode;
  /** Span types replayed when mode is partial. */
  readonly replayTypes?: readonly SpanType[];
}

/** Replay strategy used to associate a runtime call with a recorded span. */
export type ReplayMatchStrategy = 'exact' | 'input' | 'sequential';

/** Replay modes supported by the replay engine. */
export type ReplayMode = 'strict' | 'lenient' | 'partial';

/** One span matched during replay, including the strategy used. */
export interface ReplaySpanMatch<TSpan extends Span = Span> {
  /** Recorded span selected for the runtime call. */
  readonly span: TSpan;
  /** Matching strategy used to select the span. */
  readonly strategy: ReplayMatchStrategy;
  /** Zero-based sequence for the matched runtime call. */
  readonly sequence: number;
}

/** Result returned by future replay operations with generic output inference. */
export interface ReplayResult<TOutput = unknown, TSpan extends Span = Span> {
  /** Function output produced during replay. */
  readonly output: TOutput;
  /** Spans matched during replay. */
  readonly spansMatched: readonly ReplaySpanMatch<TSpan>[];
  /** Original trace duration in milliseconds. */
  readonly originalDuration: number;
  /** Replay execution duration in milliseconds. */
  readonly replayDuration: number;
}

/** A function that may be recorded or replayed by future engine features. */
export type TraceableFunction<TOutput = unknown> = () => TOutput | Promise<TOutput>;

/** Isolated GhostTrace API instance. */
export interface Tracer {
  /** Configuration captured when the tracer was created. */
  readonly config: GhostTraceConfig;
  /** Records a named function execution. */
  readonly record: <TOutput>(
    name: string,
    fn: TraceableFunction<TOutput>,
    options?: RecordOptions
  ) => Promise<RecordedTrace>;
  /** Replays a function using a trace object or trace file path. */
  readonly replay: <TOutput, TSpan extends Span = Span>(
    trace: Trace<TSpan> | string,
    fn: TraceableFunction<TOutput>,
    options?: ReplayOptions
  ) => Promise<ReplayResult<Awaited<TOutput>, TSpan>>;
  /** Validates and normalizes configuration. */
  readonly defineConfig: (config: GhostTraceConfig) => GhostTraceConfig;
}
