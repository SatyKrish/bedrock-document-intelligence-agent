import { execFileSync } from "node:child_process";
import type { Config } from "./config.js";
export interface Aws {
  call(args: string[]): unknown;
}
export class CliAws implements Aws {
  constructor(private config: Config) {}
  call(args: string[]) {
    try {
      const output = execFileSync(
        "aws",
        [
          ...args,
          "--profile",
          this.config.profile,
          "--region",
          this.config.region,
          "--output",
          "json",
          "--no-cli-pager",
        ],
        { encoding: "utf8", timeout: 60000, maxBuffer: 8 * 1024 * 1024 },
      );
      return output.trim() ? JSON.parse(output) : {};
    } catch {
      throw Error(
        `AWS operation failed: ${args[0]} ${args[1]}. No credentials or raw responses are logged; reconcile state before repeating a write.`,
      );
    }
  }
}
export const asObject = (x: unknown) => x as Record<string, any>;
