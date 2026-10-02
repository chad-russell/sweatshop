/** Short, stable display form of a sandbox id (mono, DESIGN.md rule 4). */
export function shortSandboxId(id: string): string {
  return id.replace(/^sbx_/, "").slice(0, 6);
}
