"use client";

import { NuqsAdapter } from "nuqs/adapters/react";

export const Providers: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => <NuqsAdapter>{children}</NuqsAdapter>;
