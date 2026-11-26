import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Preline UI input pattern (https://preline.co/docs/forms.html) mapped to
 * the AOGC token palette: white surface, border, shadow-sm, primary focus ring.
 */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "border-input bg-card placeholder:text-muted-foreground/70 selection:bg-primary selection:text-primary-foreground flex h-9 w-full min-w-0 rounded-lg border px-3.5 py-1 text-base shadow-sm transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        "focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-primary/25",
        "aria-invalid:border-danger aria-invalid:ring-[3px] aria-invalid:ring-danger/25",
        className
      )}
      {...props}
    />
  )
}

export { Input }
