import * as React from "react"
import { cn } from "cn"

/** A plain `<select>` styled like Input — for short fixed lists in forms
 *  where the Radix Select's popover is more than the field needs. */
function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        "h-9 rounded-md border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { NativeSelect }
