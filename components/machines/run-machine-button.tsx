"use client";

import { Play } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * 0012: "Run" on a machine's page. Runs start from the composer (the
 * prompt is a message), so this opens a fresh composer with the machine
 * preselected — in Chats for workspace-free machines, or in the chosen
 * project for project machines.
 */
export function RunMachineButton({
  machineId,
  workspace,
  projects,
}: {
  machineId: string;
  workspace: "project" | "none";
  projects: readonly { id: string; name: string }[];
}) {
  const query = `?machine=${encodeURIComponent(machineId)}`;
  if (workspace === "none") {
    return (
      <Button asChild size="sm">
        <Link href={`/${query}`}>
          <Play /> Run
        </Link>
      </Button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" disabled={projects.length === 0} title={projects.length ? undefined : "No projects yet"}>
          <Play /> Run
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Run in project</DropdownMenuLabel>
        {projects.map((p) => (
          <DropdownMenuItem key={p.id} asChild>
            <Link href={`/p/${p.id}${query}`}>{p.name}</Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
