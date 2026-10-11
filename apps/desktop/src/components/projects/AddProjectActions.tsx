import { FolderOpen, FolderPlus, GitBranch } from "lucide-react";
import { useUi } from "@/stores/ui";
import { Button } from "@/components/ui/button";

/** Page header buttons to clone, create or import a project. */
export function AddProjectActions() {
  const setNewProject = useUi((s) => s.setNewProject);
  return (
    <>
      <Button onClick={() => setNewProject("clone")}>
        <GitBranch className="h-3.5 w-3.5" /> Klonen
      </Button>
      <Button onClick={() => setNewProject("create")}>
        <FolderPlus className="h-3.5 w-3.5" /> Neu
      </Button>
      <Button variant="primary" onClick={() => setNewProject("import")}>
        <FolderOpen className="h-3.5 w-3.5" /> Ordner öffnen
      </Button>
    </>
  );
}
