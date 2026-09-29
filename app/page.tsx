import { ThemeToggle } from "@/components/theme-toggle";

/**
 * Shell placeholder proving the token/theme system end to end; the chat
 * surface (0001 step 6) replaces this content.
 */
export default function Home() {
  return (
    <main className="flex flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <span className="font-mono text-sm text-muted-foreground">
          sweatshop
        </span>
        <ThemeToggle />
      </header>
      <section className="flex flex-1 items-center justify-center p-8">
        <div className="max-w-md rounded-lg border border-border bg-card p-6 text-card-foreground shadow-xs">
          <h1 className="text-lg font-semibold">theme check</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Card on <code className="font-mono">bg-background</code>, primary
            text in <span className="text-primary">brand voltage</span>, status{" "}
            <span className="text-success">success</span> /{" "}
            <span className="text-warning">warning</span> /{" "}
            <span className="text-info">info</span>. Cycle themes with the
            palette button.
          </p>
        </div>
      </section>
    </main>
  );
}
