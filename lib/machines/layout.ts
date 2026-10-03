import { END, type MachineDefinition } from "./definition";

/**
 * 0014 automatic layout: a small layered (Sugiyama-style) layout for
 * machine graphs — pure, no positions stored anywhere. Machines are at
 * most 30 stages × 8 transitions, so the simple algorithm is plenty:
 *
 *  1. back edges: a DFS from `start` (then any unreached stage) marks
 *     edges that close a cycle — loops like verify → implement;
 *  2. ranks: longest path over the remaining forward edges (so a stage
 *     sits right of everything that leads to it); `end` takes the last
 *     rank; unreachable stages still get a rank from their own sources;
 *  3. order within a rank: a few barycenter sweeps to reduce crossings,
 *     seeded by definition order so the result is deterministic;
 *  4. coordinates: rank → x, slot → y, each rank centred vertically
 *     ("LR"); or rank → y, slot → x, each rank centred horizontally
 *     ("TB" — for narrow containers and phones, where a long chain reads
 *     by scrolling down instead of panning sideways).
 *
 * Pure (no Node, no React) — used by the graph views and unit tests.
 */

export const END_NODE = END;

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  rank: number;
}

export interface LayoutEdge {
  id: string;
  source: string;
  target: string;
  /** Index into the source stage's `next` (null = implicit end edge). */
  index: number | null;
  /** Closes a cycle (drawn as a returning curve). */
  back: boolean;
  /** A stage with no `next` ends the run: an implied, dashed edge. */
  implicit: boolean;
  when?: string;
}

/** Flow direction: left→right or top→bottom. */
export type LayoutDirection = "LR" | "TB";

export interface Layout {
  direction: LayoutDirection;
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  width: number;
  height: number;
}

export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 84;
/** The terminal `end` node is a narrow pill. */
export const END_WIDTH = 96;
const RANK_GAP = 120;
const SLOT_GAP = 36;
/** Top→bottom: room between ranks for edge labels, and between siblings. */
const RANK_GAP_TB = 72;
const SLOT_GAP_TB = 32;
const SWEEPS = 4;

/** Stable edge id: `<source>-><target>` (targets are unique per source). */
export function edgeId(source: string, target: string): string {
  return `${source}->${target}`;
}

