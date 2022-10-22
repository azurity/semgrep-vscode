import path = require("path");
import fs = require('fs');
import * as vscode from "vscode";
import { promisify } from "util";
import { execFile } from "child_process";


const execFileAsync = promisify(execFile);
let Mark: vscode.TextEditorDecorationType;
// let MarkDone: vscode.TextEditorDecorationType;

export function activate(context: vscode.ExtensionContext) {
  const semgrepSearchProvider = new SemgrepSearchProvider();

  Mark = vscode.window.createTextEditorDecorationType({
    backgroundColor: "rgb(255 255 0 / 10%)",
    // textDecoration: "underline wavy red",
  });
  // MarkDone = vscode.window.createTextEditorDecorationType({
  //   backgroundColor: "yellow",
  //   // textDecoration: "underline wavy rgb(127 127 127 / 0.7)",
  // });

  vscode.window.onDidChangeActiveTextEditor(refreshHighlight);

  const customView = vscode.window.createTreeView("semgrepTreeView", {
    treeDataProvider: semgrepSearchProvider,
  });

  const subs = context.subscriptions;
  subs.push(
    vscode.languages.registerHoverProvider(
      { scheme: "file" },
      new HoverProvider()
    )
  );

  subs.push(
    vscode.commands.registerCommand(
      "semgrep.scanWorkspace",
      async (context: vscode.ExtensionContext) =>
        await semgrepSearchProvider.search(customView)
    )
  );

  subs.push(
    vscode.commands.registerCommand(
      "semgrep.goToFile",
      async (filePath: string, lineNumber: number) =>
        await semgrepSearchProvider.goToFile(filePath, lineNumber)
    )
  );

  subs.push(
    vscode.commands.registerCommand('semgrep.remove', function (item: Finding) {
      semgrepSearchProvider.results.forEach((value: SearchResult) => {
        let index = value.findings.findIndex((value) => value === item);
        if (index >= 0) {
          value.findings.splice(index, 1);
        }
        rangeResults.get(value.resourceUri.toString())!.splice(index, 1);
      });
      semgrepSearchProvider.results = semgrepSearchProvider.results.filter((value: SearchResult) => {
        if (value.findings.length == 0) {
          rangeResults.delete(value.resourceUri.toString());
          return false;
        }
        return true;
      });
      refreshHighlight();
      semgrepSearchProvider._onDidChangeTreeData.fire(null);
    })
  );

  // subs.push(
  //   vscode.commands.registerCommand(
  //     "semgrep.deleteEntry",
  //     async (element: Finding | SearchResult) =>
  //       await semgrepSearchProvider.deleteElement(element)
  //   )
  // );
};

export class SemgrepSearchProvider
  implements vscode.TreeDataProvider<SearchResult | Finding>
{
  _onDidChangeTreeData: vscode.EventEmitter<SearchResult | null> =
    new vscode.EventEmitter<SearchResult | null>();
  readonly onDidChangeTreeData: vscode.Event<SearchResult | null> =
    this._onDidChangeTreeData.event;

  results: SearchResult[] = [];

  getTreeItem(element: SearchResult): vscode.TreeItem {
    return element;
  }

  getParent(
    element: SearchResult | Finding
  ): SearchResult | Finding | undefined {
    /*
      I thought about this for a long time.
      I know this is not the most effective way of doing this
      but it is the easiest. Computers are fast tell this becomes
      a problem i'm just going to leave it like this
    */
    this.results.forEach((e) => {
      e.findings.forEach((f) => {
        if (f === element) {
          return e;
        }
      });
    });

    return undefined;
  }

  // deleteElement(element: SearchResult | Finding) {
  //   if (element instanceof SearchResult) {
  //     this.results = this.results.filter((e) => {
  //       return e !== element;
  //     });
  //   } else {
  //     this.results.forEach((e) => {
  //       e.findings = e.findings.filter((f) => {
  //         if (f !== element) {
  //           return true;
  //         }

  //         // We are going to remove this element so we need to subtract one
  //         e.description = String(e.findings.length - 1);
  //       });
  //     });
  //   }

  //   this._onDidChangeTreeData.fire(null);
  // }

  getChildren(
    element?: SearchResult
  ): Thenable<SearchResult[]> | Thenable<Finding[]> {
    if (element == undefined) {
      return Promise.resolve(this.results);
    }

    return Promise.resolve(element.findings);
  }

  goToFile = async (filePath: string, lineNumber: number) => {
    const openPath = vscode.Uri.parse("file://" + filePath);
    const document = await vscode.workspace.openTextDocument(openPath);

    const editor = await vscode.window.showTextDocument(document);

    editor.revealRange(new vscode.Range(lineNumber, 0, lineNumber, 0)); //TODO: we should most likely add the end as well since it provided
    editor.selection = new vscode.Selection(lineNumber, 0, lineNumber, 0);
  };

  search = async (customView: vscode.TreeView<SearchResult | Finding>) => {


    const path = vscode.workspace.workspaceFolders;

    if (path == undefined) {
      return;
    }

    vscode.commands.executeCommand("semgrepTreeView.focus");

    let outputGen = searchPatternWorkspace(
      path[0].uri.fsPath,
      // inputResult,
      // quickPickResult
    );

    // customView.message = `Results for pattern: "${inputResult}"`;
    this.results = [];
    this._onDidChangeTreeData.fire(null);

    for await (let it of outputGen) {
      customView.message = `${it.percent} of ${it.total}`;
      if (it.result.length > 0) {
        this.results = this.results.concat(it.result);
        refreshHighlight();
        this._onDidChangeTreeData.fire(null);
      }
    }
  };
}

