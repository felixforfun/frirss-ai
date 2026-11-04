import { create } from 'zustand';
import type { ExternalSignalSource } from '../lib/intelligenceRanking';

// ═══════════════════════════════════════════════════════════════════════
// Ephemeral, session-only coverage readout for the ranking preferences UI:
// how many of the current candidates carry measured evidence per source.
// Deliberately NOT persisted and NOT synced to the server: it is a live
// status display, refreshed by the Interesting view's acquisition layer.
// ═══════════════════════════════════════════════════════════════════════

interface DiscoveryCoverageState {
  measured: Partial<Record<ExternalSignalSource, number>>;
  /** Candidates the acquisition layer requested evidence for (cohort cap included). */
  candidates: number;
  updatedAt: number;
  set: (measured: Partial<Record<ExternalSignalSource, number>>, candidates: number) => void;
  clear: () => void;
}

export const useDiscoveryCoverageStore = create<DiscoveryCoverageState>((set) => ({
  measured: {},
  candidates: 0,
  updatedAt: 0,
  set: (measured, candidates) => set({ measured, candidates, updatedAt: Date.now() }),
  clear: () => set({ measured: {}, candidates: 0, updatedAt: 0 }),
}));
