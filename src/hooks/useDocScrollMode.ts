import { useEffect, useMemo } from 'react';
import { useBreakpoint } from './useBreakpoint';
import { applyDocScrollState, docScrollEnabled } from '../lib/docScrollMode';

/**
 * Document-scrolling entitlement (mobile browser only — see
 * `src/lib/docScrollMode.ts`). Consumers bind their scroll listeners and pick
 * layout classes from this.
 *
 * Publishing `<html data-scroll="doc">` lives here too: the breakpoint may
 * flip at runtime (rotation), and every instance applying the same value
 * keeps the attribute in sync with the JS decision.
 */
export function useDocScrollMode(): boolean {
  const isMobile = useBreakpoint() === 'mobile';
  // Detection is stable for a page's lifetime (the app can't switch between
  // browser tab and installed PWA without a reload), so compute it once.
  const enabled = useMemo(() => docScrollEnabled(), []);
  useEffect(() => {
    applyDocScrollState(isMobile && enabled);
  }, [isMobile, enabled]);
  return isMobile && enabled;
}
