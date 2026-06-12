import { avatarHue } from "@/lib/avatar-hue";

interface ActorAvatarProps {
  actor: string;
  size?: number;
}

/**
 * Small colored initial tile derived from the actor's name. Hue is hashed
 * from the string (`avatarHue`) so the same actor renders with the same
 * color across runs.
 */
export function ActorAvatar({ actor, size = 16 }: ActorAvatarProps) {
  const initial = actor.charAt(0).toUpperCase();
  const hue = avatarHue(actor);
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-[3px] font-semibold text-white"
      style={{
        background: `oklch(0.55 0.10 ${hue})`,
        width: size,
        height: size,
        fontSize: Math.max(8, Math.round(size * 0.55)),
      }}
      title={actor}
    >
      {initial}
    </span>
  );
}
