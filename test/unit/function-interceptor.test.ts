import { describe, expect, it } from 'vitest';
import { SpanType, ghost, type Span } from '../../src/index.js';

function rootSpan(spans: readonly Span[]): Span {
  const span = spans[0];

  if (span === undefined) {
    throw new Error('expected trace to contain a root span');
  }

  return span;
}

function namedFunctionSpans(spans: readonly Span[], name: string): readonly Span[] {
  return spans.filter((span) => span.type === SpanType.Function && span.name === name);
}

function onlySpan(spans: readonly Span[], name: string): Span {
  const matches = namedFunctionSpans(spans, name);

  expect(matches).toHaveLength(1);
  const span = matches[0];
  if (span === undefined) {
    throw new Error(`expected one function span named ${name}`);
  }

  return span;
}

describe('function interceptor', () => {
  it('wrap records sync input args, output, duration, and original function name', async () => {
    const add = ghost.wrap(function add(left: number, right: number): number {
      return left + right;
    });

    const trace = await ghost.record('wrapped-add', () => add(2, 3), {
      interceptors: ['function']
    });
    const span = onlySpan(trace.spans, 'add');

    expect(span).toMatchObject({
      parentId: rootSpan(trace.spans).id,
      type: SpanType.Function,
      name: 'add',
      input: [2, 3],
      output: 5,
      error: null
    });
    expect(span.duration).toBe(span.endTime - span.startTime);
    expect(span.duration).toBeGreaterThan(0);
  });

  it('records thrown sync errors on the wrapped function span', async () => {
    const explode = ghost.wrap(function explode(value: string): never {
      throw new TypeError(`bad ${value}`);
    });

    const trace = await ghost.record('wrapped-sync-error', () => explode('input'), {
      interceptors: ['function']
    });
    const span = onlySpan(trace.spans, 'explode');

    expect(rootSpan(trace.spans).error).toMatchObject({
      name: 'TypeError',
      message: 'bad input'
    });
    expect(span).toMatchObject({
      input: ['input'],
      error: {
        name: 'TypeError',
        message: 'bad input'
      }
    });
  });

  it('records async resolutions and rejections after awaited work completes', async () => {
    const load = ghost.wrap(async function load(id: string): Promise<{ readonly id: string }> {
      await Promise.resolve();
      return { id };
    });
    const rejectLoad = ghost.wrap(async function rejectLoad(id: string): Promise<never> {
      await Promise.resolve();
      throw new RangeError(`missing ${id}`);
    });

    const successTrace = await ghost.record('wrapped-async-success', () => load('a'), {
      interceptors: ['function']
    });
    const errorTrace = await ghost.record('wrapped-async-error', () => rejectLoad('b'), {
      interceptors: ['function']
    });

    expect(onlySpan(successTrace.spans, 'load')).toMatchObject({
      input: ['a'],
      output: { id: 'a' },
      error: null
    });
    expect(onlySpan(errorTrace.spans, 'rejectLoad')).toMatchObject({
      input: ['b'],
      error: {
        name: 'RangeError',
        message: 'missing b'
      }
    });
  });

  it('preserves this-context binding and the wrapped function name', async () => {
    const increment = ghost.wrap(function increment(this: { readonly base: number }, amount: number): number {
      return this.base + amount;
    });
    const receiver = {
      base: 10,
      increment
    };

    expect(increment.name).toBe('increment');

    const trace = await ghost.record('this-binding', () => receiver.increment(7), {
      interceptors: ['function']
    });

    expect(rootSpan(trace.spans).output).toBe(17);
    expect(onlySpan(trace.spans, 'increment')).toMatchObject({
      input: [7],
      output: 17,
      error: null
    });
  });

  it('wrapModule wraps function exports while passing non-functions through unchanged', async () => {
    const moduleExports = {
      label: 'math-module',
      count: 2,
      add(left: number, right: number): number {
        return left + right;
      },
      async double(value: number): Promise<number> {
        await Promise.resolve();
        return value * 2;
      }
    };

    const wrappedModule = ghost.wrapModule(moduleExports);

    expect(wrappedModule.label).toBe(moduleExports.label);
    expect(wrappedModule.count).toBe(moduleExports.count);
    expect(wrappedModule.add).not.toBe(moduleExports.add);
    expect(wrappedModule.double).not.toBe(moduleExports.double);

    const trace = await ghost.record(
      'wrapped-module',
      async () => ({
        sum: wrappedModule.add(2, 4),
        doubled: await wrappedModule.double(5),
        label: wrappedModule.label
      }),
      { interceptors: ['function'] }
    );

    expect(rootSpan(trace.spans).output).toEqual({
      sum: 6,
      doubled: 10,
      label: 'math-module'
    });
    expect(onlySpan(trace.spans, 'add').output).toBe(6);
    expect(onlySpan(trace.spans, 'double').output).toBe(10);
  });

  it('records nested wrapped calls with parent-child relationships', async () => {
    const inner = ghost.wrap(function inner(value: number): number {
      return value + 1;
    });
    const outer = ghost.wrap(function outer(value: number): number {
      return inner(value) + inner(value + 10);
    });

    const trace = await ghost.record('nested-wrapped-functions', () => outer(3), {
      interceptors: ['function']
    });
    const root = rootSpan(trace.spans);
    const outerSpan = onlySpan(trace.spans, 'outer');
    const innerSpans = namedFunctionSpans(trace.spans, 'inner');
    const outerChild = root.children.find((span) => span.id === outerSpan.id);

    expect(innerSpans).toHaveLength(2);
    expect(outerSpan.parentId).toBe(root.id);
    expect(innerSpans.every((span) => span.parentId === outerSpan.id)).toBe(true);
    expect(outerChild?.children.map((span) => span.id)).toEqual(innerSpans.map((span) => span.id));
  });

  it('records recursive factorial calls as a correct parent chain', async () => {
    let factorial: (value: number) => number;
    const factorialTarget = (value: number): number => {
      return value <= 1 ? 1 : value * factorial(value - 1);
    };
    Object.defineProperty(factorialTarget, 'name', { value: 'factorial' });
    factorial = ghost.wrap(factorialTarget);

    const trace = await ghost.record('factorial-five', () => factorial(5), {
      interceptors: ['function']
    });
    const root = rootSpan(trace.spans);
    const factorialSpans = namedFunctionSpans(trace.spans, 'factorial');

    expect(root.output).toBe(120);
    expect(factorialSpans).toHaveLength(5);
    expect(factorialSpans.map((span) => span.input)).toEqual([[5], [4], [3], [2], [1]]);

    let current = root.children.find((span) => span.id === factorialSpans[0]?.id);
    for (const span of factorialSpans) {
      expect(current?.id).toBe(span.id);
      expect(current?.parentId).toBe(span.parentId);
      current = current?.children.find((child) => child.name === 'factorial');
    }
  });

  it('handles more than ten nested recursive wrapped calls', async () => {
    let countdown: (value: number) => number;
    const countdownTarget = (value: number): number => {
      return value <= 1 ? 1 : countdown(value - 1);
    };
    Object.defineProperty(countdownTarget, 'name', { value: 'countdown' });
    countdown = ghost.wrap(countdownTarget);

    const trace = await ghost.record('countdown-twelve', () => countdown(12), {
      interceptors: ['function']
    });
    const root = rootSpan(trace.spans);
    const countdownSpans = namedFunctionSpans(trace.spans, 'countdown');

    expect(countdownSpans).toHaveLength(12);

    let current = root.children.find((span) => span.id === countdownSpans[0]?.id);
    for (const span of countdownSpans) {
      expect(current?.id).toBe(span.id);
      current = current?.children.find((child) => child.name === 'countdown');
    }
  });
});
