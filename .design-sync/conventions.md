## Belltower design tokens

This is a **tokens-only** sync — Belltower is a vanilla HTML/CSS/JS app with
no component framework, so there are no reusable components to import. What's
here is the real, unmodified token vocabulary from the app's two stylesheets.
Build designs by writing plain CSS/HTML that consumes these custom
properties directly — do not invent a component library or a different
class/token naming scheme.

### Wrapping and setup

No provider or wrapper is required. Load `styles.css` (it `@import`s
everything below) and use the CSS custom properties directly, e.g.
`background: var(--surface); color: var(--text-primary);`. There are two
independent token namespaces — don't mix them:

- **Admin/app namespace** (`--*`, from `admin-ui.css`) — the default for
  any staff-facing screen (dashboards, tables, forms, admin panels).
- **Carline namespace** (`--cl-*`, from `carline.css`) — only for
  dismissal/kiosk-style full-screen displays. Supports dark mode via
  `[data-theme="dark"]` on a wrapping element, and a font-size scale via
  `[data-fontsize="sm"|"md"|"lg"]`.

### The token vocabulary

Admin namespace — surfaces & text:
`--app-bg` `--surface` `--border` `--text-primary` `--text-secondary` `--text-muted`

Admin namespace — brand & status (use for actions/badges/alerts, never hex):
`--primary` `--primary-hover` `--success` `--warning` `--danger`

Admin namespace — elevation & layering:
`--elevation-1` / `--elevation-2` (box-shadow values) and a z-index scale
`--z-drawer-overlay` `--z-drawer` `--z-modal` `--z-toast` `--z-flatpickr` `--z-overlay-top`
(respect this stacking order for any overlay/modal/toast you design).

Carline namespace mirrors the same roles under `--cl-*`
(`--cl-bg` `--cl-surface` `--cl-border` `--cl-text` `--cl-text-sub` `--cl-text-muted`
`--cl-primary` `--cl-primary-dark`), plus state-specific triads for its card
states: `--cl-waiting-*`, `--cl-called-*`, `--cl-recalled-*` (each has
`-bg`/`-border`/`-text`/`-hdr`), and layout tokens `--cl-header-h` `--cl-bar-h`
`--cl-radius` (10px) `--cl-card-name-size`.

No token exists for typography/spacing/radius scales — those are used as
literal values, consistently, across the app:
- **Type scale**: 11/12/13/14px for body and dense UI, 16-20px for section
  headers, 24px for page titles. Body copy uses `font-weight: 400`; labels
  and emphasis use 500/600; headings/badges use 600-700(-800).
- **Radius**: 4-6px for small controls (inputs, chips), 8-10px for cards and
  buttons, 999px for pills/avatars/badges.
- **Spacing/gap**: an 8px-ish rhythm — 4, 6, 8, 10, 12, 14, 16px are all in
  active use; don't invent off-scale values.

### Where the truth lives

- `styles/admin-ui.css` — the full admin design system (buttons, forms,
  tables, badges, drawers, modals) as shipped in the real app.
- `styles/carline.css` — the full carline/kiosk stylesheet, light + dark.
- `styles/fonts.css` — the Google Fonts `@import`s the app itself uses.

### Build snippet

```html
<link rel="stylesheet" href="./styles.css">
<div style="background:var(--app-bg);min-height:100vh;padding:24px;
            font-family:Inter,ui-sans-serif,system-ui,sans-serif;">
  <div style="background:var(--surface);border:1px solid var(--border);
              border-radius:10px;box-shadow:var(--elevation-1);padding:16px;">
    <h2 style="color:var(--text-primary);">Card title</h2>
    <p style="color:var(--text-secondary);">Body copy at 13-14px.</p>
    <button style="background:var(--primary);color:#fff;border:0;
                    border-radius:8px;padding:9px 14px;font-weight:600;">
      Primary action
    </button>
  </div>
</div>
```
