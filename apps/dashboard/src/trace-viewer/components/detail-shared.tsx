"use client";

import type React from "react";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";

/**
 * Small presentational primitives shared across the detail tabs (Call,
 * Metadata, Network). Kept intentionally thin — no "tab shell" abstraction —
 * the tab bodies themselves genuinely differ.
 */

/** dt/dd definition-list pair: micro-label + value. `className` fully replaces
 * the default `dd` styling rather than merging with it (Metadata's plain
 * `text-body` value needs to shed Call's `font-mono … text-fg-2`). */
export function Field({
  label,
  value,
  className,
}: {
  label: string;
  value: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-caption font-medium tracking-[0.1px] text-fg-3">
        {label}
      </dt>
      <dd className={className ?? "font-mono text-caption text-fg-2"}>
        {value}
      </dd>
    </div>
  );
}

/** A titled section: micro-label header + body. `className` fully replaces the
 * default wrapper styling (Network's bordered/padded rows vs Call's plain stack). */
export function Section({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div className={className ?? "flex flex-col gap-1.5"}>
      <h3 className="text-caption font-medium tracking-[0.1px] text-fg-3">
        {title}
      </h3>
      {children}
    </div>
  );
}

/** A label/value row inside a `Section`, official-viewer "General" panel style. */
export function GeneralRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex gap-3 text-body">
      <span className="w-28 shrink-0 text-fg-3">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

/** Muted inline notice for empty/placeholder tab states. */
export function TabNotice({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return <div className="px-3 py-4 text-caption text-fg-4">{children}</div>;
}

/**
 * Dual empty state for time-windowed tabs (Console/Network): a compact
 * {@link TabNotice} when scoped to the selected action's (now-empty) window,
 * else the full-height `Empty` illustration for "nothing in the whole trace".
 * Only the wrapper is shared — each tab computes its own scoped/unscoped rows
 * with its own time-window predicate.
 */
export function ScopedEmpty({
  scoped,
  scopedMessage,
  title,
  description,
}: {
  scoped: boolean;
  scopedMessage: string;
  title: string;
  description: string;
}): React.ReactElement {
  if (scoped) return <TabNotice>{scopedMessage}</TabNotice>;
  return (
    <Empty className="h-full py-8">
      <EmptyTitle>{title}</EmptyTitle>
      <EmptyDescription>{description}</EmptyDescription>
    </Empty>
  );
}
