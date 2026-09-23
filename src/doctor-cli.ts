#!/usr/bin/env node

/**
 * MobileBuildMCP Doctor CLI
 *
 * This standalone script runs the doctor tool and outputs the results
 * to the console. It's designed to be run directly via npx or mise.
 */

import { version } from './version.ts';
import { doctorLogic } from './mcp/tools/doctor/doctor.ts';
import { getDefaultCommandExecutor } from './utils/execution/index.ts';
import { bootstrapRuntime } from './runtime/bootstrap-runtime.ts';

function shouldUseNonRedactedOutput(argv: string[]): boolean {
  return argv.includes('--non-redacted');
}

async function runDoctor(): Promise<void> {
  try {
    // Using console.error to avoid linting issues as it's allowed by the project's linting rules
    console.error(`Running MobileBuildMCP Doctor (v${version})...`);
    console.error('Collecting system information and checking dependencies...\n');

    await bootstrapRuntime({ runtime: 'cli' });

    const nonRedacted = shouldUseNonRedactedOutput(process.argv.slice(2));
    if (nonRedacted) {
      console.error(
        'Warning: --non-redacted is enabled; doctor output may include sensitive data.',
      );
    }

    const executor = getDefaultCommandExecutor();
    const result = await doctorLogic({ nonRedacted }, executor);

    if (result.content && result.content.length > 0) {
      const textContent = result.content.find((item) => item.type === 'text');
      if (textContent?.type === 'text') {
        // eslint-disable-next-line no-console
        console.log(textContent.text);
      } else {
        console.error('Error: Unexpected doctor result format');
      }
    } else {
      console.error('Error: No doctor information returned');
    }

    console.error('\nDoctor run complete. Please include this output when reporting issues.');
  } catch (error) {
    console.error('Error running doctor:', error);
    process.exit(1);
  }
}

// Run the doctor
runDoctor().catch((error) => {
  console.error('Unhandled exception:', error);
  process.exit(1);
});
