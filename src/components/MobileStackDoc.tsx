import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
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
 * layer per document scroll position:
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
 *   • `popping`   — the base returns to flow AT POP START, still hidden under
 *                   the sliding overlay, and the document scroll is restored
 *                   in the same synchronous commit — the list is the live,
 *                   scrollable surface the whole time, so a fling the user
 *                   starts mid-pop is not dropped at a later commit. The
 *                   reader freezes as a fixed layer at its own document
 *                   offset (`top: chrome − readerScrollY`, full height) and
 *                   slides out; when it is gone the overlay unmounts with no
 *                   further scroll work.
 *
 * Why restore at pop start: swapping a full-viewport layer from fixed back
 * into flow and re-stamping the scroll offset AFTER the slide (an earlier
 * revision did exactly that) left the list unscrollable for the slide plus a
 * post-commit freeze on iOS WebKit — the touch series began against a frozen
 * snapshot and its momentum was discarded when the element under the finger
 * changed identity. Restoring live flow immediately keeps the same scroll
 * surface from the first post-pop touch, with the saved position back before
 * the first pop paint (the doc-comment invariant that motivated the
 * frozen-snapshot design).
 *
 * Why `top: chrome − scrollY`: in flow, content offset `c` of the layer sits
 * at document Y `chrome + c`; at scroll = S the viewport shows it at viewport
 * Y `chrome + c − S`. A fixed layer with `top = chrome − S` puts slot `c` at
 * the same viewport Y — pixel-identical continuation, with the pinned chrome
 * overlaying the first `chrome` pixels exactly as in the live view. It is
 * what freezes both the reader at pop start and — historically — the base.
 *
 * Scroll memory: the base's scroll position is captured at push and restored
 * at pop-start (`baseScrollRef`); the reader's own position at pop-start
 * capture (`readerScrollRef`) anchors its freeze offset. Layer phases are
 * published through `setMobileStackPhase` so the article list can stop
 * treating window scroll events as its own while the reader owns the
 * document — 'popping' publishes 'list': the document already belongs to the
 * list there.
 *
 * Each layer renders as ONE stable wrapper whose style changes with the
 * phase (never a branch swap), so no subtree re-renders into a new node at a
 * commit — a commit is style-only work plus (pop) the scroll restore.
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
  // 'popping' publishes 'list': the base is live in flow from pop start.
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

  // ── Pop commit: base returns to flow with its scroll restored ──────
  // Synchronous with the first pop render, so the restored position and the
  // scrollable surface are truth from the FIRST POP PAINT — the sliding
  // overlay covers the repaint; there is no post-slide commit to wait for.
  useLayoutEffect(() => {
    if (phase !== 'popping') return;
    window.scrollTo(0, baseScroll.current);
  }, [phase]);

  // ── Pop animation end: only the overlay unmount stays ──────────────
  useEffect(() => {
    if (phase !== 'popping') return;
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)));
    const t = setTimeout(() => setPhase('list'), reduced ? 40 : 400);
    return () => { cancelAnimationFrame(raf); clearTimeout(t); };
  }, [phase, reduced]);

  const reducedMotion = reduced;
  const transition = reducedMotion ? undefined : 'transform 0.35s cubic-bezier(0.32, 0.72, 0, 1)';
  const dimTransition = reducedMotion ? undefined : 'opacity 0.35s ease';

  // Chrome top offset as an inline reference for layer tops.
  const CH = 'var(--frirss-chrome-top-h, 0px)';

  const showDim = phase === 'pushing' || phase === 'popping';
  const dimOpacity = visible ? 0.15 : 0;

  const overlayMounted = phase !== 'list';
  const overlayEl = overlayMounted ? cachedOverlay.current : null;

  // ── Base (article list / publisher preview) — ONE stable wrapper ──
  // `display: none` keeps list state alive during reading (a subtree with
  // display none contributes no document height); pop start re-reveals it
  // live, straight under the sliding overlay.
  const baseStyle: CSSProperties = {
    background: 'var(--panel-bg)',
    display: phase === 'reading' ? 'none' : undefined,
    transform: phase === 'pushing' ? `translateX(${visible ? -80 : 0}px)` : undefined,
    transition: phase === 'pushing' ? transition : undefined,
  };

  // ── Overlay (reading pane) — ONE stable wrapper ────────────────────
  let overlayStyle: CSSProperties;
  if (phase === 'reading') {
    // In flow: the reader grows the document, the navigational chrome above
    // stays pinned, the reader scrolls the document.
    overlayStyle = {
      position: 'relative',
      minHeight: `calc(100svh - ${CH})`,
      background: 'var(--panel-bg)',
    };
  } else if (phase === 'pushing') {
    // Fixed viewport layer while sliding in. `overflow: clip` is used rather
    // than `hidden` — it must not become a scroll container (§4.D); `inset: 0`
    // keeps the layer a viewport-sized box so ReadingPane's own anchored bars
    // stay visually bottom-pinned while it slides.
    overlayStyle = {
      position: 'fixed',
      inset: 0,
      background: 'var(--panel-bg)',
      overflow: 'clip',
      boxShadow: '-2px 0 20px rgba(0,0,0,0.1)',
      transform: `translateX(${visible ? 0 : '100%'})`,
      transition,
    };
  } else {
    // Fixed freeze while sliding out. The reader keeps its exact document
    // offset: `top = chrome − readerScroll` puts content slot `c` at the
    // viewport Y it had in flow (see class doc), and the wrapper is as tall
    // as the reader content so the visible slice is unperturbed. No
    // `overflow: clip` and no bottom edge: the moving slice must not clip
    // its content, and the reader's own anchored bars sit at the wrapper's
    // natural bottom, which coincides with the viewport bottom while the
    // offset is in range.
    overlayStyle = {
      position: 'fixed',
      left: 0,
      right: 0,
      top: `calc(${CH} - ${Math.max(0, readerScroll.current)}px)`,
      background: 'var(--panel-bg)',
      boxShadow: '-2px 0 20px rgba(0,0,0,0.1)',
      transform: `translateX(${visible ? 0 : '100%'})`,
      transition,
    };
  }

  return (
    <>
      {/* ── Base view ─────────────────────────────────────────────────── */}
      <div className="relative" style={baseStyle}>
        {base}
      </div>

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

      {/* ── Overlay view ─────────────────────────────────────────────── */}
      {overlayMounted && (
        <div
          className={phase === 'reading' ? 'relative flex flex-col' : 'z-20'}
          style={overlayStyle}
        >
          {overlayEl}
        </div>
      )}
    </>
  );
}
