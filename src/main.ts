import { appendFileSync, readFileSync } from "node:fs";
import { main, type Io } from "./run";

const io: Io = {
  env: process.env,
  readFile: (path) => readFileSync(path, "utf8"),
  appendFile: (path, text) => {
    if (path) appendFileSync(path, text);
  },
  log: (line) => console.log(line),
  fetch: (...args) => fetch(...args),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

main(io).then((failed) => {
  process.exitCode = failed ? 1 : 0;
});
