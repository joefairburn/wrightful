"use client";

import { LogOut } from "lucide-react";
import { navigate } from "rwsdk/client";
import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from "@/app/components/ui/popover";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/cn";

interface SidebarUserMenuProps {
  name: string;
  email: string;
  image: string | null;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0] ?? "";
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1] ?? "";
  return (first.charAt(0) + last.charAt(0)).toUpperCase();
}

export function SidebarUserMenu({ name, email, image }: SidebarUserMenuProps) {
  return (
    <Popover>
      <PopoverTrigger
        aria-label={`Account menu for ${name}`}
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-foreground outline-none",
          "transition-colors hover:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        )}
      >
        {image ? (
          <img
            src={image}
            alt=""
            width={24}
            height={24}
            className="size-full rounded-full object-cover"
            referrerPolicy="no-referrer"
          />
        ) : (
          <span className="font-mono font-semibold text-[9px] text-muted-foreground">
            {initials(name)}
          </span>
        )}
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" sideOffset={8} className="w-64">
        <div className="flex flex-col gap-3">
          <div className="flex min-w-0 items-center gap-3">
            {image ? (
              <img
                src={image}
                alt=""
                width={36}
                height={36}
                className="size-9 shrink-0 rounded-full border border-border/50 bg-muted object-cover"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="flex size-9 shrink-0 items-center justify-center rounded-full border border-border/50 bg-muted font-mono font-semibold text-[11px] text-muted-foreground">
                {initials(name)}
              </div>
            )}
            <div className="min-w-0">
              <p className="truncate font-medium text-sm">{name}</p>
              <p className="truncate font-mono text-[11px] text-muted-foreground">
                {email}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              void authClient.signOut().then(() => {
                void navigate("/login");
              });
            }}
            className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-left font-mono font-medium text-[11px] text-foreground uppercase tracking-wider transition-colors hover:bg-accent"
          >
            <LogOut size={12} strokeWidth={2.5} />
            Log out
          </button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
