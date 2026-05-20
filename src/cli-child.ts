import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function runCurrentCliChild(
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<void> {
  const entry = resolve(dirname(fileURLToPath(import.meta.url)), "cli.ts");
  const env = { ...(opts.env ?? process.env) };
  env.NODE_OPTIONS ??= "--max-old-space-size=1024";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, entry, ...args], {
      cwd: opts.cwd,
      env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `pixpec child CLI failed: ${["node", entry, ...args].join(" ")} exited with ${
            signal ? `signal ${signal}` : `code ${code}`
          }`,
        ),
      );
    });
  });
}
