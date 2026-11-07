import { useCallback, useEffect, useRef, useState } from 'react';
import { playheadStore } from './playhead-store';

/**
 * Playback engine (SPEC 09 §23): advances the playhead using
 * requestAnimationFrame at the project fps. Supports loop playback
 * within the work area.
 */
export function usePlayback(durationUs: number, fps: number, workArea?: { inUs: number; outUs: number }) {
  const [isPlaying, setIsPlaying] = useState(false);
  const rafRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);

  const tick = useCallback(
    (timestamp: number) => {
      if (lastTimeRef.current === 0) lastTimeRef.current = timestamp;
      const elapsedMs = timestamp - lastTimeRef.current;
      lastTimeRef.current = timestamp;

      const current = playheadStore.get();
      const deltaUs = elapsedMs * 1_000;
      let next = current + deltaUs;

      // Loop within work area if set
      const loopEnd = workArea ? workArea.outUs : durationUs;
      const loopStart = workArea ? workArea.inUs : 0;

      if (next >= loopEnd) {
        next = loopStart;
      }

      playheadStore.set(next);

      rafRef.current = requestAnimationFrame(tick);
    },
    [durationUs, fps, workArea],
  );

  const play = useCallback(() => {
    if (isPlaying) return;
    setIsPlaying(true);
    lastTimeRef.current = 0;
    rafRef.current = requestAnimationFrame(tick);
  }, [isPlaying, tick]);

  const pause = useCallback(() => {
    setIsPlaying(false);
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
  }, []);

  const toggle = useCallback(() => {
    if (isPlaying) pause();
    else play();
  }, [isPlaying, play, pause]);

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return { isPlaying, play, pause, toggle };
}
