// Gutter diffs for SVN files. VS Code draws quick diffs only for a SourceControl's
// quickDiffProvider, so one SourceControl is created per SVN working-copy root, the
// first time a file in it is opened. It has no input box, no resource groups and no
// commands: it shows up in the SCM view as an empty provider and offers nothing to run.
import * as path from "path";
import * as vscode from "vscode";

/** Returns the BASE URI for a file if it belongs to this root and svn tracks it. */
export type OriginalFor = (file: vscode.Uri, root: string) => Promise<vscode.Uri | undefined>;

export class SvnQuickDiff implements vscode.Disposable {
  private readonly controls = new Map<string, vscode.SourceControl>();

  constructor(private readonly originalFor: OriginalFor) {}

  ensure(root: string): void {
    if (this.controls.has(root)) return;
    const sc = vscode.scm.createSourceControl("stitch.svn", `SVN (Stitch): ${path.basename(root)}`, vscode.Uri.file(root));
    sc.inputBox.visible = false;
    sc.quickDiffProvider = {
      provideOriginalResource: (uri) => this.originalFor(uri, root),
    };
    this.controls.set(root, sc);
  }

  clear(): void {
    for (const sc of this.controls.values()) sc.dispose();
    this.controls.clear();
  }

  dispose(): void {
    this.clear();
  }
}
