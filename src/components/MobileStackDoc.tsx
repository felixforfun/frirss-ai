import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { prefersReducedMotion } from '../lib/reducedMotion';
import { setMobileStackPhase } from '../lib/docScrollMode';

interface MobileStackDocProps {
  showOverlay: boolean;
  base: ReactNode;
  overlay: ReactNode;
}

type Phase = 'list' | 'pushing' | 'reading' | 'popping';

/**
 * Document-scrolling navigation stack (mobile, Safari browser tab — §4.B of
 * the native-scrolling brief).
 *
 * The document is the only scroller, so the stack has exactly ONE in-flow
 * layer at a time and one frozen, out-of-flow layer:
 *
 *   • `list`      — base (article list) in flow; overlay unmounted.
 *   • `pushing`   — the reading pane mounts as a `position: fixed` viewport
 *                   layer and slides in over the base (which stays IN flow,
 *                   so the already-scrolled document doesn't jump), with the
 *                   same dim + parallax as the container stack.
 *   • `reading`   — the overlay is dropped back into flow (swap happens in
 *                   one synchronous commit together with `scrollTo(0,0)`):
 *                   the reader now owns the document. The base is frozen via
 *                   `display: none` so it contributes no document height.
 *   • `popping`   — both layers become fixed again: the base re-frozen at its
 *                   saved offset (`top: chrome − savedScrollY` reproduces the
 *                   exact live rendering), the overlay slides out; one commit
 *                   later the base returns to flow and the document scroll
 *                   position is restored — the saved list position comes back
 *                   before the first post-pop paint.
 *
 * Why `top: chrome − scrollY`: in flow, content offset `c` of the layer sits
 * at document Y `chrome + c`; at scroll = S the viewport shows it at viewport
 * Y `chrome + c − S`. A fixed layer with `top = chrome − S` puts slot `c` at
 * the same viewport Y — pixel-identical continuation, with the pinned chrome
 * overlaying the first `chrome` pixels exactly as in the live view. Sticky
 * children (list header) compute their natural position because the document
 * is clamped to scroll 0 while layers are fixed, which matches the frozen
 * snapshot.
 *
 * Scroll memory: the base's scroll position is captured at push and restored
 * at pop (`baseScrollRef`); the reader's own position at pop-start capture
 * (`readerScrollRef`) only matters for the freeze offset. Layer phases are
 * published through `setMobileStackPhase` so the article list can stop
 * treating window scroll events as its own while the reader owns the
 * document.
 *
 * Transition note: the base counter-slide on pop is static (frozen snapshot)
 * rather than animated — the overlay slide remains, which satisfies the
 * "simplified transition" allowance for §0.3 item 4.
 */
