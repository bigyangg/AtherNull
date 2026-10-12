import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// permittedRepository is stored as entered on the "Import a repository" form
// (e.g. "github.com/acme/website", "https://github.com/acme/website.git",
// or just "acme/website") — normalize before building a github.com link.
export function githubRevisionUrl(permittedRepository: string, revision: string): string {
  const path = permittedRepository
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/^github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  return `https://github.com/${path}/tree/${encodeURIComponent(revision)}`;
}

// "github.com/acme/web" or "https://github.com/acme/web.git" -> "acme/web";
// a local path -> its last segment.
export function repoLabel(repository: string): string {
  // Planned from a chat with no repository: AtherNull hosts the code.
  if (repository.startsWith("athernull://hosted/")) return "AtherNull-hosted";
  const parts = repository
    .trim()
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/\.git$/, "")
    .split(/[\\/]/)
    .filter(Boolean);
  if (parts[0]?.includes(".") && parts.length >= 3) return parts.slice(1).join("/");
  return parts.at(-1) ?? repository;
}
