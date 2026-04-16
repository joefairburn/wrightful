import { cosmiconfig } from "cosmiconfig";
import { z } from "zod";
import type { WrightfulConfig } from "../types.js";

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
): Promise<WrightfulConfig> {
  // Load config file
  const explorer = cosmiconfig("wrightful");
  const fileConfig = await explorer.search();

  // Merge: CLI flags > env vars > config file
  const raw = {
    url: cliOptions.url || process.env.WRIGHTFUL_URL || fileConfig?.config?.url,
    token:
      cliOptions.token ||
      process.env.WRIGHTFUL_API_KEY ||
      fileConfig?.config?.token,
    artifacts:
      cliOptions.artifacts ||
      process.env.WRIGHTFUL_ARTIFACTS ||
      fileConfig?.config?.artifacts ||
      "failed",
  };

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const missing: string[] = [];
    if (!raw.url) missing.push("url (--url, WRIGHTFUL_URL, or config file)");
    if (!raw.token)
      missing.push("token (--token, WRIGHTFUL_API_KEY, or config file)");

    if (missing.length > 0) {
      throw new Error(`Missing required config:\n  ${missing.join("\n  ")}`);
    }

    throw new Error(
      `Invalid config: ${result.error.issues.map((i) => i.message).join(", ")}`,
    );
  }

  return result.data;
}
