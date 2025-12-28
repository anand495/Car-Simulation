/**
 * MAIN TEST RUNNER
 * =================
 * Runs all test suites and generates a comprehensive report.
 *
 * Usage:
 *   npx ts-node src/tests/run-all-tests.ts [options]
 *
 * Options:
 *   --unit         Run only unit tests
 *   --interaction  Run only interaction tests
 *   --scenario     Run only scenario tests
 *   --log <path>   Analyze a simulation log file
 *   --report       Generate markdown report
 *   --quick        Run quick subset of tests
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { runUnitTests, getUnitTestResults } from './unit-tests.js';
import { runInteractionTests, getInteractionTestResults } from './interaction-tests.js';
import { runScenarioTests } from './scenario-tests.js';
import { runBehavioralTests, getBehavioralTestResults } from './behavioral-tests.js';
import { runAllTests as runLogTests, printResults, generateReport, SimulationLog } from './log-analyzer.js';
import { formatTestReportForSave, generateMarkdownReport, TestSuiteResult } from './test-harness.js';

// ES module __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// CLI ARGUMENT PARSING
// ============================================================================

interface TestOptions {
  runUnit: boolean;
  runInteraction: boolean;
  runScenario: boolean;
  runBehavioral: boolean;
  logPath: string | null;
  generateReport: boolean;
  quickMode: boolean;
  saveResults: boolean;
  outputDir: string | null;
}

function parseArgs(): TestOptions {
  const args = process.argv.slice(2);

  const options: TestOptions = {
    runUnit: false,
    runInteraction: false,
    runScenario: false,
    runBehavioral: false,
    logPath: null,
    generateReport: args.includes('--report'),
    quickMode: args.includes('--quick'),
    saveResults: args.includes('--save') || args.includes('--report'),
    outputDir: null,
  };

  // Check for specific test types
  if (args.includes('--unit')) options.runUnit = true;
  if (args.includes('--interaction')) options.runInteraction = true;
  if (args.includes('--scenario')) options.runScenario = true;
  if (args.includes('--behavioral')) options.runBehavioral = true;

  // Check for log file
  const logIndex = args.indexOf('--log');
  if (logIndex !== -1 && args[logIndex + 1]) {
    options.logPath = args[logIndex + 1];
  }

  // Check for output directory
  const outIndex = args.indexOf('--out');
  if (outIndex !== -1 && args[outIndex + 1]) {
    options.outputDir = args[outIndex + 1];
  }

  // If no specific test type selected, run all
  if (!options.runUnit && !options.runInteraction && !options.runScenario && !options.runBehavioral && !options.logPath) {
    options.runUnit = true;
    options.runInteraction = true;
    options.runScenario = true;
    options.runBehavioral = true;
  }

  return options;
}

// ============================================================================
// MAIN RUNNER
// ============================================================================

async function main(): Promise<void> {
  const options = parseArgs();
  const startTime = Date.now();
  const collectedResults: TestSuiteResult[] = [];

  console.log('\n');
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║           PARKING SIMULATION TEST SUITE                           ║');
  console.log('║           Version 3.4 - Disciplined Driving                       ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log('\n');

  let hasFailures = false;

  try {
    // Run unit tests
    if (options.runUnit) {
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('  UNIT TESTS - Pure Functions');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      try {
        await runUnitTests();
        const unitResults = getUnitTestResults();
        if (unitResults) {
          collectedResults.push(unitResults);
          if (unitResults.failed > 0) hasFailures = true;
        }
      } catch (e) {
        hasFailures = true;
      }
    }

    // Run interaction tests
    if (options.runInteraction) {
      console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('  INTERACTION TESTS - Multi-Vehicle Behavior (High Occupancy)');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      try {
        await runInteractionTests();
        const interactionResults = getInteractionTestResults();
        if (interactionResults) {
          collectedResults.push(interactionResults);
          if (interactionResults.failed > 0) hasFailures = true;
        }
      } catch (e) {
        hasFailures = true;
      }
    }

    // Run scenario tests
    if (options.runScenario && !options.quickMode) {
      console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('  SCENARIO TESTS - Full Flow');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      try {
        await runScenarioTests();
      } catch (e) {
        hasFailures = true;
      }
    }

    // Run behavioral validation tests
    if (options.runBehavioral) {
      console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('  BEHAVIORAL TESTS - 12 Core Validation Requirements');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      try {
        await runBehavioralTests();
        const behavioralResults = getBehavioralTestResults();
        if (behavioralResults) {
          collectedResults.push(behavioralResults);
          if (behavioralResults.failed > 0) hasFailures = true;
        }
      } catch (e) {
        hasFailures = true;
      }
    }

    // Run log analysis
    if (options.logPath) {
      console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('  LOG ANALYSIS');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

      try {
        console.log(`\nLoading log from: ${options.logPath}`);
        const logData = fs.readFileSync(options.logPath, 'utf-8');
        const log: SimulationLog = JSON.parse(logData);

        console.log(`Loaded ${log.snapshots.length} snapshots, ${log.events.length} events`);

        const results = runLogTests(log);
        printResults(results);

        if (options.generateReport) {
          const report = generateReport(log, results);
          const reportPath = options.logPath.replace('.json', '-report.md');
          fs.writeFileSync(reportPath, report);
          console.log(`Report written to: ${reportPath}`);
        }

        const allPassed = results.every(r => r.passed);
        if (!allPassed) hasFailures = true;

      } catch (error) {
        console.error('Error analyzing log:', error);
        hasFailures = true;
      }
    }

    // Save test results if requested
    if (options.saveResults && collectedResults.length > 0) {
      const outputDir = options.outputDir || path.join(__dirname, 'results');

      // Create output directory if it doesn't exist
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      const report = formatTestReportForSave(collectedResults, startTime);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);

      // Save JSON report
      const jsonPath = path.join(outputDir, `test-report-${timestamp}.json`);
      fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
      console.log(`\n📄 JSON report saved to: ${jsonPath}`);

      // Save markdown report
      const mdPath = path.join(outputDir, `test-report-${timestamp}.md`);
      const mdContent = generateMarkdownReport(report);
      fs.writeFileSync(mdPath, mdContent);
      console.log(`📄 Markdown report saved to: ${mdPath}`);

      // Also save a "latest" copy for easy access
      const latestJsonPath = path.join(outputDir, 'test-report-latest.json');
      const latestMdPath = path.join(outputDir, 'test-report-latest.md');
      fs.writeFileSync(latestJsonPath, JSON.stringify(report, null, 2));
      fs.writeFileSync(latestMdPath, mdContent);
      console.log(`📄 Latest report: ${latestMdPath}`);
    }

    // Final summary
    console.log('\n');
    console.log('╔══════════════════════════════════════════════════════════════════╗');
    if (hasFailures) {
      console.log('║  ❌  SOME TESTS FAILED                                            ║');
    } else {
      console.log('║  ✅  ALL TESTS PASSED                                             ║');
    }
    console.log('╚══════════════════════════════════════════════════════════════════╝');
    console.log('\n');

    process.exit(hasFailures ? 1 : 0);

  } catch (error) {
    console.error('Fatal error running tests:', error);
    process.exit(1);
  }
}

// Print usage if --help
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
Parking Simulation Test Suite
=============================

Usage:
  npx tsx src/tests/run-all-tests.ts [options]

Options:
  --unit         Run only unit tests (pure functions)
  --interaction  Run only interaction tests (multi-vehicle, high occupancy)
  --scenario     Run only scenario tests (full flow)
  --behavioral   Run only behavioral validation tests (12 core requirements)
  --log <path>   Analyze a simulation log file
  --report       Generate markdown report (implies --save)
  --save         Save test results to JSON and Markdown files
  --out <dir>    Output directory for saved reports (default: src/tests/results)
  --quick        Run quick subset (skip scenario tests)
  --help, -h     Show this help message

Behavioral Tests (12 Core Requirements):
  1. Cars able to park in the lot
  2. Two cars are not assigned the same spot
  3. No stuck cars (or stuck resolution works)
  4. Disciplined driving behavior (lane discipline, yielding)
  5. No collisions
  6. Cars not clustering together (spawn clearance)
  7. All parking-bound cars eventually park (completion rate)
  8. Cars treat parked cars as obstacles
  9. Cars constrained to paved paths
  10. Conflict resolution logic works correctly
  11. Context-aware behavior (location + intent dependent)
  12. Task completion rate metrics

Examples:
  # Run all tests and save results
  npx tsx src/tests/run-all-tests.ts --save

  # Run behavioral validation tests only
  npx tsx src/tests/run-all-tests.ts --behavioral

  # Run interaction tests with report
  npx tsx src/tests/run-all-tests.ts --interaction --report

  # Analyze a log file
  npx tsx src/tests/run-all-tests.ts --log ~/Downloads/sim-log.json --report

  # Quick smoke test
  npx tsx src/tests/run-all-tests.ts --quick

  # Save to custom directory
  npx tsx src/tests/run-all-tests.ts --save --out ./my-reports
`);
  process.exit(0);
}

main();
