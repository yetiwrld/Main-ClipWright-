// Invariant checks from SPEC 09 §29. Run in development and in tests: a command
// that breaks one of these is a bug, not an edge case.

import type { TimelineState } from './selectors';
import { itemEndUs } from './selectors';
import { frameDurationUs, type Fps } from './time';

export function checkInvariants(state: TimelineState, fps: Fps): string[] {
  const problems: string[] = [];
  const minDuration = frameDurationUs(fps);

  for (const track of state.tracks) {
    const items = track.itemIds
      .map((id) => state.items[id])
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .filter((item) => item.trackId === track.id);

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;
      if (item.startUs < 0) problems.push(`${item.id} starts before zero.`);
      if (item.durationUs < minDuration) problems.push(`${item.id} is shorter than one frame.`);
      if (state.items[item.id] && state.items[item.id]!.trackId !== track.id) {
        problems.push(`${item.id} is listed on ${track.id} but belongs to ${state.items[item.id]!.trackId}.`);
      }
      const next = items[index + 1];
      if (next && itemEndUs(item) > next.startUs) {
        problems.push(`${item.id} overlaps ${next.id} on ${track.name}.`);
      }
      if (item.sourceDurationUs && item.mediaId) {
        const used = item.sourceInUs + item.durationUs * (item.speed ?? 1);
        if (item.sourceInUs < 0 || used > item.sourceDurationUs + 1) {
          problems.push(`${item.id} reads outside its source media.`);
        }
      }
    }

    for (let index = 1; index < items.length; index += 1) {
      if (items[index]!.startUs < items[index - 1]!.startUs) {
        problems.push(`${track.name} item order is not sorted.`);
        break;
      }
    }
  }

  for (const item of Object.values(state.items)) {
    if (!state.tracks.some((track) => track.id === item.trackId)) {
      problems.push(`${item.id} is on a track that does not exist.`);
    }
  }

  const mainTracks = state.tracks.filter((track) => track.role === 'main');
  if (mainTracks.length !== 1) {
    problems.push(`Expected exactly one main track, found ${mainTracks.length}.`);
  }

  return problems;
}
