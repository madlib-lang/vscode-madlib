const { LanguageClient, RevealOutputChannelOn } = require("vscode-languageclient");
const vscode = require("vscode");
const { execSync } = require("child_process");

let client;
let statusBar;
let outputChannel;
let traceOutputChannel;

const escapeShell = (cmd) =>
  '"' + cmd.replace(/(["\$`\\])/g, "\\$1") + '"';

function getMadlibPath() {
  return vscode.workspace.getConfiguration("madlib").get("server.path") || "madlib";
}

function isMadlibAvailable(madlibPath) {
  try {
    execSync(`${madlibPath} --version`, { encoding: "utf-8", timeout: 5000 });
    return true;
  } catch (_) {
    return false;
  }
}

function setStatusBar(state) {
  if (!statusBar) return;
  switch (state) {
    case "starting":
      statusBar.text = "$(sync~spin) Madlib";
      statusBar.tooltip = "Madlib Language Server is starting...";
      statusBar.backgroundColor = undefined;
      break;
    case "ready":
      statusBar.text = "$(check) Madlib";
      statusBar.tooltip = "Madlib Language Server is ready — click to restart";
      statusBar.backgroundColor = undefined;
      break;
    case "error":
      statusBar.text = "$(error) Madlib";
      statusBar.tooltip = "Madlib Language Server error — click to restart";
      statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
      break;
    case "stopped":
      statusBar.text = "$(circle-slash) Madlib";
      statusBar.tooltip = "Madlib Language Server stopped — click to restart";
      statusBar.backgroundColor = undefined;
      break;
  }
}

exports.activate = async (context) => {
  outputChannel = vscode.window.createOutputChannel("Madlib Language Server");
  traceOutputChannel = vscode.window.createOutputChannel("Madlib Language Server Trace");

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "madlib.restartLanguageServer";
  setStatusBar("starting");
  statusBar.show();

  context.subscriptions.push(outputChannel, traceOutputChannel, statusBar);

  const madlibPath = getMadlibPath();

  if (!isMadlibAvailable(madlibPath)) {
    setStatusBar("error");
    const action = await vscode.window.showErrorMessage(
      `Madlib: '${madlibPath}' binary not found in PATH. Please install Madlib to enable language features.`,
      "Open Installation Guide"
    );
    if (action === "Open Installation Guide") {
      vscode.env.openExternal(vscode.Uri.parse("https://madlib-lang.org"));
    }
    return;
  }

  const options = { command: madlibPath, args: ["lsp"] };
  const serverOptions = { run: options, debug: options };

  const fileWatcher = vscode.workspace.createFileSystemWatcher("**/*.mad");
  context.subscriptions.push(fileWatcher);

  const clientOptions = {
    documentSelector: [{ scheme: "file", language: "madlib" }],
    outputChannel,
    traceOutputChannel,
    revealOutputChannelOn: RevealOutputChannelOn.Never,
    synchronize: {
      fileEvents: fileWatcher,
    },
  };

  client = new LanguageClient(
    "MadlibServer",
    "Madlib Language Server",
    serverOptions,
    clientOptions
  );

  client.onDidChangeState((event) => {
    const { State } = require("vscode-languageclient");
    if (event.newState === State.Running) {
      setStatusBar("ready");
    } else if (event.newState === State.Stopped) {
      setStatusBar("stopped");
    } else if (event.newState === State.Starting) {
      setStatusBar("starting");
    }
  });

  const formattingProvider = vscode.languages.registerDocumentFormattingEditProvider("madlib", {
    provideDocumentFormattingEdits(document) {
      const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!rootPath) {
        vscode.window.showErrorMessage("Madlib: No workspace folder open. Cannot format.");
        return [];
      }
      try {
        const result = execSync(
          `${getMadlibPath()} format --text ${escapeShell(document.getText())}`,
          { encoding: "utf-8", cwd: rootPath }
        );
        const firstLine = document.lineAt(0);
        const lastLine = document.lineAt(document.lineCount - 1);
        const textRange = new vscode.Range(firstLine.range.start, lastLine.range.end);
        return [vscode.TextEdit.replace(textRange, result)];
      } catch (e) {
        vscode.window.showErrorMessage(`Madlib formatter failed: ${e.message}`);
        return [];
      }
    },
  });
  context.subscriptions.push(formattingProvider);

  // Format on save
  const onSaveListener = vscode.workspace.onWillSaveTextDocument((event) => {
    const enabled = vscode.workspace.getConfiguration("madlib").get("format.onSave");
    if (!enabled) return;
    if (event.document.languageId !== "madlib") return;
    event.waitUntil(
      vscode.commands.executeCommand("editor.action.formatDocument")
    );
  });
  context.subscriptions.push(onSaveListener);

  context.subscriptions.push(
    vscode.commands.registerCommand("madlib.restartLanguageServer", async () => {
      setStatusBar("starting");
      try {
        await client.stop();
        await client.start();
        vscode.window.showInformationMessage("Madlib language server restarted.");
      } catch (e) {
        setStatusBar("error");
        vscode.window.showErrorMessage(`Madlib: Failed to restart language server: ${e.message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("madlib.showOutputChannel", () => {
      outputChannel.show();
    })
  );

  try {
    await client.start();
  } catch (e) {
    setStatusBar("error");
    vscode.window.showErrorMessage(`Madlib: Language server failed to start: ${e.message}`);
  }
};

exports.deactivate = async () => {
  if (client) {
    await client.stop();
  }
};
