"use client";

import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  Handle,
  MarkerType,
  Position,
  type Edge as FlowEdge,
  type EdgeProps,
  type Node as FlowNode,
  type NodeProps,
} from "@xyflow/react";
import { AlertTriangle, Bot, Flag, Hand, Play, Terminal } from "lucide-react";
import { memo, useMemo } from "react";
import { Canvas } from "@/components/ai-elements/canvas";
import { Controls } from "@/components/ai-elements/controls";
import { END, type MachineDefinition, type Stage } from "@/lib/machines/definition";
import { END_WIDTH, layoutMachine, NODE_HEIGHT, NODE_WIDTH, type LayoutEdge } from "@/lib/machines/layout";
import { HarnessMark } from "@/components/harness-logo";
import { cn } from "@/lib/utils";

/**
 * 0014: a machine definition drawn as a graph — the machine page's
 * editor canvas and the run view's progress strip. Positions come from
 * the automatic layout (lib/machines/layout); nothing is stored. Nodes
 * are not draggable. Everything else (selection, connecting, the run
 * overlay, issues) is passed in, so this stays a pure view of the
 * definition plus decorations.
 */

/** Per-stage run progress (the run view's overlay). */
export interface StageProgress {
  visits: number;
  /** Last visit status: running | waiting | completed | failed | parked. */
  status: string;
}

export interface GraphOverlay {
  /** Where the run is now (null when it has finished). */
  current: string | null;
  /** The run is waiting at a human gate (current is that gate). */
  waiting: boolean;
  progress: ReadonlyMap<string, StageProgress>;
  /** Edge ids (`source->target`) the run has taken. */
  taken: ReadonlySet<string>;
  /** The run is live: taken edges animate. */
  live: boolean;
}

export interface GraphIssues {
  nodes: ReadonlyMap<string, readonly string[]>;
  edges: ReadonlyMap<string, readonly string[]>;
}

interface StageData extends Record<string, unknown> {
  id: string;
  stage: Stage | null;
  isStart: boolean;
  progress?: StageProgress;
  current: boolean;
  waiting: boolean;
  issues?: readonly string[];
  connectable: boolean;
}

interface TransitionData extends Record<string, unknown> {
  edge: LayoutEdge;
  taken: boolean;
  animated: boolean;
  muted: boolean;
  issues?: readonly string[];
}

const KIND_ICON = { harness: Terminal, agent: Bot, human: Hand } as const;

function firstLine(text: string): string {
  return text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
}

