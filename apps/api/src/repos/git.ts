import { execFile } from "node:child_process";

// ADR-0019 — the only way the API runs git. No shell, no prompts, no
// line-ending conversion (bytes in the repository are exactly the bytes the
// agent wrote), and no user config or hooks leaking in.
const BASE_ARGS = ["-c", "core.autocrlf=false", "-c", "core.hooksPath=/dev/null", "-c", "advice.detachedHead=false"];
const MAX_OUTPUT = 256 * 1024 * 1024;

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(`git ${args[0]} failed (${code}): ${stderr.trim().slice(-500)}`);
  }
}

export interface GitResult {
  stdout: Buffer;
  stderr: string;
  code: number;
}

export interface GitOptions {
  cwd?: string;
  input?: Buffer | string;
  env?: Record<string, string>;
  /** Exit codes that are answers rather than failures (e.g. merge-tree's 1 = conflict). */
  okCodes?: number[];
}

export function git(args: string[], options: GitOptions = {}): Promise<GitResult> {
  const ok = new Set([0, ...(options.okCodes ?? [])]);
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      [...BASE_ARGS, ...args],
      {
        cwd: options.cwd,
        encoding: "buffer",
        maxBuffer: MAX_OUTPUT,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
          ...options.env,
        },
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : null) : 0;
        const err = stderr.toString("utf8");
        if (code !== null && ok.has(code)) resolve({ stdout, stderr: err, code });
        else reject(new GitError(args, code, err || String(error?.message ?? "")));
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
    else child.stdin?.end();
  });
}

export async function gitText(args: string[], options: GitOptions = {}): Promise<string> {
  return (await git(args, options)).stdout.toString("utf8").trim();
}
