"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { DirectionProvider } from "@radix-ui/react-direction";

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30 * 1000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      })
  );

  return (
    // Radix primitives (Tabs, Dialog, Select, Popover, DropdownMenu, …)
    // default to LTR and even render dir="ltr" on their root elements,
    // which flipped whole page sections (e.g. the importers table) to
    // LTR. Providing the direction once here makes every Radix
    // component — including portalled overlays — RTL aware.
    <DirectionProvider dir="rtl">
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </DirectionProvider>
  );
}
