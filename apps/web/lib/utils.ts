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
