# 0080 — Mobile composer: one settings chip instead of three controls

Status: **implemented on `feat/mobile-composer`.** Part of the chat-UI
decluttering pass (sidebar spinner fix, 0078's work pill, 0079's outline
tray, this).

## Why

The composer footer's model picker, sandbox picker, and (when a
project has hosts) the host auto-approve toggle sit inline next to the
work chip and the usage control. At 390px, measured with a real chat,
those five controls fit on one row only because two of them truncate —
and the row overflows as soon as the work chip ("N working") or the
host toggle also show. Desktop has the room; mobile doesn't, and
nothing here needs to be reachable in one tap on a phone the way the
textarea and submit button do.

## Decisions

1. **Desktop is untouched.** At `sm` (640px) and up, the exact same
   three components render with the exact same classes they always
   have — `components/composer-settings.tsx` just relocated their
   definitions (`SandboxPicker`, `HostAutoApproveToggle`) out of
   `components/chat.tsx`, which no longer has any other call site for
   them.
2. **Below `sm`, one chip opens a bottom sheet.** The chip shows a
   sliders icon, the short model label (`routePickerLabel` — factored
   out of `RoutePicker`'s own trigger-text computation in
   `components/route-picker.tsx`, so the chip and the full picker say
   the same thing without a second `RoutePicker` mounted to ask), and a
   small dot (`hasBoundSandbox`) when a sandbox is actually
   attached/owned — not merely picked. Tapping it opens "Chat
   settings": the same `RoutePicker`/`SandboxPicker`/
   `HostAutoApproveToggle` components, full-width, each under a plain
   text label ("Model", "Sandbox", "Auto-approve host commands" via the
   toggle's own inline text). `HostAutoApproveToggle` gained a
   `className` prop (unused behaviour otherwise) so the sheet can make
   it full-width the same way `SandboxPicker`/`RoutePicker` already
   accept one.
3. **CSS-only switching, not a media-query hook.** The repo has no
   `useIsMobile`-style hook, and a JS media query risks a hydration
   mismatch (server render doesn't know the client's viewport). Both
   subtrees mount: the desktop trio sits in a `hidden sm:contents`
   wrapper (invisible below `sm`, laid out as direct children at `sm`
   and up), and the mobile chip's trigger sits in a plain `sm:hidden`
   one. The sheet's own copies of the three controls only exist in the
   DOM while the sheet is open — that's just how a Radix `Dialog`
   already behaves (`Dialog.Content` doesn't render until `open`), not
   anything built for this — so there is never a moment with two
   *visible* copies of the same control, and the only always-mounted
   duplicate (the hidden desktop trio) carries no side effects: neither
   `RoutePicker` nor `SandboxPicker` fetches anything itself, both just
   render whatever `view`/`sandboxes` props the frame already fetched
   once, and `onOpen` only fires when a user actually opens a dropdown
   — which an invisible (`display: none`) trigger can't do. Verified in
   a real browser at 390px: two `aria-label="Sandbox"` buttons exist in
   the DOM, but only one has a non-zero `getBoundingClientRect()` at a
   time.
4. **The sheet is a restyled `Dialog`, not a new primitive.** No Sheet/
   Drawer component exists in `components/ui/`, and the brief forbids
   a new dependency. `components/ui/dialog.tsx`'s `DialogContent`
   hardcodes centered-modal positioning classes that would need
   overriding on nearly every property (position, translate, radius,
   max-width) — fragile to get right purely through Tailwind-merge
   override strings. Simpler and more robust: use the exported
   `Dialog`/`DialogPortal`/`DialogOverlay`/`DialogTitle`/
   `DialogDescription` wrappers (none of which carry positioning
   opinions) and reach for the raw `Dialog.Content`/`Dialog.Trigger`/
   `Dialog.Close` primitives (`radix-ui`) only for the one piece that
   needed a fully custom className: a bottom sheet, full width, rounded
   top corners, `max-h-[85dvh]` with its own scroll, safe-area bottom
   padding, slide-from-bottom open/close animation (the same
   `data-open`/`data-closed` variant convention every other popover-ish
   component here already uses).

## Not doing

A real Sheet/Drawer primitive (one Dialog restyled is enough for the
one place that needs it), swipe-to-dismiss gestures, remembering the
sheet's scroll position, or touching the work chip / usage control
beyond leaving them exactly where they were.
