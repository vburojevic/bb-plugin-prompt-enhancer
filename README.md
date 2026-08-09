# bb-plugin-prompt-enhancer

Rewrites the composer's draft prompt into a clearer, more effective prompt —
in place, in the composer input. Click the ⚡ action in any composer: the
draft locks briefly while a hidden bb thread (same provider as the current
thread, or the project default on the new-thread composer) rewrites it, then
the rewritten text replaces the draft. No external APIs — the hidden thread
is the AI.

The ▾ chevron next to the action opens the enhancer model picker: pin an
explicit provider+model for the rewrite, or leave it on "Provider default"
to inherit. The chevron's tooltip shows the pinned model, if any.

While a rewrite runs, the spark doubles as a cancel button (hover shows ✕).
After a rewrite lands, the success toast offers **Undo** to restore the
original draft. Hidden enhancement threads are stopped and deleted as soon
as they resolve, so they never accumulate. All animation collapses to an
instant text swap under `prefers-reduced-motion`.

More:

- **⌘E / Ctrl+E** enhances from the keyboard when the composer is focused.
- The picker's **Style** group picks the rewrite shape: Tighten (default),
  Expand into spec, Add acceptance criteria, Translate to English.
- Follow-up drafts in a thread include the thread title and the tail of the
  last assistant message as context, so "that bug" resolves to the actual bug.
- The rewriter is told how many attachments the draft carries so it never
  invents or drops references to them.
- Settings (`bb plugin config prompt-enhancer`):
  - `previewBeforeApply` (default off) — review the rewrite in an
    Apply/Discard dialog instead of replacing the draft immediately.
  - `customInstructions` — extra instruction appended to every rewrite.

## UI components

`components/ui/` is vendored source you own (the shadcn model): edit the
files freely — they never update out from under you. Add more from the BB
component registry (the full shadcn set, version-matched to your BB install
via the pinned ref in `components.json`):

```
npx shadcn add @bb/dialog @bb/select
```

Run `npm install` once before `bb plugin build` — the vendored components'
npm deps bundle into your dist. React, and BB-shimmed packages like the
radix portal primitives and `sonner` (`import { toast } from "sonner"`
reaches BB's own toaster), are provided by the BB app at runtime and never
bundled. Ship `dist/` (npm tarball or committed for git installs) so
people installing your plugin never need npm.

## Manifest

`package.json` is the plugin manifest. Notable fields:

- `bb.server` — backend entry (required); optional `bb.app` for a frontend.
- `bb.name` and `bb.description` — required human-facing identity.
- `bb.branding` — required; declare `icon` as a BB icon name or a
  plugin-relative compact SVG, or declare `logo.light` (with optional
  `logo.dark`). Logo assets must be relative `.svg`, `.png`, or
  `.webp` files.
- `engines.bb` — supported bb app version range.
- `engines.bbPluginSdk` — supported plugin SDK range (scaffold: `^0.4.1`).

Run `bb plugin build` before publishing git/npm installs. It writes
`dist/server.js` + `server.meta.json` (and, with `bb.app`, `app.js` /
`app.css` / `app.meta.json`). Each `*.meta.json` stamps SDK major/version,
`artifactFormatVersion`, `pluginId`, `pluginVersion`, and
`builtWith` so managed installs can verify the artifacts.

## Install

From this directory:

```
bb plugin install .
```

After editing sources, reload:

```
bb plugin reload prompt-enhancer
```

## Configure

```
bb plugin config prompt-enhancer
bb plugin config prompt-enhancer set greeting hi
```

## Types & API reference

`types/bb-plugin-sdk.d.ts` (and `types/bb-plugin-sdk-app.d.ts` for the
frontend) are the full, bundled BB plugin API — `tsconfig.json` maps
`@bb/plugin-sdk` to them, so your editor and `tsc` see real types with no extra
install. They are readable declarations: open them for an exact signature.

The SDK surface grows with every BB release, and these are a copy. Refresh
them from the BB you are running:

```
bb plugin types          # rewrite types/ from this BB
bb plugin types --check  # CI: fail when they are out of date
```

`bb plugin build` and `bb plugin dev` refresh them for you. Ask BB to write
plugins for you: the `bb-plugin-authoring` skill documents the whole surface
with examples.

Confused by the API, or need something the types don't explain? Clone the BB
repo and read the source: <https://github.com/get-bb/bb>.
