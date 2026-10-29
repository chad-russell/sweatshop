# 0089 — Sidebar: a Projects list, a Chats section, one indent rule

Status: **approved by the owner in chat.**

Refines 0087. Supersedes 0007's per-group **Unfiled** sub-section.

## Problem

- Rows are indented inconsistently. Each row kind computes its own padding.
  Folder rows reserve a drag-handle slot, but Unfiled, age labels and
  conversation rows don't. So a project's chats can sit left of its folders'
  chevrons, and Unfiled once sat left of its own project.
- The Conversations heading takes up a full row and pushes every item one
  level in, but it only exists to carry a ⋯ menu.
- Chats (conversations without a project) looked like a project and could be
  dragged in among the projects. It is a different kind of thing: the
  catch-all for chats that have no project.

## Behavior

### Layout (Projects view)

```
Inbox / PRs / Projects / Sandboxes / Previews      (nav, unchanged)
PROJECTS                                       ⋯
  ▸ ⧉ cn                    17
  ▾ ⧉ sweatshop             81
      ▸ 📁 Design docs        3
        TODAY
          Fix sidebar nesting
          …
CHATS
  ▸ 📁 Some folder
    TODAY
      Plain chat
```

- **Projects**: a heading with a ⋯ menu, then one row per project. Projects
  can be reordered by dragging and with Move up / Move down, the same as in
  0087.
- **Chats**: a heading, then its folders and chats laid out the same way as a
  project's contents. It always comes after the projects. It can't be dragged
  or reordered, but it can still have folders. It isn't collapsible: the
  heading is just a label, the same as Projects.
- Both sections share one scroll area.
- The **Conversations** heading is removed. Its ⋯ menu moves to the Projects
  heading and keeps everything it has now: Projects / Recent view, Reset
  order, Archive, Trash. In the Recent, Archive and Trash views, and while
  searching, the heading shows that name (or the match count) in place of
  "Projects", as the Conversations heading does today. The Recent view is
  otherwise unchanged.

### No Unfiled level

- A project's (or Chats') own chats are listed right after its folders,
  under the same age labels as today (Today, Yesterday, …).
- To unfile a chat, drop it on its project's row (or on the Chats heading),
  or use Move → *Top level*. That is already how the group header behaves.
- The `unfiled:<id>` expanded preference is no longer read. Old stored keys
  are ignored.

### One indent rule

Every tree row is laid out on the same grid:
`[indent = depth × INDENT][handle slot][chevron slot][icon][label]`.

- The handle and chevron slots are always there, left empty when a row has no
  drag handle or no children. So everything at the same depth lines up, and a
  child's chevron sits under its parent's icon.
- Age labels sit at the depth of the chats they label, aligned with those
  chats' text.
- Thread children (0040) keep their guide line and nest one level deeper.
- One shared constant and helper set the indent, instead of each component
  computing its own.

## Testing

- Unit tests: group ordering leaves out Chats (already done on this branch),
  and the indent helper.
- Browser check of the left edges at each depth, plus before/after
  screenshots in the PR.
