const fs = require("fs");
const path = require("path");

const SERVER_PACKAGE = "@lumine-code/sofistik-language-server";

const nodeLaunch = (entry, version) => ({
  command: process.execPath,
  args: [entry, "--stdio"],
  env: { ELECTRON_RUN_AS_NODE: "1" },
  ...(version && { version }),
});

exports.resolveServer = async (configuredPath) => {
  if (configuredPath) {
    if (!path.isAbsolute(configuredPath)) throw new Error("Server Path must be an absolute path.");
    const javascript = /\.(?:c|m)?js$/i.test(configuredPath);
    await fs.promises.access(configuredPath, javascript ? fs.constants.R_OK : fs.constants.X_OK);
    return javascript ? nodeLaunch(configuredPath) : { command: configuredPath, args: ["--stdio"] };
  }

  // The server is a git-pinned runtime dependency. Resolve from this package,
  // which also makes its parser and datasets resolve from the same generation.
  let entry;
  try {
    entry = require.resolve(`${SERVER_PACKAGE}/bin/cli.js`);
  } catch (error) {
    if (error.code === "MODULE_NOT_FOUND") return null;
    throw error;
  }
  return nodeLaunch(entry, require(`${SERVER_PACKAGE}/package.json`).version);
};
