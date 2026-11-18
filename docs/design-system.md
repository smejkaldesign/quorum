# Design system

The desktop renderer (`app/src`, `app/ee/src`) has one stylesheet, `app/src/styles.css`, and one file of shared React controls, `app/src/controls.tsx`. Admin (`admin/src/styles.css`) copies the token names and values so the two look alike.

## Tokens

All tokens live in the first `:root` block of `styles.css`. `:root[data-dev]` overrides the brand set so the development copy runs green. Use a token when one has the role you need; add a token only when a value repeats and has one clear role.

| Group | Tokens | Use |
|---|---|---|
| Surfaces | `--panel`, `--card`, `--card-2`, `--menu-bg`, `--container-bg`, `--container-tile` | Window, cards, menus, grouped settings containers and their tiles |
| Lines | `--line`, `--line-2`, `--menu-line`, `--container-border`, `--line-hover` | Dividers, outlined controls, and the outlined button hover border |
| Dividers | `--divider`, `--divider-subtle` | `--divider` between sections (Home) and under list headers; `--divider-subtle` between rows of a list (Notifications, Memory health) |
| Text | `--text`, `--muted`, `--text-soft`, `--text-faint`, `--text-dim` | Primary text, secondary text, reading body copy, heading marks and placeholders, list markers and paths |
| Hover | `--hover` | Background of a hovered row, menu item or icon button |
| Brand | `--brand`, `--brand-rgb`, `--brand-soft`, `--brand-tint`, `--brand-grad-a`, `--brand-grad-b`, `--brand-deep`, `--brand-graph` | Primary actions, focus rings, selection |
| Status | `--go`, `--go-rgb`, `--caution`, `--stop`, `--danger`, `--danger-rgb`, `--danger-bg` | Live and recording state, warnings, destructive actions |
| Review | `--review`, `--review-rgb`, `--issue`, `--issue-rgb`, `--issue-text`, `--ok`, `--ok-rgb` | In review marks and counts, problems, resolved items |
| Layout | `--page-w` | Width of the main page column |
| Shadow | `--menu-shadow` | Menus and popovers |

The `-rgb` tokens hold a bare `r, g, b` triple for tints: `rgba(var(--go-rgb), 0.14)`.

The note editor scopes its own set (`--ed-text`, `--ed-faint`, `--ed-code-bg`, `--ed-quote`) on `.note-view` and `.note-rich`, with light values under `:root[data-theme="light"]`.

## Shared components

Import these from `app/src/controls.tsx` (`../../src/controls` from `app/ee/src`).

| Component | Renders | Use for |
|---|---|---|
| `Row` | `.set-row` with icon, title, description and an optional control | A settings line |
| `Toggle` | `.switch` checkbox | An on or off setting |
| `useMenu` | Open state that closes on any outside click | A small dropdown |
| `Modal` | `.palette-scrim` > `.modal` with a labelled `h2` | Any sheet. A press on the scrim or Escape calls `onClose`. `locked` ignores both while work runs. `escape={false}` when the sheet listens for Escape on the window |
| `ModalActions` | `.modal-actions` with a `start` slot and `.modal-actions-end` | The button row at the bottom of a sheet |
| `EmptyState` | `.set-card.set-zero` with icon, title and children | A settings list with nothing in it yet |
| `Segmented` | `.seg` with one button per option | A two to four way switch. `kind="tabs"` for a view switch, `kind="radio"` inside a form, `kind="pressed"` for a toggle pair. `inline` renders a span |

`ConfirmModal` (`app/src/ConfirmModal.tsx`) is a ready yes or no sheet built on `Modal` for steps that cannot be undone.

## Shared classes

These are styled once in `styles.css` and used directly in JSX:

- Buttons: `.pill` (outlined), `.pill.primary`, `.small-pill`, `.danger-pill`, `.act-pill`, `.icon-btn`, `.link-btn`, `.text-btn`
- Menus: `.menu-wrap` > `.menu`, `.menu-sep`; `button.checked` marks the current choice
- Settings: `.set-card`, `.set-line`, `.set-label`, `.set-field`, `.set-select`, `.set-error`, `.set-note`, `.set-hint`
- Counts and badges: `.nf-count` (`.review` for In review), `.meta-pill`

## Rules

- Colors come from tokens. A literal color in a rule is a one-off with no role yet.
- A pattern used in three or more places becomes a component in `controls.tsx`.
- Keep class names that tests or other rules select on when you extract a component; the component renders the same classes.
