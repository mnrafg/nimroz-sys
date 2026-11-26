import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Preline UI textarea pattern — matches Input styling (white surface,
 * border, shadow-sm, primary focus ring).
 */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "border-input bg-card placeholder:text-muted-foreground/70 flex field-sizing-content min-h-16 w-full rounded-lg border px-3.5 py-2 text-base shadow-sm transition-[color,box-shadow] outline-none focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-primary/25 aria-invalid:border-danger aria-invalid:ring-[3px] aria-invalid:ring-danger/25 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
