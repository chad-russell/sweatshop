import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "@/lib/clipboard";

/**
 * The copy seam (lib/clipboard.ts): the async Clipboard API is only
 * exposed in secure contexts, and sweatshop is browsed over plain http
 * on the LAN — the helper must fall back to the execCommand path there.
 * Node's own navigator has no clipboard, so the fallback path runs
 * natively; the secure path is stubbed in.
 */

function fakeDocument(execResult: boolean) {
  const textarea = {
    remove: vi.fn(),
    select: vi.fn(),
    setAttribute: vi.fn(),
    style: {} as Record<string, string>,
    value: "",
  };
  const doc = {
    body: { appendChild: vi.fn() },
    createElement: vi.fn(() => textarea),
    execCommand: vi.fn(() => execResult),
  };
  return { doc, textarea };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("copyText", () => {
  it("uses the async Clipboard API when available", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { doc } = fakeDocument(true);
    vi.stubGlobal("document", doc);

    await expect(copyText("hello")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(doc.execCommand).not.toHaveBeenCalled();
  });

  it("falls back to execCommand when the Clipboard API is missing (insecure origin)", async () => {
    vi.stubGlobal("navigator", {});
    const { doc, textarea } = fakeDocument(true);
    vi.stubGlobal("document", doc);

    await expect(copyText("hello")).resolves.toBe(true);
    expect(textarea.value).toBe("hello");
    expect(textarea.select).toHaveBeenCalledOnce();
    expect(doc.body.appendChild).toHaveBeenCalledOnce();
    expect(doc.execCommand).toHaveBeenCalledWith("copy");
    expect(textarea.remove).toHaveBeenCalledOnce();
  });

  it("falls back when the Clipboard API rejects", async () => {
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: async () => {
          throw new Error("NotAllowedError");
        },
      },
    });
    const { doc } = fakeDocument(true);
    vi.stubGlobal("document", doc);

    await expect(copyText("hello")).resolves.toBe(true);
    expect(doc.execCommand).toHaveBeenCalledWith("copy");
  });

  it("reports failure when neither path works", async () => {
    vi.stubGlobal("navigator", {});
    const { doc } = fakeDocument(false);
    vi.stubGlobal("document", doc);

    await expect(copyText("hello")).resolves.toBe(false);
  });

  it("reports failure without a document", async () => {
    vi.stubGlobal("navigator", {});

    await expect(copyText("hello")).resolves.toBe(false);
  });
});