export function layoutMachine(def: MachineDefinition, direction: LayoutDirection = "LR"): Layout {
  const ids = Object.keys(def.stages);
  const known = new Set(ids);
  const hasEnd = ids.some((id) => {
    const next = def.stages[id]!.next;
    return next.length === 0 || next.some((t) => t.to === END);
  });

  // Edges, including implicit "no next → end" ones. Dangling targets (an
  // invalid draft) are skipped: the graph shows what can be drawn.
  const edges: LayoutEdge[] = [];
  for (const id of ids) {
    const next = def.stages[id]!.next;
    if (next.length === 0) {
      edges.push({ id: edgeId(id, END), source: id, target: END, index: null, back: false, implicit: true });
      continue;
    }
    next.forEach((t, index) => {
      if (t.to !== END && !known.has(t.to)) return;
      if (edges.some((e) => e.source === id && e.target === t.to)) return;
      edges.push({ id: edgeId(id, t.to), source: id, target: t.to, index, back: false, implicit: false, when: t.when });
    });
  }

  const out = new Map<string, LayoutEdge[]>();
  for (const e of edges) out.set(e.source, [...(out.get(e.source) ?? []), e]);

  // 1. Back edges via DFS (gray = on the current path).
  const state = new Map<string, "gray" | "black">();
  const visit = (id: string) => {
    state.set(id, "gray");
    for (const e of out.get(id) ?? []) {
      if (e.target === END) continue;
      const s = state.get(e.target);
      if (s === "gray") e.back = true;
      else if (s === undefined) visit(e.target);
    }
    state.set(id, "black");
  };
  const roots = [def.stages[def.start] ? def.start : null, ...ids].filter(
    (id): id is string => id !== null,
  );
  for (const id of roots) if (!state.has(id)) visit(id);

  // 2. Longest-path ranks over forward edges (a DAG after step 1).
  const forward = edges.filter((e) => !e.back && e.target !== END);
  const rank = new Map<string, number>();
  const indegree = new Map(ids.map((id) => [id, 0]));
  for (const e of forward) indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
  const queue = ids.filter((id) => indegree.get(id) === 0);
  // Start first so it anchors rank 0 even when other sources exist.
  queue.sort((a, b) => (a === def.start ? -1 : b === def.start ? 1 : 0));
  for (const id of queue) rank.set(id, 0);
  while (queue.length) {
    const id = queue.shift()!;
    for (const e of forward.filter((f) => f.source === id)) {
      rank.set(e.target, Math.max(rank.get(e.target) ?? 0, rank.get(id)! + 1));
      indegree.set(e.target, indegree.get(e.target)! - 1);
      if (indegree.get(e.target) === 0) queue.push(e.target);
    }
  }
  const maxRank = Math.max(0, ...ids.map((id) => rank.get(id) ?? 0));
  if (hasEnd) rank.set(END, maxRank + 1);

  // 3. Order within ranks: barycenter sweeps, deterministic seed.
  const nodeIds = hasEnd ? [...ids, END] : ids;
  const ranks: string[][] = [];
  for (const id of nodeIds) (ranks[rank.get(id)!] ??= []).push(id);
  const position = () => {
    const pos = new Map<string, number>();
    ranks.forEach((r) => r.forEach((id, i) => pos.set(id, i)));
    return pos;
  };
  const neighbors = (id: string, dir: "in" | "out") =>
    edges
      .filter((e) => !e.back && (dir === "in" ? e.target === id : e.source === id))
      .map((e) => (dir === "in" ? e.source : e.target));
  for (let sweep = 0; sweep < SWEEPS; sweep += 1) {
    const down = sweep % 2 === 0;
    const order = down ? ranks.map((_, i) => i) : ranks.map((_, i) => ranks.length - 1 - i);
    for (const r of order) {
      const pos = position();
      const bary = new Map(
        ranks[r]!.map((id, i) => {
          const ns = neighbors(id, down ? "in" : "out").filter((n) => pos.has(n));
          return [id, ns.length ? ns.reduce((s, n) => s + pos.get(n)!, 0) / ns.length : i];
        }),
      );
      ranks[r]!.sort((a, b) => bary.get(a)! - bary.get(b)!);
    }
  }

  // 4. Coordinates, each rank centred on the widest/tallest.
  const tallest = Math.max(1, ...ranks.map((r) => r.length));
  const nodes: LayoutNode[] = [];
  if (direction === "TB") {
    const width = tallest * NODE_WIDTH + (tallest - 1) * SLOT_GAP_TB;
    ranks.forEach((r, ri) => {
      const span = r.length * NODE_WIDTH + (r.length - 1) * SLOT_GAP_TB;
      const left = (width - span) / 2;
      r.forEach((id, si) => {
        nodes.push({
          id,
          rank: ri,
          // the narrow `end` pill centres in its slot
          x: left + si * (NODE_WIDTH + SLOT_GAP_TB) + (id === END ? (NODE_WIDTH - END_WIDTH) / 2 : 0),
          y: ri * (NODE_HEIGHT + RANK_GAP_TB),
        });
      });
    });
    const height = ranks.length * NODE_HEIGHT + (ranks.length - 1) * RANK_GAP_TB;
    return { direction, nodes, edges, width, height };
  }
  const height = tallest * NODE_HEIGHT + (tallest - 1) * SLOT_GAP;
  ranks.forEach((r, ri) => {
    const span = r.length * NODE_HEIGHT + (r.length - 1) * SLOT_GAP;
    const top = (height - span) / 2;
    r.forEach((id, si) => {
      nodes.push({
        id,
        rank: ri,
        x: ri * (NODE_WIDTH + RANK_GAP),
        y: top + si * (NODE_HEIGHT + SLOT_GAP),
      });
    });
  });
  const width = ranks.length * NODE_WIDTH + (ranks.length - 1) * RANK_GAP;
  return { direction, nodes, edges, width, height };
}

/**
 * Pick the orientation that shows the graph larger in a container: the
 * scale each layout would fit at (capped at 1 — never zoom in), with a
 * bias to left→right, which is the default reading. Vertical wins only
 * when it is clearly more legible (narrow canvases, phones).
 */
export function pickDirection(def: MachineDefinition, box: { width: number; height: number }): LayoutDirection {
  if (box.width <= 0 || box.height <= 0) return "LR";
  const fit = (l: Layout) =>
    Math.min(1, box.width / (l.width * FIT_PAD), box.height / (l.height * FIT_PAD));
  return fit(layoutMachine(def, "TB")) > fit(layoutMachine(def, "LR")) * 1.25 ? "TB" : "LR";
}

/** fitView's padding (10% a side) as a size multiplier. */
const FIT_PAD = 1.25;
