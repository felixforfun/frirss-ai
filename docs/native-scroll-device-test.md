# Native Safari scrolling — on-device test script (iOS Safari, iPhone)

Branch: `fix/native-safari-document-scroll` · Mode gate: **document scrolling = mobile breakpoint AND not standalone** (§4.H option b).

Test on hardware in **iOS Safari (browser tab)** first, then in the **installed PWA (standalone)** — the two modes must behave differently BY DESIGN:

- Browser tab → the document scrolls → Safari's bars collapse and reappear.
- PWA → exact old container architecture, pixel-identical.

Quick mode sanity: run `?scroll=doc` / `?scroll=container` in the browser tab to force either architecture (dev override, cached in `localStorage.frirss_scrollModeOverride` — clear the key or use the opposite value to reset). Verify the current mode in console:

```js
document.documentElement.getAttribute('data-scroll');        // 'doc' in browser tab, null in PWA
document.documentElement.dataset.mobileStack;                // 'list' or 'reading'
getComputedStyle(document.documentElement).getPropertyValue('--frirss-chrome-top-h');
```

---

## A. The goal: Safari bars move (browser tab)

| # | Check | Expected |
|---|-------|----------|
| A1 | Scroll down on the article list | Safari's URL bar + bottom bar collapse (chrome shrinks); list scrolls under |
| A2 | Scroll back up (or flick up) | Bars reappear |
| A3 | Reach the very top | Bars fully expanded, no rubber-band fight |
| A4 | While scrolled, open a server, come back | Bars state resumes naturally, no forced expansion glitch |
| A5 | No horizontal movement at any scroll angle | No sideways slide of the page (container uses `overflow-x: clip` on html/body) |

## B. List behavior (browser tab, `mobileStack: 'list'`)

| # | Check | Expected |
|---|-------|----------|
| B1 | Scroll a long list, open article, pop back | List restored to the exact same offset — no jump to top |
| B2 | The pinned top chrome (safe-area strip + server bar) never collapses by itself; height is constant | `--frirss-chrome-top-h` stable; sticky list header sits exactly under the chrome |
| B3 | Sticky list header sticks while scrolling the document, un-sticks at section boundaries | Sticks at `top: var(--frirss-chrome-top-h)` |
| B4 | Mark-as-read while scrolling: items pass under the pinned chrome | Seen threshold at the chrome edge, NOT under the collapsed URL bar (IO rootMargin = chrome height) |
| B5 | “N new articles” banner while deep-scrolled | Appears pinned below the chrome; tapping it scrolls the document to top |
| B6 | Pull-to-refresh at top | Custom PTR still works; **does not fight Safari’s native PTR** — no double bounce, no dead grip |
| B7 | Swipe a row left/right while the document is mid-scroll | Row swipes fine; the page must not scroll diagonally (`touch-action: pan-y`) |

## C. Reader (browser tab, `mobileStack: 'reading'`)

| # | Check | Expected |
|---|-------|----------|
| C1 | Open an article | Push slide-in with dim + parallax, reader starts at top |
| C2 | Scroll the article | **Document** scrolls → Safari bars collapse/reappear inside the article too |
| C3 | Reading progress tracking | % read and progress line track the document scroll, 100% at the real bottom |
| C4 | Open a linked page inside the article, then go back | Scroll position of that linked page restored |
| C5 | Leave reader, re-open the same article | Position restored (not forced to top) |
| C6 | Bottom action bar (mark unread, open link…) | Stays pinned at the visual bottom while the document scrolls |
| C7 | Find-in-page / jump to anchors | Works, chrome offset respected |
| C8 | Pop back to list | Slide-out; **the list is visible behind the receding reader**, restored before first paint (the base counter-slide is a frozen snapshot — simplified transition is accepted by the brief) |

## D. Overlays (scroll lock)

Drawer, bottom sheets, command palette, preferences, confirm dialog — while one is open:

| # | Check | Expected |
|---|-------|----------|
| D1 | Try to scroll behind the overlay | Background does not move (body freeze) |
| D2 | Close the overlay | No jump — the page is where it was, synchronously (no visible “settle down”) |
| D3 | Drawer → nested confirm dialog | Still frozen behind the stack, single restore at the end |

## E. Modes that must NOT change (§0.1 pixel identity)

| # | Check | Expected |
|---|-------|----------|
| E1 | Installed PWA (standalone) | List scrolls in its own container exactly as before; no document scrolling; bar behavior identical to previous build |
| E2 | PWA: list offset preserved on open/pop | Same as before |
| E3 | Desktop breakpoint (browser and PWA) | Multi-pane layout unchanged, no regressions |
| E4 | Tablet breakpoint | Unchanged |
| E5 | `?scroll=container` override in browser tab | Behaves exactly like E1 (proves the old path is intact under the same build) |

## F. Reduced motion

| # | Check | Expected |
|---|-------|----------|
| F1 | Enable Reduce Motion in iOS Settings, open/pop articles | No slide animations; instant layer swap; scroll restore still exact |

## G. Chrome height reactivity

| # | Check | Expected |
|---|-------|----------|
| G1 | Toggle the server switcher / rotate the device | Chrome height re-publishes (`--frirss-chrome-top-h`), sticky header, banner slot and mark-as-read boundary all follow with no dead zone or overlap |

---

## Known risks to look at closely

1. Custom pull-to-refresh vs Safari native PTR interplay (B6) — biggest unknown.
2. Pop-phase base is a static frozen snapshot (C8) — brief accepts the simplified transition; confirm it doesn’t look broken.
3. Bottom action bar inside the fixed reader layer during push/pop (C6) — verify it never detaches from the bottom edge mid-slide.
4. Mark-as-read boundary right after a chrome height change (G1).

## Quick console aid (browser tab)

Paste in the address bar must start with `javascript:` — iOS strips it; use the console in Safari desktop inspector (Develop → iPhone) instead:

```js
(() => {
  const cs = getComputedStyle(document.documentElement);
  console.table({
    'data-scroll': document.documentElement.dataset.scroll,
    mobileStack: document.documentElement.dataset.mobileStack,
    chromeTopH: cs.getPropertyValue('--frirss-chrome-top-h'),
    scrollY: window.scrollY,
    docHeight: document.documentElement.scrollHeight,
  });
})();
```

Record anything unexpected with a screenshot + the console table above.
