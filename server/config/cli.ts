import { initializeProviderConfig, migrateProviderBinding, ConfigError, type InitializeOptions, type MigrateBindingOptions } from './index.js';
import { isLiveVoiceProvider, type LiveVoiceProvider } from '../adapters/live-voice/index.js';
import { saveLiveSelection } from './live.js';

const help = 'Usage: node <compiled-root>/config/cli.js init --config-dir <new-private-dir> --owner-id <current-store-owner> --profile-input <private-profile-json> --source-env <authorized-private-env-file> [--binding-input <private-binding-json>]\n       node <compiled-root>/config/cli.js migrate-binding --config-dir <existing-private-dir> --owner-id <current-store-owner> --binding-input <private-binding-json>\nAll paths must be explicit absolute paths. Fixed source variable: GEMINI_API_KEY. Binding is an operator assertion, not provider identity verification.\n';
type SelectOptions = { configDir: string; provider: LiveVoiceProvider; voice?: string };
type Command = { command: 'init'; options: InitializeOptions } | { command: 'migrate-binding'; options: MigrateBindingOptions }
  | { command: 'select'; options: SelectOptions };
function argumentsFrom(args: string[]): Command {
  const command = args[0];
  if ((command !== 'init' && command !== 'migrate-binding' && command !== 'select') ||
      (command === 'init' ? ![9, 11, 13].includes(args.length)
        : command === 'select' ? args.length !== 5 && args.length !== 7 : args.length !== 7)) throw new ConfigError('invalid_arguments');
  const names: Record<string, string> = { '--config-dir': 'configDir', '--owner-id': 'ownerId', '--binding-input': 'bindingInputPath',
    ...(command === 'init' ? { '--profile-input': 'profileInputPath', '--source-env': 'sourceEnvPath', '--provider': 'provider' }
      : command === 'select' ? { '--provider': 'provider', '--voice': 'voice' } : {}) };
  const values: Record<string, string> = {};
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i]!;
    const name = Object.hasOwn(names, flag) ? names[flag] : undefined;
    const value = args[i + 1];
    if (!name || !value || value.startsWith('--') || Object.hasOwn(values, name)) throw new ConfigError('invalid_arguments');
    values[name] = value;
  }
  if (command === 'select') {
    if (!values['configDir'] || !values['provider'] || !isLiveVoiceProvider(values['provider'])) throw new ConfigError('invalid_arguments');
    return { command, options: { configDir: values['configDir'], provider: values['provider'],
      ...(values['voice'] !== undefined ? { voice: values['voice'] } : {}) } };
  }
  if (!values['configDir'] || !values['ownerId']) throw new ConfigError('invalid_arguments');
  const common = { configDir: values['configDir'], ownerId: values['ownerId'] };
  if (command === 'migrate-binding') {
    if (!values['bindingInputPath']) throw new ConfigError('invalid_arguments');
    return { command, options: { ...common, bindingInputPath: values['bindingInputPath'] } };
  }
  if (!values['profileInputPath'] || !values['sourceEnvPath']) throw new ConfigError('invalid_arguments');
  const provider = values['provider'];
  if (provider !== undefined && !isLiveVoiceProvider(provider)) throw new ConfigError('invalid_arguments');
  return { command, options: { ...common, profileInputPath: values['profileInputPath'], sourceEnvPath: values['sourceEnvPath'],
    ...(values['bindingInputPath'] ? { bindingInputPath: values['bindingInputPath'] } : {}),
    ...(provider !== undefined ? { provider } : {}) } };
}
if (process.argv.slice(2).length === 1 && process.argv[2] === '--help') {
  process.stdout.write(help);
} else {
  try {
    const parsed = argumentsFrom(process.argv.slice(2));
    if (parsed.command === 'init') initializeProviderConfig(parsed.options);
    else if (parsed.command === 'select') saveLiveSelection(parsed.options);
    else migrateProviderBinding(parsed.options);
    process.stdout.write(parsed.command === 'init' ? 'Provider configuration initialized.\n'
      : parsed.command === 'select' ? 'Live provider selection saved; it applies when the service next starts.\n'
      : 'Provider binding migrated. Sensitive legacy backup retained; profile and preferences unchanged.\n');
  } catch (e) {
    const code = e instanceof ConfigError ? e.code : 'initialization_failed';
    process.stderr.write(`Provider configuration error: ${code}. Preserve protected configuration and any retained legacy backup for authorized inspection; failed migration may leave a valid old or new active record. Failed initialization requires a fresh destination.\n`);
    process.exitCode = 1;
  }
}
