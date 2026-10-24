import { AppError } from "@/server/errors";

export type StateMachineDefinition<S extends string> = {
  name: string;
  initial: S;
  /** Allowed next states for each state. Terminal states map to []. */
  transitions: Record<S, readonly S[]>;
};

export type StateMachine<S extends string> = StateMachineDefinition<S> & {
  states: readonly S[];
  canTransition(from: S, to: S): boolean;
  /** Throws INVALID_STATE_TRANSITION; callers never infer transitions from the UI. */
  assertTransition(from: S, to: S): void;
  nextStates(from: S): readonly S[];
  isTerminal(state: S): boolean;
};

export function defineStateMachine<S extends string>(definition: StateMachineDefinition<S>): StateMachine<S> {
  const states = Object.keys(definition.transitions) as S[];
  for (const [from, targets] of Object.entries(definition.transitions) as [S, readonly S[]][]) {
    for (const to of targets) {
      if (!(to in definition.transitions)) {
        throw new Error(`${definition.name}: transition ${from} -> ${to} targets an unknown state`);
      }
    }
  }

  const canTransition = (from: S, to: S) => definition.transitions[from]?.includes(to) ?? false;

  return {
    ...definition,
    states,
    canTransition,
    assertTransition(from, to) {
      if (!canTransition(from, to)) {
        throw new AppError("INVALID_STATE_TRANSITION", {
          detail: `${definition.name}: ${from} -> ${to} is not allowed`,
        });
      }
    },
    nextStates: (from) => definition.transitions[from] ?? [],
    isTerminal: (state) => (definition.transitions[state] ?? []).length === 0,
  };
}
