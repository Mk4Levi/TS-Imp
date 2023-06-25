// Compodoc does not follow symlinks (it ignores them and their contents entirely)
// So, we need to run a separate compodoc process on every symlink inside the project,
// then combine the results into one large documentation.json

import { join, resolve } from "path";
import { realpath, readFile, writeFile, lstat } from "fs-extra";
import { globSync } from "glob";
import { directory } from "tempy";
import { execaCommand } from "./utils/exec";

const logger = console;

// Find all symlinks in a directory. There may be more efficient ways to do this, but this works.
async function findSymlinks(dir: string) {
  const potentialDirs = await globSync(`${dir}/**/*/`);

  return (
    await Promise.all(
      potentialDirs.map(
        async (p) =>
          [p, (await lstat(p.replace(/\/$/, ""))).isSymbolicLink()] as [
            string,
            boolean
          ]
      )
    )
  )
    .filter(([, s]) => s)
    .map(([p]) => p);
}

async function run(cwd: string) {
  const dirs = [
    cwd,
    ...(await findSymlinks(resolve(cwd, "./src"))),
    ...(await findSymlinks(resolve(cwd, "./stories"))),
    ...(await findSymlinks(resolve(cwd, "./template-stories"))),
  ];

  const docsArray: Record<string, any>[] = await Promise.all(
    dirs.map(async (dir) => {
      const outputDir = directory();
      const resolvedDir = await realpath(dir);
      await execaCommand(
        `yarn compodoc ${resolvedDir} -p ./tsconfig.json -e json -d ${outputDir}`,
        { cwd }
      );
      const contents = await readFile(
        join(outputDir, "documentation.json"),
        "utf8"
      );
      try {
        return JSON.parse(contents);
      } catch (err) {
        logger.error(`Error parsing JSON at ${outputDir}\n\n`);
        logger.error(contents);
        throw err;
      }
    })
  );

  // Compose together any array entries, discard anything else (we happen to only read the array fields)
  const documentation = docsArray.slice(1).reduce((acc, entry) => {
    return Object.fromEntries(
      Object.entries(acc).map(([key, accValue]) => {
        if (Array.isArray(accValue)) {
          return [key, [...accValue, ...entry[key]]];
        }
        return [key, accValue];
      })
    );
  }, docsArray[0]);

  await writeFile(
    join(cwd, "documentation.json"),
    JSON.stringify(documentation)
  );
}

if (require.main === module) {
  run(resolve(process.argv[2]))
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error();
      logger.error(err);
      process.exit(1);
    });
}

import glob from "fast-glob";
import path from "path";
import fsSync from "node:fs";
import JSON5 from "json5";

const files = glob.sync("**/*/tsconfig.json", {
  absolute: true,
  cwd: "..",
});

(async function main() {
  const packages = files
    .filter((file) => !file.includes("node_modules") && !file.includes("dist"))
    .map((file) => {
      const packageJson = path.join(path.dirname(file), "package.json");
      let packageName;
      if (fsSync.existsSync(packageJson)) {
        const json = fsSync.readFileSync(packageJson, { encoding: "utf-8" });
        packageName = JSON5.parse(json).name;
      }

      let strict;
      if (fsSync.existsSync(file)) {
        const tsconfig = fsSync.readFileSync(file, { encoding: "utf-8" });
        const tsconfigJson = JSON5.parse(tsconfig);
        strict = tsconfigJson?.compilerOptions?.strict ?? false;
      }

      if (packageName && strict === false) {
        return packageName;
      }
      return null;
    })
    .filter(Boolean)
    .sort();

  console.log(packages.join("\n"));
  console.log(packages.length);

  // console.log(files.filter((file) => !file.includes('node_modules') && !file.includes('dist')));
})();

/* eslint-disable import/extensions */
import { fail, danger } from "danger";
import { execSync } from "child_process";

execSync("npm install lodash");

const flatten = require("lodash/flatten.js");
const intersection = require("lodash/intersection.js");
const isEmpty = require("lodash/isEmpty.js");

const pkg = require("../code/package.json"); // eslint-disable-line import/newline-after-import
const prLogConfig = pkg["pr-log"];

const Versions = {
  PATCH: "PATCH",
  MINOR: "MINOR",
  MAJOR: "MAJOR",
};

const branchVersion = Versions.MINOR;

const checkRequiredLabels = (labels: string[]) => {
  const forbiddenLabels = flatten([
    "ci: do not merge",
    "in progress",
    branchVersion !== Versions.MAJOR ? "BREAKING CHANGE" : [],
    branchVersion === Versions.PATCH ? "feature request" : [],
  ]);

  const requiredLabels = flatten([
    prLogConfig.skipLabels || [],
    (prLogConfig.validLabels || []).map((keyVal: string) => keyVal[0]),
  ]);

  const blockingLabels = intersection(forbiddenLabels, labels);
  if (!isEmpty(blockingLabels)) {
    fail(
      `PR is marked with ${blockingLabels
        .map((label: string) => `"${label}"`)
        .join(", ")} label${blockingLabels.length > 1 ? "s" : ""}.`
    );
  }

  const foundLabels = intersection(requiredLabels, labels);
  if (isEmpty(foundLabels)) {
    fail(`PR is not labeled with one of: ${JSON.stringify(requiredLabels)}`);
  } else if (foundLabels.length > 1) {
    fail(
      `Please choose only one of these labels: ${JSON.stringify(foundLabels)}`
    );
  }
};

const checkPrTitle = (title: string) => {
  const match = title.match(/^[A-Z].+:\s[A-Z].+$/);
  if (!match) {
    fail(
      `PR title must be in the format of "Area: Summary", With both Area and Summary starting with a capital letter
Good examples:
- "Docs: Describe Canvas Doc Block"
- "Svelte: Support Svelte v4"
Bad examples:
- "add new api docs"
- "fix: Svelte 4 support"
- "Vue: improve docs"`
    );
  }
};

if (prLogConfig) {
  const { labels } = danger.github.issue;
  checkRequiredLabels(labels.map((l) => l.name));
  checkPrTitle(danger.github.pr.title);
}

/* eslint-disable no-console */
import { readJson } from "fs-extra";
import { join } from "path";
import { CODE_DIRECTORY } from "./utils/constants";
import { execaCommand } from "./utils/exec";

type Branch = "main" | "next" | "alpha" | "next-release" | "latest-release";
type Workflow = "merged" | "daily";

const getFooter = async (branch: Branch, workflow: Workflow, job: string) => {
  if (job === "chromatic-sandboxes") {
    return `\n\nThis might not necessarily be a bug, it could be a visual diff that you have to review and approve. Please check it!`;
  }

  // The CI workflows can run on release branches and we should display the version number
  if (branch === "next-release" || branch === "latest-release") {
    const packageJson = await readJson(join(CODE_DIRECTORY, "package.json"));

    // running in alpha branch we should just show the version which failed
    return `\n**Version: ${packageJson.version}**`;
  }

  const mergeCommits =
    workflow === "merged"
      ? // show single merge for merged workflow
        `git log -1 --pretty=format:"\`%h\` %<(12)%ar %s [%an]"`
      : // show last 24h merges for daily workflow
        `git log --merges --since="24 hours ago" --pretty=format:"\`%h\` %<(12)%ar %s [%an]"`;

  const result = await execaCommand(mergeCommits, { shell: true });
  const formattedResult = result.stdout
    // discord needs escaped line breaks
    .replace(/\n/g, "\\n")
    // make links out of pull request ids
    .replace(
      /Merge pull request #/g,
      "https://github.com/storybookjs/storybook/pull/"
    );

  return `\n\n**Relevant PRs:**\n${formattedResult}`;
};

