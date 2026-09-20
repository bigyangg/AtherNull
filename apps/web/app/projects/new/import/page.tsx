import { NewRepoProjectForm } from "@/components/projects/new-repo-project-form";

export default function ImportProjectPage() {
  return (
    <main className="mx-auto max-w-xl px-6 py-10">
      <h1 className="mb-6 text-xl font-semibold">Import repository</h1>
      <NewRepoProjectForm />
    </main>
  );
}
