# 0006 — Export / copy paths

Status: **Proposed**

Related: [feature 0019 — Tileview toolbar & selection](0019-tileview-toolbar-and-selection.md)
(**produces** the selection this feature exports — the selection model, marquee,
Files/Folders toggle and toolbar all moved there when this discussion outgrew
"export"), [issue 0002 — Background scanning service](../issues/0002-background-scanning-service.md)
(the **read-only** non-goal this feature deliberately works *within*),
[feature 0004 — search & filter](0004-search-and-filter.md) (another natural producer
of a path set to export).

## Scope

This feature is now **just the export action**: take the selection set built by
[0019](0019-tileview-toolbar-and-selection.md) and turn it into **clipboard text or a
downloaded file**. How nodes get *selected* (the marquee, checkboxes, Files/Folders
mode, subsumption, persistence) is 0019's concern; this doc covers only what happens
when the user hits **Export**.

## Goal

Help the user **act on** what they found — without the tool ever acting for them. Hand
the user the *paths* for their current selection so they can go delete / move / archive
with their own tools.

## The boundary this respects

The viewer is **strictly read-only** (see 0002's non-goals): it never deletes, moves,
or writes into the scanned roots. That's a safety decision for a NAS tool, not a gap.
This feature is the sanctioned middle ground — it hands the user the *information* to
act, and stops there. The destructive decision and the destructive command both live
entirely outside this app, with the user.

So: **no mutation endpoints, no "delete" button, ever.** Just "here are the paths, now
they're on your clipboard / in a `.txt`."

## The one thing to get right: which path?

The store deliberately keeps **host paths server-side** — the client addresses nodes by
`root` + relative `path`, and real host paths never reach the browser (0002 /
[config.ts](../../server/src/config.ts)). But to actually `rm` or `mv` something, the
user needs a path meaningful **on the machine where they'll run the command** — usually
the host/NAS path, not the app's internal relative form.

Options, to decide:

- **Relative-to-root** (e.g. `Photos/2019/huge.iso`) — always safe to expose, already
  known to the client, but the user must prepend the share location themselves.
- **Reconstructed host path** — join the root's server-side `absolutePath` with the
  relative path **on the server** and return the string for export only. More directly
  usable, but it re-exposes host paths the design otherwise hides, so it should be an
  explicit, server-side, export-only endpoint — never leaked into the normal tree/tile
  responses.
- **Configurable prefix** — let the operator set a display/base path per root (the
  share's UNC/NFS mount as the *user* sees it, which may differ from the container's
  mount point anyway) that gets prepended on export.

## Shape of the change

- **Export UI** — two buttons on the [0019](0019-tileview-toolbar-and-selection.md)
  toolbar (next to the selection count + Clear), disabled when the selection is empty:
  - **Copy** → **clipboard** (`navigator.clipboard.writeText`).
  - **Save** → **download as file** (`.txt`, one path per line; maybe `.csv` with
    size/mtime columns for triage).

  Both read the current selection and apply **subsumption** (0019 — directories
  collapse to one line, descendants dropped) before emitting paths.
- If **host-path reconstruction** is chosen, a small **export-only** endpoint, e.g.
  `POST /api/export/paths { root, paths[] } → text`, that does the server-side join
  under the same traversal guards as every other path input — rather than ever shipping
  host paths through the tree API. With relative-to-root (± an operator prefix) the
  export is entirely client-side and needs no endpoint.

## Open questions

- **Which path form is the default** — the core decision. Likely relative-to-root by
  default with an optional operator-set prefix, and host-path reconstruction gated
  behind explicit config + the export-only endpoint.
- **Format:** plain list vs. CSV-with-metadata (size, mtime) to help the user triage
  before deleting.
- **Quoting/escaping** for paths with spaces/newlines if the export is meant to be
  pasted into a shell — or explicitly document "this is a list, not a script."

## Recommendation

Build the **read-only export** (clipboard + file), default to **relative-to-root**
paths with an optional operator-configured base prefix, and keep host-path
reconstruction behind explicit config + an export-only endpoint. Never add a mutation
path. This gives the user real leverage while keeping the tool's safety boundary
intact.

## Decision

Not yet decided — pending the path-form, format, and quoting questions above. The
selection model that feeds this is settled in [0019](0019-tileview-toolbar-and-selection.md).
