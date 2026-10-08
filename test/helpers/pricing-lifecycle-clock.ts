/** A test-process Date only: host clock, timers, performance and hrtime are untouched. */
export function installPricingLifecycleClock(initial = Date.now()) {
  const NativeDate = Date;
  let now = initial;
  const SyntheticDate = new Proxy(NativeDate, {
    construct(target, args, newTarget) {
      return Reflect.construct(target, args.length ? args : [now], newTarget);
    },
    apply() { return new NativeDate(now).toString(); },
    get(target, property, receiver) {
      return property === 'now' ? () => now : Reflect.get(target, property, receiver);
    },
  });
  globalThis.Date = SyntheticDate;
  return {
    set(instant: string | number) {
      const value = typeof instant === 'string' ? NativeDate.parse(instant) : instant;
      if (!Number.isFinite(value)) throw new Error('Invalid synthetic lifecycle instant');
      now = value;
    },
    restore() {
      if (globalThis.Date !== SyntheticDate) throw new Error('Synthetic lifecycle clock was replaced');
      globalThis.Date = NativeDate;
    },
  };
}
