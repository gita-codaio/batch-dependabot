"use strict";
const path = require("path");
const { promises: fs } = require("fs");
const execa = require("execa");
const terminalLink = require("terminal-link");
const { replaceInFile } = require("replace-in-file");

/**
 * @typedef {InstanceType<import('@actions/github/lib/utils').GitHub>} GitHub
 */
/**
 * @template T
 * @typedef {T extends AsyncGenerator<infer T, any, any> ? T : never} ExtractYield<T>
 */
/**
 * @typedef {ExtractYield<ReturnType<typeof getCombinablePRs>>} PR
 */
/**
 * @typedef {Object} Target
 * @property {string} owner
 * @property {string} repo
 */
/**
 * @typedef {Object} Logger
 * @property {(...args: any[]) => void} info
 * @property {(...args: any[]) => void} success
 * @property {(...args: any[]) => void} warning
 * @property {(...args: any[]) => void} error
 * @property {(name: string, cb: () => Promise<void>) => Promise<void>} group
 */

const DEFAULT_BASE_BRANCH = "main";
const DEFAULT_COMBINE_BRANCH_NAME = "combine-prs";
const DEFAULT_MUST_BE_GREEN = true;
const DEFAULT_ALLOW_SKIPPED = false;
const DEFAULT_BRANCH_PREFIX = "dependabot";
const DEFAULT_IGNORE_LABEL = "nocombine";
const DEFAULT_OPEN_PR = true;


