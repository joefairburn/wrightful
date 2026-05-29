import { AppLayout } from "@/components/app-layout";

/**
 * Settings tree shell — wraps `/settings/**` in the AppLayout's settings
 * chrome (profile / teams sidebar with workspace switcher on top and a
 * "Back to app" link at the bottom). Selected workspace + teams flow through
 * `useShared()` from `middleware/01.context.ts`, so this layout has no
 * companion `.server.ts`.
 */
export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AppLayout mode="settings">{children}</AppLayout>;
}
