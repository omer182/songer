import { useEffect, useRef } from 'react';
import type { PartyState } from '../../../shared/types';
import { sfx } from './sfx';

/** Play buzzer / correct / wrong sounds as the party moves between phases. */
export function usePartySounds(state: PartyState | null, opts: { onlyTeamId?: string } = {}) {
  const prev = useRef<PartyState | null>(null);
  useEffect(() => {
    const p = prev.current;
    prev.current = state;
    if (!p || !state || p.songIndex !== state.songIndex) return;
    const mine = (teamId: string | null | undefined) => !opts.onlyTeamId || teamId === opts.onlyTeamId;
    if (p.phase === 'round' && state.phase === 'buzzed' && mine(state.buzz?.teamId)) sfx.buzz();
    else if (p.phase === 'buzzed' && state.phase === 'reveal' && state.last?.teamId && mine(state.last.teamId)) sfx.correct();
    else if (p.phase === 'buzzed' && state.phase === 'round' && mine(p.buzz?.teamId)) sfx.wrong();
  }, [state, opts.onlyTeamId]);
}