/**
 * @param {Object} params
 * @param {GitHub} params.github
 * @param {Target} params.target
 * @param {Logger} params.logger
 * @param {Object} [options]
 * @param {string} [options.baseBranch]
 * @param {string} [options.combineBranchName]
 * @param {boolean} [options.mustBeGreen]
 * @param {boolean} [options.allowSkipped]
 * @param {string} [options.branchPrefix]
 * @param {string} [options.ignoreLabel]
 * @param {boolean} [options.openPR]
*/
const combinePRs = async (
  { github, logger, target },
  {
    baseBranch = DEFAULT_BASE_BRANCH,
    combineBranchName = DEFAULT_COMBINE_BRANCH_NAME,
    mustBeGreen = DEFAULT_MUST_BE_GREEN,
    allowSkipped = DEFAULT_ALLOW_SKIPPED,
    branchPrefix = DEFAULT_BRANCH_PREFIX,
    ignoreLabel = DEFAULT_IGNORE_LABEL,
    openPR = DEFAULT_OPEN_PR,
  } = {}
) => {
  
  logger.info(`Setting up repository for committing.`);

  await setupRepository({ baseBranch, combineBranchName });

  logger.info(`Combining PRs in repo ${target.owner}/${target.repo}.`);

  const combinablePRs = getCombinablePRs(
    { github, logger, target },
    {
      mustBeGreen,
      allowSkipped,
      branchPrefix,
      ignoreLabel,
    }
  );


  let prString = "";
  let prs = 0
  for await (const pr of combinablePRs) {
    await logger.group(
      `Updating ${pr.pkg} from ${pr.fromVersion} to ${pr.toVersion}.`,
      async () => {
        try {
          try {
            await cherryPickPR(pr, logger);
            await commentPR(pr, target, logger, github, combineBranchName);
          } catch (err) {
            if (!err.message.includes("CONFLICT")) {
              throw err;
            }

            logger.warning(`Cherry-pick for ${pr.pkg} failed due to conflict.`);
            await applyPRVersionBump(pr, logger);
          }

          logger.success(
            `Successfully updated ${pr.pkg} from ${pr.fromVersion} to ${pr.toVersion}.`
          );
          prString += "* #" + pr.number + " " + pr.title + "\n";
          prs += 1;
        } catch (err) {
          logger.error(
            `Failed to apply "${pr.title}" due to error:\n\n${
              err.message || err
            }`
          );
        }
      }
    );
  }
  if (prs > 1) {
    // await execa("git", ["stash"]);
    // logger.info('Git stash')
    logger.info('Git rebase')

    await execa("git", ["rebase", "origin/main", combineBranchName]);
    // logger.info('Yarn install')
    // await updateYarn(logger);


    await execa("git", ["push", "-f", "origin", combineBranchName]);
    logger.info('Git push')

    if (openPR) {
      const BUILD_URL = `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      const body = `This PR was created by the Combine PRs action by combining the following PRs:\n\n${prString}\n\nDetails here:${BUILD_URL}`;

      const response = await github.rest.pulls.create({
        owner: target.owner,
        repo: target.repo,
        title: `Batched Dependabot Github Action: ${combineBranchName}`,
        head: combineBranchName,
        base: baseBranch,
        body: body,
      });

      

      logger.success(
        terminalLink(`Successfully opened PR`, response.data.html_url )
      );
    }
  }
  else{
    logger.info("No PRs found to merge")
    try {
      await execa("git", ["branch", "-D", combineBranchName]);
    } catch (error) {
      console.log("Currently that branch does not exist");
      
    }
  }
};

/**
 * @param {Object} params
 * @param {GitHub} params.github
 * @param {Logger} params.logger
 * @param {Target} params.target
 * @param {Object} [options]
 * @param {string} [options.branchPrefix]
 * @param {string} [options.ignoreLabel]
 * @param {boolean} [options.mustBeGreen]
 * @param {boolean} [options.allowSkipped]
 */
const getCombinablePRs = async function* (
  { github, logger, target },
  {
    mustBeGreen = DEFAULT_MUST_BE_GREEN,
    allowSkipped = DEFAULT_ALLOW_SKIPPED,
    branchPrefix = DEFAULT_BRANCH_PREFIX,
    ignoreLabel = DEFAULT_IGNORE_LABEL,
  } = {}
) {
  const pulls = await github.paginate(
    "GET /repos/{owner}/{repo}/pulls",
    target
  );
    /**
   * @type {string[]}
   */
    let branchPrefixList = []
    if (branchPrefix.length) {
      branchPrefixList = branchPrefix.split(',').map((word) => word.trim());
   }

  for (const pull of pulls) {
    const { ref } = pull.head;
    logger.info('pull: ' + pull);
    if (branchPrefixList.some(substr => ref.startsWith(substr))){
      logger.info(
        `${ref} does start with ${branchPrefix}.`
      );
    
    const apiRef = { ...target, ref };

    if (mustBeGreen) {
      const checks = await github.paginate(
        "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
        apiRef
      );

      const isNotAllGreenOrSkipped = (check) => {
        const { conclusion } = check;
        const isSuccessfull = conclusion === "success";
        const isSkipped = conclusion === "skipped";
        const isAllGreenOrSkipped = !allowSkipped ? isSuccessfull : isSuccessfull || isSkipped;
        return !isAllGreenOrSkipped;
      }

      if (checks.some(isNotAllGreenOrSkipped)) {
        logger.warning(
          `Checks for ${ref} are not all successful. Not combining.`
        );
        continue;
      }
    }

    if (
      ignoreLabel &&
      pull.labels.some((label) => label.name === ignoreLabel)
    ) {
      logger.warning(`${ref} has label ${ignoreLabel}. Not combining.`);
      continue;
    }

    const titleExtraction = pull.title.match(PR_TITLE_REGEX);
    
    if (titleExtraction == null) {
      logger.warning(
        `Failed to extract version bump info from commit message: ${pull.title}`
      );
      continue;
    }
    

    const { data: lastCommit } = await github.request(
      "GET /repos/{owner}/{repo}/commits/{ref}",
      apiRef
    );

    const [shortCommitMessage, pkg, fromVersion, toVersion] = titleExtraction;
    const pkgManagerExtraction = ref.match(PKG_MANAGER_REGEX);

    if (!pkgManagerExtraction) {
      logger.warning(`Failed to extract package manager from ${ref}`);
      continue;
    }

    const [, manager] = pkgManagerExtraction;


    yield {
      ref,
      number: pull.number,
      title: pull.title,
      lastCommit,
      shortCommitMessage,
      pkg,
      fromVersion,
      toVersion,
      manager,
    };
  }
  }
};

/**
 * @param {Object} [params]
 * @param {string} [params.baseBranch]
 * @param {string} [params.combineBranchName]
 */
const setupRepository = async ({
  baseBranch = DEFAULT_BASE_BRANCH,
  combineBranchName = DEFAULT_COMBINE_BRANCH_NAME,
} = {}) => {
  try {
    await execa("git", ["branch", "-D", combineBranchName]);
  } catch (error) {
    console.log("Currently that branch does not exist");
  }
  console.log(await execa("git", ["config", "--list"]));
  await execa("git", ["branch", combineBranchName, baseBranch]);
  await execa("git", ["checkout", combineBranchName]);
  console.log(await execa("git", ["branch", "-r"]));

  await execa("git", ["fetch", "--all"]);
};

/**
 * @param {PR} pr
 * @param {Logger} logger
 * @param {target} target context
 * @param {github} github object
 * @param {combineBranchName} combined github branch PR name
 */
 const commentPR = async (
  { ref, title },
  target,
  logger,
  github,
  combineBranchName
) => {
  const combinedBranchUrl = `https://github.com/${target.owner}/${target.repo}/tree/${combineBranchName}`;
  logger.info(`Commenting on ${title}`);
  try {
    await github.request('POST /repos/{owner}/{repo}/commits/{commit_sha}/comments', {
      owner: target.owner,
      repo: target.repo,
      commit_sha: ref,
      body: `This PR has been combined by Github Actions into a batched PR named: ${combinedBranchUrl}`
    })
  } catch (err) {
    throw err;
  }
};


/**
 * @param {PR} pr
 * @param {Logger} logger
 */
const cherryPickPR = async (
  { pkg, fromVersion, toVersion, lastCommit, title},
  logger
) => {
  logger.info(`Cherry-picking ${pkg} from ${fromVersion} to ${toVersion} with ${lastCommit.sha}.`);
  try {
    const results = await execa("git", ["cherry-pick", "--strategy=recursive", "-X", "theirs", lastCommit.sha], {
      stderr: "ignore",
    });
    return results;
  } catch (err) {
    await execa("git", ["cherry-pick", "--abort"], {
      stdout: "ignore",
      reject: false,
    });

    throw err;
  }
};

const updateYarn = async (logger) => {

  logger.info(`Updating yarn.lock`);
  await execa("yarn", ["install", "--silent"]);
  await execa("git", ["add", "."])
  await execa("git", ["commit", "-m", "commit yarn file"])

    // await verifyUpdated("yarn.lock");
}
const PR_TITLE_REGEX = /bump ([\w-@\/]+) from ([\w\.-]+) to ([\w\.-]+)/i;
const PKG_MANAGER_REGEX = /dependabot\/([\w-]+)/;
const EXTRACT_FROM_REGEX = /^\-(.*)$/m;
const EXTRACT_TO_REGEX = /^\+(.*)$/m;

/**
 * @param {string} file
 */
const fileExists = (file) =>
  fs
    .access(file)
    .then(() => true)
    .catch(() => false);

/**
 * @param {Object} file
 * @param {string} file.patch
 * @param {string} file.filename
 */
const applyPatchToFile = async (file) => {
  const [, from] = file.patch.match(EXTRACT_FROM_REGEX) || [];
  const [, to] = file.patch.match(EXTRACT_TO_REGEX) || [];

  if (!from || !to) {
    throw new Error(
      `Could not extract from or to from patch for ${file.filename}.`
    );
  }

  await replaceInFile({
    files: file.filename,
    from,
    to,
  });
};

/**
 * @param {string} filename
 */
const verifyUpdated = async (filename) => {
  const diffResult = await execa("git", ["diff", "--name-only"]);

  if (!diffResult.stdout.includes(`${filename}`)) {
    await execa("git", ["reset", "--hard"]);
    throw new Error(`Failed to update ${filename}`);
  }
};

/**
 * @param {PR} pr
 * @param {Logger} logger
 */
const applyPRVersionBump = async (
  { pkg, fromVersion, toVersion, manager, lastCommit, shortCommitMessage },
  logger
) => {
  logger.info(
    `Manually applying version bump for ${pkg} from ${fromVersion} to ${toVersion} with ${manager}.`
  );

  switch (manager) {
    case "npm_and_yarn":
      const { filename, patch } =
        lastCommit.files.find((file) =>
          file.filename.includes("package.json")
        ) || {};

      if (!filename || !patch) {
        throw new Error(`Change not found for package.json for ${pkg}.`);
      }

      await applyPatchToFile({ filename, patch });

      const dirname = path.dirname(filename);
      logger.info('dirname')
      logger.info(dirname);
      if (await fileExists(path.join(dirname, "package-lock.json"))) {
        logger.info(`Updating package-lock.json`);
        await execa("npm", ["install"], {
          cwd: dirname,
        });
        await verifyUpdated("package-lock.json");
      } else if (await fileExists(path.join(dirname, "yarn.lock"))) {
        logger.info(`Updating yarn.lock`);
        await execa("yarn", {
          cwd: dirname,
        });
        await verifyUpdated("yarn.lock");
      }
      break;
    default:
      throw new Error(
        `Cannot manually apply update for package manager ${manager}.`
      );
  }

  await execa("git", ["add", "."]);

  const authorName = lastCommit.commit.author.name || "github-actions";
  const authorEmail =
    lastCommit.commit.author.email || "github-actions@github.com";
  await execa("git", [
    "commit",
    "--author",
    `${authorName} <${authorEmail}>`,
    "-m",
    shortCommitMessage,
  ]);
};

module.exports = {
  combinePRs,
  getCombinablePRs,
  setupRepository,
  cherryPickPR,
  applyPRVersionBump,
};
