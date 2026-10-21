/** Mode chip read-model shape (0055 PR2) — the query lives in
 *  @/lib/chat/mode-chrome, away from the store layer per 0049. */
export interface ModeChromePhase {
  id: string;
  name: string;
}

export interface ModeChromeMode {
  kind: "mode";
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

/** A skill is bound but it isn't (or is no longer) a mode — e.g. a
 *  plain thread skill, or one that's been deleted. 0059: that does not
 *  block owner mode entry; the chip still offers modes. */
export interface ModeChromeBound {
  kind: "bound";
  skillId: string;
}

/** Null (not this type) = no skill bound at all — a plain "Normal" chat. */
export type ModeChromeData = ModeChromeMode | ModeChromeBound;
