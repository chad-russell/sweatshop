/** Mode chip read-model shape (0055 PR2) — the query lives in
 *  @/lib/chat/mode-chrome, away from the store layer per 0049. */
export interface ModeChromePhase {
  id: string;
  name: string;
}

export interface ModeChromeData {
  skillId: string;
  /** The skill's H1 title (or its id, when there is no H1). */
  title: string;
  /** Declared phases, in document order; empty for a phaseless mode. */
  phases: ModeChromePhase[];
  /** The chat's current phase, when it names one THIS body still
   *  declares — null for a phaseless mode, a legacy thread that hasn't
   *  adopted a phase yet, or a stale id a renamed heading dropped. */
  current: ModeChromePhase | null;
}
