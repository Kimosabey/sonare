/**
 * The store exists so a 30Hz signal never enters a page's render path, so what
 * matters is that it notifies exactly when it should and no more — a store that
 * woke every subscriber on an unchanged value would move the cost rather than
 * remove it.
 *
 * `subscribe` and `getSnapshot` are handed to useSyncExternalStore unbound, so
 * these call them detached from the object on purpose.
 */

import { describe, expect, it, vi } from "vitest";
import { createLevelStore } from "./levelStore.js";

describe("createLevelStore", () => {
  it("starts silent", () => {
    expect(createLevelStore().getSnapshot()).toBe(-90);
  });

  it("notifies subscribers when the level changes", () => {
    const store = createLevelStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.set(-42);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toBe(-42);
  });

  it("does not notify when the value is unchanged", () => {
    // At 30Hz a held level is common — a run of identical frames must not wake
    // every subscriber to discover nothing happened.
    const store = createLevelStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.set(-42);
    store.set(-42);
    store.set(-42);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("stops notifying once unsubscribed", () => {
    const store = createLevelStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    unsubscribe();
    store.set(-30);

    expect(listener).not.toHaveBeenCalled();
    // The value still moves; only the notification stops.
    expect(store.getSnapshot()).toBe(-30);
  });

  it("notifies every subscriber, since two leaves read this", () => {
    const store = createLevelStore();
    const meter = vi.fn();
    const interim = vi.fn();
    store.subscribe(meter);
    store.subscribe(interim);

    store.set(-20);

    expect(meter).toHaveBeenCalledTimes(1);
    expect(interim).toHaveBeenCalledTimes(1);
  });

  it("returns to silence on reset, so a stale level never lingers between takes", () => {
    const store = createLevelStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.set(-12);
    listener.mockClear();

    store.reset();

    expect(store.getSnapshot()).toBe(-90);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("works with subscribe and getSnapshot called unbound", () => {
    // Exactly how useSyncExternalStore uses them. A `this`-based
    // implementation would throw here.
    const store = createLevelStore();
    const { subscribe, getSnapshot } = store;
    const listener = vi.fn();

    subscribe(listener);
    store.set(-55);

    expect(getSnapshot()).toBe(-55);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
