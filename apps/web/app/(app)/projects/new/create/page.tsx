import { NewProjectForm } from "@/components/projects/new-project-form";

export default function CreateProjectPage() {
  return (
    <main className="mx-auto max-w-xl px-6 py-10">
      <h1 className="mb-6 text-xl font-semibold">New project</h1>
      <NewProjectForm />
    </main>
  );
}
