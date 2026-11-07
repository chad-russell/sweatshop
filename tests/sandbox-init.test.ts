import { describe, expect, it } from "vitest";
import { createContainerArgs } from "../lib/sandboxes/provision";

/**
 * Sandbox containers run with `--init`: the engine's init is PID 1 and
 * reaps orphaned processes. Without it the image's `sleep infinity` was
 * PID 1, reaped nothing, and every `docker exec` leftover piled up as a
 * zombie until process spawns slowed to a crawl (lib/sandboxes/provision.ts).
 */
describe("sandbox container launch", () => {
  it("runs detached, named, with an init as PID 1", () => {
    expect(createContainerArgs("sbx_abc", "localhost/sweatshop-sandbox")).toEqual([
      "run",
      "-d",
      "--init",
      "--name",
      "sbx_abc",
      "localhost/sweatshop-sandbox",
    ]);
  });

  it("keeps the image last, so it is never parsed as a flag value", () => {
    const args = createContainerArgs("sbx_abc", "docker.io/me/img:v1");
    expect(args.at(-1)).toBe("docker.io/me/img:v1");
    expect(args.indexOf("--init")).toBeLessThan(args.indexOf("--name"));
  });
});
