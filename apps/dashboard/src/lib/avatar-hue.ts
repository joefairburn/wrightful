/**
 * Deterministic identity hue for avatar/badge tiles, hashed from the display
 * string so the same actor/team renders the same colour everywhere. Restricted
 * to the cool 220-290° band per the design bundle's `TeamBadge`/`Avatar` —
 * keeps tiles in the steel/indigo family rather than scattering across the
 * rainbow. Shared by `ActorAvatar` and the workspace switcher's `TeamBadge`.
 */
export function avatarHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return 220 + (Math.abs(h) % 70);
}
