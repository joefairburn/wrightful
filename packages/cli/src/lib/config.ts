import { cosmiconfig } from "cosmiconfig";
import { z } from "zod";
import type { GreenroomConfig } from "../types.js";

const ConfigSchema = z.object({
  url: z.string().url(),
  token: z.string().min(1),
  artifacts: z.enum(["all", "failed", "none"]).default("failed"),
});

interface CliOptions {
  url?: string;
  token?: string;
  artifacts?: string;
}

export async function resolveConfig(
  cliOptions: CliOptions,
): Promise<GreenroomConfig> {
  // Load config file
  const explorer = cosmiconfig("greenroom");
  const fileConfig = await explorer.search();

  // Merge: CLI flags > env vars > config file
  const raw = {
    url: cliOptions.url || process.env.GREENROOM_URL || fileConfig?.config?.url,
    token:
      cliOptions.token ||
      process.env.GREENROOM_API_KEY ||
      fileConfig?.config?.token,
    artifacts:
      cliOptions.artifacts ||
      process.env.GREENROOM_ARTIFACTS ||
      fileConfig?.config?.artifacts ||
      "failed",
  };

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const missing: string[] = [];
    if (!raw.url) missing.push("url (--url, GREENROOM_URL, or config file)");
    if (!raw.token)
      missing.push("token (--token, GREENROOM_API_KEY, or config file)");

    if (missing.length > 0) {
      throw new Error(`Missing required config:\n  ${missing.join("\n  ")}`);
    }

    throw new Error(
      `Invalid config: ${result.error.issues.map((i) => i.message).join(", ")}`,
    );
  }

  return result.data;
}
