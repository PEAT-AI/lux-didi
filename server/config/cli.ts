import { initializeProviderConfig, ConfigError, type InitializeOptions } from './index.js';

const help = 'Usage: node <compiled-root>/config/cli.js init --config-dir <new-private-dir> --owner-id <current-store-owner> --profile-input <private-profile-json> --source-env <authorized-private-env-file>\nAll paths must be explicit absolute paths. Fixed source variable: GEMINI_API_KEY.\n';
function argumentsFrom(args: string[]): InitializeOptions {
  if (args[0] !== 'init' || args.length !== 9) throw new ConfigError('invalid_arguments');
  const names: Record<string, keyof InitializeOptions> = { '--config-dir': 'configDir', '--owner-id': 'ownerId', '--profile-input': 'profileInputPath', '--source-env': 'sourceEnvPath' };
  const values: Partial<InitializeOptions> = {};
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i]!;
    const name = Object.hasOwn(names, flag) ? names[flag] : undefined;
    const value = args[i + 1];
    if (!name || !value || value.startsWith('--') || values[name] !== undefined) throw new ConfigError('invalid_arguments');
    values[name] = value;
  }
  if (Object.keys(values).length !== 4) throw new ConfigError('invalid_arguments');
  return values as InitializeOptions;
}
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') process.stdout.write(help);
else {
  try {
    initializeProviderConfig(argumentsFrom(args));
    process.stdout.write('Provider configuration initialized.\n');
  } catch (e) {
    const code = e instanceof ConfigError ? e.code : 'initialization_failed';
    process.stderr.write(`Provider configuration error: ${code}. Existing targets are unchanged; if a new private directory was created, preserve it and use a fresh destination after authorized inspection.\n`);
    process.exitCode = 1;
  }
}
