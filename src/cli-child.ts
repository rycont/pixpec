import { spawn } from "node:child_process";

export async function runCurrentCliChild(
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<void> {
  const entry = process.argv[1];
  if (!entry) throw new Error("pixpec child CLI: current CLI entry is unknown");
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