export class SearchResult extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public findings: Finding[],
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly resourceUri: vscode.Uri
  ) {
    super(label, collapsibleState);
    this.iconPath = vscode.ThemeIcon.File;
  }
}

export class Finding extends vscode.TreeItem {
  constructor(
    public label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly command?: vscode.Command
  ) {
    super(label.split('\n')[0], collapsibleState);
    this.tooltip = label;
    this.label = label.split('\n')[0];
    this.contextValue = "finding";
  }
}

function getAllFiles(filePath: string): string[] {
  let allFilePaths: string[] = [];
  if (fs.existsSync(filePath)) {
    const files = fs.readdirSync(filePath);
    for (let i = 0; i < files.length; i++) {
      let file = files[i];
      let currentFilePath = filePath + '/' + file;
      let stats = fs.lstatSync(currentFilePath);
      if (stats.isDirectory()) {
        allFilePaths = allFilePaths.concat(getAllFiles(currentFilePath));
      } else {
        allFilePaths.push(currentFilePath);
      }
    }
  }
  return allFilePaths;
}

interface Info {
  range: vscode.Range;
  check_id: string;
  message: string;
  confidence: string;
  severity: string;
}

let rangeResults = new Map<string, Info[]>();

// Checks a pattern based on path.
export const searchPatternWorkspace = async function* (
  filePath: string
): AsyncGenerator<{ percent: number, total: number, result: SearchResult[] }> {

  let configFolders = vscode.workspace.getConfiguration('semgrep.scan').get('configuration') as string[];
  let SEMGREP_BINARY = vscode.workspace.getConfiguration('semgrep').get('path') as string;
  let configOpt = configFolders.map(it => ['-c', it]).flat();

  let totalN = 0;
  let step = 0;
  let files = getAllFiles(filePath);
  rangeResults = new Map<string, Info[]>();
  for (let file of files) {
    const { stdout, stderr } = await execFileAsync(
      SEMGREP_BINARY,
      // ["--json", "-e", pattern, "-l", lang, filePath],
      ["--json", ...configOpt, file],
      { timeout: 30 * 1000 }
    );
    step += 1;

    let results = new Map<string, SearchResult>();
    JSON.parse(stdout.trim()).results.forEach((result: any) => {
      if (results.has(path.basename(result.path))) {
        results.get(path.basename(result.path))?.findings.push(
          new Finding(result.extra.lines, vscode.TreeItemCollapsibleState.None, {
            command: "semgrep.goToFile",
            arguments: [result.path, result.start.line - 1],
            title: "Go to file",
          })
        );
      } else {
        results.set(
          path.basename(result.path),
          new SearchResult(
            path.basename(result.path),
            [
              new Finding(
                result.extra.lines,
                vscode.TreeItemCollapsibleState.None,
                {
                  command: "semgrep.goToFile",
                  arguments: [result.path, result.start.line - 1],
                  title: "Go to file",
                }
              ),
            ],
            vscode.TreeItemCollapsibleState.Expanded,
            vscode.Uri.parse("file://" + result.path)
          )
        );
      }
      if (rangeResults.has("file://" + result.path)) {
        rangeResults.get("file://" + result.path)?.push({
          range: new vscode.Range(result.start.line - 1, result.start.col - 1, result.end.line - 1, result.end.col - 1),
          check_id: result.check_id,
          message: result.extra.message,
          confidence: result.extra.metadata.confidence,
          severity: result.extra.severity
        });
      } else {
        rangeResults.set("file://" + result.path, [
          {
            range: new vscode.Range(result.start.line - 1, result.start.col - 1, result.end.line - 1, result.end.col - 1),
            check_id: result.check_id,
            message: result.extra.message,
            confidence: result.extra.metadata.confidence,
            severity: result.extra.severity
          }
        ]);
      }
    });
    if (results.size != 0) {
      yield {
        percent: step,
        total: files.length,
        result: Array.from(results).map(([key, value]) => {
          value.description = String(value.findings.length);
          return value;
        })
      };
    } else {
      yield {
        percent: step,
        total: files.length,
        result: [],
      }
    }
    totalN += results.size;
  }

  if (totalN == 0) {
    await vscode.window.showInformationMessage(
      "No Results returned for that pattern"
    );
  }
  return;
};


function refreshHighlight() {
  if (!!vscode.window.activeTextEditor) {
    let docPath = vscode.window.activeTextEditor.document.uri.toString();
    vscode.window.activeTextEditor.setDecorations(Mark, []);
    if (rangeResults.has(docPath)) {
      vscode.window.activeTextEditor.setDecorations(Mark, [...rangeResults.get(docPath)!.map(it => it.range)]);
    }
  }
}

class HoverProvider implements vscode.HoverProvider {
  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.Hover> {
    let docPath = document.uri.toString();
    if (rangeResults.has(docPath)) {
      for (let range of rangeResults.get(docPath)!) {
        if (range.range.contains(position)) {
          return new vscode.Hover(`**ID**: ${range.check_id}\n\n**Message**: ${range.message}\n\n**Confidence**: ${range.confidence}`, range.range);
        }
      }
    }
  }
}