export default function MobileStackDoc({ showOverlay, base, overlay }: MobileStackDocProps) {
  const [phase, setPhase] = useState<Phase>('list');
  const [visible, setVisible] = useState(false);
  const baseScroll = useRef(0);
  const readerScroll = useRef(0);

  // Cache overlay content during the exit animation (same as container mode).
  const cachedOverlay = useRef<ReactNode>(null);
  if (overlay) cachedOverlay.current = overlay;

  const reduced = prefersReducedMotion();

  const wasShown = useRef(false);
  useLayoutEffect(() => {
    if (showOverlay && !wasShown.current) {
      // PUSH — capture the document scroll as the list's saved position.
      // The base does NOT leave the flow here: the document height and the
      // scroll offset are untouched, so this commit cannot jump anything.
      baseScroll.current = window.scrollY;
      setVisible(false);
      setPhase('pushing');
    } else if (!showOverlay && wasShown.current) {
      // POP — capture the reader's current document offset to freeze it in
      // place; `baseScroll` still holds the saved list position.
      readerScroll.current = window.scrollY;
      setVisible(false);
      setPhase('popping');
    }
    wasShown.current = showOverlay;
  }, [showOverlay]);

  // Publish the layer phase BEFORE paint so ArticleList's window-scroll
  // handler never mistakes the reader's scrolling for list scrolling.
  useLayoutEffect(() => {
    setMobileStackPhase(phase === 'reading' ? 'reading' : 'list');
  }, [phase]);

  // ── Push animation: slide the fixed overlay in ────────────────────
  useEffect(() => {
    if (phase !== 'pushing') return;
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)));
    const t = setTimeout(() => setPhase('reading'), reduced ? 40 : 400);
    return () => { cancelAnimationFrame(raf); clearTimeout(t); };
  }, [phase, reduced]);

  // ── Reading commit: one synchronous swap, reader owns the document ──
  useLayoutEffect(() => {
    if (phase !== 'reading') return;
    // The reader starts at the top exactly as the container stack does — a
    // no-op for a fresh article, and a restore for a re-opened one is owned
    // by ReadingPane itself.
    window.scrollTo(0, 0);
  }, [phase]);

  // ── Pop animation: slide the fixed overlay out ────────────────────
  useEffect(() => {
    if (phase !== 'popping') return;
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)));
    const t = setTimeout(() => setPhase('list'), reduced ? 40 : 400);
    return () => { cancelAnimationFrame(raf); clearTimeout(t); };
  }, [phase, reduced]);

  // ── List commit: base returns to flow with its scroll restored ─────
  useLayoutEffect(() => {
    if (phase !== 'list') return;
    window.scrollTo(0, baseScroll.current);
  }, [phase]);

  const reducedMotion = reduced;
  const transition = reducedMotion ? undefined : 'transform 0.35s cubic-bezier(0.32, 0.72, 0, 1)';
  const dimTransition = reducedMotion ? undefined : 'opacity 0.35s ease';

  // Chrome top offset as an inline reference for layer tops.
  const CH = 'var(--frirss-chrome-top-h, 0px)';

  const showDim = phase === 'pushing' || phase === 'popping';
  const dimOpacity = visible ? 0.15 : 0;

  const overlayMounted = phase !== 'list';
  const overlayEl = overlayMounted ? cachedOverlay.current : null;

  return (
    <>
      {/* ── Base view (article list / publisher preview) ─────────────── */}
      {phase === 'reading' ? (
        // Frozen: out of the document entirely — contributes no height, keeps
        // list state (store, seen-rows) alive for the return trip.
        <div style={{ display: 'none' }}>{base}</div>
      ) : phase === 'popping' ? (
        // Frozen snapshot, visible under the sliding overlay. `top` places
        // the scrolled content offset exactly where the live document had
        // it (see class doc); scrollY is clamped to 0 while the layers are
        // fixed, so children keep their natural (un-stuck) positions.
        <div
          style={{
            position: 'fixed',
            left: 0,
            right: 0,
            width: '100%',
            top: `calc(${CH} - ${Math.max(0, baseScroll.current)}px)`,
            background: 'var(--panel-bg)',
            transform: `translateX(${visible ? 0 : -80}px)`,
            transition,
          }}
        >
          {base}
        </div>
      ) : (
        // In flow: 'list' (and 'pushing', where it stays live-scrolled).
        <div
          className="relative"
          style={{
            transform: phase === 'pushing' ? `translateX(${visible ? -80 : 0}px)` : undefined,
            transition: phase === 'pushing' ? transition : undefined,
            background: 'var(--panel-bg)',
          }}
        >
          {base}
        </div>
      )}

      {/* ── Dim layer ───────────────────────────────────────────────── */}
      {showDim && (
        <div
          className="pointer-events-none z-10"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'black',
            opacity: dimOpacity,
            transition: dimTransition,
          }}
        />
      )}

      {/* ── Overlay view (reading pane) ─────────────────────────────── */}
      {overlayMounted && (
        phase === 'reading' ? (
          // In flow: the reader grows the document, the navigational chrome
          // above stays pinned, the reader scrolls the document.
          <div
            className="relative flex flex-col"
            style={{ minHeight: `calc(100svh - ${CH})`, background: 'var(--panel-bg)' }}
          >
            {overlayEl}
          </div>
        ) : (
          // Fixed viewport layer during push/pop. `overflow: clip` is used
          // rather than `hidden` — it must not become a scroll container
          // (§4.D); `inset: 0` keeps the layer a viewport-sized box so
          // ReadingPane's own anchored bars stay visually bottom-pinned
          // while it slides.
          <div
            className="z-20"
            style={{
              position: 'fixed',
              inset: 0,
              background: 'var(--panel-bg)',
              overflow: 'clip',
              boxShadow: '-2px 0 20px rgba(0,0,0,0.1)',
              transform: `translateX(${visible ? 0 : '100%'})`,
              transition,
            }}
          >
            {overlayEl}
          </div>
        )
      )}
    </>
  );
}
