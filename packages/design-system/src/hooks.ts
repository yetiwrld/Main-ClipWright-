import { useState, useEffect } from 'react';

export type LayoutTier = 'compact' | 'standard' | 'large';

export function computeLayoutTier(width: number): LayoutTier {
  if (width < 1366) return 'compact';
  if (width < 1920) return 'standard';
  return 'large';
}

export function useLayoutTier(overrideWidth?: number): LayoutTier {
  const [tier, setTier] = useState<LayoutTier>(() =>
    computeLayoutTier(overrideWidth ?? (typeof window !== 'undefined' ? window.innerWidth : 1440))
  );

  useEffect(() => {
    if (overrideWidth !== undefined) {
      setTier(computeLayoutTier(overrideWidth));
      return;
    }
    const handleResize = () => {
      setTier(computeLayoutTier(window.innerWidth));
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [overrideWidth]);

  return tier;
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return (
      window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
      document.documentElement.getAttribute('data-reduced-motion') === 'true'
    );
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () =>
      setReduced(mq.matches || document.documentElement.getAttribute('data-reduced-motion') === 'true');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return reduced;
}