// This command is run in Circle CI on failures, to get a rich message to report to Discord
// Usage: yarn get-report-message type workflow branch
async function run() {
  const [, , workflow = "", template = "none"] = process.argv;

  if (!workflow) {
    throw new Error("[get-report-message] Missing workflow argument.");
  }

  const { CIRCLE_BRANCH: currentBranch = "", CIRCLE_JOB: currentJob = "" } =
    process.env;

  if (!currentBranch || !currentJob) {
    throw new Error(
      "[get-report-message] Missing CIRCLE_BRANCH or CIRCLE_JOB environment variables."
    );
  }

  const title = `Oh no! The **${currentJob}** job has failed${
    template !== "none" ? ` for **${template}**.` : "."
  }`;
  const body = `\n\n**Branch**: \`${currentBranch}\`\n**Workflow:** ${workflow}`;
  const footer = await getFooter(
    currentBranch as Branch,
    workflow as Workflow,
    currentJob
  );

  console.log(`${title}${body}${footer}`.replace(/\n/g, "\\n"));
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

import { join } from "path";
import { BigQuery } from "@google-cloud/bigquery";

import type { BenchResults } from "./bench/types";
import { loadBench } from "./bench/utils";
import { SANDBOX_DIRECTORY } from "./utils/constants";
import { execaCommand } from "./utils/exec";

const templateKey = process.argv[2];

const GCP_CREDENTIALS = JSON.parse(process.env.GCP_CREDENTIALS || "{}");
const sandboxDir = process.env.SANDBOX_ROOT || SANDBOX_DIRECTORY;
const templateSandboxDir =
  templateKey && join(sandboxDir, templateKey.replace("/", "-"));

const defaults: Record<keyof BenchResults, null> = {
  branch: null,
  commit: null,
  timestamp: null,
  label: null,

  createTime: null,
  generateTime: null,
  initTime: null,
  createSize: null,
  generateSize: null,
  initSize: null,
  diffSize: null,
  buildTime: null,
  buildSize: null,
  buildSbAddonsSize: null,
  buildSbCommonSize: null,
  buildSbManagerSize: null,
  buildSbPreviewSize: null,
  buildStaticSize: null,
  buildPrebuildSize: null,
  buildPreviewSize: null,
  devPreviewResponsive: null,
  devManagerResponsive: null,
  devManagerHeaderVisible: null,
  devManagerIndexVisible: null,
  devStoryVisible: null,
  devStoryVisibleUncached: null,
  devAutodocsVisible: null,
  devMDXVisible: null,
  buildManagerHeaderVisible: null,
  buildManagerIndexVisible: null,
  buildAutodocsVisible: null,
  buildStoryVisible: null,
  buildMDXVisible: null,
};

const uploadBench = async () => {
  const results = await loadBench({ rootDir: templateSandboxDir });

  const row = {
    ...defaults,
    branch:
      process.env.CIRCLE_BRANCH ||
      (await execaCommand("git rev-parse --abbrev-ref HEAD")).stdout,
    commit:
      process.env.CIRCLE_SHA1 ||
      (await execaCommand("git rev-parse HEAD")).stdout,
    timestamp: new Date().toISOString(),
    label: templateKey,
    ...results,
  } as BenchResults;

  const store = new BigQuery({
    projectId: GCP_CREDENTIALS.project_id,
    credentials: GCP_CREDENTIALS,
  });
  const dataset = store.dataset("benchmark_results");
  const appTable = dataset.table("bench2");

  await appTable.insert([row]);
};

uploadBench()
  .catch((err) => {
    console.error(err);
    if (err.errors) {
      err.errors.forEach((elt: any) => {
        console.log(elt);
      });
    }
    process.exit(1);
  })
  .then(() => {
    console.log("done");
  });

import { readdir } from "fs/promises";
import { pathExists } from "fs-extra";
import { program } from "commander";
import dedent from "ts-dedent";
import {
  allTemplates,
  templatesByCadence,
  type Cadence,
  type Template as TTemplate,
  type SkippableTask,
} from "../code/lib/cli/src/sandbox-templates";
import { SANDBOX_DIRECTORY } from "./utils/constants";

const sandboxDir = process.env.SANDBOX_ROOT || SANDBOX_DIRECTORY;

type Template = Pick<TTemplate, "inDevelopment" | "skipTasks">;
export type TemplateKey = keyof typeof allTemplates;
export type Templates = Record<TemplateKey, Template>;

async function getDirectories(source: string) {
  return (await readdir(source, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

export async function getTemplate(
  cadence: Cadence,
  scriptName: string,
  { index, total }: { index: number; total: number }
) {
  let potentialTemplateKeys: TemplateKey[] = [];
  if (await pathExists(sandboxDir)) {
    const sandboxes = await getDirectories(sandboxDir);
    potentialTemplateKeys = sandboxes
      .map((dirName) => {
        return Object.keys(allTemplates).find(
          (templateKey) => templateKey.replace("/", "-") === dirName
        );
      })
      .filter(Boolean) as TemplateKey[];
  }

  if (potentialTemplateKeys.length === 0) {
    const cadenceTemplates = Object.entries(allTemplates).filter(([key]) =>
      templatesByCadence[cadence].includes(key as TemplateKey)
    );
    potentialTemplateKeys = cadenceTemplates.map(([k]) => k) as TemplateKey[];
  }

  potentialTemplateKeys = potentialTemplateKeys.filter((t) => {
    const currentTemplate = allTemplates[t] as Template;
    return (
      currentTemplate.inDevelopment !== true &&
      !currentTemplate.skipTasks?.includes(scriptName as SkippableTask)
    );
  });

  if (potentialTemplateKeys.length !== total) {
    throw new Error(dedent`Circle parallelism set incorrectly.
    
      Parallelism is set to ${total}, but there are ${
      potentialTemplateKeys.length
    } templates to run:
      ${potentialTemplateKeys.map((v) => `- ${v}`).join("\n")}
    
      ${await getParallelismSummary(cadence)}
    `);
  }

  return potentialTemplateKeys[index];
}

const tasks = [
  "sandbox",
  "build",
  "chromatic",
  "e2e-tests",
  "e2e-tests-dev",
  "test-runner",
  // 'test-runner-dev', TODO: bring this back when the task is enabled again
  "bench",
];

async function getParallelismSummary(cadence?: Cadence, scriptName?: string) {
  let potentialTemplateKeys: TemplateKey[] = [];
  const cadences = cadence
    ? [cadence]
    : (Object.keys(templatesByCadence) as Cadence[]);
  const scripts = scriptName ? [scriptName] : tasks;
  const summary = [];
  summary.push("These are the values you should have in .circleci/config.yml:");
  cadences.forEach((cad) => {
    summary.push(`\n${cad}`);
    const cadenceTemplates = Object.entries(allTemplates).filter(([key]) =>
      templatesByCadence[cad].includes(key as TemplateKey)
    );
    potentialTemplateKeys = cadenceTemplates.map(([k]) => k) as TemplateKey[];

    scripts.forEach((script) => {
      const templateKeysPerScript = potentialTemplateKeys.filter((t) => {
        const currentTemplate = allTemplates[t] as Template;
        return (
          currentTemplate.inDevelopment !== true &&
          !currentTemplate.skipTasks?.includes(script as SkippableTask)
        );
      });
      if (templateKeysPerScript.length > 0) {
        summary.push(
          `-- ${script} - parallelism: ${templateKeysPerScript.length}${
            templateKeysPerScript.length === 2 ? " (default)" : ""
          }`
        );
      } else {
        summary.push(
          `-- ${script} - this script is fully skipped for this cadence.`
        );
      }
    });
  });

  return summary.concat("\n").join("\n");
}

type RunOptions = { cadence?: Cadence; task?: string; debug: boolean };
async function run({ cadence, task, debug }: RunOptions) {
  if (debug) {
    if (task && !(task in tasks)) {
      throw new Error(
        dedent`The "${task}" task you provided is not valid. Valid tasks (found in .circleci/config.yml) are: 
        ${tasks.map((v) => `- ${v}`).join("\n")}`
      );
    }
    console.log(await getParallelismSummary(cadence as Cadence, task));
    return;
  }

  if (!cadence)
    throw new Error("Need to supply cadence to get template script");

  const { CIRCLE_NODE_INDEX = 0, CIRCLE_NODE_TOTAL = 1 } = process.env;

  console.log(
    await getTemplate(cadence as Cadence, task, {
      index: +CIRCLE_NODE_INDEX,
      total: +CIRCLE_NODE_TOTAL,
    })
  );
}

if (require.main === module) {
  program
    .description("Retrieve the template to run for a given cadence and task")
    .option(
      "--cadence <cadence>",
      "Which cadence you want to run the script for"
    )
    .option("--task <task>", "Which task you want to run the script for")
    .option(
      "--debug",
      "Whether to list the parallelism counts for tasks by cadence",
      false
    );

  program.parse(process.argv);

  const options = program.opts() as RunOptions;

  run(options).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

import { readdir } from "fs/promises";
import { pathExists } from "fs-extra";
import { program } from "commander";
import dedent from "ts-dedent";
import {
  allTemplates,
  templatesByCadence,
  type Cadence,
  type Template as TTemplate,
  type SkippableTask,
} from "../code/lib/cli/src/sandbox-templates";
import { SANDBOX_DIRECTORY } from "./utils/constants";

const sandboxDir = process.env.SANDBOX_ROOT || SANDBOX_DIRECTORY;

type Template = Pick<TTemplate, "inDevelopment" | "skipTasks">;
export type TemplateKey = keyof typeof allTemplates;
export type Templates = Record<TemplateKey, Template>;

async function getDirectories(source: string) {
  return (await readdir(source, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

export async function getTemplate(
  cadence: Cadence,
  scriptName: string,
  { index, total }: { index: number; total: number }
) {
  let potentialTemplateKeys: TemplateKey[] = [];
  if (await pathExists(sandboxDir)) {
    const sandboxes = await getDirectories(sandboxDir);
    potentialTemplateKeys = sandboxes
      .map((dirName) => {
        return Object.keys(allTemplates).find(
          (templateKey) => templateKey.replace("/", "-") === dirName
        );
      })
      .filter(Boolean) as TemplateKey[];
  }

  if (potentialTemplateKeys.length === 0) {
    const cadenceTemplates = Object.entries(allTemplates).filter(([key]) =>
      templatesByCadence[cadence].includes(key as TemplateKey)
    );
    potentialTemplateKeys = cadenceTemplates.map(([k]) => k) as TemplateKey[];
  }

  potentialTemplateKeys = potentialTemplateKeys.filter((t) => {
    const currentTemplate = allTemplates[t] as Template;
    return (
      currentTemplate.inDevelopment !== true &&
      !currentTemplate.skipTasks?.includes(scriptName as SkippableTask)
    );
  });

  if (potentialTemplateKeys.length !== total) {
    throw new Error(dedent`Circle parallelism set incorrectly.
    
      Parallelism is set to ${total}, but there are ${
      potentialTemplateKeys.length
    } templates to run:
      ${potentialTemplateKeys.map((v) => `- ${v}`).join("\n")}
    
      ${await getParallelismSummary(cadence)}
    `);
  }

  return potentialTemplateKeys[index];
}

const tasks = [
  "sandbox",
  "build",
  "chromatic",
  "e2e-tests",
  "e2e-tests-dev",
  "test-runner",
  // 'test-runner-dev', TODO: bring this back when the task is enabled again
  "bench",
];

async function getParallelismSummary(cadence?: Cadence, scriptName?: string) {
  let potentialTemplateKeys: TemplateKey[] = [];
  const cadences = cadence
    ? [cadence]
    : (Object.keys(templatesByCadence) as Cadence[]);
  const scripts = scriptName ? [scriptName] : tasks;
  const summary = [];
  summary.push("These are the values you should have in .circleci/config.yml:");
  cadences.forEach((cad) => {
    summary.push(`\n${cad}`);
    const cadenceTemplates = Object.entries(allTemplates).filter(([key]) =>
      templatesByCadence[cad].includes(key as TemplateKey)
    );
    potentialTemplateKeys = cadenceTemplates.map(([k]) => k) as TemplateKey[];

    scripts.forEach((script) => {
      const templateKeysPerScript = potentialTemplateKeys.filter((t) => {
        const currentTemplate = allTemplates[t] as Template;
        return (
          currentTemplate.inDevelopment !== true &&
          !currentTemplate.skipTasks?.includes(script as SkippableTask)
        );
      });
      if (templateKeysPerScript.length > 0) {
        summary.push(
          `-- ${script} - parallelism: ${templateKeysPerScript.length}${
            templateKeysPerScript.length === 2 ? " (default)" : ""
          }`
        );
      } else {
        summary.push(
          `-- ${script} - this script is fully skipped for this cadence.`
        );
      }
    });
  });

  return summary.concat("\n").join("\n");
}

type RunOptions = { cadence?: Cadence; task?: string; debug: boolean };
async function run({ cadence, task, debug }: RunOptions) {
  if (debug) {
    if (task && !(task in tasks)) {
      throw new Error(
        dedent`The "${task}" task you provided is not valid. Valid tasks (found in .circleci/config.yml) are: 
        ${tasks.map((v) => `- ${v}`).join("\n")}`
      );
    }
    console.log(await getParallelismSummary(cadence as Cadence, task));
    return;
  }

  if (!cadence)
    throw new Error("Need to supply cadence to get template script");

  const { CIRCLE_NODE_INDEX = 0, CIRCLE_NODE_TOTAL = 1 } = process.env;

  console.log(
    await getTemplate(cadence as Cadence, task, {
      index: +CIRCLE_NODE_INDEX,
      total: +CIRCLE_NODE_TOTAL,
    })
  );
}

if (require.main === module) {
  program
    .description("Retrieve the template to run for a given cadence and task")
    .option(
      "--cadence <cadence>",
      "Which cadence you want to run the script for"
    )
    .option("--task <task>", "Which task you want to run the script for")
    .option(
      "--debug",
      "Whether to list the parallelism counts for tasks by cadence",
      false
    );

  program.parse(process.argv);

  const options = program.opts() as RunOptions;

  run(options).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

import { readdir } from "fs/promises";
import { pathExists } from "fs-extra";
import { program } from "commander";
import dedent from "ts-dedent";
import {
  allTemplates,
  templatesByCadence,
  type Cadence,
  type Template as TTemplate,
  type SkippableTask,
} from "../code/lib/cli/src/sandbox-templates";
import { SANDBOX_DIRECTORY } from "./utils/constants";

const sandboxDir = process.env.SANDBOX_ROOT || SANDBOX_DIRECTORY;

type Template = Pick<TTemplate, "inDevelopment" | "skipTasks">;
export type TemplateKey = keyof typeof allTemplates;
export type Templates = Record<TemplateKey, Template>;

async function getDirectories(source: string) {
  return (await readdir(source, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

export async function getTemplate(
  cadence: Cadence,
  scriptName: string,
  { index, total }: { index: number; total: number }
) {
  let potentialTemplateKeys: TemplateKey[] = [];
  if (await pathExists(sandboxDir)) {
    const sandboxes = await getDirectories(sandboxDir);
    potentialTemplateKeys = sandboxes
      .map((dirName) => {
        return Object.keys(allTemplates).find(
          (templateKey) => templateKey.replace("/", "-") === dirName
        );
      })
      .filter(Boolean) as TemplateKey[];
  }

  if (potentialTemplateKeys.length === 0) {
    const cadenceTemplates = Object.entries(allTemplates).filter(([key]) =>
      templatesByCadence[cadence].includes(key as TemplateKey)
    );
    potentialTemplateKeys = cadenceTemplates.map(([k]) => k) as TemplateKey[];
  }

  potentialTemplateKeys = potentialTemplateKeys.filter((t) => {
    const currentTemplate = allTemplates[t] as Template;
    return (
      currentTemplate.inDevelopment !== true &&
      !currentTemplate.skipTasks?.includes(scriptName as SkippableTask)
    );
  });

  if (potentialTemplateKeys.length !== total) {
    throw new Error(dedent`Circle parallelism set incorrectly.
    
      Parallelism is set to ${total}, but there are ${
      potentialTemplateKeys.length
    } templates to run:
      ${potentialTemplateKeys.map((v) => `- ${v}`).join("\n")}
    
      ${await getParallelismSummary(cadence)}
    `);
  }

  return potentialTemplateKeys[index];
}

const tasks = [
  "sandbox",
  "build",
  "chromatic",
  "e2e-tests",
  "e2e-tests-dev",
  "test-runner",
  // 'test-runner-dev', TODO: bring this back when the task is enabled again
  "bench",
];

async function getParallelismSummary(cadence?: Cadence, scriptName?: string) {
  let potentialTemplateKeys: TemplateKey[] = [];
  const cadences = cadence
    ? [cadence]
    : (Object.keys(templatesByCadence) as Cadence[]);
  const scripts = scriptName ? [scriptName] : tasks;
  const summary = [];
  summary.push("These are the values you should have in .circleci/config.yml:");
  cadences.forEach((cad) => {
    summary.push(`\n${cad}`);
    const cadenceTemplates = Object.entries(allTemplates).filter(([key]) =>
      templatesByCadence[cad].includes(key as TemplateKey)
    );
    potentialTemplateKeys = cadenceTemplates.map(([k]) => k) as TemplateKey[];

    scripts.forEach((script) => {
      const templateKeysPerScript = potentialTemplateKeys.filter((t) => {
        const currentTemplate = allTemplates[t] as Template;
        return (
          currentTemplate.inDevelopment !== true &&
          !currentTemplate.skipTasks?.includes(script as SkippableTask)
        );
      });
      if (templateKeysPerScript.length > 0) {
        summary.push(
          `-- ${script} - parallelism: ${templateKeysPerScript.length}${
            templateKeysPerScript.length === 2 ? " (default)" : ""
          }`
        );
      } else {
        summary.push(
          `-- ${script} - this script is fully skipped for this cadence.`
        );
      }
    });
  });

  return summary.concat("\n").join("\n");
}

type RunOptions = { cadence?: Cadence; task?: string; debug: boolean };
async function run({ cadence, task, debug }: RunOptions) {
  if (debug) {
    if (task && !(task in tasks)) {
      throw new Error(
        dedent`The "${task}" task you provided is not valid. Valid tasks (found in .circleci/config.yml) are: 
        ${tasks.map((v) => `- ${v}`).join("\n")}`
      );
    }
    console.log(await getParallelismSummary(cadence as Cadence, task));
    return;
  }

  if (!cadence)
    throw new Error("Need to supply cadence to get template script");

  const { CIRCLE_NODE_INDEX = 0, CIRCLE_NODE_TOTAL = 1 } = process.env;

  console.log(
    await getTemplate(cadence as Cadence, task, {
      index: +CIRCLE_NODE_INDEX,
      total: +CIRCLE_NODE_TOTAL,
    })
  );
}

if (require.main === module) {
  program
    .description("Retrieve the template to run for a given cadence and task")
    .option(
      "--cadence <cadence>",
      "Which cadence you want to run the script for"
    )
    .option("--task <task>", "Which task you want to run the script for")
    .option(
      "--debug",
      "Whether to list the parallelism counts for tasks by cadence",
      false
    );

  program.parse(process.argv);

  const options = program.opts() as RunOptions;

  run(options).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

import { readdir } from "fs/promises";
import { pathExists } from "fs-extra";
import { program } from "commander";
import dedent from "ts-dedent";
import {
  allTemplates,
  templatesByCadence,
  type Cadence,
  type Template as TTemplate,
  type SkippableTask,
} from "../code/lib/cli/src/sandbox-templates";
import { SANDBOX_DIRECTORY } from "./utils/constants";

const sandboxDir = process.env.SANDBOX_ROOT || SANDBOX_DIRECTORY;

type Template = Pick<TTemplate, "inDevelopment" | "skipTasks">;
export type TemplateKey = keyof typeof allTemplates;
export type Templates = Record<TemplateKey, Template>;

async function getDirectories(source: string) {
  return (await readdir(source, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

export async function getTemplate(
  cadence: Cadence,
  scriptName: string,
  { index, total }: { index: number; total: number }
) {
  let potentialTemplateKeys: TemplateKey[] = [];
  if (await pathExists(sandboxDir)) {
    const sandboxes = await getDirectories(sandboxDir);
    potentialTemplateKeys = sandboxes
      .map((dirName) => {
        return Object.keys(allTemplates).find(
          (templateKey) => templateKey.replace("/", "-") === dirName
        );
      })
      .filter(Boolean) as TemplateKey[];
  }

  if (potentialTemplateKeys.length === 0) {
    const cadenceTemplates = Object.entries(allTemplates).filter(([key]) =>
      templatesByCadence[cadence].includes(key as TemplateKey)
    );
    potentialTemplateKeys = cadenceTemplates.map(([k]) => k) as TemplateKey[];
  }

  potentialTemplateKeys = potentialTemplateKeys.filter((t) => {
    const currentTemplate = allTemplates[t] as Template;
    return (
      currentTemplate.inDevelopment !== true &&
      !currentTemplate.skipTasks?.includes(scriptName as SkippableTask)
    );
  });

  if (potentialTemplateKeys.length !== total) {
    throw new Error(dedent`Circle parallelism set incorrectly.
    
      Parallelism is set to ${total}, but there are ${
      potentialTemplateKeys.length
    } templates to run:
      ${potentialTemplateKeys.map((v) => `- ${v}`).join("\n")}
    
      ${await getParallelismSummary(cadence)}
    `);
  }

  return potentialTemplateKeys[index];
}

const tasks = [
  "sandbox",
  "build",
  "chromatic",
  "e2e-tests",
  "e2e-tests-dev",
  "test-runner",
  // 'test-runner-dev', TODO: bring this back when the task is enabled again
  "bench",
];

async function getParallelismSummary(cadence?: Cadence, scriptName?: string) {
  let potentialTemplateKeys: TemplateKey[] = [];
  const cadences = cadence
    ? [cadence]
    : (Object.keys(templatesByCadence) as Cadence[]);
  const scripts = scriptName ? [scriptName] : tasks;
  const summary = [];
  summary.push("These are the values you should have in .circleci/config.yml:");
  cadences.forEach((cad) => {
    summary.push(`\n${cad}`);
    const cadenceTemplates = Object.entries(allTemplates).filter(([key]) =>
      templatesByCadence[cad].includes(key as TemplateKey)
    );
    potentialTemplateKeys = cadenceTemplates.map(([k]) => k) as TemplateKey[];

    scripts.forEach((script) => {
      const templateKeysPerScript = potentialTemplateKeys.filter((t) => {
        const currentTemplate = allTemplates[t] as Template;
        return (
          currentTemplate.inDevelopment !== true &&
          !currentTemplate.skipTasks?.includes(script as SkippableTask)
        );
      });
      if (templateKeysPerScript.length > 0) {
        summary.push(
          `-- ${script} - parallelism: ${templateKeysPerScript.length}${
            templateKeysPerScript.length === 2 ? " (default)" : ""
          }`
        );
      } else {
        summary.push(
          `-- ${script} - this script is fully skipped for this cadence.`
        );
      }
    });
  });

  return summary.concat("\n").join("\n");
}

type RunOptions = { cadence?: Cadence; task?: string; debug: boolean };
async function run({ cadence, task, debug }: RunOptions) {
  if (debug) {
    if (task && !(task in tasks)) {
      throw new Error(
        dedent`The "${task}" task you provided is not valid. Valid tasks (found in .circleci/config.yml) are: 
        ${tasks.map((v) => `- ${v}`).join("\n")}`
      );
    }
    console.log(await getParallelismSummary(cadence as Cadence, task));
    return;
  }

  if (!cadence)
    throw new Error("Need to supply cadence to get template script");

  const { CIRCLE_NODE_INDEX = 0, CIRCLE_NODE_TOTAL = 1 } = process.env;

  console.log(
    await getTemplate(cadence as Cadence, task, {
      index: +CIRCLE_NODE_INDEX,
      total: +CIRCLE_NODE_TOTAL,
    })
  );
}

if (require.main === module) {
  program
    .description("Retrieve the template to run for a given cadence and task")
    .option(
      "--cadence <cadence>",
      "Which cadence you want to run the script for"
    )
    .option("--task <task>", "Which task you want to run the script for")
    .option(
      "--debug",
      "Whether to list the parallelism counts for tasks by cadence",
      false
    );

  program.parse(process.argv);

  const options = program.opts() as RunOptions;

  run(options).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

import { readdir } from "fs/promises";
import { pathExists } from "fs-extra";
import { program } from "commander";
import dedent from "ts-dedent";
import {
  allTemplates,
  templatesByCadence,
  type Cadence,
  type Template as TTemplate,
  type SkippableTask,
} from "../code/lib/cli/src/sandbox-templates";
import { SANDBOX_DIRECTORY } from "./utils/constants";

const sandboxDir = process.env.SANDBOX_ROOT || SANDBOX_DIRECTORY;

type Template = Pick<TTemplate, "inDevelopment" | "skipTasks">;
export type TemplateKey = keyof typeof allTemplates;
export type Templates = Record<TemplateKey, Template>;

async function getDirectories(source: string) {
  return (await readdir(source, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

export async function getTemplate(
  cadence: Cadence,
  scriptName: string,
  { index, total }: { index: number; total: number }
) {
  let potentialTemplateKeys: TemplateKey[] = [];
  if (await pathExists(sandboxDir)) {
    const sandboxes = await getDirectories(sandboxDir);
    potentialTemplateKeys = sandboxes
      .map((dirName) => {
        return Object.keys(allTemplates).find(
          (templateKey) => templateKey.replace("/", "-") === dirName
        );
      })
      .filter(Boolean) as TemplateKey[];
  }

  if (potentialTemplateKeys.length === 0) {
    const cadenceTemplates = Object.entries(allTemplates).filter(([key]) =>
      templatesByCadence[cadence].includes(key as TemplateKey)
    );
    potentialTemplateKeys = cadenceTemplates.map(([k]) => k) as TemplateKey[];
  }

  potentialTemplateKeys = potentialTemplateKeys.filter((t) => {
    const currentTemplate = allTemplates[t] as Template;
    return (
      currentTemplate.inDevelopment !== true &&
      !currentTemplate.skipTasks?.includes(scriptName as SkippableTask)
    );
  });

  if (potentialTemplateKeys.length !== total) {
    throw new Error(dedent`Circle parallelism set incorrectly.
    
      Parallelism is set to ${total}, but there are ${
      potentialTemplateKeys.length
    } templates to run:
      ${potentialTemplateKeys.map((v) => `- ${v}`).join("\n")}
    
      ${await getParallelismSummary(cadence)}
    `);
  }

  return potentialTemplateKeys[index];
}

const tasks = [
  "sandbox",
  "build",
  "chromatic",
  "e2e-tests",
  "e2e-tests-dev",
  "test-runner",
  // 'test-runner-dev', TODO: bring this back when the task is enabled again
  "bench",
];

async function getParallelismSummary(cadence?: Cadence, scriptName?: string) {
  let potentialTemplateKeys: TemplateKey[] = [];
  const cadences = cadence
    ? [cadence]
    : (Object.keys(templatesByCadence) as Cadence[]);
  const scripts = scriptName ? [scriptName] : tasks;
  const summary = [];
  summary.push("These are the values you should have in .circleci/config.yml:");
  cadences.forEach((cad) => {
    summary.push(`\n${cad}`);
    const cadenceTemplates = Object.entries(allTemplates).filter(([key]) =>
      templatesByCadence[cad].includes(key as TemplateKey)
    );
    potentialTemplateKeys = cadenceTemplates.map(([k]) => k) as TemplateKey[];

    scripts.forEach((script) => {
      const templateKeysPerScript = potentialTemplateKeys.filter((t) => {
        const currentTemplate = allTemplates[t] as Template;
        return (
          currentTemplate.inDevelopment !== true &&
          !currentTemplate.skipTasks?.includes(script as SkippableTask)
        );
      });
      if (templateKeysPerScript.length > 0) {
        summary.push(
          `-- ${script} - parallelism: ${templateKeysPerScript.length}${
            templateKeysPerScript.length === 2 ? " (default)" : ""
          }`
        );
      } else {
        summary.push(
          `-- ${script} - this script is fully skipped for this cadence.`
        );
      }
    });
  });

  return summary.concat("\n").join("\n");
}

type RunOptions = { cadence?: Cadence; task?: string; debug: boolean };
async function run({ cadence, task, debug }: RunOptions) {
  if (debug) {
    if (task && !(task in tasks)) {
      throw new Error(
        dedent`The "${task}" task you provided is not valid. Valid tasks (found in .circleci/config.yml) are: 
        ${tasks.map((v) => `- ${v}`).join("\n")}`
      );
    }
    console.log(await getParallelismSummary(cadence as Cadence, task));
    return;
  }

  if (!cadence)
    throw new Error("Need to supply cadence to get template script");

  const { CIRCLE_NODE_INDEX = 0, CIRCLE_NODE_TOTAL = 1 } = process.env;

  console.log(
    await getTemplate(cadence as Cadence, task, {
      index: +CIRCLE_NODE_INDEX,
      total: +CIRCLE_NODE_TOTAL,
    })
  );
}

if (require.main === module) {
  program
    .description("Retrieve the template to run for a given cadence and task")
    .option(
      "--cadence <cadence>",
      "Which cadence you want to run the script for"
    )
    .option("--task <task>", "Which task you want to run the script for")
    .option(
      "--debug",
      "Whether to list the parallelism counts for tasks by cadence",
      false
    );

  program.parse(process.argv);

  const options = program.opts() as RunOptions;

  run(options).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

import { readdir } from "fs/promises";
import { pathExists } from "fs-extra";
import { program } from "commander";
import dedent from "ts-dedent";
import {
  allTemplates,
  templatesByCadence,
  type Cadence,
  type Template as TTemplate,
  type SkippableTask,
} from "../code/lib/cli/src/sandbox-templates";
import { SANDBOX_DIRECTORY } from "./utils/constants";

const sandboxDir = process.env.SANDBOX_ROOT || SANDBOX_DIRECTORY;

type Template = Pick<TTemplate, "inDevelopment" | "skipTasks">;
export type TemplateKey = keyof typeof allTemplates;
export type Templates = Record<TemplateKey, Template>;

async function getDirectories(source: string) {
  return (await readdir(source, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

export async function getTemplate(
  cadence: Cadence,
  scriptName: string,
  { index, total }: { index: number; total: number }
) {
  let potentialTemplateKeys: TemplateKey[] = [];
  if (await pathExists(sandboxDir)) {
    const sandboxes = await getDirectories(sandboxDir);
    potentialTemplateKeys = sandboxes
      .map((dirName) => {
        return Object.keys(allTemplates).find(
          (templateKey) => templateKey.replace("/", "-") === dirName
        );
      })
      .filter(Boolean) as TemplateKey[];
  }

  if (potentialTemplateKeys.length === 0) {
    const cadenceTemplates = Object.entries(allTemplates).filter(([key]) =>
      templatesByCadence[cadence].includes(key as TemplateKey)
    );
    potentialTemplateKeys = cadenceTemplates.map(([k]) => k) as TemplateKey[];
  }

  potentialTemplateKeys = potentialTemplateKeys.filter((t) => {
    const currentTemplate = allTemplates[t] as Template;
    return (
      currentTemplate.inDevelopment !== true &&
      !currentTemplate.skipTasks?.includes(scriptName as SkippableTask)
    );
  });

  if (potentialTemplateKeys.length !== total) {
    throw new Error(dedent`Circle parallelism set incorrectly.
    
      Parallelism is set to ${total}, but there are ${
      potentialTemplateKeys.length
    } templates to run:
      ${potentialTemplateKeys.map((v) => `- ${v}`).join("\n")}
    
      ${await getParallelismSummary(cadence)}
    `);
  }

  return potentialTemplateKeys[index];
}

const tasks = [
  "sandbox",
  "build",
  "chromatic",
  "e2e-tests",
  "e2e-tests-dev",
  "test-runner",
  // 'test-runner-dev', TODO: bring this back when the task is enabled again
  "bench",
];

async function getParallelismSummary(cadence?: Cadence, scriptName?: string) {
  let potentialTemplateKeys: TemplateKey[] = [];
  const cadences = cadence
    ? [cadence]
    : (Object.keys(templatesByCadence) as Cadence[]);
  const scripts = scriptName ? [scriptName] : tasks;
  const summary = [];
  summary.push("These are the values you should have in .circleci/config.yml:");
  cadences.forEach((cad) => {
    summary.push(`\n${cad}`);
    const cadenceTemplates = Object.entries(allTemplates).filter(([key]) =>
      templatesByCadence[cad].includes(key as TemplateKey)
    );
    potentialTemplateKeys = cadenceTemplates.map(([k]) => k) as TemplateKey[];

    scripts.forEach((script) => {
      const templateKeysPerScript = potentialTemplateKeys.filter((t) => {
        const currentTemplate = allTemplates[t] as Template;
        return (
          currentTemplate.inDevelopment !== true &&
          !currentTemplate.skipTasks?.includes(script as SkippableTask)
        );
      });
      if (templateKeysPerScript.length > 0) {
        summary.push(
          `-- ${script} - parallelism: ${templateKeysPerScript.length}${
            templateKeysPerScript.length === 2 ? " (default)" : ""
          }`
        );
      } else {
        summary.push(
          `-- ${script} - this script is fully skipped for this cadence.`
        );
      }
    });
  });

  return summary.concat("\n").join("\n");
}

type RunOptions = { cadence?: Cadence; task?: string; debug: boolean };
async function run({ cadence, task, debug }: RunOptions) {
  if (debug) {
    if (task && !(task in tasks)) {
      throw new Error(
        dedent`The "${task}" task you provided is not valid. Valid tasks (found in .circleci/config.yml) are: 
        ${tasks.map((v) => `- ${v}`).join("\n")}`
      );
    }
    console.log(await getParallelismSummary(cadence as Cadence, task));
    return;
  }

  if (!cadence)
    throw new Error("Need to supply cadence to get template script");

  const { CIRCLE_NODE_INDEX = 0, CIRCLE_NODE_TOTAL = 1 } = process.env;

  console.log(
    await getTemplate(cadence as Cadence, task, {
      index: +CIRCLE_NODE_INDEX,
      total: +CIRCLE_NODE_TOTAL,
    })
  );
}

if (require.main === module) {
  program
    .description("Retrieve the template to run for a given cadence and task")
    .option(
      "--cadence <cadence>",
      "Which cadence you want to run the script for"
    )
    .option("--task <task>", "Which task you want to run the script for")
    .option(
      "--debug",
      "Whether to list the parallelism counts for tasks by cadence",
      false
    );

  program.parse(process.argv);

  const options = program.opts() as RunOptions;

  run(options).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

import { readdir } from "fs/promises";
import { pathExists } from "fs-extra";
import { program } from "commander";
import dedent from "ts-dedent";
import {
  allTemplates,
  templatesByCadence,
  type Cadence,
  type Template as TTemplate,
  type SkippableTask,
} from "../code/lib/cli/src/sandbox-templates";
import { SANDBOX_DIRECTORY } from "./utils/constants";

const sandboxDir = process.env.SANDBOX_ROOT || SANDBOX_DIRECTORY;

type Template = Pick<TTemplate, "inDevelopment" | "skipTasks">;
export type TemplateKey = keyof typeof allTemplates;
export type Templates = Record<TemplateKey, Template>;

async function getDirectories(source: string) {
  return (await readdir(source, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

export async function getTemplate(
  cadence: Cadence,
  scriptName: string,
  { index, total }: { index: number; total: number }
) {
  let potentialTemplateKeys: TemplateKey[] = [];
  if (await pathExists(sandboxDir)) {
    const sandboxes = await getDirectories(sandboxDir);
    potentialTemplateKeys = sandboxes
      .map((dirName) => {
        return Object.keys(allTemplates).find(
          (templateKey) => templateKey.replace("/", "-") === dirName
        );
      })
      .filter(Boolean) as TemplateKey[];
  }

  if (potentialTemplateKeys.length === 0) {
    const cadenceTemplates = Object.entries(allTemplates).filter(([key]) =>
      templatesByCadence[cadence].includes(key as TemplateKey)
    );
    potentialTemplateKeys = cadenceTemplates.map(([k]) => k) as TemplateKey[];
  }

  potentialTemplateKeys = potentialTemplateKeys.filter((t) => {
    const currentTemplate = allTemplates[t] as Template;
    return (
      currentTemplate.inDevelopment !== true &&
      !currentTemplate.skipTasks?.includes(scriptName as SkippableTask)
    );
  });

  if (potentialTemplateKeys.length !== total) {
    throw new Error(dedent`Circle parallelism set incorrectly.
    
      Parallelism is set to ${total}, but there are ${
      potentialTemplateKeys.length
    } templates to run:
      ${potentialTemplateKeys.map((v) => `- ${v}`).join("\n")}
    
      ${await getParallelismSummary(cadence)}
    `);
  }

  return potentialTemplateKeys[index];
}

const tasks = [
  "sandbox",
  "build",
  "chromatic",
  "e2e-tests",
  "e2e-tests-dev",
  "test-runner",
  // 'test-runner-dev', TODO: bring this back when the task is enabled again
  "bench",
];

async function getParallelismSummary(cadence?: Cadence, scriptName?: string) {
  let potentialTemplateKeys: TemplateKey[] = [];
  const cadences = cadence
    ? [cadence]
    : (Object.keys(templatesByCadence) as Cadence[]);
  const scripts = scriptName ? [scriptName] : tasks;
  const summary = [];
  summary.push("These are the values you should have in .circleci/config.yml:");
  cadences.forEach((cad) => {
    summary.push(`\n${cad}`);
    const cadenceTemplates = Object.entries(allTemplates).filter(([key]) =>
      templatesByCadence[cad].includes(key as TemplateKey)
    );
    potentialTemplateKeys = cadenceTemplates.map(([k]) => k) as TemplateKey[];

    scripts.forEach((script) => {
      const templateKeysPerScript = potentialTemplateKeys.filter((t) => {
        const currentTemplate = allTemplates[t] as Template;
        return (
          currentTemplate.inDevelopment !== true &&
          !currentTemplate.skipTasks?.includes(script as SkippableTask)
        );
      });
      if (templateKeysPerScript.length > 0) {
        summary.push(
          `-- ${script} - parallelism: ${templateKeysPerScript.length}${
            templateKeysPerScript.length === 2 ? " (default)" : ""
          }`
        );
      } else {
        summary.push(
          `-- ${script} - this script is fully skipped for this cadence.`
        );
      }
    });
  });

  return summary.concat("\n").join("\n");
}

type RunOptions = { cadence?: Cadence; task?: string; debug: boolean };
async function run({ cadence, task, debug }: RunOptions) {
  if (debug) {
    if (task && !(task in tasks)) {
      throw new Error(
        dedent`The "${task}" task you provided is not valid. Valid tasks (found in .circleci/config.yml) are: 
        ${tasks.map((v) => `- ${v}`).join("\n")}`
      );
    }
    console.log(await getParallelismSummary(cadence as Cadence, task));
    return;
  }

  if (!cadence)
    throw new Error("Need to supply cadence to get template script");

  const { CIRCLE_NODE_INDEX = 0, CIRCLE_NODE_TOTAL = 1 } = process.env;

  console.log(
    await getTemplate(cadence as Cadence, task, {
      index: +CIRCLE_NODE_INDEX,
      total: +CIRCLE_NODE_TOTAL,
    })
  );
}

if (require.main === module) {
  program
    .description("Retrieve the template to run for a given cadence and task")
    .option(
      "--cadence <cadence>",
      "Which cadence you want to run the script for"
    )
    .option("--task <task>", "Which task you want to run the script for")
    .option(
      "--debug",
      "Whether to list the parallelism counts for tasks by cadence",
      false
    );

  program.parse(process.argv);

  const options = program.opts() as RunOptions;

  run(options).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

import { readdir } from "fs/promises";
import { pathExists } from "fs-extra";
import { program } from "commander";
import dedent from "ts-dedent";
import {
  allTemplates,
  templatesByCadence,
  type Cadence,
  type Template as TTemplate,
  type SkippableTask,
} from "../code/lib/cli/src/sandbox-templates";
import { SANDBOX_DIRECTORY } from "./utils/constants";

const sandboxDir = process.env.SANDBOX_ROOT || SANDBOX_DIRECTORY;

type Template = Pick<TTemplate, "inDevelopment" | "skipTasks">;
export type TemplateKey = keyof typeof allTemplates;
export type Templates = Record<TemplateKey, Template>;

async function getDirectories(source: string) {
  return (await readdir(source, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

export async function getTemplate(
  cadence: Cadence,
  scriptName: string,
  { index, total }: { index: number; total: number }
) {
  let potentialTemplateKeys: TemplateKey[] = [];
  if (await pathExists(sandboxDir)) {
    const sandboxes = await getDirectories(sandboxDir);
    potentialTemplateKeys = sandboxes
      .map((dirName) => {
        return Object.keys(allTemplates).find(
          (templateKey) => templateKey.replace("/", "-") === dirName
        );
      })
      .filter(Boolean) as TemplateKey[];
  }

  if (potentialTemplateKeys.length === 0) {
    const cadenceTemplates = Object.entries(allTemplates).filter(([key]) =>
      templatesByCadence[cadence].includes(key as TemplateKey)
    );
    potentialTemplateKeys = cadenceTemplates.map(([k]) => k) as TemplateKey[];
  }

  potentialTemplateKeys = potentialTemplateKeys.filter((t) => {
    const currentTemplate = allTemplates[t] as Template;
    return (
      currentTemplate.inDevelopment !== true &&
      !currentTemplate.skipTasks?.includes(scriptName as SkippableTask)
    );
  });

  if (potentialTemplateKeys.length !== total) {
    throw new Error(dedent`Circle parallelism set incorrectly.
    
      Parallelism is set to ${total}, but there are ${
      potentialTemplateKeys.length
    } templates to run:
      ${potentialTemplateKeys.map((v) => `- ${v}`).join("\n")}
    
      ${await getParallelismSummary(cadence)}
    `);
  }

  return potentialTemplateKeys[index];
}

const tasks = [
  "sandbox",
  "build",
  "chromatic",
  "e2e-tests",
  "e2e-tests-dev",
  "test-runner",
  // 'test-runner-dev', TODO: bring this back when the task is enabled again
  "bench",
];

async function getParallelismSummary(cadence?: Cadence, scriptName?: string) {
  let potentialTemplateKeys: TemplateKey[] = [];
  const cadences = cadence
    ? [cadence]
    : (Object.keys(templatesByCadence) as Cadence[]);
  const scripts = scriptName ? [scriptName] : tasks;
  const summary = [];
  summary.push("These are the values you should have in .circleci/config.yml:");
  cadences.forEach((cad) => {
    summary.push(`\n${cad}`);
    const cadenceTemplates = Object.entries(allTemplates).filter(([key]) =>
      templatesByCadence[cad].includes(key as TemplateKey)
    );
    potentialTemplateKeys = cadenceTemplates.map(([k]) => k) as TemplateKey[];

    scripts.forEach((script) => {
      const templateKeysPerScript = potentialTemplateKeys.filter((t) => {
        const currentTemplate = allTemplates[t] as Template;
        return (
          currentTemplate.inDevelopment !== true &&
          !currentTemplate.skipTasks?.includes(script as SkippableTask)
        );
      });
      if (templateKeysPerScript.length > 0) {
        summary.push(
          `-- ${script} - parallelism: ${templateKeysPerScript.length}${
            templateKeysPerScript.length === 2 ? " (default)" : ""
          }`
        );
      } else {
        summary.push(
          `-- ${script} - this script is fully skipped for this cadence.`
        );
      }
    });
  });

  return summary.concat("\n").join("\n");
}

type RunOptions = { cadence?: Cadence; task?: string; debug: boolean };
async function run({ cadence, task, debug }: RunOptions) {
  if (debug) {
    if (task && !(task in tasks)) {
      throw new Error(
        dedent`The "${task}" task you provided is not valid. Valid tasks (found in .circleci/config.yml) are: 
        ${tasks.map((v) => `- ${v}`).join("\n")}`
      );
    }
    console.log(await getParallelismSummary(cadence as Cadence, task));
    return;
  }

  if (!cadence)
    throw new Error("Need to supply cadence to get template script");

  const { CIRCLE_NODE_INDEX = 0, CIRCLE_NODE_TOTAL = 1 } = process.env;

  console.log(
    await getTemplate(cadence as Cadence, task, {
      index: +CIRCLE_NODE_INDEX,
      total: +CIRCLE_NODE_TOTAL,
    })
  );
}

if (require.main === module) {
  program
    .description("Retrieve the template to run for a given cadence and task")
    .option(
      "--cadence <cadence>",
      "Which cadence you want to run the script for"
    )
    .option("--task <task>", "Which task you want to run the script for")
    .option(
      "--debug",
      "Whether to list the parallelism counts for tasks by cadence",
      false
    );

  program.parse(process.argv);

  const options = program.opts() as RunOptions;

  run(options).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

import { readdir } from "fs/promises";
import { pathExists } from "fs-extra";
import { program } from "commander";
import dedent from "ts-dedent";
import {
  allTemplates,
  templatesByCadence,
  type Cadence,
  type Template as TTemplate,
  type SkippableTask,
} from "../code/lib/cli/src/sandbox-templates";
import { SANDBOX_DIRECTORY } from "./utils/constants";

const sandboxDir = process.env.SANDBOX_ROOT || SANDBOX_DIRECTORY;

type Template = Pick<TTemplate, "inDevelopment" | "skipTasks">;
export type TemplateKey = keyof typeof allTemplates;
export type Templates = Record<TemplateKey, Template>;

async function getDirectories(source: string) {
  return (await readdir(source, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

export async function getTemplate(
  cadence: Cadence,
  scriptName: string,
  { index, total }: { index: number; total: number }
) {
  let potentialTemplateKeys: TemplateKey[] = [];
  if (await pathExists(sandboxDir)) {
    const sandboxes = await getDirectories(sandboxDir);
    potentialTemplateKeys = sandboxes
      .map((dirName) => {
        return Object.keys(allTemplates).find(
          (templateKey) => templateKey.replace("/", "-") === dirName
        );
      })
      .filter(Boolean) as TemplateKey[];
  }

  if (potentialTemplateKeys.length === 0) {
    const cadenceTemplates = Object.entries(allTemplates).filter(([key]) =>
      templatesByCadence[cadence].includes(key as TemplateKey)
    );
    potentialTemplateKeys = cadenceTemplates.map(([k]) => k) as TemplateKey[];
  }

  potentialTemplateKeys = potentialTemplateKeys.filter((t) => {
    const currentTemplate = allTemplates[t] as Template;
    return (
      currentTemplate.inDevelopment !== true &&
      !currentTemplate.skipTasks?.includes(scriptName as SkippableTask)
    );
  });

  if (potentialTemplateKeys.length !== total) {
    throw new Error(dedent`Circle parallelism set incorrectly.
    
      Parallelism is set to ${total}, but there are ${
      potentialTemplateKeys.length
    } templates to run:
      ${potentialTemplateKeys.map((v) => `- ${v}`).join("\n")}
    
      ${await getParallelismSummary(cadence)}
    `);
  }

  return potentialTemplateKeys[index];
}

const tasks = [
  "sandbox",
  "build",
  "chromatic",
  "e2e-tests",
  "e2e-tests-dev",
  "test-runner",
  // 'test-runner-dev', TODO: bring this back when the task is enabled again
  "bench",
];

async function getParallelismSummary(cadence?: Cadence, scriptName?: string) {
  let potentialTemplateKeys: TemplateKey[] = [];
  const cadences = cadence
    ? [cadence]
    : (Object.keys(templatesByCadence) as Cadence[]);
  const scripts = scriptName ? [scriptName] : tasks;
  const summary = [];
  summary.push("These are the values you should have in .circleci/config.yml:");
  cadences.forEach((cad) => {
    summary.push(`\n${cad}`);
    const cadenceTemplates = Object.entries(allTemplates).filter(([key]) =>
      templatesByCadence[cad].includes(key as TemplateKey)
    );
    potentialTemplateKeys = cadenceTemplates.map(([k]) => k) as TemplateKey[];

    scripts.forEach((script) => {
      const templateKeysPerScript = potentialTemplateKeys.filter((t) => {
        const currentTemplate = allTemplates[t] as Template;
        return (
          currentTemplate.inDevelopment !== true &&
          !currentTemplate.skipTasks?.includes(script as SkippableTask)
        );
      });
      if (templateKeysPerScript.length > 0) {
        summary.push(
          `-- ${script} - parallelism: ${templateKeysPerScript.length}${
            templateKeysPerScript.length === 2 ? " (default)" : ""
          }`
        );
      } else {
        summary.push(
          `-- ${script} - this script is fully skipped for this cadence.`
        );
      }
    });
  });

  return summary.concat("\n").join("\n");
}

type RunOptions = { cadence?: Cadence; task?: string; debug: boolean };
async function run({ cadence, task, debug }: RunOptions) {
  if (debug) {
    if (task && !(task in tasks)) {
      throw new Error(
        dedent`The "${task}" task you provided is not valid. Valid tasks (found in .circleci/config.yml) are: 
        ${tasks.map((v) => `- ${v}`).join("\n")}`
      );
    }
    console.log(await getParallelismSummary(cadence as Cadence, task));
    return;
  }

  if (!cadence)
    throw new Error("Need to supply cadence to get template script");

  const { CIRCLE_NODE_INDEX = 0, CIRCLE_NODE_TOTAL = 1 } = process.env;

  console.log(
    await getTemplate(cadence as Cadence, task, {
      index: +CIRCLE_NODE_INDEX,
      total: +CIRCLE_NODE_TOTAL,
    })
  );
}

if (require.main === module) {
  program
    .description("Retrieve the template to run for a given cadence and task")
    .option(
      "--cadence <cadence>",
      "Which cadence you want to run the script for"
    )
    .option("--task <task>", "Which task you want to run the script for")
    .option(
      "--debug",
      "Whether to list the parallelism counts for tasks by cadence",
      false
    );

  program.parse(process.argv);

  const options = program.opts() as RunOptions;

  run(options).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

import { readdir } from "fs/promises";
import { pathExists } from "fs-extra";
import { program } from "commander";
import dedent from "ts-dedent";
import {
  allTemplates,
  templatesByCadence,
  type Cadence,
  type Template as TTemplate,
  type SkippableTask,
} from "../code/lib/cli/src/sandbox-templates";
import { SANDBOX_DIRECTORY } from "./utils/constants";

const sandboxDir = process.env.SANDBOX_ROOT || SANDBOX_DIRECTORY;

type Template = Pick<TTemplate, "inDevelopment" | "skipTasks">;
export type TemplateKey = keyof typeof allTemplates;
export type Templates = Record<TemplateKey, Template>;

async function getDirectories(source: string) {
  return (await readdir(source, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

export async function getTemplate(
  cadence: Cadence,
  scriptName: string,
  { index, total }: { index: number; total: number }
) {
  let potentialTemplateKeys: TemplateKey[] = [];
  if (await pathExists(sandboxDir)) {
    const sandboxes = await getDirectories(sandboxDir);
    potentialTemplateKeys = sandboxes
      .map((dirName) => {
        return Object.keys(allTemplates).find(
          (templateKey) => templateKey.replace("/", "-") === dirName
        );
      })
      .filter(Boolean) as TemplateKey[];
  }

  if (potentialTemplateKeys.length === 0) {
    const cadenceTemplates = Object.entries(allTemplates).filter(([key]) =>
      templatesByCadence[cadence].includes(key as TemplateKey)
    );
    potentialTemplateKeys = cadenceTemplates.map(([k]) => k) as TemplateKey[];
  }

  potentialTemplateKeys = potentialTemplateKeys.filter((t) => {
    const currentTemplate = allTemplates[t] as Template;
    return (
      currentTemplate.inDevelopment !== true &&
      !currentTemplate.skipTasks?.includes(scriptName as SkippableTask)
    );
  });

  if (potentialTemplateKeys.length !== total) {
    throw new Error(dedent`Circle parallelism set incorrectly.
    
      Parallelism is set to ${total}, but there are ${
      potentialTemplateKeys.length
    } templates to run:
      ${potentialTemplateKeys.map((v) => `- ${v}`).join("\n")}
    
      ${await getParallelismSummary(cadence)}
    `);
  }

  return potentialTemplateKeys[index];
}

const tasks = [
  "sandbox",
  "build",
  "chromatic",
  "e2e-tests",
  "e2e-tests-dev",
  "test-runner",
  // 'test-runner-dev', TODO: bring this back when the task is enabled again
  "bench",
];

async function getParallelismSummary(cadence?: Cadence, scriptName?: string) {
  let potentialTemplateKeys: TemplateKey[] = [];
  const cadences = cadence
    ? [cadence]
    : (Object.keys(templatesByCadence) as Cadence[]);
  const scripts = scriptName ? [scriptName] : tasks;
  const summary = [];
  summary.push("These are the values you should have in .circleci/config.yml:");
  cadences.forEach((cad) => {
    summary.push(`\n${cad}`);
    const cadenceTemplates = Object.entries(allTemplates).filter(([key]) =>
      templatesByCadence[cad].includes(key as TemplateKey)
    );
    potentialTemplateKeys = cadenceTemplates.map(([k]) => k) as TemplateKey[];

    scripts.forEach((script) => {
      const templateKeysPerScript = potentialTemplateKeys.filter((t) => {
        const currentTemplate = allTemplates[t] as Template;
        return (
          currentTemplate.inDevelopment !== true &&
          !currentTemplate.skipTasks?.includes(script as SkippableTask)
        );
      });
      if (templateKeysPerScript.length > 0) {
        summary.push(
          `-- ${script} - parallelism: ${templateKeysPerScript.length}${
            templateKeysPerScript.length === 2 ? " (default)" : ""
          }`
        );
      } else {
        summary.push(
          `-- ${script} - this script is fully skipped for this cadence.`
        );
      }
    });
  });

  return summary.concat("\n").join("\n");
}

type RunOptions = { cadence?: Cadence; task?: string; debug: boolean };
async function run({ cadence, task, debug }: RunOptions) {
  if (debug) {
    if (task && !(task in tasks)) {
      throw new Error(
        dedent`The "${task}" task you provided is not valid. Valid tasks (found in .circleci/config.yml) are: 
        ${tasks.map((v) => `- ${v}`).join("\n")}`
      );
    }
    console.log(await getParallelismSummary(cadence as Cadence, task));
    return;
  }

  if (!cadence)
    throw new Error("Need to supply cadence to get template script");

  const { CIRCLE_NODE_INDEX = 0, CIRCLE_NODE_TOTAL = 1 } = process.env;

  console.log(
    await getTemplate(cadence as Cadence, task, {
      index: +CIRCLE_NODE_INDEX,
      total: +CIRCLE_NODE_TOTAL,
    })
  );
}

if (require.main === module) {
  program
    .description("Retrieve the template to run for a given cadence and task")
    .option(
      "--cadence <cadence>",
      "Which cadence you want to run the script for"
    )
    .option("--task <task>", "Which task you want to run the script for")
    .option(
      "--debug",
      "Whether to list the parallelism counts for tasks by cadence",
      false
    );

  program.parse(process.argv);

  const options = program.opts() as RunOptions;

  run(options).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

import { readdir } from "fs/promises";
import { pathExists } from "fs-extra";
import { program } from "commander";
import dedent from "ts-dedent";
import {
  allTemplates,
  templatesByCadence,
  type Cadence,
  type Template as TTemplate,
  type SkippableTask,
} from "../code/lib/cli/src/sandbox-templates";
import { SANDBOX_DIRECTORY } from "./utils/constants";

const sandboxDir = process.env.SANDBOX_ROOT || SANDBOX_DIRECTORY;

type Template = Pick<TTemplate, "inDevelopment" | "skipTasks">;
export type TemplateKey = keyof typeof allTemplates;
export type Templates = Record<TemplateKey, Template>;

async function getDirectories(source: string) {
  return (await readdir(source, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

export async function getTemplate(
  cadence: Cadence,
  scriptName: string,
  { index, total }: { index: number; total: number }
) {
  let potentialTemplateKeys: TemplateKey[] = [];
  if (await pathExists(sandboxDir)) {
    const sandboxes = await getDirectories(sandboxDir);
    potentialTemplateKeys = sandboxes
      .map((dirName) => {
        return Object.keys(allTemplates).find(
          (templateKey) => templateKey.replace("/", "-") === dirName
        );
      })
      .filter(Boolean) as TemplateKey[];
  }

  if (potentialTemplateKeys.length === 0) {
    const cadenceTemplates = Object.entries(allTemplates).filter(([key]) =>
      templatesByCadence[cadence].includes(key as TemplateKey)
    );
    potentialTemplateKeys = cadenceTemplates.map(([k]) => k) as TemplateKey[];
  }

  potentialTemplateKeys = potentialTemplateKeys.filter((t) => {
    const currentTemplate = allTemplates[t] as Template;
    return (
      currentTemplate.inDevelopment !== true &&
      !currentTemplate.skipTasks?.includes(scriptName as SkippableTask)
    );
  });

  if (potentialTemplateKeys.length !== total) {
    throw new Error(dedent`Circle parallelism set incorrectly.
    
      Parallelism is set to ${total}, but there are ${
      potentialTemplateKeys.length
    } templates to run:
      ${potentialTemplateKeys.map((v) => `- ${v}`).join("\n")}
    
      ${await getParallelismSummary(cadence)}
    `);
  }

  return potentialTemplateKeys[index];
}

const tasks = [
  "sandbox",
  "build",
  "chromatic",
  "e2e-tests",
  "e2e-tests-dev",
  "test-runner",
  // 'test-runner-dev', TODO: bring this back when the task is enabled again
  "bench",
];

async function getParallelismSummary(cadence?: Cadence, scriptName?: string) {
  let potentialTemplateKeys: TemplateKey[] = [];
  const cadences = cadence
    ? [cadence]
    : (Object.keys(templatesByCadence) as Cadence[]);
  const scripts = scriptName ? [scriptName] : tasks;
  const summary = [];
  summary.push("These are the values you should have in .circleci/config.yml:");
  cadences.forEach((cad) => {
    summary.push(`\n${cad}`);
    const cadenceTemplates = Object.entries(allTemplates).filter(([key]) =>
      templatesByCadence[cad].includes(key as TemplateKey)
    );
    potentialTemplateKeys = cadenceTemplates.map(([k]) => k) as TemplateKey[];

    scripts.forEach((script) => {
      const templateKeysPerScript = potentialTemplateKeys.filter((t) => {
        const currentTemplate = allTemplates[t] as Template;
        return (
          currentTemplate.inDevelopment !== true &&
          !currentTemplate.skipTasks?.includes(script as SkippableTask)
        );
      });
      if (templateKeysPerScript.length > 0) {
        summary.push(
          `-- ${script} - parallelism: ${templateKeysPerScript.length}${
            templateKeysPerScript.length === 2 ? " (default)" : ""
          }`
        );
      } else {
        summary.push(
          `-- ${script} - this script is fully skipped for this cadence.`
        );
      }
    });
  });

  return summary.concat("\n").join("\n");
}

type RunOptions = { cadence?: Cadence; task?: string; debug: boolean };
async function run({ cadence, task, debug }: RunOptions) {
  if (debug) {
    if (task && !(task in tasks)) {
      throw new Error(
        dedent`The "${task}" task you provided is not valid. Valid tasks (found in .circleci/config.yml) are: 
        ${tasks.map((v) => `- ${v}`).join("\n")}`
      );
    }
    console.log(await getParallelismSummary(cadence as Cadence, task));
    return;
  }

  if (!cadence)
    throw new Error("Need to supply cadence to get template script");

  const { CIRCLE_NODE_INDEX = 0, CIRCLE_NODE_TOTAL = 1 } = process.env;

  console.log(
    await getTemplate(cadence as Cadence, task, {
      index: +CIRCLE_NODE_INDEX,
      total: +CIRCLE_NODE_TOTAL,
    })
  );
}

if (require.main === module) {
  program
    .description("Retrieve the template to run for a given cadence and task")
    .option(
      "--cadence <cadence>",
      "Which cadence you want to run the script for"
    )
    .option("--task <task>", "Which task you want to run the script for")
    .option(
      "--debug",
      "Whether to list the parallelism counts for tasks by cadence",
      false
    );

  program.parse(process.argv);

  const options = program.opts() as RunOptions;

  run(options).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

import { readdir } from "fs/promises";
import { pathExists } from "fs-extra";
import { program } from "commander";
import dedent from "ts-dedent";
import {
  allTemplates,
  templatesByCadence,
  type Cadence,
  type Template as TTemplate,
  type SkippableTask,
} from "../code/lib/cli/src/sandbox-templates";
import { SANDBOX_DIRECTORY } from "./utils/constants";

const sandboxDir = process.env.SANDBOX_ROOT || SANDBOX_DIRECTORY;

type Template = Pick<TTemplate, "inDevelopment" | "skipTasks">;
export type TemplateKey = keyof typeof allTemplates;
export type Templates = Record<TemplateKey, Template>;

async function getDirectories(source: string) {
  return (await readdir(source, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

export async function getTemplate(
  cadence: Cadence,
  scriptName: string,
  { index, total }: { index: number; total: number }
) {
  let potentialTemplateKeys: TemplateKey[] = [];
  if (await pathExists(sandboxDir)) {
    const sandboxes = await getDirectories(sandboxDir);
    potentialTemplateKeys = sandboxes
      .map((dirName) => {
        return Object.keys(allTemplates).find(
          (templateKey) => templateKey.replace("/", "-") === dirName
        );
      })
      .filter(Boolean) as TemplateKey[];
  }

  if (potentialTemplateKeys.length === 0) {
    const cadenceTemplates = Object.entries(allTemplates).filter(([key]) =>
      templatesByCadence[cadence].includes(key as TemplateKey)
    );
    potentialTemplateKeys = cadenceTemplates.map(([k]) => k) as TemplateKey[];
  }

  potentialTemplateKeys = potentialTemplateKeys.filter((t) => {
    const currentTemplate = allTemplates[t] as Template;
    return (
      currentTemplate.inDevelopment !== true &&
      !currentTemplate.skipTasks?.includes(scriptName as SkippableTask)
    );
  });

  if (potentialTemplateKeys.length !== total) {
    throw new Error(dedent`Circle parallelism set incorrectly.
    
      Parallelism is set to ${total}, but there are ${
      potentialTemplateKeys.length
    } templates to run:
      ${potentialTemplateKeys.map((v) => `- ${v}`).join("\n")}
    
      ${await getParallelismSummary(cadence)}
    `);
  }

  return potentialTemplateKeys[index];
}

const tasks = [
  "sandbox",
  "build",
  "chromatic",
  "e2e-tests",
  "e2e-tests-dev",
  "test-runner",
  // 'test-runner-dev', TODO: bring this back when the task is enabled again
  "bench",
];

async function getParallelismSummary(cadence?: Cadence, scriptName?: string) {
  let potentialTemplateKeys: TemplateKey[] = [];
  const cadences = cadence
    ? [cadence]
    : (Object.keys(templatesByCadence) as Cadence[]);
  const scripts = scriptName ? [scriptName] : tasks;
  const summary = [];
  summary.push("These are the values you should have in .circleci/config.yml:");
  cadences.forEach((cad) => {
    summary.push(`\n${cad}`);
    const cadenceTemplates = Object.entries(allTemplates).filter(([key]) =>
      templatesByCadence[cad].includes(key as TemplateKey)
    );
    potentialTemplateKeys = cadenceTemplates.map(([k]) => k) as TemplateKey[];

    scripts.forEach((script) => {
      const templateKeysPerScript = potentialTemplateKeys.filter((t) => {
        const currentTemplate = allTemplates[t] as Template;
        return (
          currentTemplate.inDevelopment !== true &&
          !currentTemplate.skipTasks?.includes(script as SkippableTask)
        );
      });
      if (templateKeysPerScript.length > 0) {
        summary.push(
          `-- ${script} - parallelism: ${templateKeysPerScript.length}${
            templateKeysPerScript.length === 2 ? " (default)" : ""
          }`
        );
      } else {
        summary.push(
          `-- ${script} - this script is fully skipped for this cadence.`
        );
      }
    });
  });

  return summary.concat("\n").join("\n");
}

type RunOptions = { cadence?: Cadence; task?: string; debug: boolean };
async function run({ cadence, task, debug }: RunOptions) {
  if (debug) {
    if (task && !(task in tasks)) {
      throw new Error(
        dedent`The "${task}" task you provided is not valid. Valid tasks (found in .circleci/config.yml) are: 
        ${tasks.map((v) => `- ${v}`).join("\n")}`
      );
    }
    console.log(await getParallelismSummary(cadence as Cadence, task));
    return;
  }

  if (!cadence)
    throw new Error("Need to supply cadence to get template script");

  const { CIRCLE_NODE_INDEX = 0, CIRCLE_NODE_TOTAL = 1 } = process.env;

  console.log(
    await getTemplate(cadence as Cadence, task, {
      index: +CIRCLE_NODE_INDEX,
      total: +CIRCLE_NODE_TOTAL,
    })
  );
}

if (require.main === module) {
  program
    .description("Retrieve the template to run for a given cadence and task")
    .option(
      "--cadence <cadence>",
      "Which cadence you want to run the script for"
    )
    .option("--task <task>", "Which task you want to run the script for")
    .option(
      "--debug",
      "Whether to list the parallelism counts for tasks by cadence",
      false
    );

  program.parse(process.argv);

  const options = program.opts() as RunOptions;

  run(options).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

import { readdir } from "fs/promises";
import { pathExists } from "fs-extra";
import { program } from "commander";
import dedent from "ts-dedent";
import {
  allTemplates,
  templatesByCadence,
  type Cadence,
  type Template as TTemplate,
  type SkippableTask,
} from "../code/lib/cli/src/sandbox-templates";
import { SANDBOX_DIRECTORY } from "./utils/constants";

const sandboxDir = process.env.SANDBOX_ROOT || SANDBOX_DIRECTORY;

type Template = Pick<TTemplate, "inDevelopment" | "skipTasks">;
export type TemplateKey = keyof typeof allTemplates;
export type Templates = Record<TemplateKey, Template>;

async function getDirectories(source: string) {
  return (await readdir(source, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

export async function getTemplate(
  cadence: Cadence,
  scriptName: string,
  { index, total }: { index: number; total: number }
) {
  let potentialTemplateKeys: TemplateKey[] = [];
  if (await pathExists(sandboxDir)) {
    const sandboxes = await getDirectories(sandboxDir);
    potentialTemplateKeys = sandboxes
      .map((dirName) => {
        return Object.keys(allTemplates).find(
          (templateKey) => templateKey.replace("/", "-") === dirName
        );
      })
      .filter(Boolean) as TemplateKey[];
  }

  if (potentialTemplateKeys.length === 0) {
    const cadenceTemplates = Object.entries(allTemplates).filter(([key]) =>
      templatesByCadence[cadence].includes(key as TemplateKey)
    );
    potentialTemplateKeys = cadenceTemplates.map(([k]) => k) as TemplateKey[];
  }

  potentialTemplateKeys = potentialTemplateKeys.filter((t) => {
    const currentTemplate = allTemplates[t] as Template;
    return (
      currentTemplate.inDevelopment !== true &&
      !currentTemplate.skipTasks?.includes(scriptName as SkippableTask)
    );
  });

  if (potentialTemplateKeys.length !== total) {
    throw new Error(dedent`Circle parallelism set incorrectly.
    
      Parallelism is set to ${total}, but there are ${
      potentialTemplateKeys.length
    } templates to run:
      ${potentialTemplateKeys.map((v) => `- ${v}`).join("\n")}
    
      ${await getParallelismSummary(cadence)}
    `);
  }

  return potentialTemplateKeys[index];
}

const tasks = [
  "sandbox",
  "build",
  "chromatic",
  "e2e-tests",
  "e2e-tests-dev",
  "test-runner",
  // 'test-runner-dev', TODO: bring this back when the task is enabled again
  "bench",
];

async function getParallelismSummary(cadence?: Cadence, scriptName?: string) {
  let potentialTemplateKeys: TemplateKey[] = [];
  const cadences = cadence
    ? [cadence]
    : (Object.keys(templatesByCadence) as Cadence[]);
  const scripts = scriptName ? [scriptName] : tasks;
  const summary = [];
  summary.push("These are the values you should have in .circleci/config.yml:");
  cadences.forEach((cad) => {
    summary.push(`\n${cad}`);
    const cadenceTemplates = Object.entries(allTemplates).filter(([key]) =>
      templatesByCadence[cad].includes(key as TemplateKey)
    );
    potentialTemplateKeys = cadenceTemplates.map(([k]) => k) as TemplateKey[];

    scripts.forEach((script) => {
      const templateKeysPerScript = potentialTemplateKeys.filter((t) => {
        const currentTemplate = allTemplates[t] as Template;
        return (
          currentTemplate.inDevelopment !== true &&
          !currentTemplate.skipTasks?.includes(script as SkippableTask)
        );
      });
      if (templateKeysPerScript.length > 0) {
        summary.push(
          `-- ${script} - parallelism: ${templateKeysPerScript.length}${
            templateKeysPerScript.length === 2 ? " (default)" : ""
          }`
        );
      } else {
        summary.push(
          `-- ${script} - this script is fully skipped for this cadence.`
        );
      }
    });
  });

  return summary.concat("\n").join("\n");
}

type RunOptions = { cadence?: Cadence; task?: string; debug: boolean };
async function run({ cadence, task, debug }: RunOptions) {
  if (debug) {
    if (task && !(task in tasks)) {
      throw new Error(
        dedent`The "${task}" task you provided is not valid. Valid tasks (found in .circleci/config.yml) are: 
        ${tasks.map((v) => `- ${v}`).join("\n")}`
      );
    }
    console.log(await getParallelismSummary(cadence as Cadence, task));
    return;
  }

  if (!cadence)
    throw new Error("Need to supply cadence to get template script");

  const { CIRCLE_NODE_INDEX = 0, CIRCLE_NODE_TOTAL = 1 } = process.env;

  console.log(
    await getTemplate(cadence as Cadence, task, {
      index: +CIRCLE_NODE_INDEX,
      total: +CIRCLE_NODE_TOTAL,
    })
  );
}

if (require.main === module) {
  program
    .description("Retrieve the template to run for a given cadence and task")
    .option(
      "--cadence <cadence>",
      "Which cadence you want to run the script for"
    )
    .option("--task <task>", "Which task you want to run the script for")
    .option(
      "--debug",
      "Whether to list the parallelism counts for tasks by cadence",
      false
    );

  program.parse(process.argv);

  const options = program.opts() as RunOptions;

  run(options).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

import { readdir } from "fs/promises";
import { pathExists } from "fs-extra";
import { program } from "commander";
import dedent from "ts-dedent";
import {
  allTemplates,
  templatesByCadence,
  type Cadence,
  type Template as TTemplate,
  type SkippableTask,
} from "../code/lib/cli/src/sandbox-templates";
import { SANDBOX_DIRECTORY } from "./utils/constants";

const sandboxDir = process.env.SANDBOX_ROOT || SANDBOX_DIRECTORY;

type Template = Pick<TTemplate, "inDevelopment" | "skipTasks">;
export type TemplateKey = keyof typeof allTemplates;
export type Templates = Record<TemplateKey, Template>;

async function getDirectories(source: string) {
  return (await readdir(source, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

export async function getTemplate(
  cadence: Cadence,
  scriptName: string,
  { index, total }: { index: number; total: number }
) {
  let potentialTemplateKeys: TemplateKey[] = [];
  if (await pathExists(sandboxDir)) {
    const sandboxes = await getDirectories(sandboxDir);
    potentialTemplateKeys = sandboxes
      .map((dirName) => {
        return Object.keys(allTemplates).find(
          (templateKey) => templateKey.replace("/", "-") === dirName
        );
      })
      .filter(Boolean) as TemplateKey[];
  }

  if (potentialTemplateKeys.length === 0) {
    const cadenceTemplates = Object.entries(allTemplates).filter(([key]) =>
      templatesByCadence[cadence].includes(key as TemplateKey)
    );
    potentialTemplateKeys = cadenceTemplates.map(([k]) => k) as TemplateKey[];
  }

  potentialTemplateKeys = potentialTemplateKeys.filter((t) => {
    const currentTemplate = allTemplates[t] as Template;
    return (
      currentTemplate.inDevelopment !== true &&
      !currentTemplate.skipTasks?.includes(scriptName as SkippableTask)
    );
  });

  if (potentialTemplateKeys.length !== total) {
    throw new Error(dedent`Circle parallelism set incorrectly.
    
      Parallelism is set to ${total}, but there are ${
      potentialTemplateKeys.length
    } templates to run:
      ${potentialTemplateKeys.map((v) => `- ${v}`).join("\n")}
    
      ${await getParallelismSummary(cadence)}
    `);
  }

  return potentialTemplateKeys[index];
}

const tasks = [
  "sandbox",
  "build",
  "chromatic",
  "e2e-tests",
  "e2e-tests-dev",
  "test-runner",
  // 'test-runner-dev', TODO: bring this back when the task is enabled again
  "bench",
];

async function getParallelismSummary(cadence?: Cadence, scriptName?: string) {
  let potentialTemplateKeys: TemplateKey[] = [];
  const cadences = cadence
    ? [cadence]
    : (Object.keys(templatesByCadence) as Cadence[]);
  const scripts = scriptName ? [scriptName] : tasks;
  const summary = [];
  summary.push("These are the values you should have in .circleci/config.yml:");
  cadences.forEach((cad) => {
    summary.push(`\n${cad}`);
    const cadenceTemplates = Object.entries(allTemplates).filter(([key]) =>
      templatesByCadence[cad].includes(key as TemplateKey)
    );
    potentialTemplateKeys = cadenceTemplates.map(([k]) => k) as TemplateKey[];

    scripts.forEach((script) => {
      const templateKeysPerScript = potentialTemplateKeys.filter((t) => {
        const currentTemplate = allTemplates[t] as Template;
        return (
          currentTemplate.inDevelopment !== true &&
          !currentTemplate.skipTasks?.includes(script as SkippableTask)
        );
      });
      if (templateKeysPerScript.length > 0) {
        summary.push(
          `-- ${script} - parallelism: ${templateKeysPerScript.length}${
            templateKeysPerScript.length === 2 ? " (default)" : ""
          }`
        );
      } else {
        summary.push(
          `-- ${script} - this script is fully skipped for this cadence.`
        );
      }
    });
  });

  return summary.concat("\n").join("\n");
}

type RunOptions = { cadence?: Cadence; task?: string; debug: boolean };
async function run({ cadence, task, debug }: RunOptions) {
  if (debug) {
    if (task && !(task in tasks)) {
      throw new Error(
        dedent`The "${task}" task you provided is not valid. Valid tasks (found in .circleci/config.yml) are: 
        ${tasks.map((v) => `- ${v}`).join("\n")}`
      );
    }
    console.log(await getParallelismSummary(cadence as Cadence, task));
    return;
  }

  if (!cadence)
    throw new Error("Need to supply cadence to get template script");

  const { CIRCLE_NODE_INDEX = 0, CIRCLE_NODE_TOTAL = 1 } = process.env;

  console.log(
    await getTemplate(cadence as Cadence, task, {
      index: +CIRCLE_NODE_INDEX,
      total: +CIRCLE_NODE_TOTAL,
    })
  );
}

if (require.main === module) {
  program
    .description("Retrieve the template to run for a given cadence and task")
    .option(
      "--cadence <cadence>",
      "Which cadence you want to run the script for"
    )
    .option("--task <task>", "Which task you want to run the script for")
    .option(
      "--debug",
      "Whether to list the parallelism counts for tasks by cadence",
      false
    );

  program.parse(process.argv);

  const options = program.opts() as RunOptions;

  run(options).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

import { readdir } from "fs/promises";
import { pathExists } from "fs-extra";
import { program } from "commander";
import dedent from "ts-dedent";
import {
  allTemplates,
  templatesByCadence,
  type Cadence,
  type Template as TTemplate,
  type SkippableTask,
} from "../code/lib/cli/src/sandbox-templates";
import { SANDBOX_DIRECTORY } from "./utils/constants";

const sandboxDir = process.env.SANDBOX_ROOT || SANDBOX_DIRECTORY;

type Template = Pick<TTemplate, "inDevelopment" | "skipTasks">;
export type TemplateKey = keyof typeof allTemplates;
export type Templates = Record<TemplateKey, Template>;

async function getDirectories(source: string) {
  return (await readdir(source, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

export async function getTemplate(
  cadence: Cadence,
  scriptName: string,
  { index, total }: { index: number; total: number }
) {
  let potentialTemplateKeys: TemplateKey[] = [];
  if (await pathExists(sandboxDir)) {
    const sandboxes = await getDirectories(sandboxDir);
    potentialTemplateKeys = sandboxes
      .map((dirName) => {
        return Object.keys(allTemplates).find(
          (templateKey) => templateKey.replace("/", "-") === dirName
        );
      })
      .filter(Boolean) as TemplateKey[];
  }

  if (potentialTemplateKeys.length === 0) {
    const cadenceTemplates = Object.entries(allTemplates).filter(([key]) =>
      templatesByCadence[cadence].includes(key as TemplateKey)
    );
    potentialTemplateKeys = cadenceTemplates.map(([k]) => k) as TemplateKey[];
  }

  potentialTemplateKeys = potentialTemplateKeys.filter((t) => {
    const currentTemplate = allTemplates[t] as Template;
    return (
      currentTemplate.inDevelopment !== true &&
      !currentTemplate.skipTasks?.includes(scriptName as SkippableTask)
    );
  });

  if (potentialTemplateKeys.length !== total) {
    throw new Error(dedent`Circle parallelism set incorrectly.
    
      Parallelism is set to ${total}, but there are ${
      potentialTemplateKeys.length
    } templates to run:
      ${potentialTemplateKeys.map((v) => `- ${v}`).join("\n")}
    
      ${await getParallelismSummary(cadence)}
    `);
  }

  return potentialTemplateKeys[index];
}

const tasks = [
  "sandbox",
  "build",
  "chromatic",
  "e2e-tests",
  "e2e-tests-dev",
  "test-runner",
  // 'test-runner-dev', TODO: bring this back when the task is enabled again
  "bench",
];

async function getParallelismSummary(cadence?: Cadence, scriptName?: string) {
  let potentialTemplateKeys: TemplateKey[] = [];
  const cadences = cadence
    ? [cadence]
    : (Object.keys(templatesByCadence) as Cadence[]);
  const scripts = scriptName ? [scriptName] : tasks;
  const summary = [];
  summary.push("These are the values you should have in .circleci/config.yml:");
  cadences.forEach((cad) => {
    summary.push(`\n${cad}`);
    const cadenceTemplates = Object.entries(allTemplates).filter(([key]) =>
      templatesByCadence[cad].includes(key as TemplateKey)
    );
    potentialTemplateKeys = cadenceTemplates.map(([k]) => k) as TemplateKey[];

    scripts.forEach((script) => {
      const templateKeysPerScript = potentialTemplateKeys.filter((t) => {
        const currentTemplate = allTemplates[t] as Template;
        return (
          currentTemplate.inDevelopment !== true &&
          !currentTemplate.skipTasks?.includes(script as SkippableTask)
        );
      });
      if (templateKeysPerScript.length > 0) {
        summary.push(
          `-- ${script} - parallelism: ${templateKeysPerScript.length}${
            templateKeysPerScript.length === 2 ? " (default)" : ""
          }`
        );
      } else {
        summary.push(
          `-- ${script} - this script is fully skipped for this cadence.`
        );
      }
    });
  });

  return summary.concat("\n").join("\n");
}

type RunOptions = { cadence?: Cadence; task?: string; debug: boolean };
async function run({ cadence, task, debug }: RunOptions) {
  if (debug) {
    if (task && !(task in tasks)) {
      throw new Error(
        dedent`The "${task}" task you provided is not valid. Valid tasks (found in .circleci/config.yml) are: 
        ${tasks.map((v) => `- ${v}`).join("\n")}`
      );
    }
    console.log(await getParallelismSummary(cadence as Cadence, task));
    return;
  }

  if (!cadence)
    throw new Error("Need to supply cadence to get template script");

  const { CIRCLE_NODE_INDEX = 0, CIRCLE_NODE_TOTAL = 1 } = process.env;

  console.log(
    await getTemplate(cadence as Cadence, task, {
      index: +CIRCLE_NODE_INDEX,
      total: +CIRCLE_NODE_TOTAL,
    })
  );
}

if (require.main === module) {
  program
    .description("Retrieve the template to run for a given cadence and task")
    .option(
      "--cadence <cadence>",
      "Which cadence you want to run the script for"
    )
    .option("--task <task>", "Which task you want to run the script for")
    .option(
      "--debug",
      "Whether to list the parallelism counts for tasks by cadence",
      false
    );

  program.parse(process.argv);

  const options = program.opts() as RunOptions;

  run(options).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

import { readdir } from "fs/promises";
import { pathExists } from "fs-extra";
import { program } from "commander";
import dedent from "ts-dedent";
import {
  allTemplates,
  templatesByCadence,
  type Cadence,
  type Template as TTemplate,
  type SkippableTask,
} from "../code/lib/cli/src/sandbox-templates";
import { SANDBOX_DIRECTORY } from "./utils/constants";

const sandboxDir = process.env.SANDBOX_ROOT || SANDBOX_DIRECTORY;

type Template = Pick<TTemplate, "inDevelopment" | "skipTasks">;
export type TemplateKey = keyof typeof allTemplates;
export type Templates = Record<TemplateKey, Template>;

async function getDirectories(source: string) {
  return (await readdir(source, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

export async function getTemplate(
  cadence: Cadence,
  scriptName: string,
  { index, total }: { index: number; total: number }
) {
  let potentialTemplateKeys: TemplateKey[] = [];
  if (await pathExists(sandboxDir)) {
    const sandboxes = await getDirectories(sandboxDir);
    potentialTemplateKeys = sandboxes
      .map((dirName) => {
        return Object.keys(allTemplates).find(
          (templateKey) => templateKey.replace("/", "-") === dirName
        );
      })
      .filter(Boolean) as TemplateKey[];
  }

  if (potentialTemplateKeys.length === 0) {
    const cadenceTemplates = Object.entries(allTemplates).filter(([key]) =>
      templatesByCadence[cadence].includes(key as TemplateKey)
    );
    potentialTemplateKeys = cadenceTemplates.map(([k]) => k) as TemplateKey[];
  }

  potentialTemplateKeys = potentialTemplateKeys.filter((t) => {
    const currentTemplate = allTemplates[t] as Template;
    return (
      currentTemplate.inDevelopment !== true &&
      !currentTemplate.skipTasks?.includes(scriptName as SkippableTask)
    );
  });

  if (potentialTemplateKeys.length !== total) {
    throw new Error(dedent`Circle parallelism set incorrectly.
    
      Parallelism is set to ${total}, but there are ${
      potentialTemplateKeys.length
    } templates to run:
      ${potentialTemplateKeys.map((v) => `- ${v}`).join("\n")}
    
      ${await getParallelismSummary(cadence)}
    `);
  }

  return potentialTemplateKeys[index];
}

const tasks = [
  "sandbox",
  "build",
  "chromatic",
  "e2e-tests",
  "e2e-tests-dev",
  "test-runner",
  // 'test-runner-dev', TODO: bring this back when the task is enabled again
  "bench",
];

async function getParallelismSummary(cadence?: Cadence, scriptName?: string) {
  let potentialTemplateKeys: TemplateKey[] = [];
  const cadences = cadence
    ? [cadence]
    : (Object.keys(templatesByCadence) as Cadence[]);
  const scripts = scriptName ? [scriptName] : tasks;
  const summary = [];
  summary.push("These are the values you should have in .circleci/config.yml:");
  cadences.forEach((cad) => {
    summary.push(`\n${cad}`);
    const cadenceTemplates = Object.entries(allTemplates).filter(([key]) =>
      templatesByCadence[cad].includes(key as TemplateKey)
    );
    potentialTemplateKeys = cadenceTemplates.map(([k]) => k) as TemplateKey[];

    scripts.forEach((script) => {
      const templateKeysPerScript = potentialTemplateKeys.filter((t) => {
        const currentTemplate = allTemplates[t] as Template;
        return (
          currentTemplate.inDevelopment !== true &&
          !currentTemplate.skipTasks?.includes(script as SkippableTask)
        );
      });
      if (templateKeysPerScript.length > 0) {
        summary.push(
          `-- ${script} - parallelism: ${templateKeysPerScript.length}${
            templateKeysPerScript.length === 2 ? " (default)" : ""
          }`
        );
      } else {
        summary.push(
          `-- ${script} - this script is fully skipped for this cadence.`
        );
      }
    });
  });

  return summary.concat("\n").join("\n");
}

type RunOptions = { cadence?: Cadence; task?: string; debug: boolean };
async function run({ cadence, task, debug }: RunOptions) {
  if (debug) {
    if (task && !(task in tasks)) {
      throw new Error(
        dedent`The "${task}" task you provided is not valid. Valid tasks (found in .circleci/config.yml) are: 
        ${tasks.map((v) => `- ${v}`).join("\n")}`
      );
    }
    console.log(await getParallelismSummary(cadence as Cadence, task));
    return;
  }

  if (!cadence)
    throw new Error("Need to supply cadence to get template script");

  const { CIRCLE_NODE_INDEX = 0, CIRCLE_NODE_TOTAL = 1 } = process.env;

  console.log(
    await getTemplate(cadence as Cadence, task, {
      index: +CIRCLE_NODE_INDEX,
      total: +CIRCLE_NODE_TOTAL,
    })
  );
}

if (require.main === module) {
  program
    .description("Retrieve the template to run for a given cadence and task")
    .option(
      "--cadence <cadence>",
      "Which cadence you want to run the script for"
    )
    .option("--task <task>", "Which task you want to run the script for")
    .option(
      "--debug",
      "Whether to list the parallelism counts for tasks by cadence",
      false
    );

  program.parse(process.argv);

  const options = program.opts() as RunOptions;

  run(options).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

import { readdir } from "fs/promises";
import { pathExists } from "fs-extra";
import { program } from "commander";
import dedent from "ts-dedent";
import {
  allTemplates,
  templatesByCadence,
  type Cadence,
  type Template as TTemplate,
  type SkippableTask,
} from "../code/lib/cli/src/sandbox-templates";
import { SANDBOX_DIRECTORY } from "./utils/constants";

const sandboxDir = process.env.SANDBOX_ROOT || SANDBOX_DIRECTORY;

type Template = Pick<TTemplate, "inDevelopment" | "skipTasks">;
export type TemplateKey = keyof typeof allTemplates;
export type Templates = Record<TemplateKey, Template>;

async function getDirectories(source: string) {
  return (await readdir(source, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

export async function getTemplate(
  cadence: Cadence,
  scriptName: string,
  { index, total }: { index: number; total: number }
) {
  let potentialTemplateKeys: TemplateKey[] = [];
  if (await pathExists(sandboxDir)) {
    const sandboxes = await getDirectories(sandboxDir);
    potentialTemplateKeys = sandboxes
      .map((dirName) => {
        return Object.keys(allTemplates).find(
          (templateKey) => templateKey.replace("/", "-") === dirName
        );
      })
      .filter(Boolean) as TemplateKey[];
  }

  if (potentialTemplateKeys.length === 0) {
    const cadenceTemplates = Object.entries(allTemplates).filter(([key]) =>
      templatesByCadence[cadence].includes(key as TemplateKey)
    );
    potentialTemplateKeys = cadenceTemplates.map(([k]) => k) as TemplateKey[];
  }

  potentialTemplateKeys = potentialTemplateKeys.filter((t) => {
    const currentTemplate = allTemplates[t] as Template;
    return (
      currentTemplate.inDevelopment !== true &&
      !currentTemplate.skipTasks?.includes(scriptName as SkippableTask)
    );
  });

  if (potentialTemplateKeys.length !== total) {
    throw new Error(dedent`Circle parallelism set incorrectly.
    
      Parallelism is set to ${total}, but there are ${
      potentialTemplateKeys.length
    } templates to run:
      ${potentialTemplateKeys.map((v) => `- ${v}`).join("\n")}
    
      ${await getParallelismSummary(cadence)}
    `);
  }

  return potentialTemplateKeys[index];
}

const tasks = [
  "sandbox",
  "build",
  "chromatic",
  "e2e-tests",
  "e2e-tests-dev",
  "test-runner",
  // 'test-runner-dev', TODO: bring this back when the task is enabled again
  "bench",
];

async function getParallelismSummary(cadence?: Cadence, scriptName?: string) {
  let potentialTemplateKeys: TemplateKey[] = [];
  const cadences = cadence
    ? [cadence]
    : (Object.keys(templatesByCadence) as Cadence[]);
  const scripts = scriptName ? [scriptName] : tasks;
  const summary = [];
  summary.push("These are the values you should have in .circleci/config.yml:");
  cadences.forEach((cad) => {
    summary.push(`\n${cad}`);
    const cadenceTemplates = Object.entries(allTemplates).filter(([key]) =>
      templatesByCadence[cad].includes(key as TemplateKey)
    );
    potentialTemplateKeys = cadenceTemplates.map(([k]) => k) as TemplateKey[];

    scripts.forEach((script) => {
      const templateKeysPerScript = potentialTemplateKeys.filter((t) => {
        const currentTemplate = allTemplates[t] as Template;
        return (
          currentTemplate.inDevelopment !== true &&
          !currentTemplate.skipTasks?.includes(script as SkippableTask)
        );
      });
      if (templateKeysPerScript.length > 0) {
        summary.push(
          `-- ${script} - parallelism: ${templateKeysPerScript.length}${
            templateKeysPerScript.length === 2 ? " (default)" : ""
          }`
        );
      } else {
        summary.push(
          `-- ${script} - this script is fully skipped for this cadence.`
        );
      }
    });
  });

  return summary.concat("\n").join("\n");
}

type RunOptions = { cadence?: Cadence; task?: string; debug: boolean };
async function run({ cadence, task, debug }: RunOptions) {
  if (debug) {
    if (task && !(task in tasks)) {
      throw new Error(
        dedent`The "${task}" task you provided is not valid. Valid tasks (found in .circleci/config.yml) are: 
        ${tasks.map((v) => `- ${v}`).join("\n")}`
      );
    }
    console.log(await getParallelismSummary(cadence as Cadence, task));
    return;
  }

  if (!cadence)
    throw new Error("Need to supply cadence to get template script");

  const { CIRCLE_NODE_INDEX = 0, CIRCLE_NODE_TOTAL = 1 } = process.env;

  console.log(
    await getTemplate(cadence as Cadence, task, {
      index: +CIRCLE_NODE_INDEX,
      total: +CIRCLE_NODE_TOTAL,
    })
  );
}

if (require.main === module) {
  program
    .description("Retrieve the template to run for a given cadence and task")
    .option(
      "--cadence <cadence>",
      "Which cadence you want to run the script for"
    )
    .option("--task <task>", "Which task you want to run the script for")
    .option(
      "--debug",
      "Whether to list the parallelism counts for tasks by cadence",
      false
    );

  program.parse(process.argv);

  const options = program.opts() as RunOptions;

  run(options).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

import { readdir } from "fs/promises";
import { pathExists } from "fs-extra";
import { program } from "commander";
import dedent from "ts-dedent";
import {
  allTemplates,
  templatesByCadence,
  type Cadence,
  type Template as TTemplate,
  type SkippableTask,
} from "../code/lib/cli/src/sandbox-templates";
import { SANDBOX_DIRECTORY } from "./utils/constants";

const sandboxDir = process.env.SANDBOX_ROOT || SANDBOX_DIRECTORY;

type Template = Pick<TTemplate, "inDevelopment" | "skipTasks">;
export type TemplateKey = keyof typeof allTemplates;
export type Templates = Record<TemplateKey, Template>;

async function getDirectories(source: string) {
  return (await readdir(source, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

export async function getTemplate(
  cadence: Cadence,
  scriptName: string,
  { index, total }: { index: number; total: number }
) {
  let potentialTemplateKeys: TemplateKey[] = [];
  if (await pathExists(sandboxDir)) {
    const sandboxes = await getDirectories(sandboxDir);
    potentialTemplateKeys = sandboxes
      .map((dirName) => {
        return Object.keys(allTemplates).find(
          (templateKey) => templateKey.replace("/", "-") === dirName
        );
      })
      .filter(Boolean) as TemplateKey[];
  }

  if (potentialTemplateKeys.length === 0) {
    const cadenceTemplates = Object.entries(allTemplates).filter(([key]) =>
      templatesByCadence[cadence].includes(key as TemplateKey)
    );
    potentialTemplateKeys = cadenceTemplates.map(([k]) => k) as TemplateKey[];
  }

  potentialTemplateKeys = potentialTemplateKeys.filter((t) => {
    const currentTemplate = allTemplates[t] as Template;
    return (
      currentTemplate.inDevelopment !== true &&
      !currentTemplate.skipTasks?.includes(scriptName as SkippableTask)
    );
  });

  if (potentialTemplateKeys.length !== total) {
    throw new Error(dedent`Circle parallelism set incorrectly.
    
      Parallelism is set to ${total}, but there are ${
      potentialTemplateKeys.length
    } templates to run:
      ${potentialTemplateKeys.map((v) => `- ${v}`).join("\n")}
    
      ${await getParallelismSummary(cadence)}
    `);
  }

  return potentialTemplateKeys[index];
}

const tasks = [
  "sandbox",
  "build",
  "chromatic",
  "e2e-tests",
  "e2e-tests-dev",
  "test-runner",
  // 'test-runner-dev', TODO: bring this back when the task is enabled again
  "bench",
];

async function getParallelismSummary(cadence?: Cadence, scriptName?: string) {
  let potentialTemplateKeys: TemplateKey[] = [];
  const cadences = cadence
    ? [cadence]
    : (Object.keys(templatesByCadence) as Cadence[]);
  const scripts = scriptName ? [scriptName] : tasks;
  const summary = [];
  summary.push("These are the values you should have in .circleci/config.yml:");
  cadences.forEach((cad) => {
    summary.push(`\n${cad}`);
    const cadenceTemplates = Object.entries(allTemplates).filter(([key]) =>
      templatesByCadence[cad].includes(key as TemplateKey)
    );
    potentialTemplateKeys = cadenceTemplates.map(([k]) => k) as TemplateKey[];

    scripts.forEach((script) => {
      const templateKeysPerScript = potentialTemplateKeys.filter((t) => {
        const currentTemplate = allTemplates[t] as Template;
        return (
          currentTemplate.inDevelopment !== true &&
          !currentTemplate.skipTasks?.includes(script as SkippableTask)
        );
      });
      if (templateKeysPerScript.length > 0) {
        summary.push(
          `-- ${script} - parallelism: ${templateKeysPerScript.length}${
            templateKeysPerScript.length === 2 ? " (default)" : ""
          }`
        );
      } else {
        summary.push(
          `-- ${script} - this script is fully skipped for this cadence.`
        );
      }
    });
  });

  return summary.concat("\n").join("\n");
}

type RunOptions = { cadence?: Cadence; task?: string; debug: boolean };
async function run({ cadence, task, debug }: RunOptions) {
  if (debug) {
    if (task && !(task in tasks)) {
      throw new Error(
        dedent`The "${task}" task you provided is not valid. Valid tasks (found in .circleci/config.yml) are: 
        ${tasks.map((v) => `- ${v}`).join("\n")}`
      );
    }
    console.log(await getParallelismSummary(cadence as Cadence, task));
    return;
  }

  if (!cadence)
    throw new Error("Need to supply cadence to get template script");

  const { CIRCLE_NODE_INDEX = 0, CIRCLE_NODE_TOTAL = 1 } = process.env;

  console.log(
    await getTemplate(cadence as Cadence, task, {
      index: +CIRCLE_NODE_INDEX,
      total: +CIRCLE_NODE_TOTAL,
    })
  );
}

if (require.main === module) {
  program
    .description("Retrieve the template to run for a given cadence and task")
    .option(
      "--cadence <cadence>",
      "Which cadence you want to run the script for"
    )
    .option("--task <task>", "Which task you want to run the script for")
    .option(
      "--debug",
      "Whether to list the parallelism counts for tasks by cadence",
      false
    );

  program.parse(process.argv);

  const options = program.opts() as RunOptions;

  run(options).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

import { readdir } from "fs/promises";
import { pathExists } from "fs-extra";
import { program } from "commander";
import dedent from "ts-dedent";
import {
  allTemplates,
  templatesByCadence,
  type Cadence,
  type Template as TTemplate,
  type SkippableTask,
} from "../code/lib/cli/src/sandbox-templates";
import { SANDBOX_DIRECTORY } from "./utils/constants";

const sandboxDir = process.env.SANDBOX_ROOT || SANDBOX_DIRECTORY;

type Template = Pick<TTemplate, "inDevelopment" | "skipTasks">;
export type TemplateKey = keyof typeof allTemplates;
export type Templates = Record<TemplateKey, Template>;

async function getDirectories(source: string) {
  return (await readdir(source, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

export async function getTemplate(
  cadence: Cadence,
  scriptName: string,
  { index, total }: { index: number; total: number }
) {
  let potentialTemplateKeys: TemplateKey[] = [];
  if (await pathExists(sandboxDir)) {
    const sandboxes = await getDirectories(sandboxDir);
    potentialTemplateKeys = sandboxes
      .map((dirName) => {
        return Object.keys(allTemplates).find(
          (templateKey) => templateKey.replace("/", "-") === dirName
        );
      })
      .filter(Boolean) as TemplateKey[];
  }

  if (potentialTemplateKeys.length === 0) {
    const cadenceTemplates = Object.entries(allTemplates).filter(([key]) =>
      templatesByCadence[cadence].includes(key as TemplateKey)
    );
    potentialTemplateKeys = cadenceTemplates.map(([k]) => k) as TemplateKey[];
  }

  potentialTemplateKeys = potentialTemplateKeys.filter((t) => {
    const currentTemplate = allTemplates[t] as Template;
    return (
      currentTemplate.inDevelopment !== true &&
      !currentTemplate.skipTasks?.includes(scriptName as SkippableTask)
    );
  });

  if (potentialTemplateKeys.length !== total) {
    throw new Error(dedent`Circle parallelism set incorrectly.
    
      Parallelism is set to ${total}, but there are ${
      potentialTemplateKeys.length
    } templates to run:
      ${potentialTemplateKeys.map((v) => `- ${v}`).join("\n")}
    
      ${await getParallelismSummary(cadence)}
    `);
  }

  return potentialTemplateKeys[index];
}

const tasks = [
  "sandbox",
  "build",
  "chromatic",
  "e2e-tests",
  "e2e-tests-dev",
  "test-runner",
  // 'test-runner-dev', TODO: bring this back when the task is enabled again
  "bench",
];

async function getParallelismSummary(cadence?: Cadence, scriptName?: string) {
  let potentialTemplateKeys: TemplateKey[] = [];
  const cadences = cadence
    ? [cadence]
    : (Object.keys(templatesByCadence) as Cadence[]);
  const scripts = scriptName ? [scriptName] : tasks;
  const summary = [];
  summary.push("These are the values you should have in .circleci/config.yml:");
  cadences.forEach((cad) => {
    summary.push(`\n${cad}`);
    const cadenceTemplates = Object.entries(allTemplates).filter(([key]) =>
      templatesByCadence[cad].includes(key as TemplateKey)
    );
    potentialTemplateKeys = cadenceTemplates.map(([k]) => k) as TemplateKey[];

    scripts.forEach((script) => {
      const templateKeysPerScript = potentialTemplateKeys.filter((t) => {
        const currentTemplate = allTemplates[t] as Template;
        return (
          currentTemplate.inDevelopment !== true &&
          !currentTemplate.skipTasks?.includes(script as SkippableTask)
        );
      });
      if (templateKeysPerScript.length > 0) {
        summary.push(
          `-- ${script} - parallelism: ${templateKeysPerScript.length}${
            templateKeysPerScript.length === 2 ? " (default)" : ""
          }`
        );
      } else {
        summary.push(
          `-- ${script} - this script is fully skipped for this cadence.`
        );
      }
    });
  });

  return summary.concat("\n").join("\n");
}

type RunOptions = { cadence?: Cadence; task?: string; debug: boolean };
async function run({ cadence, task, debug }: RunOptions) {
  if (debug) {
    if (task && !(task in tasks)) {
      throw new Error(
        dedent`The "${task}" task you provided is not valid. Valid tasks (found in .circleci/config.yml) are: 
        ${tasks.map((v) => `- ${v}`).join("\n")}`
      );
    }
    console.log(await getParallelismSummary(cadence as Cadence, task));
    return;
  }

  if (!cadence)
    throw new Error("Need to supply cadence to get template script");

  const { CIRCLE_NODE_INDEX = 0, CIRCLE_NODE_TOTAL = 1 } = process.env;

  console.log(
    await getTemplate(cadence as Cadence, task, {
      index: +CIRCLE_NODE_INDEX,
      total: +CIRCLE_NODE_TOTAL,
    })
  );
}

if (require.main === module) {
  program
    .description("Retrieve the template to run for a given cadence and task")
    .option(
      "--cadence <cadence>",
      "Which cadence you want to run the script for"
    )
    .option("--task <task>", "Which task you want to run the script for")
    .option(
      "--debug",
      "Whether to list the parallelism counts for tasks by cadence",
      false
    );

  program.parse(process.argv);

  const options = program.opts() as RunOptions;

  run(options).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
