interface ActorAvatarProps {
  actor: string;
  size?: number;
}

/**
 * Small colored initial tile derived from the actor's name. Hue is hashed
 * from the string so the same actor renders with the same color across
 * runs. Restricted to the cool 220-290° band per the design bundle's
 * `TeamBadge`/`Avatar` — keeps avatars in the steel/indigo family rather
 * than scattering across the rainbow.
 */
export function ActorAvatar({ actor, size = 16 }: ActorAvatarProps) {
  const initial = actor.charAt(0).toUpperCase();
  let h = 0;
  for (let i = 0; i < actor.length; i++) {
    h = (h * 31 + actor.charCodeAt(i)) | 0;
  }
  const hue = 220 + (Math.abs(h) % 70);
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
