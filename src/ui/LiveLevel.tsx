/**
 * The only two places that subscribe to the 30Hz level.
 *
 * These exist so the level never enters the page's render path. Each is a leaf
 * that reads the store and passes a plain number down, which means LevelMeter
 * and InterimFeedback keep their simple `level: number` props and stay
 * trivially testable — the subscription is an implementation detail of where
 * they are mounted, not part of what they are.
 */

import { useSyncExternalStore } from "react";
import { LevelMeter } from "../speech/components/LevelMeter.js";
import { InterimFeedback } from "./InterimFeedback.js";
import type { LevelStore } from "./levelStore.js";

interface LiveLevelMeterProps {
  store: LevelStore;
  active: boolean;
  clipping: boolean;
}

export function LiveLevelMeter({ store, active, clipping }: LiveLevelMeterProps) {
  const level = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return <LevelMeter level={level} active={active} clipping={clipping} />;
}

interface LiveInterimFeedbackProps {
  store: LevelStore;
  recording: boolean;
  speaking: boolean;
  hangoverMs: number;
  autoStop: boolean;
}

export function LiveInterimFeedback({
  store,
  recording,
  speaking,
  hangoverMs,
  autoStop,
}: LiveInterimFeedbackProps) {
  const level = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return (
    <InterimFeedback
      recording={recording}
      speaking={speaking}
      level={level}
      hangoverMs={hangoverMs}
      autoStop={autoStop}
    />
  );
}
