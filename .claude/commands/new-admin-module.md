Scaffold a complete new admin module for the Belltower project. The user will provide a module name and capability flag as arguments (e.g. `/new-admin-module incidents can_manage_students`).

Parse the arguments from the invocation. If no arguments were provided, ask the user for: (1) module name in kebab-case, (2) the capability flag from the profiles table that gates access.

Then do all four steps:

## Step 1 — Create `app/admin.[module-name].js`

Use `app/admin.promotion.js` as a reference for the structure. The file must:
- Import from `'./admin.supabase.js'` (never `./supabaseClient.js`)
- Declare module-level state: `let _profile = null; let _initialized = false;`
- Export `async function init[ModuleName]Section(profile)` as the entry point
- Wire DOM events inside an `if (!_initialized) { _initialized = true; ... }` guard
- Include a placeholder load function and an empty render function to start

## Step 2 — Add nav link in `app/admin.html`

Read `app/admin.html` first. Find the Settings nav section (near `#promotion` and `#access` links). Insert:
```html
<a href="#[module-name]" data-cap="[capability-flag]"><i data-lucide="ICON"></i> [Label]</a>
```
Choose a fitting Lucide icon. Place it in a logical position relative to existing nav items.

## Step 3 — Add section HTML in `app/admin.html`

Insert a new section before `<section id="schools" class="admin-section">`:
```html
<section id="[module-name]" class="admin-section">
  <div class="admin-content fade-in">
    <div class="panel">
      <h3>[Module Label]</h3>
      <div id="[module-name]Content"><p class="muted" style="font-size:13px;">Loading…</p></div>
    </div>
  </div>
</section>
```

## Step 4 — Add route in `app/admin.core.js`

Read `app/admin.core.js` first. Find the lazy-import routing block (near the `#promotion` route). Add:
```js
if (target === '#[module-name]') {
  const mod = await import('./admin.[module-name].js');
  await mod.init[ModuleName]Section(currentProfile);
}
```

After all four steps are done, confirm what was created and ask what functionality to build first.
