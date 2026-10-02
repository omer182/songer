import { useEffect, useRef } from 'react';
import type { PartyState } from '../../../shared/types';
import { sfx } from './sfx';
import { celebrate } from './celebrate';

/** Play buzzer / correct / wrong sounds (and confetti for a correct song) as the party moves between phases. */
export function usePartySounds(state: PartyState | null, opts: { onlyTeamId?: string } = {}) {
  const prev = useRef<PartyState | null>(null);
  useEffect(() => {
    const p = prev.current;
    prev.current = state;
    if (!p || !state || p.songIndex !== state.songIndex) return;
    const mine = (teamId: string | null | undefined) => !opts.onlyTeamId || teamId === opts.onlyTeamId;
    if (p.phase === 'round' && state.phase === 'buzzed' && mine(state.buzz?.teamId)) sfx.buzz();
    else if (p.phase === 'buzzed' && state.phase === 'reveal' && state.last?.teamId && mine(state.last.teamId)) {
      sfx.correct();
      const team = state.teams.find((t) => t.id === state.last!.teamId);
      celebrate(state.last.artistOnly ? 0.25 : 0.4 + (5 - Math.min(p.stage, 5)) * 0.12, team?.color);
    }
    else if (p.phase === 'buzzed' && state.phase === 'round' && mine(p.buzz?.teamId)) sfx.wrong();
  }, [state, opts.onlyTeamId]);
}
