"use client";

import * as React from "react";
import { Check, ChevronsUpDown, Loader2, Search, X } from "lucide-react";
import { Command as CommandPrimitive } from "cmdk";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn, searchMatch } from "@/lib/utils";

// ============================================================
// SearchSelect — RTL searchable dropdown (combobox)
// Built on Radix Popover + cmdk. Consistent height with SelectTrigger,
// safe truncation for long Dari names, keyboard navigation and
// normalized Dari/English filtering.
// ============================================================

export interface SearchSelectOption {
  value: string;
  label: string;
  /** Secondary line shown under the label (e.g. company name or code). */
  description?: string;
  /** Extra hidden keywords included in search matching. */
  keywords?: string;
}

export interface SearchSelectProps {
  options: SearchSelectOption[];
  value: string | null | undefined;
  onChange: (value: string | null) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  loading?: boolean;
  disabled?: boolean;
  /** Hint text rendered instead of the placeholder when disabled. */
  disabledHint?: string;
  allowClear?: boolean;
  className?: string;
  /** Width class for the dropdown panel; defaults to trigger width. */
  contentClassName?: string;
  id?: string;
  "aria-label"?: string;
  invalid?: boolean;
}

export function SearchSelect({
  options,
  value,
  onChange,
  placeholder = "انتخاب کنید",
  searchPlaceholder = "جستجو…",
  emptyMessage = "هیچ نتیجه‌ای یافت نشد",
  loading = false,
  disabled = false,
  disabledHint,
  allowClear = false,
  className,
  contentClassName,
  id,
  invalid = false,
  ...aria
}: SearchSelectProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const searchRef = React.useRef<HTMLInputElement>(null);

  const selected = React.useMemo(
    () => options.find((o) => o.value === value) ?? null,
    [options, value]
  );

  const handleSelect = (val: string) => {
    onChange(val === value ? value : val);
    setOpen(false);
    setQuery("");
  };

  const clear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange(null);
    setQuery("");
  };

  const filter = React.useMemo(() => {
    return (opt: SearchSelectOption) =>
      searchMatch([opt.label, opt.description ?? "", opt.keywords ?? ""].join(" "), query);
  }, [query]);

  const filtered = React.useMemo(
    () => options.filter(filter),
    [options, filter]
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls="search-select-list"
          aria-autocomplete="list"
          disabled={disabled}
          className={cn(
            "border-input bg-card flex h-9 w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm shadow-sm transition-[color,box-shadow] outline-none focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-primary/25 disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-danger aria-invalid:ring-[3px] aria-invalid:ring-danger/25",
            invalid && "border-danger ring-[3px] ring-danger/25",
            !selected && "text-muted-foreground",
            className
          )}
          {...aria}
        >
          <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-start">
            {disabled && disabledHint ? (
              disabledHint
            ) : selected ? (
              selected.label
            ) : (
              placeholder
            )}
          </span>
          {allowClear && selected && !disabled ? (
            <span
              role="button"
              tabIndex={-1}
              aria-label="پاک کردن انتخاب"
              onClick={clear}
              className="shrink-0 rounded-sm p-0.5 opacity-50 transition-opacity hover:bg-muted hover:opacity-100"
            >
              <X className="size-3.5" />
            </span>
          ) : (
            <ChevronsUpDown className="size-4 shrink-0 opacity-50" aria-hidden />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        className={cn(
          "p-0 w-[var(--radix-popover-trigger-width)] min-w-56",
          contentClassName
        )}
        align="start"
        onOpenAutoFocus={(e) => {
          // Focus lands on the search input for instant typing.
          e.preventDefault();
          requestAnimationFrame(() => searchRef.current?.focus());
        }}
      >
        <CommandPrimitive
          id="search-select-list"
          shouldFilter={false}
          className="overflow-hidden rounded-xl"
          dir="rtl"
        >
          <div className="flex h-9 items-center gap-2 border-b border-border px-3">
            <Search className="size-4 shrink-0 opacity-50" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              className="flex h-full w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/70 disabled:cursor-not-allowed"
              dir="rtl"
            />
          </div>
          <CommandPrimitive.List className="max-h-64 overflow-y-auto overflow-x-hidden p-1">
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                در حال بارگذاری…
              </div>
            ) : filtered.length === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground">
                {emptyMessage}
              </div>
            ) : (
              filtered.map((opt) => {
                const isSelected = opt.value === value;
                return (
                  <CommandPrimitive.Item
                    key={opt.value}
                    value={opt.value}
                    onSelect={() => handleSelect(opt.value)}
                    className="relative flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm outline-none select-none data-[selected=true]:bg-muted data-[selected=true]:text-foreground"
                  >
                    <Check
                      className={cn(
                        "size-4 shrink-0",
                        isSelected ? "text-primary opacity-100" : "opacity-0"
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate" title={opt.label}>
                        {opt.label}
                      </span>
                      {opt.description && (
                        <span className="block truncate text-xs text-muted-foreground">
                          {opt.description}
                        </span>
                      )}
                    </span>
                  </CommandPrimitive.Item>
                );
              })
            )}
          </CommandPrimitive.List>
        </CommandPrimitive>
      </PopoverContent>
    </Popover>
  );
}

/** Convenience hook for building option lists from server records. */
export function toOptions<T>(
  rows: T[] | undefined,
  toValue: (row: T) => string | number,
  toLabel: (row: T) => string,
  toDescription?: (row: T) => string | undefined | null,
  toKeywords?: (row: T) => string | undefined | null
): SearchSelectOption[] {
  if (!rows) return [];
  return rows.map((r) => ({
    value: String(toValue(r)),
    label: toLabel(r),
    description: toDescription ? (toDescription(r) ?? undefined) : undefined,
    keywords: toKeywords ? (toKeywords(r) ?? undefined) : undefined,
  }));
}
