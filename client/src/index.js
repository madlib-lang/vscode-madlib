const path = require("path");

const {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} = require("vscode-languageclient");

let client;

exports.activate = context => {
  console.log(context);
  // The server is implemented in node
  let serverModule = context.asAbsolutePath(path.join("server", "src", "index.js"));
  // The debug options for the server
  // --inspect=6009: runs the server in Node's Inspector mode so VS Code can attach to the server for debugging
  let debugOptions = { execArgv: ["--nolazy", "--inspect=6009"] };

  // If the extension is launched in debug mode then the debug server options are used
  // Otherwise the run options are used
  let serverOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: debugOptions,
    },
  };

  // Options to control the language client
  let clientOptions = {
    documentSelector: [{ scheme: "file", language: "madlib" }],
    hoverProvider: true,
  };

  // Create the language client and start the client.
  client = new LanguageClient(
    "MadlibServer",
    "Madlib Language Server",
    serverOptions,
    clientOptions
  );

  // Start the client. This will also launch the server
  client.start();
};

exports.deactivate = () => {
  if (!client) {
    return undefined;
  }
  return client.stop();
};
