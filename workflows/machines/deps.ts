/**
 * 0031: dynamic-import loaders for the Node modules the machine-run
 * steps use (the "step ceremony" that CAN move — the `"use step"`
 * directive itself cannot; see docs/0031). Statically importable: this
 * module holds no static Node imports, so it is workflow-bundle-safe
 * and the loads stay lazy inside each step.
 */

/** The db handle plus the machines store — the pair most steps want. */
export async function machineStore() {
  const [{ db }, m] = await Promise.all([import("../../db"), import("../../db/machines")]);
  return { db: db(), m };
}
