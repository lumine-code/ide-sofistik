const SERVER_PACKAGE = "@lumine-code/sofistik-language-server";

exports.resolveServer = async (context, configuredPath) => {
  const selection = await context.resolver.select({
    configuredPath,
    configuredKind: "auto",
    bundledPath: () => {
      try {
        return require.resolve(`${SERVER_PACKAGE}/bin/cli.js`);
      } catch (error) {
        if (error.code === "MODULE_NOT_FOUND") return null;
        throw error;
      }
    },
    kind: "node",
    allowShellWrapper: true,
  });
  if (!selection) return null;
  const launch = await context.resolver.launch(selection, {
    args: ["--stdio"],
    cwd: context.rootPath,
    transport: "stdio",
  });
  if (launch && selection.source === "bundled")
    launch.version = require(`${SERVER_PACKAGE}/package.json`).version;
  return launch;
};
