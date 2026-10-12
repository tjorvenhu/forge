import type { GitIntegrationConflict } from "@forge/protocol";

/** Task for the Claude session that takes over origin's commits after FORGE could not do it automatically. */
export function integrationPrompt(c: GitIntegrationConflict, push: boolean): string {
  const remote = `origin/${c.branch}`;
  const files = c.files.length ? c.files.map((f) => `- ${f}`).join("\n") : "- (git hat keine Dateien genannt)";
  const intro = push ? `Ich wollte ${c.branch} pushen.` : `Ich wollte ${c.branch} aktualisieren (Pull).`;
  const situation = c.stash
    ? [
        `${intro} Der Branch ist schon auf dem Stand von ${remote}, aber beim Zurückholen meiner nicht committeten Änderungen aus dem Stash gab es Konflikte in:`,
        files,
      ]
    : [
        `${intro} Auf ${remote} gibt es ${c.remoteCommits} neue Commits, lokal habe ich ${c.localCommits} eigene. FORGE hat einen Rebase versucht, der hatte Konflikte in:`,
        files,
        "",
        "Der Rebase ist abgebrochen, das Repository ist wieder im Stand von vorher.",
      ];
  const steps = c.stash
    ? ["Löse die Konflikte so, dass meine Änderungen und die neuen Commits erhalten bleiben. Danach `git stash drop`, aber erst wenn alles aufgelöst ist."]
    : [`\`git fetch origin\`, dann \`git rebase --autostash --rebase-merges ${remote}\`.`, "Löse die Konflikte so, dass beide Seiten erhalten bleiben."];
  steps.push(
    "Wenn nicht klar ist, welche Seite gelten soll, oder die Änderungen fachlich kollidieren: frag mich mit AskUserQuestion und rate nicht. Passt ein Merge besser als ein Rebase (etwa bei sehr vielen Konflikten über viele Commits), schlag ihn vor und frag vorher.",
    "Prüf danach, ob das Projekt noch baut und die Tests laufen, sofern es dafür einen Befehl gibt.",
    push ? `Dann \`git push origin ${c.branch}\`. Kein Force-Push.` : "Nicht pushen.",
  );
  return [...situation, "", "Bitte:", ...steps.map((s, i) => `${i + 1}. ${s}`), "", "Fass am Ende kurz zusammen, wie du jeden Konflikt aufgelöst hast."].join("\n");
}
