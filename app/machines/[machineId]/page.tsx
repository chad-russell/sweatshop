import { notFound } from "next/navigation";
import { MachineEditor } from "@/components/machines/machine-editor";
import { db } from "@/db";
import { getMachine, MachineError } from "@/db/machines";

export const dynamic = "force-dynamic";

const STARTER = {
  workspace: "none",
  start: "draft",
  stages: {
    draft: {
      kind: "agent",
      title: "Draft",
      instructions: "Answer the prompt.",
      next: [{ to: "review" }],
    },
    review: {
      kind: "human",
      title: "Review",
      instructions: "Accept, or send back with a note.",
      next: [
        { to: "end", when: "Accept" },
        { to: "draft", when: "Revise" },
      ],
    },
  },
};

/** Create (/machines/new) or edit one machine (0009). */
export default async function MachinePage({ params }: { params: Promise<{ machineId: string }> }) {
  const { machineId } = await params;
  if (machineId === "new") {
    return <MachineEditor initial={{ id: "", name: "", description: "", definition: STARTER, version: 0 }} isNew />;
  }
  let m;
  try {
    m = getMachine(db(), machineId);
  } catch (err) {
    if (err instanceof MachineError && err.code === "not-found") notFound();
    throw err;
  }
  return (
    <MachineEditor
      initial={{ id: m.id, name: m.name, description: m.description ?? "", definition: m.definition, version: m.version }}
    />
  );
}