const StageNode = memo(function StageNode({ data, selected }: NodeProps<FlowNode<StageData>>) {
  const { stage, id } = data;
  const handles = (
    <>
      <Handle type="target" position={Position.Left} isConnectable={data.connectable} className="size-2! border-border! bg-muted-foreground!" />
      {stage && (
        <Handle type="source" position={Position.Right} isConnectable={data.connectable} className="size-2! border-border! bg-muted-foreground!" />
      )}
    </>
  );

  if (!stage) {
    return (
      <div
        style={{ width: END_WIDTH, height: NODE_HEIGHT }}
        className="flex items-center justify-center gap-1.5 rounded-full border border-dashed border-border bg-card font-mono text-xs text-muted-foreground"
      >
        {handles}
        <Flag className="size-3.5" aria-hidden />
        end
      </div>
    );
  }

  const Icon = KIND_ICON[stage.kind];
  const badge = stage.kind === "harness" ? stage.harness : stage.kind;
  const tone = data.progress
    ? data.progress.status === "failed"
      ? "text-destructive"
      : data.progress.status === "parked" || data.progress.status === "waiting"
        ? "text-warning"
        : data.progress.status === "completed"
          ? "text-success"
          : "text-info"
    : "text-muted-foreground";
  return (
    <div
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
      className={cn(
        "flex flex-col gap-1 rounded-md border bg-card px-3 py-2 text-card-foreground transition-shadow",
        data.issues?.length ? "border-destructive" : "border-border",
        selected && "ring-2 ring-ring",
        data.current && (data.waiting ? "ring-2 ring-warning" : "ring-2 ring-info"),
      )}
      title={data.issues?.join("\n")}
    >
      {handles}
      <div className="flex items-center gap-1.5">
        {stage.kind === "harness" ? (
          <HarnessMark kind={stage.harness} tint={false} className={cn("size-3.5", tone)} />
        ) : (
          <Icon className={cn("size-3.5 shrink-0", tone)} aria-hidden />
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{stage.title}</span>
        {data.isStart && <Play className="size-3 shrink-0 text-muted-foreground" aria-label="Start" />}
        {data.issues?.length ? <AlertTriangle className="size-3.5 shrink-0 text-destructive" aria-label="Has issues" /> : null}
      </div>
      <div className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
        <span className="rounded border border-border px-1">{badge}</span>
        <span className="truncate">{id}</span>
        {data.progress && (
          <span className={cn("ml-auto shrink-0", tone)}>
            ×{data.progress.visits} {data.progress.status}
          </span>
        )}
      </div>
      <p className="truncate text-xs text-muted-foreground">{firstLine(stage.instructions) || "—"}</p>
    </div>
  );
});

/**
 * Forward edges: a bezier left→right. Back edges (loops) leave the
 * source's right side, dip under both nodes, and enter the target's
 * left side — so a loop reads as "goes back" instead of crossing the
 * graph.
 */
const TransitionEdge = memo(function TransitionEdge(props: EdgeProps<FlowEdge<TransitionData>>) {
  const { data, sourceX, sourceY, targetX, targetY, markerEnd, selected } = props;
  if (!data) return null;
  let path: string;
  let labelX: number;
  let labelY: number;
  if (data.edge.back) {
    const dip = Math.max(sourceY, targetY) + NODE_HEIGHT / 2 + 28;
    const out = 28;
    path = [
      `M ${sourceX} ${sourceY}`,
      `C ${sourceX + out} ${sourceY}, ${sourceX + out} ${dip}, ${sourceX} ${dip}`,
      `L ${targetX} ${dip}`,
      `C ${targetX - out} ${dip}, ${targetX - out} ${targetY}, ${targetX} ${targetY}`,
    ].join(" ");
    labelX = (sourceX + targetX) / 2;
    labelY = dip;
  } else {
    [path, labelX, labelY] = getBezierPath({
      sourceX,
      sourceY,
      sourcePosition: Position.Right,
      targetX,
      targetY,
      targetPosition: Position.Left,
    });
  }
  const broken = Boolean(data.issues?.length);
  const stroke = broken
    ? "var(--destructive)"
    : selected
      ? "var(--ring)"
      : data.taken
        ? "var(--primary)"
        : "var(--muted-foreground)";
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        markerEnd={markerEnd}
        interactionWidth={16}
        style={{
          stroke,
          strokeWidth: data.taken || selected ? 2 : 1.25,
          strokeDasharray: data.edge.implicit ? "5 5" : undefined,
          opacity: data.muted ? 0.45 : 1,
        }}
      />
      {data.animated && (
        <circle r="3.5" fill="var(--primary)">
          <animateMotion dur="2s" path={path} repeatCount="indefinite" />
        </circle>
      )}
      {(data.edge.when || broken) && (
        <EdgeLabelRenderer>
          <div
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            title={data.issues?.join("\n") ?? data.edge.when}
            className={cn(
              "nodrag nopan pointer-events-auto absolute max-w-28 truncate rounded border bg-card px-1.5 py-0.5 text-[10px]",
              broken ? "border-destructive text-destructive" : "border-border text-muted-foreground",
              data.muted && "opacity-60",
            )}
          >
            {data.edge.when ?? data.issues?.[0]}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

const nodeTypes = { stage: StageNode };
const edgeTypes = { transition: TransitionEdge };

export interface MachineGraphProps {
  definition: MachineDefinition;
  overlay?: GraphOverlay;
  issues?: GraphIssues;
  selection?: { node?: string | null; edge?: string | null };
  /** Allow dragging new connections between stages (the editor). */
  editable?: boolean;
  onSelectNode?: (id: string | null) => void;
  onSelectEdge?: (edge: { id: string; source: string; target: string } | null) => void;
  onConnect?: (source: string, target: string) => void;
  /** Delete key on the current selection (editor). */
  onDelete?: (target: { node?: string; edge?: { source: string; target: string } }) => void;
  /** Hide the zoom controls (short strips, e.g. the run view). */
  compact?: boolean;
  className?: string;
}

export function MachineGraph({
  definition,
  overlay,
  issues,
  selection,
  editable = false,
  onSelectNode,
  onSelectEdge,
  onConnect,
  onDelete,
  compact = false,
  className,
}: MachineGraphProps) {
  const layout = useMemo(() => layoutMachine(definition), [definition]);

  const nodes = useMemo<FlowNode<StageData>[]>(
    () =>
      layout.nodes.map((n) => ({
        id: n.id,
        type: "stage",
        position: { x: n.x, y: n.y },
        draggable: false,
        selectable: Boolean(onSelectNode) && n.id !== END,
        selected: selection?.node === n.id,
        data: {
          id: n.id,
          stage: n.id === END ? null : (definition.stages[n.id] ?? null),
          isStart: n.id === definition.start,
          progress: overlay?.progress.get(n.id),
          current: overlay?.current === n.id,
          waiting: Boolean(overlay?.waiting && overlay.current === n.id),
          issues: issues?.nodes.get(n.id),
          connectable: editable,
        },
      })),
    [layout, definition, overlay, issues, selection?.node, editable, onSelectNode],
  );

  const edges = useMemo<FlowEdge<TransitionData>[]>(
    () =>
      layout.edges.map((e) => {
        const taken = overlay?.taken.has(e.id) ?? false;
        const color = issues?.edges.get(e.id)?.length
          ? "var(--destructive)"
          : taken
            ? "var(--primary)"
            : "var(--muted-foreground)";
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          type: "transition",
          selectable: Boolean(onSelectEdge) && !e.implicit,
          selected: selection?.edge === e.id,
          markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color },
          data: {
            edge: e,
            taken,
            animated: Boolean(overlay?.live && taken),
            muted: Boolean(overlay && !taken),
            issues: issues?.edges.get(e.id),
          },
        };
      }),
    [layout, overlay, issues, selection?.edge, onSelectEdge],
  );

  return (
    <div className={cn("relative h-full w-full", className)}>
      <Canvas
        // Remount when the shape changes so fitView re-frames it.
        key={layout.nodes.map((n) => n.id).join("|")}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        // Readability over seeing everything: a long chain stays legible
        // (pan to see the rest) instead of shrinking to fit.
        fitViewOptions={{ padding: 0.1, maxZoom: 1, minZoom: compact ? 0.45 : 0.6 }}
        minZoom={0.3}
        nodesDraggable={false}
        nodesConnectable={editable}
        elementsSelectable={Boolean(onSelectNode || onSelectEdge)}
        selectionOnDrag={false}
        panOnDrag
        deleteKeyCode={editable ? ["Backspace", "Delete"] : null}
        proOptions={{ hideAttribution: true }}
        onInit={(flow) => {
          // fitView may stop at its minimum zoom with the graph still wider
          // than the canvas, centring it and pushing `start` off-screen.
          // Graphs read left to right, so anchor the left edge instead.
          const { x, y, zoom } = flow.getViewport();
          if (x < 0) flow.setViewport({ x: 24, y, zoom });
        }}
        onNodeClick={(_, node) => onSelectNode?.(node.id === END ? null : node.id)}
        onEdgeClick={(_, edge) => onSelectEdge?.({ id: edge.id, source: edge.source, target: edge.target })}
        onPaneClick={() => {
          onSelectNode?.(null);
          onSelectEdge?.(null);
        }}
        onConnect={(c) => {
          if (c.source && c.target && c.source !== END) onConnect?.(c.source, c.target);
        }}
        onBeforeDelete={async ({ nodes: n, edges: e }) => {
          // Deletion is a definition edit, never a flow-state one.
          const node = n.find((x) => x.id !== END);
          const edge = e.find((x) => !(x.data as TransitionData | undefined)?.edge.implicit);
          if (node) onDelete?.({ node: node.id });
          else if (edge) onDelete?.({ edge: { source: edge.source, target: edge.target } });
          return false;
        }}
      >
        {!compact && <Controls showInteractive={false} position="bottom-left" />}
      </Canvas>
    </div>
  );
}

/** Run overlay from the run's visits (the timeline's rows). */
export function overlayFromVisits(
  visits: readonly { seq: number; stageId: string; status: string; transitionTo: string | null }[],
  run: { status: string; currentStage: string | null },
): GraphOverlay {
  const progress = new Map<string, StageProgress>();
  const taken = new Set<string>();
  for (const v of [...visits].sort((a, b) => a.seq - b.seq)) {
    const p = progress.get(v.stageId);
    progress.set(v.stageId, { visits: (p?.visits ?? 0) + 1, status: v.status });
    if (v.transitionTo) taken.add(`${v.stageId}->${v.transitionTo}`);
  }
  const live = run.status === "running" || run.status === "waiting";
  return {
    current: live ? run.currentStage : null,
    waiting: run.status === "waiting",
    progress,
    taken,
    live,
  };
}
