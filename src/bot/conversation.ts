/**
 * Ephemeral per-sender conversation state for custom route flows.
 * In-memory only — no persistence, no PII logged.
 */

const DEFAULT_TTL_MS = 120_000; // 2 minutes

export interface PendingFlow {
  sender: string;
  /**
   * 'route'       — entered custom mode (via "0"); awaiting a free-text route or origin.
   * 'origin'/'destination' — awaiting a pick for that half: a number when
   *                 `candidates` is non-empty, else free text.
   * 'confirm'     — awaiting yes/no for `confirmTarget`.
   */
  awaiting: 'route' | 'origin' | 'destination' | 'confirm';
  origin?: string;
  destination?: string;
  candidates: string[];
  confirmTarget?: string;
  /** Which half a `confirm` / menu pick resolves. */
  confirmRole?: 'origin' | 'destination';
  /** Raw destination text stashed while the origin is being disambiguated. */
  destText?: string;
  expiresAt: number;
}

export interface ConversationStore {
  /** Stamps expiresAt = now() + ttlMs and stores the flow. Overwrites any existing flow for the sender. */
  set(flow: Omit<PendingFlow, 'expiresAt'>): PendingFlow;
  /** Returns the flow if present and not expired. Evicts and returns undefined if expired or absent. */
  get(sender: string): PendingFlow | undefined;
  /** Removes the flow for the sender. */
  clear(sender: string): void;
}

export function createConversationStore(opts?: {
  ttlMs?: number;
  now?: () => number;
}): ConversationStore {
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts?.now ?? (() => Date.now());
  const store = new Map<string, PendingFlow>();

  return {
    set(flow: Omit<PendingFlow, 'expiresAt'>): PendingFlow {
      const stamped: PendingFlow = { ...flow, expiresAt: now() + ttlMs };
      store.set(flow.sender, stamped);
      return stamped;
    },

    get(sender: string): PendingFlow | undefined {
      const entry = store.get(sender);
      if (entry === undefined) {
        return undefined;
      }
      if (now() < entry.expiresAt) {
        return entry;
      }
      // Expired — evict and return undefined
      store.delete(sender);
      return undefined;
    },

    clear(sender: string): void {
      store.delete(sender);
    },
  };
}
