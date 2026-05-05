import { describe, expect, it } from 'vitest';
import { createVirtualClock } from '../../src/index.js';

describe('virtual clock', () => {
  it('starts at 0 and produces 1000 strictly increasing relative timestamps', () => {
    const clock = createVirtualClock();
    const timestamps = Array.from({ length: 1000 }, () => clock.now());

    expect(clock.startTime).toBe(0);
    expect(timestamps[0]).toBe(0);

    for (let index = 1; index < timestamps.length; index += 1) {
      const previous = timestamps[index - 1] as number;
      const current = timestamps[index] as number;

      expect(current).toBeGreaterThan(previous);
    }
  });

  it('repeats the same deterministic timestamp sequence for identical recordings', () => {
    const firstRecordingClock = createVirtualClock();
    const secondRecordingClock = createVirtualClock();

    const firstSequence = Array.from({ length: 12 }, () => firstRecordingClock.now());
    const secondSequence = Array.from({ length: 12 }, () => secondRecordingClock.now());

    expect(firstSequence).toEqual(secondSequence);
    expect(firstSequence[0]).toBe(0);
  });

  it('resets to its initial relative timestamp sequence', () => {
    const clock = createVirtualClock();
    const firstSequence = [clock.now(), clock.now(), clock.now()];

    clock.reset();

    expect([clock.now(), clock.now(), clock.now()]).toEqual(firstSequence);
  });
});
