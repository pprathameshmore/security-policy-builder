import chalk from 'chalk';
import commander from 'commander';
import fs from 'fs-extra';
import path from 'path';
import packageJson from '../../package.json';
import * as assessment from '../assessment';
import * as configure from '../configure';
import { DEFAULT_TEMPLATES } from '../constants';
import * as error from '../error';
import { createJupiterOneClient, JupiterOneEnvironment } from '../j1';
import { Entity } from '../j1/types';
import {
  AssessmentAnswers,
  AssessmentInput,
  Gap,
  PolicyBuilderConfig,
  PolicyBuilderPaths,
} from '../types';

const EUSAGEERROR = 126;

type ProgramInput = {
  version?: string;
  standard?: string;
  config?: string;
  output?: string;
  templates?: string;
  includeRisks?: string;
  account?: string;
  apiToken?: string;
};
async function getRisksFromRegistry(program: ProgramInput): Promise<Entity[]> {
  if (!program.account) {
    throw error.fatal('Missing -a, --account <name> input!', EUSAGEERROR);
  }

  if (!program.apiToken) {
    throw error.fatal(
      'Missing -k, --api-token <api_token> input!',
      EUSAGEERROR
    );
  }

  const j1Client = createJupiterOneClient({
    accountId: program.account,
    apiKey: program.apiToken,
    targetEnvironment: process.env.J1_TARGET_ENV as JupiterOneEnvironment,
  });
  return j1Client.queryForEntityList(
    'find Risk with _beginOn > date.now - 1year'
  );
}

export async function run() {
  // establish root project directory so sane relative paths work
  let projectDir = process.env.PROJECT_DIR;
  if (!projectDir) {
    projectDir = path.normalize(path.join(__dirname, '../../'));
    const projectDirs = projectDir.split('/');
    if (projectDirs[projectDirs.length - 1] === 'commands') {
      projectDir = path.dirname(projectDir);
    }
  }

  const program = commander
    .version(packageJson.version, '-v, --version')
    .usage('--standard <compliance_standard> --config <file> [options]')
    .option(
      '-s, --standard <compliance_standard>',
      'compliance standard to assess against. currently supported: hipaa'
    )
    .option('-c, --config <file>', 'JSON config file')
    .option('-o, --output [dir]', 'optional output directory', 'assessments')
    .option('-t, --templates [dir]', 'optional path to template files')
    .option(
      '-r, --include-risks',
      'include items from JupiterOne Risk Register (requires -a and -u/-k to authenticate to JupiterOne account)'
    )
    .option('-a, --account <name>', 'JupiterOne account id')
    .option('-k, --api-token <api_token>', 'JupiterOne API token')
    .parse(process.argv)
    .opts() as ProgramInput;

  if (!program.standard || !program.config) {
    commander.outputHelp();
    process.exit(2);
  }

  if (!program.templates) {
    // if unspecified via the --templates flag,
    // prefer a local 'templates' dir (as it may contain modifications),
    // default to @jupiterone/security-policy-templates NPM package if not found.
    const localTemplates = path.join(projectDir, 'templates');
    const npmTemplates = path.join(projectDir, DEFAULT_TEMPLATES);
    program.templates = fs.pathExistsSync(localTemplates)
      ? localTemplates
      : npmTemplates;
  } else {
    program.templates = path.resolve(program.templates);
  }

  const paths: PolicyBuilderPaths = {
    templates: program.templates,
    output: program.output!,
    partials: 'partials',
  };

  const configFile = program.config;
  console.log('config file: %j', configFile);

  let config: PolicyBuilderConfig = {
    organization: {},
  };
  try {
    config = JSON.parse(fs.readFileSync(configFile, { encoding: 'utf8' }));
  } catch (err) {
    error.fatal(
      `Unable to load configuration from ${configFile} : ${err}`,
      EUSAGEERROR
    );
  }
  let riskList;
  if (program.includeRisks) {
    const riskEntities = await getRisksFromRegistry(program);
    riskList = assessment.generateRiskList(riskEntities);
  } else {
    riskList = 'Detailed risk items omitted.';
  }

  const inputs = await gatherInputs(program, config);
  const standard = program.standard.toLowerCase();

  // tabulate gaps from input prompts
  const inputGaps = calculateInputGaps(inputs);

  // tabulate gaps in controls/procedures
  const { cpGaps, annotatedRefs } = await assessment.calculateCPGaps(
    standard,
    config,
    paths
  );

  const allGaps = inputGaps.concat(cpGaps);

  const gapSummary = assessment.generateGapSummary(allGaps, config, standard);
  const gapList = assessment.generateGapList(allGaps);
  const hipaaControlsMapping = assessment.generateStandardControlsMapping(
    annotatedRefs,
    config
  );
  Object.assign(inputs, {
    gapList,
    gapSummary,
    hipaaControlsMapping,
    riskList,
  });

  console.log(`Generating ${standard.toUpperCase()} self-assessment report...`);
  await assessment.generateReport(inputs, standard, paths);
  if (allGaps.length === 0) {
    console.log(chalk.green('No gaps identified.'));
  } else {
    console.log(
      chalk.yellow(
        `Gaps identified: ${allGaps.length}. See "Gaps, Findings and Action Items" section in report.`
      )
    );
  }
}

export function calculateInputGaps(inputs: AssessmentInput) {
  const gaps: Gap[] = [];
  const orgKeys = Object.keys(inputs) as (keyof AssessmentInput)[];
  for (const orgKey of orgKeys) {
    const match = /has(.*)Gap/.exec(orgKey);
    if (match !== null) {
      const name = match[1];
      const ref = name
        .replace(/([A-Z])([a-z])/g, (match, upper, lower) => {
          return ` ${upper}${lower}`;
        })
        .trim();
      gaps.push({
        ref,
        title: '(see above)',
      });
    }
  }

  return gaps;
}

export type PenTestQuestionName =
  | 'lastPenTestDate'
  | 'lastPenTestProvider'
  | 'penTestFrequency'
  | 'nextPenTestDate';

const PEN_TEST_QUESTIONS: PenTestQuestionName[] = [
  'lastPenTestDate',
  'lastPenTestProvider',
  'penTestFrequency',
  'nextPenTestDate',
];

async function gatherInputs(
  program: ProgramInput,
  config: PolicyBuilderConfig
) {
  const org = config.organization;
  if (!assessment.validateOrgValues(org)) {
    error.fatal(
      'Please update your policy config file and re-run the policy builder before continuing with the assessment.',
      EUSAGEERROR
    );
  }

  const standardName = program.standard!;
  const answers = (await configure.safeInquirerPrompt(
    assessment.questions(standardName)
  )) as AssessmentAnswers;

  // invert boolean values for gap questions
  (Object.keys(answers) as (keyof AssessmentAnswers)[])
    .filter((questionName) => /has.*Gap/.test(questionName))
    .forEach((gap) => {
      answers[gap] = !answers[gap];
    });

  if (answers.hasPenTestGap) {
    PEN_TEST_QUESTIONS.forEach((item) => {
      answers[item] = '*TBD*' as any;
    });
  }

  return {
    ...org,
    ...answers,
    date: new Date(),
    policyTOC: assessment.generatePolicyTOC(config),
    isHIPAACoveredEntityText: org.isHIPAACoveredEntity ? 'is' : 'is not',
    isHIPAABusinessAssociateText: org.isHIPAABusinessAssociate
      ? 'is'
      : 'is not',
  };
}
