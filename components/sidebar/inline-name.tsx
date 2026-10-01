"use client";

import { useRef, useState } from "react";

/**
 * Inline text field for naming/renaming: Enter or blur commits a changed,
 * non-empty value; Escape or an empty/unchanged value cancels. The first
 * outcome wins (Enter would otherwise commit and then blur again).
 */
export function InlineName({
  initial = "",
  placeholder,
  label,
  onSubmit,
  onCancel,
}: {
  initial?: string;
  placeholder?: string;
  label: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const settled = useRef(false);

  const finish = (commit: boolean) => {
    if (settled.current) return;
    settled.current = true;
    const next = value.trim();
    if (commit && next && next !== initial) onSubmit(next);
    else onCancel();
  };

  return (
    <input
      autoFocus
      value={value}
      placeholder={placeholder}
      aria-label={label}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(true);
        if (e.key === "Escape") finish(false);
      }}
      className="min-w-0 flex-1 rounded-sm border border-sidebar-ring bg-transparent px-1.5 py-0.5 text-sm outline-none placeholder:text-sidebar-foreground/40"
    />
  );
}
