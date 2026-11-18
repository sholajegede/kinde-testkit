const { join } = require("node:path");

const dist = join(__dirname, "..", "..", "..", "dist");

module.exports = {
  rootDir: __dirname,
  testEnvironment: "node",
  testMatch: ["<rootDir>/*.test.cjs"],
  moduleNameMapper: {
    "^kinde-testkit$": join(dist, "index.cjs"),
    "^kinde-testkit/jest$": join(dist, "jest.cjs"),
  },
};
